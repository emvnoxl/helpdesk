import { Hono } from "hono";
import { type AppEnv, clientIp, endUserSession, requesterAuth, startUserSession, userSessionId } from "./auth";
import { audit } from "./audit";
import { changed } from "./bus";
import { config, ssoEnforced } from "./config";
import { db } from "./db";
import { RateLimiter, hashPassword, verifyPassword } from "./security";

/* Normal users sign in with a name, their company email and a personal PIN. The first person to use an email creates its PIN; from then on
   every computer (or browser, or incognito window) that has not signed in before must enter it. A computer that is already signed in stays
   signed in (long-lived cookie, or until the browser closes if "Remember me" was unticked). Five wrong PINs lock the account for 15 minutes.
   There is no email verification: the PIN is what stops one person opening another's tickets. An admin can clear a forgotten PIN. */

export const identity = new Hono<AppEnv>();
const limiter = new RateLimiter(20, 10 * 60_000);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const now = () => Math.floor(Date.now() / 1000);

/** Exactly 6 digits, and not something anyone would try first (000000, 123456, 654321, 121212...). */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || !/^\d{6}$/.test(pin)) return "Your PIN must be exactly 6 digits.";
  const d = [...pin].map(Number);
  const same = d.every((x) => x === d[0]);
  const step = d.every((x, i) => i === 0 || x - d[i - 1]! === 1) || d.every((x, i) => i === 0 || d[i - 1]! - x === 1);
  const pairs = /^(\d\d)\1\1$/.test(pin) || /^(\d\d\d)\1$/.test(pin) || /^(\d)\1(\d)\2(\d)\3$/.test(pin); // 121212, 123123, 112233
  if (same || step || pairs || ["123321", "159753", "147258", "258369", "696969", "520520", "100000", "111222"].includes(pin)) return "Choose a PIN that is harder to guess (not 123456, 000000 or a run of numbers).";
  return null;
}

interface Row { id: number; name: string; role: string; active: number; pin_hash: string | null; session_version: number; failed_attempts: number; locked_until: number }

identity.post("/identify", async (c) => {
  // Once Microsoft 365 sign-in is switched on for everyone, names and PINs are no longer a way in.
  if (ssoEnforced()) return c.json({ error: "sso_required" }, 403);
  if (!limiter.take(clientIp(c))) return c.json({ error: "Too many attempts. Please wait a few minutes and try again." }, 429);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  if (!name) return c.json({ error: "Please enter your name." }, 400);
  if (!EMAIL.test(email)) return c.json({ error: "Enter a valid email address." }, 400);
  if (config.companyDomain && email.split("@")[1] !== config.companyDomain)
    return c.json({ error: `Use your company email (@${config.companyDomain}).` }, 400);
  const remember = body.remember !== false;

  const existing = await db
    .prepare("SELECT id, name, role, active, pin_hash, session_version, failed_attempts, locked_until FROM users WHERE email = ?")
    .bind(email)
    .first<Row>();
  const who = (id: number | null) => ({ id, name, role: "requester" });

  if (existing && !existing.active) {
    await audit(c, "signin.blocked", "security", `Blocked sign-in for a disabled account (${email})`, { who: who(existing.id) });
    return c.json({ error: "This account has been disabled. Please contact IT." }, 403);
  }
  if (existing && existing.locked_until > now()) {
    await audit(c, "signin.locked", "security", `Sign-in refused: ${email} is locked after wrong PINs`, { who: who(existing.id) });
    return c.json({ error: `Too many wrong PINs. Try again in ${Math.ceil((existing.locked_until - now()) / 60)} minutes, or ask IT to reset it.`, locked_until: existing.locked_until }, 429);
  }

  let id: number;
  let version = 1;
  let created = false;
  if (existing?.pin_hash) {
    // A known account: this computer has to prove it is the owner.
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!pin) return c.json({ error: "pin_required", name: existing.name }, 401);
    if (pin.length > 20 || !(await verifyPassword(pin, existing.pin_hash))) {
      const fails = existing.failed_attempts + 1;
      if (fails >= MAX_FAILS) {
        await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?").bind(now() + LOCK_SECONDS, existing.id).run();
        await audit(c, "signin.locked", "security", `${email} locked for 15 minutes after ${MAX_FAILS} wrong PINs`, { who: who(existing.id) });
        return c.json({ error: "Too many wrong PINs. This account is locked for 15 minutes, or ask IT to reset it.", locked_until: now() + LOCK_SECONDS }, 429);
      }
      await db.prepare("UPDATE users SET failed_attempts = ? WHERE id = ?").bind(fails, existing.id).run();
      await audit(c, "signin.pin_failed", "security", `Wrong PIN for ${email} (${fails} of ${MAX_FAILS})`, { who: who(existing.id) });
      return c.json({ error: "That PIN isn't right.", attempts_left: MAX_FAILS - fails }, 401);
    }
    id = existing.id;
    version = existing.session_version;
    await db.prepare("UPDATE users SET failed_attempts = 0, locked_until = 0, name = CASE WHEN role = 'requester' THEN ? ELSE name END WHERE id = ?").bind(name, id).run();
  } else {
    // A new email, or an account that predates PINs: the person signing in now creates the PIN.
    const pin = body.new_pin;
    if (pin === undefined || pin === null || pin === "") return c.json({ error: "pin_setup", new: !existing }, 401);
    const problem = pinProblem(pin);
    if (problem) return c.json({ error: problem, field: "new_pin" }, 400);
    const hash = await hashPassword(pin as string);
    if (existing) {
      id = existing.id;
      version = existing.session_version;
      await db.prepare("UPDATE users SET pin_hash = ?, failed_attempts = 0, locked_until = 0, name = CASE WHEN role = 'requester' THEN ? ELSE name END WHERE id = ?").bind(hash, name, id).run();
    } else {
      const row = await db.prepare("INSERT INTO users (email, name, role, pin_hash, welcome_pending) VALUES (?, ?, 'requester', ?, 1) RETURNING id").bind(email, name, hash).first<{ id: number }>();
      id = row!.id;
      created = true;
    }
  }

  startUserSession(c, id, remember, version);
  await db.prepare("UPDATE users SET last_login_at = unixepoch() WHERE id = ?").bind(id).run();
  await audit(
    c,
    created ? "account.registered" : existing?.pin_hash ? "signin.user" : "account.pin_created",
    created || !existing?.pin_hash ? "account" : "signin",
    created ? `New account created: ${name} (${email}), PIN set` : existing?.pin_hash ? `Signed in with PIN (${email})${remember ? "" : ", not remembered"}` : `Created a PIN for ${email} and signed in`,
    { who: who(id) },
  );
  if (created) changed();
  return c.json({ ok: true, created }); // `created` starts the first-time setup in the browser
});

identity.post("/signout", async (c) => {
  const uid = userSessionId(c);
  if (uid) {
    const u = await db.prepare("SELECT name, email FROM users WHERE id = ?").bind(uid).first<{ name: string; email: string }>();
    if (u) await audit(c, "signout.user", "signin", `Signed out (${u.email})`, { who: { id: uid, name: u.name, role: "requester" } });
  }
  endUserSession(c);
  return c.json({ ok: true });
});

identity.get("/me", requesterAuth, async (c) => {
  const { id, name, email } = c.get("user");
  const p = await db.prepare("SELECT pin_hash IS NOT NULL AS has_pin, email_notify, ms_oid IS NOT NULL AS ms_linked, job_title, department FROM users WHERE id = ?").bind(id).first<{ has_pin: number; email_notify: number; ms_linked: number; job_title: string | null; department: string | null }>();
  return c.json({ id, name, email, has_pin: !!p?.has_pin, email_notify: p?.email_notify !== 0, ms_linked: !!p?.ms_linked, job_title: p?.job_title ?? null, department: p?.department ?? null });
});

// { email_notify: boolean }: whether ticket updates are emailed to this person.
identity.patch("/me/preferences", requesterAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.email_notify !== "boolean") return c.json({ error: "nothing to change" }, 400);
  await db.prepare("UPDATE users SET email_notify = ? WHERE id = ?").bind(body.email_notify ? 1 : 0, c.get("user").id).run();
  await audit(c, "account.email_notify", "account", body.email_notify ? "Switched ticket emails on" : "Switched ticket emails off");
  return c.json({ email_notify: body.email_notify });
});

/* ---- the signed-in person managing their own PIN ---- */

// Set or change the PIN. Every other computer is signed out; this one gets a fresh session straight away.
identity.post("/security/pin", requesterAuth, async (c) => {
  const me = c.get("user");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const row = await db.prepare("SELECT pin_hash, session_version, failed_attempts, locked_until FROM users WHERE id = ?").bind(me.id).first<{ pin_hash: string | null; session_version: number; failed_attempts: number; locked_until: number }>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.locked_until > now()) return c.json({ error: "Too many wrong PINs. Try again later." }, 429);
  if (row.pin_hash) {
    const cur = typeof body.current === "string" ? body.current : "";
    if (!cur || cur.length > 20 || !(await verifyPassword(cur, row.pin_hash))) {
      const fails = row.failed_attempts + 1;
      await db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").bind(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? now() + LOCK_SECONDS : 0, me.id).run();
      await audit(c, "signin.pin_failed", "security", "Wrong current PIN while trying to change it");
      return c.json({ error: "Your current PIN isn't right.", attempts_left: Math.max(0, MAX_FAILS - fails) }, 401);
    }
  }
  const problem = pinProblem(body.next);
  if (problem) return c.json({ error: problem }, 400);
  const version = row.session_version + 1;
  await db.prepare("UPDATE users SET pin_hash = ?, session_version = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?").bind(await hashPassword(body.next as string), version, me.id).run();
  startUserSession(c, me.id, true, version);
  await audit(c, row.pin_hash ? "account.pin_changed" : "account.pin_created", "account", row.pin_hash ? "Changed their PIN (other computers signed out)" : "Created a PIN");
  return c.json({ ok: true });
});

// Lost a laptop, or used a shared PC: end every session of this person except the one asking.
identity.post("/security/signout-everywhere", requesterAuth, async (c) => {
  const me = c.get("user");
  const row = await db.prepare("SELECT session_version FROM users WHERE id = ?").bind(me.id).first<{ session_version: number }>();
  const version = (row?.session_version ?? 1) + 1;
  await db.prepare("UPDATE users SET session_version = ? WHERE id = ?").bind(version, me.id).run();
  startUserSession(c, me.id, true, version);
  await audit(c, "signout.everywhere", "signin", "Signed out of every other computer");
  return c.json({ ok: true });
});
