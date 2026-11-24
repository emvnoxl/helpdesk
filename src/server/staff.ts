import { Hono } from "hono";
import { type AppEnv, clientIp, endStaffSession, staffAuth, staffSessionExpiry, startStaffSession } from "./auth";
import { db } from "./db";
import { config, ssoEnforced } from "./config";
import { RateLimiter, hashPassword, verifyPassword } from "./security";
import { audit } from "./audit";

/* Agents and admins: each has an account (email + password) created by an admin, and signs in at /agent or /admin.
   Mounted at /api/staff. Login/logout are public; everything after staffAuth() needs a staff session. */

export const staff = new Hono<AppEnv>();

export const MIN_PASSWORD = 12;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);
const limiter = new RateLimiter(config.loginRateLimit, 10 * 60_000);

// Verifying against a throwaway hash when the email is unknown keeps the response time the same either way.
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword("not-a-real-password"));

interface LoginRow {
  id: number; email: string; name: string; role: "agent" | "admin"; password_hash: string | null;
  must_change_password: number; credential_version: number; failed_attempts: number; locked_until: number;
}

staff.post("/login", async (c) => {
  if (!limiter.take(clientIp(c))) {
    await audit(c, "signin.throttled", "security", "Too many staff sign-in attempts from one address", { who: { id: null, name: "Unknown", role: "unknown" } });
    return c.json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  }
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const portal = body.portal === "admin" ? "admin" : body.portal === "agent" ? "agent" : null;
  if (!portal || !email || !password || password.length > 200) return c.json({ error: "Enter your email and password." }, 400);
  // With Microsoft 365 sign-in switched on, agents use only that. Admins keep their local password as the way back in if Microsoft or the tenant is unavailable.
  if (ssoEnforced() && portal !== "admin") return c.json({ error: "incorrect" }, 401);

  // Each portal only accepts its own role, so an agent can't sign in at /admin and vice versa.
  const row = await db
    .prepare(
      `SELECT id, email, name, role, password_hash, must_change_password, credential_version, failed_attempts, locked_until
       FROM users WHERE email = ? AND role = ? AND active = 1`,
    )
    .bind(email, portal)
    .first<LoginRow>();

  if (row && row.locked_until > now()) {
    await audit(c, "signin.locked", "security", `Sign-in refused: ${row.email} is locked`, { who: { id: row.id, name: row.name, role: row.role } });
    return c.json({ error: "locked", locked_until: row.locked_until }, 429);
  }
  const ok = await verifyPassword(password, row ? row.password_hash : await dummyHash());
  if (!row || !ok) {
    if (!row) {
      await audit(c, "signin.failed", "security", `Failed ${portal} sign-in: no such account (${email.slice(0, 80)})`, { who: { id: null, name: email.slice(0, 80), role: "unknown" } });
      return c.json({ error: "incorrect" }, 401);
    }
    const fails = row.failed_attempts + 1;
    if (fails >= MAX_FAILS) {
      const until = now() + LOCK_SECONDS;
      await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?").bind(until, row.id).run();
      await audit(c, "signin.locked", "security", `${row.email} locked for 15 minutes after ${MAX_FAILS} wrong passwords`, { who: { id: row.id, name: row.name, role: row.role } });
      return c.json({ error: "locked", locked_until: until }, 429);
    }
    await db.prepare("UPDATE users SET failed_attempts = ? WHERE id = ?").bind(fails, row.id).run();
    await audit(c, "signin.failed", "security", `Wrong password for ${row.email} (${fails} of ${MAX_FAILS})`, { who: { id: row.id, name: row.name, role: row.role } });
    return c.json({ error: "incorrect", attempts_left: MAX_FAILS - fails }, 401);
  }

  await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = 0, last_login_at = ? WHERE id = ?").bind(now(), row.id).run();
  const expires_at = startStaffSession(c, row, body.remember === true);
  await audit(c, "signin.staff", "signin", `Signed in to the ${portal} portal${body.remember === true ? " (kept signed in)" : ""}`, { who: { id: row.id, name: row.name, role: row.role } });
  return c.json({ ok: true, expires_at, must_change_password: !!row.must_change_password });
});

staff.post("/logout", (c) => {
  endStaffSession(c);
  return c.json({ ok: true });
});

/* ---------- signed-in staff from here on ---------- */
staff.use("*", staffAuth());

staff.get("/me", async (c) => {
  const u = c.get("user");
  const p = await db.prepare("SELECT email_notify FROM users WHERE id = ?").bind(u.id).first<{ email_notify: number }>();
  return c.json({ id: u.id, name: u.name, email: u.email, role: u.role, must_change_password: !!u.must_change_password, email_notify: p?.email_notify !== 0, expires_at: staffSessionExpiry(c) });
});

staff.post("/password", async (c) => {
  const u = c.get("user");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";
  if (next.length < MIN_PASSWORD || next.length > 200) return c.json({ error: `Use at least ${MIN_PASSWORD} characters (a passphrase of a few words works well).` }, 400);
  if (next === current) return c.json({ error: "The new password must be different." }, 400);

  const row = await db
    .prepare("SELECT password_hash, credential_version, failed_attempts, locked_until FROM users WHERE id = ?")
    .bind(u.id)
    .first<{ password_hash: string; credential_version: number; failed_attempts: number; locked_until: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.locked_until > now()) return c.json({ error: "locked", locked_until: row.locked_until }, 429);
  if (!(await verifyPassword(current, row.password_hash))) {
    const fails = row.failed_attempts + 1;
    if (fails >= MAX_FAILS) {
      const until = now() + LOCK_SECONDS;
      await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?").bind(until, u.id).run();
      return c.json({ error: "locked", locked_until: until }, 429);
    }
    await db.prepare("UPDATE users SET failed_attempts = ? WHERE id = ?").bind(fails, u.id).run();
    return c.json({ error: "Current password is incorrect.", attempts_left: MAX_FAILS - fails }, 401);
  }

  // A new credential_version signs out every older session; we hand this browser a fresh one straight away.
  const version = row.credential_version + 1;
  await db
    .prepare("UPDATE users SET password_hash = ?, must_change_password = 0, credential_version = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?")
    .bind(await hashPassword(next), version, u.id)
    .run();
  const expires_at = startStaffSession(c, { id: u.id, credential_version: version });
  await audit(c, "account.password_changed", "account", "Changed their own password");
  return c.json({ ok: true, expires_at });
});

// The name people see as "assigned to".
staff.patch("/profile", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const me = c.get("user");
  // Only the e-mail switch: { email_notify: boolean }
  if (body.name === undefined && typeof body.email_notify === "boolean") {
    await db.prepare("UPDATE users SET email_notify = ? WHERE id = ?").bind(body.email_notify ? 1 : 0, me.id).run();
    await audit(c, "account.email_notify", "account", body.email_notify ? "Switched ticket emails on" : "Switched ticket emails off");
    return c.json({ ok: true, email_notify: body.email_notify });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  if (name.length < 2) return c.json({ error: "Enter your name." }, 400);
  await db.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, me.id).run();
  return c.json({ ok: true, name });
});

// Shared by the agent and admin portals: my queue, what still needs triage, and the headline counts.
staff.get("/overview", async (c) => {
  const me = c.get("user");
  const OPEN = "status NOT IN ('resolved','closed')";
  const [mine, triage, counts, topCat, resolved] = await db.batch([
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.status, t.priority, t.priority_locked, t.due_at, t.created_at, t.updated_at,
              u.name AS requester, c.name AS category
       FROM tickets t JOIN users u ON u.id = t.requester_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.assignee_id = ? AND t.${OPEN}
       ORDER BY t.priority_rank DESC, t.created_at ASC LIMIT 50`,
    ).bind(me.id),
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.priority, t.priority_locked, t.created_at, u.name AS requester, c.name AS category
       FROM tickets t JOIN users u ON u.id = t.requester_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.assignee_id IS NULL AND t.${OPEN}
       ORDER BY t.priority_rank DESC, t.created_at ASC LIMIT 15`,
    ),
    db.prepare(
      `SELECT COUNT(*) AS open,
              COALESCE(SUM(priority='urgent'),0) AS urgent,
              COALESCE(SUM(status != 'waiting' AND due_at IS NOT NULL AND due_at < unixepoch()),0) AS overdue,
              COALESCE(SUM(assignee_id IS NULL),0) AS unassigned
       FROM tickets WHERE ${OPEN}`,
    ),
    db.prepare(
      `SELECT c.name, COUNT(*) AS n FROM tickets t JOIN categories c ON c.id = t.category_id
       WHERE t.created_at >= unixepoch() - 30*86400 GROUP BY c.id ORDER BY n DESC LIMIT 1`,
    ),
    // Fixed but not yet closed: the end-of-day board an admin sweeps.
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.priority, t.resolved_at, t.updated_at, u.name AS requester, c.name AS category, a.name AS assignee
       FROM tickets t JOIN users u ON u.id = t.requester_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.status = 'resolved' ORDER BY t.resolved_at DESC, t.id DESC LIMIT 300`,
    ),
  ]);
  return c.json({
    now: now(),
    me: me.id,
    role: me.role,
    mine: mine.results,
    triage: triage.results,
    resolved: resolved.results,
    counts: counts.results[0] ?? {},
    topCategory: me.role === "admin" ? (topCat.results[0] ?? null) : null,
  });
});
