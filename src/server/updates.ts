import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { runBackup } from "./backup";
import { changed } from "./bus";
import { db } from "./db";
import { seal, unseal } from "./settings";
import { getSetting, putSetting } from "./sla";
import { BUILD } from "./version";

/* "Is there a newer version?" The helpdesk asks GitHub (read-only) which commit the branch is at and compares it with the commit it was
   built from. When they differ, every admin gets one bell notification and the System page shows what changed and the command to run.
   Installing is done by `./update.sh` on the server, or by the "Update now" button, which asks the separate updater helper (see the end of
   this file); either way people then see the usual "being updated" screen.
   A private repository needs a read-only token (GitHub > Settings > Developer settings > Fine-grained tokens > this repository >
   Contents: read-only). It is stored encrypted and never sent back to the browser. Only the repository name and the token go to GitHub;
   nothing about tickets or people does. */

interface Source { repo: string; branch: string; token: string } // token sealed at rest
export interface UpdateState {
  checked_at: number;
  error: string | null;
  latest: { sha: string; message: string; date: string } | null;
  /** true = newer code exists; false = up to date; null = cannot tell (this build has no commit id, or GitHub does not know it) */
  available: boolean | null;
  behind: number | null;
  changes: string[];
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9_./-]{1,100}$/;

async function source(): Promise<Source> {
  let s: Partial<Source> = {};
  try { s = JSON.parse((await getSetting("update_source")) ?? "{}"); } catch { /* none saved */ }
  return {
    repo: s.repo ?? process.env.UPDATE_REPO ?? "",
    branch: s.branch ?? process.env.UPDATE_BRANCH ?? "main",
    token: s.token !== undefined ? s.token : process.env.UPDATE_TOKEN ? seal(process.env.UPDATE_TOKEN) : "",
  };
}

/** The commit this build came from, or "" when the id is a build time ("t2611251430") or "dev". A trailing "+" means local edits. */
const runningSha = () => (/^[0-9a-f]{7,40}\+?$/.test(BUILD.id) ? BUILD.id.replace("+", "") : "");

async function gh<T>(src: Source, path: string): Promise<T> {
  const token = unseal(src.token);
  const res = await fetch(`${process.env.UPDATE_API_URL || "https://api.github.com"}/repos/${src.repo}/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "helpdesk-update-check", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404 || res.status === 401 || res.status === 403)
    throw new Error(token ? "GitHub refused it: check the repository name and that the token can read it." : "GitHub says the repository is not found. If it is private, add a read-only token.");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return (await res.json()) as T;
}

export async function readState(): Promise<UpdateState | null> {
  try {
    const s = JSON.parse((await getSetting("update_state")) ?? "null") as UpdateState | null;
    // Stored before the restart that installed it: the answer is already out of date.
    if (s?.latest && runningSha() === s.latest.sha) return { ...s, available: false, behind: 0, changes: [] };
    return s;
  } catch { return null; }
}

let checking = false;

/** Asks GitHub, stores the answer, and tells the admins once per new version. Never throws. */
export async function checkForNewVersion(): Promise<UpdateState> {
  const now = Math.floor(Date.now() / 1000);
  const src = await source();
  let state: UpdateState = { checked_at: now, error: null, latest: null, available: null, behind: null, changes: [] };
  if (!src.repo) return { ...state, error: "Not set up: enter the GitHub repository below." };
  if (checking) return (await readState()) ?? state;
  checking = true;
  try {
    const head = await gh<{ sha: string; commit: { message: string; committer: { date: string } } }>(src, `commits/${encodeURIComponent(src.branch)}`);
    const latest = { sha: head.sha.slice(0, 7), message: head.commit.message.split("\n")[0].slice(0, 160), date: head.commit.committer?.date ?? "" };
    state.latest = latest;
    const mine = runningSha();
    if (mine) {
      if (mine === latest.sha) { state.available = false; state.behind = 0; }
      else {
        try {
          const cmp = await gh<{ status: string; ahead_by: number; commits: { commit: { message: string } }[] }>(src, `compare/${mine}...${encodeURIComponent(src.branch)}`);
          state.behind = cmp.ahead_by;
          state.available = cmp.status === "ahead" || cmp.status === "diverged";
          state.changes = cmp.commits.slice(-15).reverse().map((c) => c.commit.message.split("\n")[0].slice(0, 120));
          if (cmp.status === "behind" || cmp.status === "identical") { state.available = false; state.behind = 0; state.changes = []; }
        } catch {
          state.available = true; // the sha differs and GitHub cannot relate them (for example a local build): say so, without a list
        }
      }
    }
  } catch (e) {
    state.error = (e as Error).message;
  } finally {
    checking = false;
  }
  await putSetting("update_state", JSON.stringify(state));
  if (state.available && state.latest && (await getSetting("update_notified")) !== state.latest.sha) {
    await putSetting("update_notified", state.latest.sha);
    await db
      .prepare(
        `INSERT INTO notifications (user_id, ticket_id, kind, title, body, created_at)
         SELECT id, NULL, 'update', 'Update available', ?, unixepoch() FROM users WHERE role = 'admin' AND active = 1`,
      )
      .bind(`${state.latest.message} (${state.latest.sha}). Admin > System shows how to install it.`.slice(0, 140))
      .run();
    await audit(null, "system.update_available", "admin", `A newer version is available: ${state.latest.sha} ${state.latest.message}`, { who: SYSTEM });
  }
  changed();
  return state;
}

/** Looks twice a day, first a couple of minutes after start-up (so a fresh install is not slowed down). Returns the stop function. */
export function startUpdateChecks() {
  const first = setTimeout(() => void checkForNewVersion().catch(() => {}), 2 * 60_000);
  const timer = setInterval(() => void checkForNewVersion().catch(() => {}), 12 * 3600_000);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

export const updates = new Hono<AppEnv>();

updates.get("/", async (c) => {
  const s = await source();
  return c.json({ repo: s.repo, branch: s.branch, has_token: !!unseal(s.token), updater: !!process.env.UPDATER_SECRET, running: BUILD.id, comparable: !!runningSha(), state: await readState() });
});

// { repo, branch?, token? }: a blank token keeps the saved one; token "-" removes it.
updates.put("/", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const repo = typeof b.repo === "string" ? b.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "") : "";
  const branch = typeof b.branch === "string" && b.branch.trim() ? b.branch.trim() : "main";
  if (repo && !REPO.test(repo)) return c.json({ error: "Write the repository as owner/name, for example emvnoxl/helpdesk." }, 400);
  if (!BRANCH.test(branch)) return c.json({ error: "That branch name does not look right." }, 400);
  const cur = await source();
  const t = typeof b.token === "string" ? b.token.trim() : "";
  if (t && /\s/.test(t)) return c.json({ error: "The token has a space or line break in it." }, 400);
  const token = t === "-" ? "" : t ? seal(t) : cur.token;
  await putSetting("update_source", JSON.stringify({ repo, branch, token } satisfies Source));
  await putSetting("update_notified", "");
  await audit(c, "system.settings", "admin", `Update check: ${repo || "off"} (${branch})${t ? (t === "-" ? ", token removed" : ", token changed") : ""}`);
  return c.json({ state: repo ? await checkForNewVersion() : null });
});

updates.post("/check", async (c) => {
  const state = await checkForNewVersion();
  return c.json({ state });
});

/* One-button install. The helpdesk never touches Docker: it asks the "updater" helper (updater/server.mjs, its own container with the
   Docker access, reachable only from this one and only with UPDATER_SECRET) to pull, build and swap. The old version keeps serving while
   it builds, and the swap shows the usual "being updated" screen. A backup is taken first. */
const updaterSecret = () => process.env.UPDATER_SECRET || "";
const updaterUrl = () => process.env.UPDATER_URL || "http://updater:8080";

async function askUpdater(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(updaterUrl() + path, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${updaterSecret()}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
}

const SETUP_HINT = "One-button updates are not switched on. Set UPDATER_SECRET and HELPDESK_DIR in .env, then run: docker compose --profile updater up -d --build";

// The state of the helper and of the last/current update (for the progress display). Never throws.
updates.get("/install/status", async (c) => {
  if (!updaterSecret()) return c.json({ enabled: false, reachable: false, job: null });
  try {
    const r = await askUpdater("/status");
    if (!r.ok) return c.json({ enabled: true, reachable: false, job: null, error: r.status === 401 ? "The updater has a different UPDATER_SECRET: restart it with the same one." : `The updater answered ${r.status}.` });
    return c.json({ enabled: true, reachable: true, job: await r.json() });
  } catch {
    return c.json({ enabled: true, reachable: false, job: null, error: "The updater is not running. Start it with: docker compose --profile updater up -d --build" });
  }
});

updates.post("/install", async (c) => {
  if (!updaterSecret()) return c.json({ error: SETUP_HINT }, 409);
  const st = await readState();
  if (!st?.available) return c.json({ error: "There is nothing newer to install. Press Check now first." }, 409);
  const me = c.get("user");
  // Ask first whether the helper is there and idle, so a backup is not made for nothing.
  try {
    const s = await askUpdater("/status");
    if (!s.ok) return c.json({ error: "The updater did not accept the request: check that UPDATER_SECRET is the same in .env for both." }, 502);
    if (((await s.json()) as { state?: string }).state === "running") return c.json({ error: "An update is already running." }, 409);
  } catch {
    return c.json({ error: "The updater is not running. Start it with: docker compose --profile updater up -d --build" }, 502);
  }
  const backup = await runBackup("manual", { id: me.id, name: me.name, role: me.role });
  if (!backup.ok) return c.json({ error: `Nothing was changed: the safety backup failed (${backup.error}).` }, 500);
  const src = await source();
  try {
    const r = await askUpdater("/update", { method: "POST", body: { branch: src.branch, token: unseal(src.token) } });
    if (r.status === 409) return c.json({ error: "An update is already running." }, 409);
    if (!r.ok) return c.json({ error: `The updater refused (${r.status}).` }, 502);
  } catch {
    return c.json({ error: "The updater stopped answering." }, 502);
  }
  await audit(c, "system.update_install", "admin", `Started installing ${st.latest?.sha ?? "the newest version"} (safety backup ${backup.file})`);
  changed();
  return c.json({ ok: true, backup: backup.file });
});
