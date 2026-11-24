import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config, sessionSecret } from "./config";
import { db } from "./db";
import { readToken, signToken } from "./security";

/* Three audiences, three kinds of session:
   - normal users ("requesters"): identify with name + company email, cookie `fg_user`, long-lived
   - agents and admins ("staff"): email + password at /agent or /admin, cookie `fg_staff`, 2 h (12 h on request)
   A requester session can never act as staff, even if the email typed belongs to a staff member. */

export type Role = "requester" | "agent" | "admin";
export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  entity: string | null;
  department: string | null;
  must_change_password?: number;
  credential_version?: number;
}
export type AppEnv = { Variables: { user: User } };

const SECRET = sessionSecret();
const USER_COOKIE = "fg_user";
const STAFF_COOKIE = "fg_staff";
const USER_SECONDS = 180 * 86400;
export const STAFF_SECONDS = 2 * 3600;
export const STAFF_LONG_SECONDS = 12 * 3600; // opt-in "keep this screen signed in" (office display)
const now = () => Math.floor(Date.now() / 1000);

type Ctx = Context<any>;

export const isSecure = (c: Ctx) => config.secureCookies || (config.trustProxy && c.req.header("x-forwarded-proto") === "https");

export function clientIp(c: Ctx): string {
  if (config.trustProxy) {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/* ---------- sessions ---------- */

/** `remember` = "Remember me on this computer": a long-lived cookie. Without it the cookie ends when the browser closes (and the token after a day). */
export function startUserSession(c: Ctx, userId: number, remember = true, version = 1) {
  const token = signToken({ k: "u", u: userId, v: version, e: now() + (remember ? USER_SECONDS : 86400) }, SECRET);
  setCookie(c, USER_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", secure: isSecure(c), ...(remember ? { maxAge: USER_SECONDS } : {}) });
}
export const endUserSession = (c: Ctx) => deleteCookie(c, USER_COOKIE, { path: "/" });
const userToken = (c: Ctx) => readToken<{ k: string; u: number; v?: number; e: number }>(getCookie(c, USER_COOKIE), SECRET);
export const userSessionId = (c: Ctx): number | null => userToken(c)?.u ?? null;

/** Returns the expiry (unix seconds). */
export function startStaffSession(c: Ctx, user: { id: number; credential_version: number }, long = false): number {
  const seconds = long ? STAFF_LONG_SECONDS : STAFF_SECONDS;
  const exp = now() + seconds;
  const token = signToken({ k: "s", u: user.id, v: user.credential_version, e: exp }, SECRET);
  setCookie(c, STAFF_COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: seconds, secure: isSecure(c) });
  return exp;
}
export const endStaffSession = (c: Ctx) => deleteCookie(c, STAFF_COOKIE, { path: "/" });

/* ---------- middleware ---------- */

/** Normal users. 401 {error:"identify"} until they've entered their name + email. */
export const requesterAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const tok = userToken(c);
  const row = tok
    ? await db.prepare("SELECT id, email, name, role, entity, department, session_version FROM users WHERE id = ? AND active = 1").bind(tok.u).first<User & { session_version: number }>()
    : null;
  // A PIN reset/change or "sign out everywhere" bumps session_version, which ends every older session at once.
  if (!row || row.session_version !== (tok!.v ?? 1)) return c.json({ error: "identify" }, 401);
  const { session_version: _v, ...safe } = row;
  c.set("user", { ...safe, role: "requester" }); // never carries staff powers
  await next();
};

// While a temporary password is pending, staff may only reach these.
const ALLOWED_WHEN_PASSWORD_CHANGE_PENDING = ["/staff/password", "/staff/me", "/staff/logout"];

/**
 * Agents and admins.
 *  - no/expired session  -> 401 {error:"signed_out"}
 *  - wrong role          -> 403, or 404 when `hide` is set (so admin-only routes don't even look like they exist)
 */
export function staffAuth(opts: { roles?: Role[]; hide?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = readToken<{ k: string; u: number; v: number; e: number }>(getCookie(c, STAFF_COOKIE), SECRET);
    const row =
      p?.k === "s"
        ? await db
            .prepare(
              "SELECT id, email, name, role, entity, department, must_change_password, credential_version FROM users WHERE id = ? AND active = 1 AND role IN ('agent','admin')",
            )
            .bind(p.u)
            .first<User>()
        : null;
    if (!p || !row || row.credential_version !== p.v) return c.json({ error: "signed_out" }, 401);
    if (opts.roles && !opts.roles.includes(row.role)) return opts.hide ? c.json({ error: "not found" }, 404) : c.json({ error: "forbidden" }, 403);
    if (row.must_change_password && !ALLOWED_WHEN_PASSWORD_CHANGE_PENDING.some((x) => c.req.path.endsWith(x)))
      return c.json({ error: "password_change_required" }, 403);
    c.set("user", row);
    await next();
  };
}

export const isStaff = (u: User) => u.role !== "requester";

export const requireRole =
  (...roles: Role[]): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!roles.includes(c.get("user").role)) return c.json({ error: "forbidden" }, 403);
    await next();
  };

/** Blocks cross-site form posts: a mutating request that carries an Origin must come from this site. */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).host;
    } catch {
      /* malformed */
    }
    const expected = (config.trustProxy && c.req.header("x-forwarded-host")) || c.req.header("host");
    if (host !== expected) return c.json({ error: "bad origin" }, 403);
  }
  await next();
};

/** When the current staff session ends (unix seconds), for the "signed in until…" display. */
export const staffSessionExpiry = (c: Ctx): number | null => readToken<{ e: number }>(getCookie(c, STAFF_COOKIE), SECRET)?.e ?? null;
