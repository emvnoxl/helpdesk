import { Hono } from "hono";
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import path from "node:path";
import { type AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { changed } from "./bus";
import { config } from "./config";
import { db } from "./db";
import { getSetting, putSetting } from "./sla";

/* Backups. Every night (BACKUP_HOUR, UTC = Ghana time) the database is copied with SQLite's VACUUM INTO (a consistent copy while the app
   runs), compressed, and the newest BACKUP_KEEP are kept. The uploads folder is mirrored next to them (files never change once written,
   so only new ones are copied). Everything goes to BACKUP_DIR: by default a folder inside the data volume, which protects against a bad
   update or a deleted ticket but NOT against losing the disk, so point BACKUP_DIR at another disk or a NAS share, or download copies
   from Admin > System. Restoring is deliberate and manual: see the README. */

const NAME = /^helpdesk-\d{8}-\d{4}\.db\.gz$/;
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
      .sort((a, b) => b.name.localeCompare(a.name));
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
    const base = `helpdesk-${stamp()}`;
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
