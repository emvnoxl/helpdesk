import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useLive } from "./live";
import { useNotify } from "./notify";
import { secondaryBtn } from "./SystemSetup";
import { btn, field } from "./ui";

/* Admin > System > Updates: is there a newer version on GitHub, what changed, and the command that installs it.
   The helpdesk only looks; installing is `./update.sh` on the server (git pull + rebuild). */

export interface UpdateInfo {
  repo: string; branch: string; has_token: boolean; updater: boolean; running: string; comparable: boolean;
  state: { checked_at: number; error: string | null; latest: { sha: string; message: string; date: string } | null; available: boolean | null; behind: number | null; changes: string[] } | null;
}

interface Job { state: "idle" | "running" | "done" | "failed"; step: string; finished_at: number | null; from: string | null; to: string | null; note: string; error: string | null; log: string[] }
interface Install { enabled: boolean; reachable: boolean; job: Job | null; error?: string }

/** For the badge on the System tab. Admins only. */
export function useUpdateInfo(enabled: boolean) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const load = useCallback(async () => { try { setInfo(await api<UpdateInfo>("/admin/system/updates")); } catch { /* the badge is optional */ } }, []);
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  useLive("/staff/stream", () => { if (enabled) void load(); });
  return { info, reload: load, set: setInfo };
}

const ago = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

export function UpdatesCard({ info, onChange }: { info: UpdateInfo; onChange: () => void }) {
  const { toast, confirm } = useNotify();
  const [inst, setInst] = useState<Install | null>(null);
  const [repo, setRepo] = useState(info.repo);
  const [branch, setBranch] = useState(info.branch);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!info.repo);
  const st = info.state;
  const job = inst?.job && inst.job.state !== "idle" && (inst.job.state === "running" || (inst.job.finished_at ?? 0) > Date.now() - 15 * 60_000) ? inst.job : null;

  const poll = useCallback(async () => { try { setInst(await api<Install>("/admin/system/updates/install/status")); } catch { /* the helpdesk is restarting: the next poll will answer */ } }, []);
  useEffect(() => { if (info.updater) void poll(); }, [info.updater, poll]);
  const running = inst?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void poll(), 2000);
    return () => window.clearInterval(id);
  }, [running, poll]);

  const install = async () => {
    const ok = await confirm({
      title: "Install the update now?",
      body: <>A backup is taken first. The new version is built while people keep working; then the helpdesk restarts and every open screen says "being updated" for a few seconds and reloads by itself. This usually takes a few minutes.</>,
      confirmLabel: "Update now",
    });
    if (!ok) return;
    setBusy(true);
    try { await api("/admin/system/updates/install", { method: "POST", json: {} }); await poll(); }
    catch (e) { toast((e as Error).message, "error", "Could not start the update"); }
    setBusy(false);
  };

  const check = async () => {
    setBusy(true);
    try { await api("/admin/system/updates/check", { method: "POST" }); onChange(); }
    catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api("/admin/system/updates", { method: "PUT", json: { repo, branch, token } });
      setToken(""); setEditing(false); onChange();
      toast("Saved. Looked for updates just now.", "success");
    } catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };
  const copy = async () => { try { await navigator.clipboard.writeText("./update.sh"); toast("Copied. Run it in the helpdesk folder on the server.", "success"); } catch { toast("Type ./update.sh in the helpdesk folder on the server.", "info"); } };

  const badge = st?.available ? "bg-[#ffb400] text-ink" : st?.error ? "bg-[#d92b33] text-white" : st?.available === false ? "bg-brand-green text-ink" : "bg-fg/10 text-fg";
  const badgeText = !info.repo ? "Not set up" : st?.available ? "Update available" : st?.error ? "Check failed" : st?.available === false ? "Up to date" : "Unknown";

  return (
    <section className="rounded-2xl border border-fg/10 bg-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Updates</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${badge}`}>{badgeText}</span>
        <div className="ml-auto flex gap-2">
          {info.repo && <button className={secondaryBtn} onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Settings"}</button>}
          {info.repo && <button className={btn} disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check now"}</button>}
        </div>
      </div>

      {info.repo && st && (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Running <span className="font-mono text-fg">{info.running}</span>
          {st.latest && <>, newest is <span className="font-mono text-fg">{st.latest.sha}</span> ({st.latest.message})</>}. Checked {ago(st.checked_at)}; it looks twice a day by itself.
        </p>
      )}
      {st?.error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{st.error}</p>}
      {info.repo && !info.comparable && !st?.error && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This copy was not built from a known commit, so it cannot tell whether it is behind. Install once with <code className="rounded bg-amber-100 px-1">./update.sh</code> and it will from then on.
        </p>
      )}

      {st?.available && (
        <div className="mt-3 rounded-xl border border-[#ffb400]/60 bg-[#ffb400]/10 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-fg">{st.behind ? `${st.behind} new change${st.behind === 1 ? "" : "s"}` : "A newer version is ready"}</p>
            {info.updater && inst?.reachable && !running && <button className={`${btn} ml-auto`} disabled={busy} onClick={() => void install()}>Update now</button>}
          </div>
          {st.changes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-fg">{st.changes.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          {info.updater && inst && !inst.reachable && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{inst.error ?? "The updater is not reachable."}</p>}
          <details className="mt-3 text-sm text-neutral-700 dark:text-neutral-300" open={!info.updater}>
            <summary className="cursor-pointer font-semibold text-fg">{info.updater ? "Or install it by hand" : "How to install it"}</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>Optional: use <strong>Announce an update</strong> below so people get a warning banner.</li>
              <li>On the server, in the helpdesk folder, run <button type="button" onClick={() => void copy()} className="rounded bg-fg/10 px-1.5 font-mono text-fg hover:bg-fg/20" title="Copy">./update.sh</button> (it pulls the new code, rebuilds and restarts; add <code className="rounded bg-fg/10 px-1">--profile https</code> if you use the built-in HTTPS).</li>
              <li>Screens say "being updated" and reload by themselves. Your data and settings are kept.</li>
            </ol>
            {!info.updater && <p className="mt-2">For a one-click button instead, switch on the updater: set <code className="rounded bg-fg/10 px-1">UPDATER_SECRET</code> and <code className="rounded bg-fg/10 px-1">HELPDESK_DIR</code> in <code className="rounded bg-fg/10 px-1">.env</code>, then run <code className="rounded bg-fg/10 px-1">docker compose --profile updater up -d --build</code> once.</p>}
          </details>
        </div>
      )}

      {job && (
        <div className={`mt-3 rounded-xl border p-4 ${job.state === "failed" ? "border-[#d92b33]/60" : "border-fg/15"}`} role={job.state === "failed" ? "alert" : "status"}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${job.state === "running" ? "bg-[#ffb400] text-ink" : job.state === "done" ? "bg-brand-green text-ink" : "bg-[#d92b33] text-white"}`}>{job.state === "running" ? "Updating" : job.state === "done" ? "Updated" : "Failed"}</span>
            <span className="text-sm font-semibold text-fg">{job.state === "failed" ? "The update did not finish" : job.step}</span>
            {job.from && job.to && <span className="text-xs text-neutral-600 dark:text-neutral-400"><span className="font-mono">{job.from}</span> to <span className="font-mono">{job.to}</span></span>}
          </div>
          {job.error && <p className="mt-2 text-sm text-fg">{job.error}</p>}
          {job.note && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{job.note}</p>}
          <details className="mt-2 text-sm" open={job.state === "failed"}>
            <summary className="cursor-pointer font-semibold text-fg">Details</summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-fg/10 p-3 text-xs text-fg">{job.log.join("\n")}</pre>
          </details>
        </div>
      )}

      {editing && (
        <div className="mt-4 space-y-3 rounded-xl border border-fg/15 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-fg">GitHub repository
              <input className={`${field} mt-1 text-fg`} placeholder="owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} autoComplete="off" />
            </label>
            <label className="block text-sm font-semibold text-fg">Branch
              <input className={`${field} mt-1 text-fg`} placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} autoComplete="off" />
            </label>
          </div>
          <label className="block text-sm font-semibold text-fg">Read-only access token {info.has_token && <span className="font-normal text-ok">(saved)</span>}
            <input className={`${field} mt-1 text-fg`} type="password" placeholder={info.has_token ? "Leave blank to keep it, or type - to remove it" : "Needed for a private repository"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
            <span className="mt-1 block text-xs font-normal text-neutral-600 dark:text-neutral-400">GitHub &gt; Settings &gt; Developer settings &gt; Fine-grained tokens: this repository only, permission <strong>Contents: Read-only</strong>. Only the repository name and this token go to GitHub, nothing about tickets or people.</span>
          </label>
          <button className={btn} disabled={busy || !repo.trim()} onClick={() => void save()}>Save and check</button>
        </div>
      )}
    </section>
  );
}
