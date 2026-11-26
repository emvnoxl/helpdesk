import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/* Restoring a backup, made safe and simple.

   A running process cannot swap its own database file, so a restore is two steps:
     1. In the app (backup.ts): the chosen backup is unpacked and CHECKED (a real helpdesk database, not damaged, not from a newer
        version, with an admin who can sign in), a fresh safety backup of the current state is taken, the checked copy is put down as
        "helpdesk.db.pending", and the helpdesk restarts itself (the usual "being updated" screen shows and the page comes back by itself).
     2. At the next start, before the database is opened (applyPendingRestore, called from db.ts): the current database is kept aside as
        "helpdesk.db.before-restore-<time>", the pending one takes its place, and uploaded files that the backup has and the folder
        lacks are copied back. Nothing is ever deleted by a restore.
   If anything goes wrong in step 2 the current database is left alone and the pending file is renamed ".failed". */

export type Inspection =
  | { ok: true; users: number; admins: number; tickets: number; comments: number; version: number; bytes: number }
  | { ok: false; error: string };

/** Opens a candidate database read-only and decides whether it may replace the live one. */
export function inspectDb(file: string, maxVersion: number): Inspection {
  let d: DatabaseSync | null = null;
  try {
    const bytes = statSync(file).size;
    const head = readFileSync(file).subarray(0, 16).toString("latin1");
    if (!head.startsWith("SQLite format 3")) return { ok: false, error: "That is not a helpdesk backup (it is not a database file)." };
    d = new DatabaseSync(file, { readOnly: true });
    const check = d.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== "ok") return { ok: false, error: "That backup is damaged (the database check failed), so it was not used." };
    const version = (d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > maxVersion) return { ok: false, error: "That backup was made by a newer version of the helpdesk than this one. Update first, then restore it." };
    const have = (d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users','tickets','comments','settings')").get() as { n: number }).n;
    if (version < 1 || have < 4) return { ok: false, error: "That file is a database, but not a helpdesk one." };
    const n = (sql: string) => (d!.prepare(sql).get() as { n: number }).n;
    const admins = n("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1");
    if (!admins) return { ok: false, error: "That backup has no active admin account, so nobody could sign in after restoring it." };
    return { ok: true, users: n("SELECT COUNT(*) AS n FROM users"), admins, tickets: n("SELECT COUNT(*) AS n FROM tickets"), comments: n("SELECT COUNT(*) AS n FROM comments"), version, bytes };
  } catch (e) {
    return { ok: false, error: "That file could not be read as a helpdesk backup: " + String((e as Error).message).slice(0, 120) };
  } finally {
    try { d?.close(); } catch { /* already closed */ }
  }
}

export const stagingDir = (dataDir: string) => path.join(dataDir, "restore-staging");

const MAX_UNPACKED = 2 * 1024 * 1024 * 1024; // a helpdesk database is megabytes; this only stops a "zip bomb"

/** Unpacks a .gz (or copies a plain database) into the staging folder and returns where it is. */
export async function stage(dataDir: string, src: string): Promise<string> {
  const dir = stagingDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, randomBytes(12).toString("hex") + ".db");
  const magic = readFileSync(src).subarray(0, 2);
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    let n = 0;
    const cap = new Transform({ transform(chunk, _e, cb) { n += chunk.length; cb(n > MAX_UNPACKED ? new Error("too big") : null, chunk); } });
    try { await pipeline(createReadStream(src), createGunzip(), cap, createWriteStream(out)); } catch (e) { rmSync(out, { force: true }); throw new Error("That file could not be unpacked (is it a .db.gz backup?)"); }
  } else {
    copyFileSync(src, out);
  }
  return out;
}

/** Staging leftovers (a restore that was started and never finished) are removed after two hours. */
export function cleanStaging(dataDir: string, maxAgeMs = 2 * 3600_000) {
  const dir = stagingDir(dataDir);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { force: true }); } catch { /* gone already */ }
  }
}

export interface PendingMeta { from: string; by: string; at: number; safety: string | null; uploadsFrom: string | null }
const pendingFile = (dataDir: string) => path.join(dataDir, "helpdesk.db.pending");
const metaFile = (dataDir: string) => path.join(dataDir, "restore-pending.json");
export const noteFile = (dataDir: string) => path.join(dataDir, "restore-note.json");

/** Step 1 (in the running app): put the checked copy down for the next start. */
export function writePending(dataDir: string, checked: string, meta: PendingMeta) {
  renameSync(checked, pendingFile(dataDir));
  writeFileSync(metaFile(dataDir), JSON.stringify(meta));
}

/** Step 2 (at start-up, before the database is opened). Returns true when a restore was applied. */
export function applyPendingRestore(dataDir: string, log: (m: string) => void = (m) => console.log(m)): boolean {
  cleanStaging(dataDir);
  const pending = pendingFile(dataDir);
  if (!existsSync(pending)) return false;
  const live = path.join(dataDir, "helpdesk.db");
  let keptAs: string | null = null;
  try {
    if (!statSync(pending).isFile()) throw new Error("the pending restore is not a file");
    let meta: PendingMeta = { from: "a backup", by: "an admin", at: Math.floor(Date.now() / 1000), safety: null, uploadsFrom: null };
    try { meta = { ...meta, ...JSON.parse(readFileSync(metaFile(dataDir), "utf8")) }; } catch { /* no details: still restore */ }
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    if (existsSync(live)) {
      keptAs = `helpdesk.db.before-restore-${stamp}`;
      renameSync(live, path.join(dataDir, keptAs));
    }
    rmSync(live + "-wal", { force: true });
    rmSync(live + "-shm", { force: true });
    renameSync(pending, live);
    // Files the restored tickets point at: copy back any that the uploads folder lacks (never overwrite, never delete).
    let files = 0;
    if (meta.uploadsFrom && existsSync(meta.uploadsFrom)) {
      const dest = path.join(dataDir, "uploads");
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(meta.uploadsFrom)) {
        try { copyFileSync(path.join(meta.uploadsFrom, f), path.join(dest, f), constants.COPYFILE_EXCL); files++; } catch (e: any) { if (e?.code !== "EEXIST") throw e; }
      }
    }
    // Keep the last three "before restore" copies; older ones go.
    const kept = readdirSync(dataDir).filter((f) => f.startsWith("helpdesk.db.before-restore-")).sort().reverse();
    for (const old of kept.slice(3)) rmSync(path.join(dataDir, old), { force: true });
    writeFileSync(noteFile(dataDir), JSON.stringify({ ...meta, kept_as: keptAs, files }));
    rmSync(metaFile(dataDir), { force: true });
    log(`[restore] restored from ${meta.from}; the previous database is kept as ${keptAs ?? "(there was none)"}`);
    return true;
  } catch (e) {
    // Put things back exactly as they were: if the current database was already moved aside, move it home again.
    try { if (keptAs && !existsSync(live) && existsSync(path.join(dataDir, keptAs))) renameSync(path.join(dataDir, keptAs), live); } catch { /* nothing more to do */ }
    log(`[restore] could not restore (${(e as Error).message}); the current database was left as it is`);
    try { renameSync(pending, pending + ".failed"); } catch { /* ignore */ }
    return false;
  }
}
