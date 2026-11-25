// The updater helper (updater/server.mjs) against real git repositories; docker is skipped (UPDATER_DRY=1) because it cannot run here.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name} ${cond ? "" : extra}`); };

const root = mkdtempSync(path.join(tmpdir(), "fg-updater-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();
const bare = path.join(root, "origin.git"), A = path.join(root, "server"), B = path.join(root, "dev");
git(root, "init", "-q", "--bare", "-b", "main", bare);
git(root, "clone", "-q", bare, A);
git(A, "checkout", "-q", "-b", "main");
writeFileSync(path.join(A, "a.txt"), "1"); git(A, "add", "."); git(A, "commit", "-q", "-m", "first"); git(A, "push", "-q", "-u", "origin", "main");
git(root, "clone", "-q", bare, B);

const SECRET = "test-updater-secret-123456", PORT = 18000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["updater/server.mjs"], { env: { ...env, UPDATER_SECRET: SECRET, PROJECT_DIR: A, UPDATER_DRY: "1", PORT: String(PORT) } });
let slog = ""; child.stdout.on("data", (b) => (slog += b)); child.stderr.on("data", (b) => (slog += b));
const call = async (method, p, body, secret = SECRET) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: "Bearer " + secret, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, json: await r.json().catch(() => null) };
};
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/status`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
const finished = async () => { for (let i = 0; i < 100; i++) { const s = (await call("GET", "/status")).json; if (s.state !== "running") return s; await new Promise((r) => setTimeout(r, 100)); } return null; };

ok("no password: refused", (await call("GET", "/status", undefined, "wrong")).code === 401 && (await call("POST", "/update", {}, "")).code === 401);
ok("starts idle", (await call("GET", "/status")).json.state === "idle");

// A new commit on the "server" branch
writeFileSync(path.join(B, "b.txt"), "2"); git(B, "add", "."); git(B, "commit", "-q", "-m", "second thing"); git(B, "push", "-q", "origin", "main");
const want = git(B, "rev-parse", "--short=7", "HEAD");

const TOKEN = "ghp_secret_token_value";
let r = await call("POST", "/update", { branch: "main; rm -rf /", token: TOKEN });
ok("an update starts (a bad branch name falls back to main)", r.code === 202);
let s = await finished();
ok("it pulls the new commit", s?.state === "done" && s.to === want && git(A, "rev-parse", "--short=7", "HEAD") === want, JSON.stringify(s));
const log = s?.log.join("\n") ?? "";
ok("it builds first, then swaps only the helpdesk service, in that order", log.indexOf("docker compose build helpdesk") > -1 && log.indexOf("docker compose up -d --no-deps helpdesk") > log.indexOf("docker compose build helpdesk"), log);
ok("it keeps the old image as :previous before building", log.indexOf("docker tag fortress-helpdesk:latest fortress-helpdesk:previous") > -1 && log.indexOf("docker tag") < log.indexOf("compose build"));
ok("the token is never in the log or the status", !JSON.stringify(s).includes(TOKEN) && !slog.includes(TOKEN));
ok("the step list says what it did", s?.from && s.from !== s.to && s.finished_at > 0);

// A change to the updater itself is flagged
writeFileSync(path.join(B, "docker-compose.yml"), "x: 1\n"); git(B, "add", "."); git(B, "commit", "-q", "-m", "compose change"); git(B, "push", "-q", "origin", "main");
await call("POST", "/update", {}); s = await finished();
ok("a change to docker-compose.yml asks for one manual ./update.sh", s?.state === "done" && /update\.sh/.test(s.note), JSON.stringify(s));

// Local work on the server that cannot fast-forward: stop before touching Docker
writeFileSync(path.join(A, "local.txt"), "x"); git(A, "add", "."); git(A, "commit", "-q", "-m", "local only");
writeFileSync(path.join(B, "c.txt"), "3"); git(B, "add", "."); git(B, "commit", "-q", "-m", "third"); git(B, "push", "-q", "origin", "main");
await call("POST", "/update", {}); s = await finished();
ok("when git cannot fast-forward it fails with a plain reason and never reaches Docker", s?.state === "failed" && /git pull/.test(s.error) && !s.log.join("\n").includes("compose build"), JSON.stringify(s));
await call("POST", "/update", {}); s = await finished();
ok("it can be tried again after a failure", s?.state === "failed");

child.kill();
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
