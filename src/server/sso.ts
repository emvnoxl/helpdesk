import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { clientIp, isSecure, startStaffSession, startUserSession } from "./auth";
import { audit } from "./audit";
import { changed } from "./bus";
import { config, sessionSecret, ssoReady } from "./config";
import { db } from "./db";
import { requestUrl } from "./devices";
import { RateLimiter, hashPassword, randomPassword, readToken, signToken } from "./security";
import { putSetting } from "./sla";

/* Sign in with Microsoft 365: OpenID Connect, authorization-code flow with PKCE, from the server (a "confidential client").
     GET /api/auth/microsoft/start?portal=user|agent|admin[&t=<ticket>]   -> sends the browser to Microsoft
     GET /api/auth/microsoft/callback                                      -> Microsoft sends it back here with a code
   The code is exchanged for tokens directly with Microsoft over TLS using the client secret; the ID token comes straight from that
   response, so (as OIDC Core 3.1.3.7 allows) its claims are checked (issuer, audience, tenant, nonce, expiry) rather than its signature.
   Who may sign in where:
     - /          anybody in the tenant: an account is created from their Microsoft profile on first use (name, job title) and, if one
                  already exists for that email (made with a PIN, or by email), it is linked to it. Always a REQUESTER session.
     - /agent     an existing agent account only (an admin adds them under Staff), /admin an existing admin only.
   The state/nonce/verifier live in a short-lived signed cookie; the tokens are never stored. */

export const sso = new Hono();
const SECRET = sessionSecret();
const COOKIE = "fg_oauth";
const limiter = new RateLimiter(30, 10 * 60_000);
const now = () => Math.floor(Date.now() / 1000);
const b64u = (b: Buffer) => b.toString("base64url");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Portal = "user" | "agent" | "admin";
const PATH: Record<Portal, string> = { user: "/", agent: "/agent", admin: "/admin" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The address Microsoft must send people back to: the saved APP_URL (so it matches what is registered), else the one in the address bar. */
export const redirectUri = (c: Parameters<typeof requestUrl>[0]) => `${config.appUrl || requestUrl(c)}/api/auth/microsoft/callback`;

/** A page that moves on by itself. Not a 302: after a redirect chain that began on Microsoft's site, the browser treats the next request as
    cross-site and would not send the Strict staff cookie, so the portal would open signed out. A page of ours that navigates is same-site. */
function go(c: any, to: string) {
  c.header("Cache-Control", "no-store");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing in</title>` +
      `<meta http-equiv="refresh" content="0;url=${esc(to)}"></head><body style="font-family:system-ui,sans-serif;padding:2rem"><p>Continuing… <a href="${esc(to)}">Click here if nothing happens</a>.</p></body></html>`,
  );
}
const fail = (c: any, portal: Portal, code: string) => go(c, `${PATH[portal]}?login_error=${encodeURIComponent(code)}`);

sso.get("/start", (c) => {
  const q = c.req.query();
  const portal: Portal = q.portal === "admin" ? "admin" : q.portal === "agent" ? "agent" : "user";
  if (!ssoReady()) return fail(c, portal, "sso_off");
  if (!limiter.take(clientIp(c))) return fail(c, portal, "throttled");
  const state = b64u(randomBytes(24));
  const nonce = b64u(randomBytes(24));
  const verifier = b64u(randomBytes(48));
  const ticket = Number.isInteger(Number(q.t)) && Number(q.t) > 0 ? Number(q.t) : 0;
  const redir = redirectUri(c);
  setCookie(c, COOKIE, signToken({ k: "o", s: state, n: nonce, v: verifier, p: portal, t: ticket, r: redir, e: now() + 600 }, SECRET), {
    httpOnly: true, sameSite: "Lax", path: "/api/auth/microsoft", maxAge: 600, secure: isSecure(c),
  });
  const u = new URL(`${config.sso.authority}/${encodeURIComponent(config.sso.tenantId)}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: config.sso.clientId,
    response_type: "code",
    redirect_uri: redir,
    response_mode: "query",
    scope: "openid profile email User.Read",
    state,
    nonce,
    code_challenge: b64u(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  c.header("Cache-Control", "no-store");
  return c.redirect(u.toString(), 302);
});

interface Claims { aud?: string; iss?: string; tid?: string; oid?: string; nonce?: string; exp?: number; name?: string; email?: string; preferred_username?: string }
const decode = (jwt: string): Claims | null => {
  try { return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Claims; } catch { return null; }
};
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

sso.get("/callback", async (c) => {
  const cookie = readToken<{ k: string; s: string; n: string; v: string; p: Portal; t: number; r: string; e: number }>(getCookie(c, COOKIE), SECRET);
  deleteCookie(c, COOKIE, { path: "/api/auth/microsoft" });
  const portal: Portal = cookie?.p ?? "user";
  const who = { id: null as number | null, name: "Unknown", role: "unknown" };
  const bad = async (code: string, why: string, name = "Unknown", id: number | null = null) => {
    await audit(c, "signin.microsoft_failed", "security", `Microsoft sign-in failed (${portal}): ${why}`, { who: { id, name: name.slice(0, 80), role: "unknown" } });
    return fail(c, portal, code);
  };
  if (!ssoReady()) return fail(c, portal, "sso_off");
  const q = c.req.query();
  if (q.error) return bad("cancelled", `Microsoft said ${String(q.error).slice(0, 60)}`);
  if (!cookie || cookie.k !== "o" || !q.state || !same(String(q.state), cookie.s) || !q.code) return bad("expired", "missing or mismatching state");

  // code -> tokens, straight from Microsoft, proving who we are with the client secret and the PKCE verifier
  let tokens: { id_token?: string; access_token?: string };
  try {
    const res = await fetch(`${config.sso.authority}/${encodeURIComponent(config.sso.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.sso.clientId, client_secret: config.sso.clientSecret, grant_type: "authorization_code",
        code: String(q.code), redirect_uri: cookie.r, code_verifier: cookie.v, scope: "openid profile email User.Read",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return bad("failed", `token exchange refused (${res.status})`);
    tokens = (await res.json()) as typeof tokens;
  } catch (e) {
    return bad("failed", `could not reach Microsoft (${(e as Error).message.slice(0, 60)})`);
  }
  const claims = tokens.id_token ? decode(tokens.id_token) : null;
  if (!claims || claims.aud !== config.sso.clientId || claims.tid !== config.sso.tenantId || !claims.oid || claims.nonce !== cookie.n || !claims.exp || claims.exp < now() - 60 || claims.iss !== `${config.sso.authority}/${config.sso.tenantId}/v2.0`)
    return bad("failed", "the identity token did not check out");

  // what Microsoft knows about them (best effort): the proper mailbox address, name, job title, department
  let prof: { displayName?: string; mail?: string; userPrincipalName?: string; jobTitle?: string; department?: string } = {};
  try {
    const r = await fetch(`${config.sso.graphUrl}/me?$select=displayName,mail,userPrincipalName,jobTitle,department`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(5000) });
    if (r.ok) prof = (await r.json()) as typeof prof;
  } catch { /* the ID token is enough */ }
  const email = String(prof.mail || claims.email || claims.preferred_username || prof.userPrincipalName || "").trim().toLowerCase().slice(0, 200);
  const name = String(prof.displayName || claims.name || email.split("@")[0] || "").trim().slice(0, 100);
  const job = String(prof.jobTitle ?? "").trim().slice(0, 100) || null;
  const dept = String(prof.department ?? "").trim().slice(0, 100) || null;
  who.name = email || "Unknown";
  if (!EMAIL.test(email)) return bad("no_email", "Microsoft sent no usable email address");
  if (config.companyDomain && email.split("@")[1] !== config.companyDomain) return bad("wrong_domain", `${email} is not on ${config.companyDomain}`, email);

  type Row = { id: number; email: string; name: string; role: "requester" | "agent" | "admin"; active: number; ms_oid: string | null; session_version: number; credential_version: number; must_change_password: number };
  const cols = "id, email, name, role, active, ms_oid, session_version, credential_version, must_change_password";
  let row = (await db.prepare(`SELECT ${cols} FROM users WHERE ms_oid = ?`).bind(claims.oid).first<Row>()) ?? null;
  const byEmail = await db.prepare(`SELECT ${cols} FROM users WHERE email = ?`).bind(email).first<Row>();
  if (row && byEmail && row.id !== byEmail.id) return bad("mismatch", `the Microsoft account for ${email} is linked to a different helpdesk account`, email, byEmail.id);
  if (!row && byEmail?.ms_oid && byEmail.ms_oid !== claims.oid) return bad("mismatch", `${email} is already linked to a different Microsoft account`, email, byEmail.id);
  row ??= byEmail ?? null;
  // Their address changed in Microsoft 365 (a rename): the Microsoft id is what identifies them, so follow it, as long as nobody else has the new address.
  if (row && row.ms_oid === claims.oid && row.email !== email && !byEmail) {
    await db.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, row.id).run();
    await audit(c, "account.email_changed", "account", `Email changed in Microsoft 365: ${row.email} is now ${email}`, { who: { id: row.id, name: row.name, role: row.role } });
  }

  let created = false;
  if (!row) {
    if (portal !== "user") return bad("not_staff", `no ${portal} account for ${email}`, email);
    const r = await db.prepare("INSERT INTO users (email, name, role, ms_oid, ms_tid, job_title, department) VALUES (?, ?, 'requester', ?, ?, ?, ?) RETURNING id").bind(email, name, claims.oid, claims.tid, job, dept).first<{ id: number }>();
    row = { id: r!.id, email, name, role: "requester", active: 1, ms_oid: claims.oid, session_version: 1, credential_version: 1, must_change_password: 0 };
    created = true;
    await audit(c, "account.registered", "account", `New account created from Microsoft 365: ${name} (${email})`, { who: { id: row.id, name, role: "requester" } });
    changed();
  }
  const actor = { id: row.id, name: row.name, role: row.role };
  if (!row.active) return bad("disabled", `${email} is disabled`, email, row.id);
  if (portal !== "user" && row.role !== portal) return bad("not_staff", `${email} is not ${portal === "admin" ? "an admin" : "an agent"}`, email, row.id);

  // link (first time), and keep what Microsoft knows fresh. Staff choose their own displayed name; requesters follow Microsoft.
  await db
    .prepare("UPDATE users SET ms_oid = ?, ms_tid = ?, job_title = COALESCE(?, job_title), department = COALESCE(department, ?), name = CASE WHEN role = 'requester' THEN ? ELSE name END, failed_attempts = 0, locked_until = 0, last_login_at = unixepoch() WHERE id = ?")
    .bind(claims.oid, claims.tid, job, dept, name, row.id)
    .run();
  if (!created && !row.ms_oid) await audit(c, "account.ms_linked", "account", `Linked ${email} to their Microsoft 365 account`, { who: actor });

  if (portal === "user") startUserSession(c, row.id, true, row.session_version);
  else {
    // Microsoft has proved who they are, so a pending temporary password is no longer needed: retire it.
    if (row.must_change_password) await db.prepare("UPDATE users SET must_change_password = 0, password_hash = ?, credential_version = credential_version + 1 WHERE id = ?").bind(await hashPassword(randomPassword()), row.id).run();
    const cv = row.must_change_password ? row.credential_version + 1 : row.credential_version;
    startStaffSession(c, { id: row.id, credential_version: cv });
    if (portal === "admin") { await putSetting("sso_verified_at", String(now())); changed(); } // an admin got in this way: it is safe to switch the old sign-ins off
  }
  await audit(c, "signin.microsoft", "signin", `Signed in with Microsoft 365 (${portal === "user" ? "helpdesk" : portal + " portal"}, ${email})`, { who: actor });

  const next = new URLSearchParams();
  if (cookie.t) next.set("t", String(cookie.t));
  if (created) next.set("welcome", "1");
  const qs = next.toString();
  return go(c, PATH[portal] + (qs ? `?${qs}` : ""));
});
