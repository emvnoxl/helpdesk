import { Hono } from "hono";
import { statfs } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { type AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { broadcast, changed, setHello } from "./bus";
import { config } from "./config";
import { db } from "./db";
import { mailInfo, sendTest } from "./notifier";
import { settingsRoutes } from "./settings";
import { getSetting, putSetting } from "./sla";
import { BUILD, STARTED_AT } from "./version";

/* Updates, as people see them.
   - Every screen learns which version the server runs (in /api/config and in the first message of the live stream). A tab that was
     loaded before an update shows "A new version is ready".
   - An admin can announce a planned update ("in 10 minutes"): every open screen shows a banner until the restart.
   - When the container is stopped (docker compose up -d --build sends SIGTERM) the server says so first, and every open screen shows
     "being updated" and reloads itself when the new version answers.
   - On start-up, if the version differs from the last one that ran, every admin gets a bell notification and the activity log a line. */

interface Maintenance { at: number; message: string }
let maintenance: Maintenance | null = null;
let restarting = false;

const ANNOUNCE_GRACE_MS = 30 * 60_000; // an announcement that is this long overdue stops being shown

export function snapshot() {
  const m = maintenance && Date.now() < maintenance.at + ANNOUNCE_GRACE_MS ? maintenance : null;
  return { version: BUILD.id, restarting, maintenance: m };
}
setHello(() => JSON.stringify(snapshot()));
const push = () => broadcast("system", JSON.stringify(snapshot()));

/** Called from the shutdown handler: tell every open screen before the connections close. */
export function announceRestart() {
  restarting = true;
  push();
}

/** Start-up: did the version change since the last run? Then tell the admins. */
export async function checkForUpdate() {
  const prev = await getSetting("app_version");
  if (prev === BUILD.id) return;
  await putSetting("app_version", BUILD.id);
  if (!prev) return; // first ever start: nothing was updated
  const info = { from: prev, to: BUILD.id, note: BUILD.note, builtAt: BUILD.builtAt, at: Math.floor(Date.now() / 1000) };
  await putSetting("last_update", JSON.stringify(info));
  await db
    .prepare(
      `INSERT INTO notifications (user_id, ticket_id, kind, title, body, created_at)
       SELECT id, NULL, 'update', 'Helpdesk updated', ?, unixepoch() FROM users WHERE role = 'admin' AND active = 1`,
    )
    .bind(`Now running ${BUILD.id}${BUILD.note ? ": " + BUILD.note : ""}`.slice(0, 140))
    .run();
  await audit(null, "system.update", "admin", `Helpdesk updated from ${prev} to ${BUILD.id}${BUILD.note ? " (" + BUILD.note + ")" : ""}`, { who: SYSTEM });
  changed();
}

const dirBytes = (dir: string): number => {
  // The uploads folder is flat (random names), so one level is enough.
  try {
    return readdirSync(dir).reduce((n, f) => n + (statSync(path.join(dir, f), { throwIfNoEntry: false })?.size ?? 0), 0);
  } catch { return 0; }
};

export const system = new Hono<AppEnv>();
system.route("/settings", settingsRoutes); // the address and email setup, editable here

system.get("/", async (c) => {
  const file = path.join(config.dataDir, "helpdesk.db");
  const size = (f: string) => statSync(f, { throwIfNoEntry: false })?.size ?? 0;
  let disk: { free: number; total: number } | null = null;
  try { const s = await statfs(config.dataDir); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { /* not supported here */ }
  let last: unknown = null;
  try { last = JSON.parse((await getSetting("last_update")) ?? "null"); } catch { last = null; }
  return c.json({
    version: BUILD.id,
    built_at: BUILD.builtAt,
    note: BUILD.note,
    started_at: Math.floor(STARTED_AT / 1000),
    node: process.version,
    db_bytes: size(file) + size(file + "-wal"),
    uploads_bytes: dirBytes(path.join(config.dataDir, "uploads")),
    disk,
    last_update: last,
    maintenance: snapshot().maintenance,
    app_url: config.appUrl || null,
    mail: config.mail.logOnly ? "log" : config.mail.graph.clientId ? "graph" : config.mail.smtp.host ? "smtp" : "off",
    mail_status: await mailInfo(),
    admin_email: c.get("user").email,
  });
});

// { to? }: sends a test email through the real transport (default: to the admin's own address). The error, if any, is returned as it is.
system.post("/test-email", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const to = typeof body.to === "string" && body.to.trim() ? body.to.trim().toLowerCase() : c.get("user").email;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 200) return c.json({ error: "That does not look like an email address." }, 400);
  try {
    const via = await sendTest(to);
    await audit(c, "system.test_email", "admin", `Sent a test email to ${to} (${via})`);
    return c.json({ ok: true, via, to });
  } catch (e) {
    await audit(c, "system.test_email_failed", "admin", `Test email to ${to} failed: ${(e as Error).message}`);
    return c.json({ error: (e as Error).message }, 502);
  }
});

// { minutes: 1..240, message? }: banner on every open screen.
system.post("/maintenance", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) return c.json({ error: "Choose between 1 and 240 minutes." }, 400);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 160) : "";
  maintenance = { at: Date.now() + Math.round(minutes) * 60_000, message };
  push();
  await audit(c, "system.announce", "admin", `Announced a helpdesk update in ${Math.round(minutes)} minutes${message ? `: ${message}` : ""}`);
  return c.json({ maintenance: snapshot().maintenance });
});

system.delete("/maintenance", async (c) => {
  if (maintenance) await audit(c, "system.announce_cancelled", "admin", "Cancelled the announced update");
  maintenance = null;
  push();
  return c.json({ maintenance: null });
});
