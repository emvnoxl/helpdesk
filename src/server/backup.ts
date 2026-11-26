import { Hono } from "hono";
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import path from "node:path";
import { type AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { changed } from "./bus";
import { config } from "./config";
import { db, SCHEMA_VERSION } from "./db";
import { bodyLimit } from "hono/body-limit";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { cleanStaging, inspectDb, stage, stagingDir, writePending } from "./restore";
import { getSetting, putSetting } from "./sla";

/* Backups. Every night (BACKUP_HOUR, UTC = Ghana time) the database is copied with SQLite's VACUUM INTO (a consistent copy while the app
   runs), compressed, and the newest BACKUP_KEEP are kept. The uploads folder is mirrored next to them (files never change once written,
   so only new ones are copied). Everything goes to BACKUP_DIR: by default a folder inside the data volume, which protects against a bad
   update or a deleted ticket but NOT against losing the disk, so point BACKUP_DIR at another disk or a NAS share, or download copies
   from Admin > System. Restoring is done from the same page (Restore next to a backup, or from a file): see restore.ts. */

const NAME = /^helpdesk-\d{8}-\d{4}(-\d+)?\.db\.gz$/; // the optional -2, -3 is for several in the same minute: a backup is never overwritten
const UPLOADS = path.join(config.dataDir, "uploads");

export interface BackupStatus { at: number; ok: boolean; file?: string; bytes?: number; seconds?: number; error?: string }

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
const day = (d = new Date()) => d.toISOString().slice(0, 10);

async function readStatus(): Promise<{ last: BackupStatus | null; lastOk: BackupStatus | null }> {
  const parse = (v: string | null) => { try { return v ? (JSON.parse(v) as BackupStatus) : null; } catch { return null; } };
  return { last: parse(await getSetting("backup_last")), lastOk: parse(await getSetting("backup_last_ok")) };
}

export function listBackups() {
  try {
    return readdirSync(config.backup.dir)
      .filter((f) => NAME.test(f))
      .map((name) => { const st = statSync(path.join(config.backup.dir, name)); return { name, bytes: st.size, at: Math.floor(st.mtimeMs / 1000) }; })
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name)); // newest first (by when it was written: same-minute names carry a suffix)
  } catch { return []; }
}

let running = false;

/** Takes one backup now. Never throws: the result says what happened. */
export async function runBackup(trigger: "schedule" | "manual", who: { id: number | null; name: string; role: string } = SYSTEM): Promise<BackupStatus> {
  if (running) return { at: Math.floor(Date.now() / 1000), ok: false, error: "A backup is already running." };
  running = true;
  const t0 = Date.now();
  const dir = config.backup.dir;
  let status: BackupStatus;
  try {
    mkdirSync(dir, { recursive: true });
    let base = `helpdesk-${stamp()}`;
    for (let n = 2; existsSync(path.join(dir, base + ".db.gz")); n++) base = `helpdesk-${stamp()}-${n}`;
    const tmp = path.join(dir, base + ".tmp.db");
    const out = path.join(dir, base + ".db.gz");
    rmSync(tmp, { force: true });
    db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(out));
    rmSync(tmp, { force: true });
    mirrorUploads(path.join(dir, "uploads"));
    // Keep the newest N.
    for (const old of listBackups().slice(config.backup.keep)) rmSync(path.join(dir, old.name), { force: true });
    status = { at: Math.floor(Date.now() / 1000), ok: true, file: path.basename(out), bytes: statSync(out).size, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    await putSetting("backup_last_ok", JSON.stringify(status));
    console.log(`[backup] ${trigger}: ${status.file} (${status.bytes} bytes)`);
  } catch (e) {
    status = { at: Math.floor(Date.now() / 1000), ok: false, error: (e as Error).message.slice(0, 200) };
    console.error("[backup] failed:", (e as Error).message);
  } finally {
    running = false;
  }
  await putSetting("backup_last", JSON.stringify(status));
  await audit(null, status.ok ? "backup.ok" : "backup.failed", "admin", status.ok ? `Backup ${status.file} (${trigger})` : `Backup failed: ${status.error}`, { who });
  changed();
  return status;
}

/** Copies new upload files across and removes files that were deleted from uploads, so the mirror matches. */
function mirrorUploads(dest: string) {
  if (!existsSync(UPLOADS)) return;
  mkdirSync(dest, { recursive: true });
  const src = new Set(readdirSync(UPLOADS));
  for (const f of src) {
    try { copyFileSync(path.join(UPLOADS, f), path.join(dest, f), constants.COPYFILE_EXCL); } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  }
  for (const f of readdirSync(dest)) if (!src.has(f)) rmSync(path.join(dest, f), { force: true });
}

/** Alert the admins (once a day) when the newest good backup is more than 36 hours old, or the last attempt failed. */
async function checkHealth() {
  const { last, lastOk } = await readStatus();
  const age = lastOk ? Date.now() / 1000 - lastOk.at : Infinity;
  const failing = !!last && !last.ok;
  if (age < 36 * 3600 && !failing) return;
  if ((await getSetting("backup_alerted")) === day()) return;
  await putSetting("backup_alerted", day());
  const why = failing ? `The last backup failed: ${last!.error ?? "unknown error"}` : lastOk ? "No backup for over a day and a half." : "There is no backup yet.";
  await db
    .prepare(`INSERT INTO notifications (user_id, ticket_id, kind, title, body, created_at) SELECT id, NULL, 'alert', 'Backup problem', ?, unixepoch() FROM users WHERE role = 'admin' AND active = 1`)
    .bind(why.slice(0, 140))
    .run();
  changed();
}

/** Checks every 5 minutes: due when it is past BACKUP_HOUR and none was taken today (UTC), or when none exists a minute after start-up. */
export function startBackups() {
  if (!config.backup.enabled) { console.log("[backup] automatic backups are off (BACKUP_ENABLED=0)"); return () => {}; }
  const started = Date.now();
  const tick = async () => {
    try {
      const { lastOk } = await readStatus();
      const doneToday = lastOk ? new Date(lastOk.at * 1000).toISOString().slice(0, 10) === day() : false;
      const due = !lastOk ? Date.now() - started > 60_000 : !doneToday && new Date().getUTCHours() >= config.backup.hour;
      if (due) await runBackup("schedule");
      else await checkHealth();
    } catch (e) { console.error("[backup] check failed:", (e as Error).message); }
  };
  const timer = setInterval(() => void tick(), 5 * 60_000);
  const first = setTimeout(() => void tick(), 65_000);
  timer.unref();
  first.unref();
  return () => { clearInterval(timer); clearTimeout(first); };
}

export const backups = new Hono<AppEnv>();

backups.get("/", async (c) => {
  const { last, lastOk } = await readStatus();
  const files = listBackups();
  const ageH = lastOk ? (Date.now() / 1000 - lastOk.at) / 3600 : null;
  return c.json({
    enabled: config.backup.enabled,
    dir: config.backup.dir,
    hour: config.backup.hour,
    keep: config.backup.keep,
    last,
    last_ok: lastOk,
    healthy: config.backup.enabled ? ageH !== null && ageH < 36 && !(last && !last.ok) : null,
    running,
    files,
    inside_data: config.backup.dir === config.dataDir || config.backup.dir.startsWith(config.dataDir + path.sep),
    uploads_mirrored: existsSync(path.join(config.backup.dir, "uploads")),
  });
});

backups.post("/run", async (c) => {
  const u = c.get("user");
  const r = await runBackup("manual", { id: u.id, name: u.name, role: u.role });
  return c.json(r, r.ok ? 200 : 500);
});

backups.get("/:name", async (c) => {
  const name = c.req.param("name");
  if (!NAME.test(name)) return c.json({ error: "not found" }, 404);
  const file = path.join(config.backup.dir, name);
  if (!existsSync(file)) return c.json({ error: "not found" }, 404);
  await audit(c, "backup.download", "admin", `Downloaded backup ${name}`);
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Content-Length": String(statSync(file).size),
    "Cache-Control": "no-store",
  });
});

/* ---- Restore (see restore.ts). Admin only, like everything here. ---- */
let restoring = false;
const UPLOAD_MAX = 512 * 1024 * 1024;

/** What is in a stored backup, for the "are you sure" screen. Nothing is changed. */
backups.get("/:name/inspect", async (c) => {
  const name = c.req.param("name");
  if (!NAME.test(name) || !existsSync(path.join(config.backup.dir, name))) return c.json({ error: "not found" }, 404);
  let staged = "";
  try {
    staged = await stage(config.dataDir, path.join(config.backup.dir, name));
    return c.json({ name, at: Math.floor(statSync(path.join(config.backup.dir, name)).mtimeMs / 1000), inspection: inspectDb(staged, SCHEMA_VERSION), now: await nowCounts() });
  } catch (e) {
    return c.json({ name, inspection: { ok: false, error: (e as Error).message } });
  } finally {
    if (staged) rmSync(staged, { force: true });
  }
});

async function nowCounts() {
  const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
  return { users: await n("SELECT COUNT(*) AS n FROM users"), tickets: await n("SELECT COUNT(*) AS n FROM tickets"), comments: await n("SELECT COUNT(*) AS n FROM comments") };
}

// A backup file from somewhere else (downloaded earlier, or from another machine): checked and kept aside until the admin confirms.
backups.post("/upload", bodyLimit({ maxSize: UPLOAD_MAX, onError: (c) => c.json({ error: "That file is too big to be a helpdesk backup." }, 413, { Connection: "close" }) }), async (c) => {
  cleanStaging(config.dataDir);
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!file || typeof file === "string" || file.size === 0) return c.json({ error: "Choose a backup file (.db.gz)." }, 400);
  mkdirSync(stagingDir(config.dataDir), { recursive: true });
  const raw = path.join(stagingDir(config.dataDir), randomBytes(12).toString("hex") + ".upload");
  let staged = "";
  try {
    await writeFile(raw, Buffer.from(await file.arrayBuffer()));
    staged = await stage(config.dataDir, raw);
    const inspection = inspectDb(staged, SCHEMA_VERSION);
    if (!inspection.ok) { rmSync(staged, { force: true }); return c.json({ error: inspection.error }, 422); }
    return c.json({ token: path.basename(staged, ".db"), name: file.name, inspection, now: await nowCounts() });
  } catch (e) {
    if (staged) rmSync(staged, { force: true });
    return c.json({ error: (e as Error).message }, 422);
  } finally {
    rmSync(raw, { force: true });
  }
});

// { from: "backup:<name>" | "upload:<token>", confirm: "RESTORE" }
backups.post("/restore", async (c) => {
  const who = c.get("user");
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (b.confirm !== "RESTORE") return c.json({ error: "Type RESTORE to confirm." }, 400);
  const from = typeof b.from === "string" ? b.from : "";
  if (restoring) return c.json({ error: "A restore is already under way." }, 409);
  let staged = "";
  let label = "";
  let uploadsFrom: string | null = null;
  if (from.startsWith("backup:")) {
    const name = from.slice(7);
    if (!NAME.test(name) || !existsSync(path.join(config.backup.dir, name))) return c.json({ error: "That backup is not there any more." }, 404);
    label = name;
    const mirror = path.join(config.backup.dir, "uploads");
    uploadsFrom = existsSync(mirror) ? mirror : null;
    try { staged = await stage(config.dataDir, path.join(config.backup.dir, name)); } catch (e) { return c.json({ error: (e as Error).message }, 422); }
  } else if (from.startsWith("upload:") && /^[a-f0-9]{24}$/.test(from.slice(7))) {
    staged = path.join(stagingDir(config.dataDir), from.slice(7) + ".db");
    if (!existsSync(staged)) return c.json({ error: "That uploaded file has expired. Upload it again." }, 404);
    label = "an uploaded file";
  } else {
    return c.json({ error: "Choose a backup to restore." }, 400);
  }
  const insp = inspectDb(staged, SCHEMA_VERSION);
  if (!insp.ok) { rmSync(staged, { force: true }); return c.json({ error: insp.error }, 422); }
  restoring = true;
  // Always keep today's state first, so a restore can itself be undone from this same list.
  const safety = await runBackup("manual", { id: who.id, name: who.name, role: who.role });
  if (!safety.ok) { restoring = false; rmSync(staged, { force: true }); return c.json({ error: `Nothing was changed: the safety backup of the current state failed (${safety.error}).` }, 500); }
  writePending(config.dataDir, staged, { from: label, by: who.name, at: Math.floor(Date.now() / 1000), safety: safety.file ?? null, uploadsFrom });
  await audit(c, "system.restore_requested", "admin", `Restore from ${label} requested (safety backup ${safety.file}); the helpdesk is restarting`);
  // Answer first, then restart through the normal shutdown path (open screens say "being updated" and come back by themselves).
  setTimeout(() => process.emit("SIGTERM" as any), 400);
  return c.json({ ok: true, safety: safety.file, restarting: true });
});

/** After a restore: say so in the activity log and tell the admins (the restored database has no memory of it). */
export async function finishRestore() {
  const note = path.join(config.dataDir, "restore-note.json");
  if (!existsSync(note)) return;
  try {
    const m = JSON.parse(readFileSync(note, "utf8")) as { from: string; by: string; kept_as: string | null; safety: string | null; files: number };
    await audit(null, "system.restore", "admin", `Restored the helpdesk from ${m.from} (asked for by ${m.by}). The database before it is kept as ${m.kept_as ?? "n/a"}${m.safety ? `; a backup of it is also in the list as ${m.safety}` : ""}`, { who: SYSTEM });
    await db
      .prepare("INSERT INTO notifications (user_id, ticket_id, kind, title, body, created_at) SELECT id, NULL, 'alert', 'Restored from a backup', ?, unixepoch() FROM users WHERE role = 'admin' AND active = 1")
      .bind(`From ${m.from}, asked for by ${m.by}.`.slice(0, 140))
      .run();
    await putSetting("last_restore", JSON.stringify({ ...m, at: Math.floor(Date.now() / 1000) }));
  } catch (e) {
    console.error("[restore] could not write the note:", (e as Error).message);
  } finally {
    rmSync(note, { force: true });
  }
}
