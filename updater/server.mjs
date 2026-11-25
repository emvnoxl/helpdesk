// The updater: a tiny helper that installs a new version when an admin presses "Update now" on Admin > System > Updates.
// It is the ONLY thing with access to Docker, so the helpdesk itself never has it. It is not published on any port: only
// containers on the same compose network (the helpdesk) can reach it, and every request needs the shared UPDATER_SECRET.
//
// It does exactly four things, in this order, and never anything else:
//   1. git pull --ff-only          (in the mounted project folder)
//   2. tag the running image as :previous (so a bad update can be rolled back)
//   3. docker compose build helpdesk   (the old version keeps serving while this runs)
//   4. docker compose up -d --no-deps helpdesk   (the swap: people see "being updated" for a few seconds)
// It never touches the data volume, the other services, or itself.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";

const SECRET = process.env.UPDATER_SECRET || "";
const DIR = process.env.PROJECT_DIR || "/project";
const SERVICE = process.env.UPDATER_SERVICE || "helpdesk";
const IMAGE = process.env.UPDATER_IMAGE || "fortress-helpdesk";
const PORT = Number(process.env.PORT || 8080);
const DRY = process.env.UPDATER_DRY === "1"; // tests: do not run docker
const BRANCH = /^[A-Za-z0-9_./-]{1,100}$/;

if (SECRET.length < 16) {
  console.error("[updater] UPDATER_SECRET must be at least 16 characters (set it in .env). Not starting.");
  process.exit(1);
}

const job = { state: "idle", step: "", started_at: null, finished_at: null, from: null, to: null, note: "", error: null, log: [] };
let token = "";
const say = (line) => {
  let l = String(line).replace(/\r/g, "");
  if (token) l = l.split(token).join("***");
  for (const part of l.split("\n")) if (part.trim()) job.log.push(part.slice(0, 300));
  if (job.log.length > 80) job.log.splice(0, job.log.length - 80);
};

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    if (DRY && cmd === "docker") { say(`[dry run] docker ${args.join(" ")}`); return resolve({ code: 0, out: "" }); }
    say(`$ ${cmd} ${args.filter((a) => !a.startsWith("http.extraHeader")).join(" ")}`);
    let out = "";
    const p = spawn(cmd, args, { cwd: DIR, env: { ...process.env, ...env } });
    const take = (b) => { out += b; say(b); };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", (e) => { say(String(e.message)); resolve({ code: 127, out }); });
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}
const git = (args, env) => run("git", ["-c", `safe.directory=${DIR}`, ...args], env);
const text = async (args) => (await run("git", ["-c", `safe.directory=${DIR}`, ...args])).out.trim();

async function projectName() {
  if (process.env.COMPOSE_PROJECT_NAME) return process.env.COMPOSE_PROJECT_NAME;
  if (DRY) return "";
  const r = await run("docker", ["inspect", "--format", '{{ index .Config.Labels "com.docker.compose.project" }}', process.env.HOSTNAME || ""]);
  return r.code === 0 ? r.out.trim() : "";
}

async function update(branch) {
  Object.assign(job, { state: "running", step: "Getting the new code", started_at: Date.now(), finished_at: null, from: null, to: null, note: "", error: null, log: [] });
  const fail = (msg) => { job.state = "failed"; job.error = msg; job.finished_at = Date.now(); say("FAILED: " + msg); };
  try {
    job.from = await text(["rev-parse", "--short=7", "HEAD"]);
    // A private repository: the same read-only token the update check uses, sent as a header for this one command (never stored here).
    const auth = token ? ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from("x-access-token:" + token).toString("base64")}`] : [];
    const pull = await git([...auth, "pull", "--ff-only", "origin", branch]);
    if (pull.code !== 0) return fail("Could not get the new code (git pull failed). Local changes in the folder, a wrong token or no internet are the usual causes; the log shows which.");
    job.to = await text(["rev-parse", "--short=7", "HEAD"]);
    const subject = await text(["log", "-1", "--format=%s"]);
    const env = { BUILD_ID: job.to, BUILD_NOTE: subject.slice(0, 160) };
    const proj = await projectName();
    if (proj) env.COMPOSE_PROJECT_NAME = proj;

    job.step = "Keeping the current version for roll-back";
    await run("docker", ["tag", `${IMAGE}:latest`, `${IMAGE}:previous`], env); // fine if it does not exist yet

    job.step = "Building the new version (people can keep working)";
    const build = await run("docker", ["compose", "build", SERVICE], env);
    if (build.code !== 0) return fail("The build failed, so nothing was changed: the old version is still running. The log shows why.");

    const touched = job.from === job.to ? "" : await text(["diff", "--name-only", job.from, job.to, "--", "updater", "docker-compose.yml"]);
    if (touched) job.note = "The updater or docker-compose.yml changed in this update. Run ./update.sh once on the server so those changes apply too.";

    job.step = "Restarting (screens say 'being updated' for a moment)";
    const up = await run("docker", ["compose", "up", "-d", "--no-deps", SERVICE], env);
    if (up.code !== 0) return fail("The new version was built but did not start. To go back: docker tag " + IMAGE + ":previous " + IMAGE + ":latest && docker compose up -d --no-build " + SERVICE);
    job.state = "done";
    job.step = "Done";
    job.finished_at = Date.now();
    say(`Updated ${job.from} -> ${job.to}`);
  } catch (e) {
    fail(String(e?.message ?? e));
  }
}

const authorised = (h) => {
  const a = createHash("sha256").update(String(h || "")).digest();
  const b = createHash("sha256").update("Bearer " + SECRET).digest();
  return timingSafeEqual(a, b);
};

http
  .createServer(async (rq, rs) => {
    const send = (code, obj) => { rs.writeHead(code, { "content-type": "application/json" }); rs.end(JSON.stringify(obj)); };
    if (!authorised(rq.headers.authorization)) return send(401, { error: "unauthorised" });
    const url = new URL(rq.url, "http://updater");
    if (rq.method === "GET" && url.pathname === "/status") return send(200, { ...job, dir: DIR, dry: DRY });
    if (rq.method === "POST" && url.pathname === "/update") {
      let raw = "";
      for await (const ch of rq) { raw += ch; if (raw.length > 4096) return send(413, { error: "too big" }); }
      let b = {};
      try { b = JSON.parse(raw || "{}"); } catch { /* defaults */ }
      const branch = typeof b.branch === "string" && BRANCH.test(b.branch) ? b.branch : "main";
      if (job.state === "running") return send(409, { error: "An update is already running." });
      token = typeof b.token === "string" && b.token.length < 300 && !/\s/.test(b.token) ? b.token : "";
      void update(branch).finally(() => { token = ""; });
      return send(202, { started: true });
    }
    send(404, { error: "not found" });
  })
  .listen(PORT, "0.0.0.0", () => console.log(`[updater] ready on :${PORT}, project folder ${DIR}, service ${SERVICE}${DRY ? " (dry run)" : ""}`));
