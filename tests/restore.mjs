// Unit tests for restoring a backup (src/server/restore.ts): the safety checks on a candidate database, and the swap at start-up.
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = mkdtempSync(path.join(os.tmpdir(), "fg-restore-"));
const out = path.join(tmp, "restore.mjs");
await build({ entryPoints: ["src/server/restore.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
const R = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name} ${cond ? "" : extra}`); };

/** Opens, counts, closes (an open handle would lock the file on Windows, which a real shutdown never leaves). */
const count = (file) => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare("SELECT COUNT(*) n FROM tickets").get().n; } finally { d.close(); } };

/** A tiny database shaped like the helpdesk's (the tables the check looks for). */
function makeDb(file, { version = 13, admins = 1, tickets = 3, tag = "x" } = {}) {
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, active INTEGER); CREATE TABLE tickets (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE comments (id INTEGER PRIMARY KEY); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);");
  for (let i = 0; i < admins; i++) d.prepare("INSERT INTO users (role, active) VALUES ('admin', 1)").run();
  d.prepare("INSERT INTO users (role, active) VALUES ('requester', 1)").run();
  for (let i = 0; i < tickets; i++) d.prepare("INSERT INTO tickets (title) VALUES (?)").run(tag + i);
  d.prepare("INSERT INTO comments DEFAULT VALUES").run();
  d.exec(`PRAGMA user_version = ${version}`);
  d.close();
}

// ---- inspecting a candidate ----
const good = path.join(tmp, "good.db"); makeDb(good, { tickets: 5 });
let r = R.inspectDb(good, 13);
ok("a real helpdesk database is accepted, with its counts", r.ok && r.tickets === 5 && r.users === 2 && r.admins === 1 && r.comments === 1 && r.version === 13, JSON.stringify(r));
const older = path.join(tmp, "older.db"); makeDb(older, { version: 9 });
ok("an older version is accepted (the helpdesk upgrades it as it starts)", R.inspectDb(older, 13).ok === true);
const newer = path.join(tmp, "newer.db"); makeDb(newer, { version: 99 });
r = R.inspectDb(newer, 13);
ok("a backup from a NEWER version is refused, with the reason", !r.ok && /newer version/.test(r.error), JSON.stringify(r));
const noAdmin = path.join(tmp, "noadmin.db"); makeDb(noAdmin, { admins: 0 });
r = R.inspectDb(noAdmin, 13);
ok("a backup with no active admin is refused (nobody could sign in)", !r.ok && /no active admin/.test(r.error), JSON.stringify(r));
const text = path.join(tmp, "text.db"); writeFileSync(text, "this is just a text file, not a database at all");
ok("a file that is not a database is refused", !R.inspectDb(text, 13).ok && /not a database/.test(R.inspectDb(text, 13).error));
const other = path.join(tmp, "other.db"); { const d = new DatabaseSync(other); d.exec("CREATE TABLE cats (id INTEGER); PRAGMA user_version = 3"); d.close(); }
ok("some other SQLite database is refused", !R.inspectDb(other, 13).ok && /not a helpdesk one/.test(R.inspectDb(other, 13).error));
const cut = path.join(tmp, "cut.db"); writeFileSync(cut, readFileSync(good).subarray(0, 4096 + 100));
ok("a database that was cut short is refused or fails its check", !R.inspectDb(cut, 13).ok);
ok("a missing file is refused, not a crash", !R.inspectDb(path.join(tmp, "nope.db"), 13).ok);

// ---- unpacking ----
const data = path.join(tmp, "data"); mkdirSync(data, { recursive: true });
const gz = path.join(tmp, "backup.db.gz"); writeFileSync(gz, gzipSync(readFileSync(good)));
const staged = await R.stage(data, gz);
ok("a .db.gz is unpacked into the staging folder and is then the same database", existsSync(staged) && R.inspectDb(staged, 13).ok && R.inspectDb(staged, 13).tickets === 5);
const staged2 = await R.stage(data, good);
ok("a plain .db is accepted too", R.inspectDb(staged2, 13).ok);
const badgz = path.join(tmp, "bad.gz"); writeFileSync(badgz, Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("this is not really gzip data")]));
let threw = false; try { await R.stage(data, badgz); } catch { threw = true; }
ok("a broken .gz is refused with a plain message and leaves nothing behind", threw && readdirSync(path.join(data, "restore-staging")).length === 2);

// ---- the swap at start-up ----
const live = path.join(data, "helpdesk.db"); makeDb(live, { tickets: 9, tag: "live" });
writeFileSync(live + "-wal", "stale"); writeFileSync(live + "-shm", "stale");
const mirror = path.join(tmp, "mirror"); mkdirSync(mirror); writeFileSync(path.join(mirror, "newfile"), "from backup"); writeFileSync(path.join(mirror, "samefile"), "backup copy");
const uploads = path.join(data, "uploads"); mkdirSync(uploads); writeFileSync(path.join(uploads, "samefile"), "live copy");
R.writePending(data, staged, { from: "helpdesk-20261125-0200.db.gz", by: "Admin", at: 1, safety: "helpdesk-20261126-0900.db.gz", uploadsFrom: mirror });
ok("a pending restore is waiting, and nothing has changed yet", existsSync(path.join(data, "helpdesk.db.pending")) && count(live) === 9);
const logs = [];
ok("at start-up the restore is applied", R.applyPendingRestore(data, (m) => logs.push(m)) === true, logs.join("|"));
ok("the live database is now the backup's", count(live) === 5);
const kept = readdirSync(data).filter((f) => f.startsWith("helpdesk.db.before-restore-"));
ok("the database it replaced is kept aside, complete", kept.length === 1 && count(path.join(data, kept[0])) === 9);
ok("old write-ahead files are gone, so they cannot corrupt the restored one", !existsSync(live + "-wal") && !existsSync(live + "-shm"));
ok("uploaded files the backup has and the folder lacks come back; existing ones are never overwritten", readFileSync(path.join(uploads, "newfile"), "utf8") === "from backup" && readFileSync(path.join(uploads, "samefile"), "utf8") === "live copy");
ok("a note is left for the helpdesk to log it, and the pending files are gone", existsSync(path.join(data, "restore-note.json")) && JSON.parse(readFileSync(path.join(data, "restore-note.json"), "utf8")).by === "Admin" && !existsSync(path.join(data, "helpdesk.db.pending")) && !existsSync(path.join(data, "restore-pending.json")));
ok("applying again does nothing", R.applyPendingRestore(data, () => {}) === false);

// only the last three "before restore" copies are kept
for (let i = 0; i < 4; i++) {
  const p = path.join(tmp, "p" + i + ".db"); makeDb(p, { tickets: 1 });
  R.writePending(data, p, { from: "x", by: "y", at: 1, safety: null, uploadsFrom: null });
  await new Promise((res) => setTimeout(res, 1100)); // the copies are named by the second
  R.applyPendingRestore(data, () => {});
}
ok("only the three newest 'before restore' copies are kept", readdirSync(data).filter((f) => f.startsWith("helpdesk.db.before-restore-")).length === 3);

// a restore that cannot be applied leaves the current database alone
const bad = path.join(tmp, "data2"); mkdirSync(bad); const live2 = path.join(bad, "helpdesk.db"); makeDb(live2, { tickets: 4 });
mkdirSync(path.join(bad, "helpdesk.db.pending")); // a folder where the file should be: the swap cannot work
const l2 = [];
ok("a restore that cannot be applied is abandoned, not half done", R.applyPendingRestore(bad, (m) => l2.push(m)) === false);
ok("…and the current database is untouched", count(live2) === 4, l2.join("|"));

// staging leftovers
const old = path.join(data, "restore-staging", "old.db"); writeFileSync(old, "x");
const longAgo = new Date(Date.now() - 5 * 3600_000); (await import("node:fs")).utimesSync(old, longAgo, longAgo);
R.cleanStaging(data);
ok("staging leftovers older than two hours are cleaned up", !existsSync(old));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
