import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import { useLive } from "./live";
import { useNotify } from "./notify";
import { btn } from "./ui";
import { UpdatesCard, useUpdateInfo } from "./UpdatesCard";
import { AddressSetup, MailSetup, secondaryBtn, SsoSetup, type Settings } from "./SystemSetup";

/* Admin > System. One calm page: a short list on the left (Overview, Updates, Sign-in, Email, Address, Backups, Reset), each with a small
   status light, and one panel on the right. The Overview shows the health of everything at a glance; a row opens its section. */

interface Status { at: number; ok: boolean; file?: string; bytes?: number; seconds?: number; error?: string }
interface Info {
  version: string; built_at: string; note: string; started_at: number; node: string; db_bytes: number; uploads_bytes: number;
  disk: { free: number; total: number } | null; last_update: { from: string; to: string; note: string; at: number } | null;
  maintenance: { at: number; message: string } | null; app_url: string | null; mail: "log" | "graph" | "smtp" | "off";
  mail_status: { transport: string; last_ok_at: number | null; last_error: string | null; last_error_at: number | null; waiting: number }; admin_email: string;
}
interface Backups {
  enabled: boolean; dir: string; hour: number; keep: number; last: Status | null; last_ok: Status | null; healthy: boolean | null; running: boolean;
  files: { name: string; bytes: number; at: number }[]; uploads_mirrored: boolean; inside_data: boolean;
}

type Section = "overview" | "updates" | "signin" | "email" | "address" | "backups" | "reset";
type Tone = "ok" | "warn" | "bad" | "off";

const size = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
const when = (ts: number) => new Date(ts * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const ago = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const upFor = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
};
const MAIL = { log: "Printed to the log (trial mode)", graph: "Microsoft 365", smtp: "SMTP", off: "Off: nobody is emailed" };

const card = "rounded-2xl border border-fg/10 bg-surface p-5";
const muted = "text-sm text-neutral-600 dark:text-neutral-400";
const DOT: Record<Tone, string> = { ok: "bg-brand-green", warn: "bg-[#ffb400]", bad: "bg-[#d92b33]", off: "bg-fg/25" };
const ICON: Record<Section, string> = {
  overview: "M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z",
  updates: "M12 3v12m0 0-4-4m4 4 4-4M5 21h14",
  signin: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Zm-3 9 2 2 4-4",
  email: "M3 6h18v12H3zM3 7l9 7 9-7",
  address: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  backups: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  reset: "M4 12a8 8 0 1 0 3-6.2M4 4v5h5",
};
const TITLE: Record<Section, string> = { overview: "Overview", updates: "Updates", signin: "Sign-in", email: "Email", address: "Address", backups: "Backups", reset: "Start fresh" };
const ORDER: Section[] = ["overview", "updates", "signin", "email", "address", "backups", "reset"];

const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><path d={d} /></svg>
);

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "bad" }) {
  return (
    <div className={card}>
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      <p className={`mt-1 truncate text-xl font-bold ${tone === "bad" ? "text-[#d92b33]" : "text-fg"}`}>{value}</p>
      {sub && <p className={`mt-0.5 truncate ${muted}`}>{sub}</p>}
    </div>
  );
}

const remembered = (): Section => {
  try { const v = localStorage.getItem("fortress-helpdesk:system-section") as Section | null; if (v && ORDER.includes(v)) return v; } catch { /* private window */ }
  return "overview";
};

export function SystemPanel({ onExpired }: { onExpired: () => void }) {
  const { toast, confirm } = useNotify();
  const [section, setSection] = useState<Section>(remembered);
  const [wipeText, setWipeText] = useState("");
  const { info: upd, reload: reloadUpd } = useUpdateInfo(true);
  const [info, setInfo] = useState<Info | null>(null);
  const [setup, setSetup] = useState<Settings | null>(null);
  const [bk, setBk] = useState<Backups | null>(null);
  const [minutes, setMinutes] = useState(10);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [to, setTo] = useState("");

  const go = (s: Section) => { setSection(s); try { localStorage.setItem("fortress-helpdesk:system-section", s); } catch { /* optional */ } };

  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([api<Info>("/admin/system"), api<Backups>("/admin/backups"), api<Settings>("/admin/system/settings")]);
      setInfo(a); setBk(b); setSetup(c); setErr("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired();
      else setErr((e as Error).message);
    }
  }, [onExpired]);
  useEffect(() => { void load(); }, [load]);
  useLive("/staff/stream", () => void load());

  const announce = async () => {
    setBusy(true);
    try { await api("/admin/system/maintenance", { method: "POST", json: { minutes, message: msg } }); toast(`Everyone will see a banner for the update at ${new Date(Date.now() + minutes * 60_000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`, "success", "Update announced"); setMsg(""); await load(); }
    catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };
  const cancel = async () => { setBusy(true); try { await api("/admin/system/maintenance", { method: "DELETE" }); await load(); } catch (e) { toast((e as Error).message, "error"); } setBusy(false); };
  const testMail = async () => {
    setBusy(true);
    try { const r = await api<{ via: string; to: string }>("/admin/system/test-email", { method: "POST", json: { to: to.trim() || info?.admin_email } }); toast(`Sent to ${r.to} (${r.via}). Check that inbox, and the junk folder.`, "success", "Test email sent"); }
    catch (e) { toast((e as Error).message, "error", "The test email failed"); }
    await load();
    setBusy(false);
  };
  const backupNow = async () => {
    setBusy(true);
    try { const r = await api<Status>("/admin/backups/run", { method: "POST" }); toast(`${r.file} (${size(r.bytes ?? 0)})`, "success", "Backup done"); }
    catch (e) { toast((e as Error).message, "error", "Backup failed"); }
    await load();
    setBusy(false);
  };
  const wipe = async () => {
    const ok = await confirm({ title: "Delete all tickets, people and computers?", body: "A backup is taken first. Only admin accounts and your settings are kept. Everyone else signs in fresh.", confirmLabel: "Delete everything", tone: "danger" });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api<{ backup: string; removed: Record<string, number> }>("/admin/system/wipe", { method: "POST", json: { confirm: "DELETE" } });
      toast(`${r.removed.tickets} tickets and ${r.removed.users} people removed. Backup: ${r.backup}`, "success", "Started fresh");
      setWipeText("");
    } catch (e) { toast((e as Error).message, "error", "Nothing was deleted"); }
    await load();
    setBusy(false);
  };

  if (!info || !bk || !setup) return err ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p> : <p className="text-neutral-500">Loading…</p>;

  const diskPct = info.disk ? Math.round(100 - (info.disk.free / info.disk.total) * 100) : null;
  const us = upd?.state;

  // One line and one light per area: this is all the Overview and the left list need.
  const health: Record<Exclude<Section, "overview" | "reset">, { tone: Tone; text: string }> = {
    updates: !upd?.repo ? { tone: "off", text: "Not set up: add your GitHub repository to be told about new versions" }
      : us?.available ? { tone: "warn", text: `Update available${us.latest ? `: ${us.latest.message}` : ""}` }
      : us?.error ? { tone: "bad", text: us.error }
      : us?.available === false ? { tone: "ok", text: `Up to date (${info.version})` }
      : { tone: "off", text: "Not checked yet" },
    signin: setup.sso.enforced ? { tone: "ok", text: "Microsoft 365 only" }
      : setup.sso.configured && setup.sso.verified_at ? { tone: "ok", text: "Microsoft 365 works; PINs are still allowed" }
      : setup.sso.configured ? { tone: "warn", text: "Set up but not tested yet: press Test sign-in" }
      : { tone: "warn", text: "Not set up: people still use PINs" },
    email: info.mail === "off" ? { tone: "warn", text: "Not set up: nobody is emailed" }
      : info.mail_status.last_error ? { tone: "bad", text: "The last email failed" }
      : info.mail === "log" ? { tone: "off", text: "Trial mode: emails are only printed in the log" }
      : { tone: "ok", text: `Sending through ${MAIL[info.mail]}` },
    address: info.app_url ? { tone: "ok", text: info.app_url } : { tone: "warn", text: "Not set: links in emails need it" },
    backups: !bk.enabled ? { tone: "bad", text: "Automatic backups are off" }
      : bk.healthy === false ? { tone: "bad", text: bk.last && !bk.last.ok ? "The last backup failed" : "No good backup in the last 36 hours" }
      : bk.healthy ? { tone: "ok", text: `Last good backup ${ago(bk.last_ok!.at)}` }
      : { tone: "warn", text: "No backup yet" },
  };
  const tone = (s: Section): Tone | null => (s === "overview" || s === "reset" ? null : health[s].tone);

  const nav = (
    <nav aria-label="System sections" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:sticky lg:top-4 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0">
      {ORDER.map((s) => {
        const t = tone(s);
        const on = section === s;
        return (
          <button
            key={s}
            onClick={() => go(s)}
            aria-current={on ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${on ? "bg-ink text-white dark:bg-brand-green dark:text-ink" : "text-fg hover:bg-fg/10"} ${s === "reset" ? "lg:mt-3" : ""}`}
          >
            <Icon d={ICON[s]} />
            <span className="flex-1 text-left">{TITLE[s]}</span>
            {t && t !== "ok" && <span className={`h-2 w-2 rounded-full ${DOT[t]} ${on ? "ring-2 ring-white/60 dark:ring-ink/50" : ""}`} aria-hidden />}
            {t === "ok" && <span className={`h-2 w-2 rounded-full ${DOT.ok}`} aria-hidden />}
            {t && <span className="sr-only">{t === "ok" ? "(fine)" : t === "off" ? "(not in use)" : t === "warn" ? "(needs a look)" : "(problem)"}</span>}
          </button>
        );
      })}
    </nav>
  );

  const overview = (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Version" value={<span className="font-mono">{info.version}</span>} sub={info.note ? info.note : `Built ${when(Date.parse(info.built_at) / 1000)}`} />
        <Stat label="Running for" value={upFor(info.started_at)} sub={info.last_update ? `Last update ${ago(info.last_update.at)}` : `Since ${when(info.started_at)}`} />
        <Stat label="Database" value={size(info.db_bytes)} sub={`Uploads ${size(info.uploads_bytes)}`} />
        <Stat label="Disk" value={diskPct === null ? "Unknown" : `${diskPct}% used`} tone={diskPct !== null && diskPct > 90 ? "bad" : undefined} sub={info.disk ? `${size(info.disk.free)} free of ${size(info.disk.total)}` : undefined} />
      </div>
      <ul className="divide-y divide-fg/10 overflow-hidden rounded-2xl border border-fg/10 bg-surface">
        {(["updates", "signin", "email", "address", "backups"] as const).map((s) => (
          <li key={s}>
            <button onClick={() => go(s)} className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-fg/5 focus:outline-none focus-visible:bg-fg/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-green">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[health[s].tone]}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold text-fg">{TITLE[s]}</span>
                <span className={`block truncate ${muted}`}>{health[s].text}</span>
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-500" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  const updates = (
    <div className="space-y-5">
      {upd && <UpdatesCard key={JSON.stringify([upd.repo, upd.state?.checked_at])} info={upd} onChange={() => void reloadUpd()} />}
      <section className={card}>
        <h2 className="text-base font-bold text-fg">Warn people before an update</h2>
        <p className={`mt-1 ${muted}`}>Everyone who has the helpdesk open sees a banner counting down. Without it they still see "being updated" during the restart; the banner just gives warning.</p>
        {info.maintenance ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-[#ffb400] px-4 py-3 text-sm font-semibold text-ink">
            <span>Announced for {new Date(info.maintenance.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{info.maintenance.message ? `: ${info.maintenance.message}` : ""}</span>
            <button className="ml-auto rounded-md bg-ink px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void cancel()}>Cancel announcement</button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm font-semibold text-fg">
              In
              <select className="ml-2 rounded-lg border border-fg/20 bg-surface px-2.5 py-2 text-fg" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[2, 5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </select>
            </label>
            <input className="min-w-0 flex-1 rounded-lg border border-fg/20 bg-surface px-3 py-2 text-sm text-fg placeholder:text-neutral-500" placeholder="Optional note, e.g. new features and fixes" maxLength={160} value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Optional note" />
            <button className={btn} disabled={busy} onClick={() => void announce()}>Show banner to everyone</button>
          </div>
        )}
        {info.last_update && <p className={`mt-3 ${muted}`}>Last update: <span className="font-mono">{info.last_update.from}</span> to <span className="font-mono">{info.last_update.to}</span>, {when(info.last_update.at)}{info.last_update.note ? ` (${info.last_update.note})` : ""}.</p>}
      </section>
    </div>
  );

  const email = (
    <section className={card}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Email</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${info.mail === "off" || info.mail_status.last_error ? "bg-[#d92b33] text-white" : info.mail === "log" ? "bg-fg/10 text-fg" : "bg-brand-green text-ink"}`}>
          {info.mail === "off" ? "Not set up" : info.mail_status.last_error ? "Last send failed" : info.mail === "log" ? "Trial mode" : "Working"}
        </span>
      </div>
      <p className={`mt-2 ${muted}`}>
        {MAIL[info.mail]}. People are emailed when their ticket gets a reply, a new status or a person; IT staff when something needs them and they have not seen it in the helpdesk.
        {info.mail === "off" && " Choose how to send below to switch it on."}
        {info.mail === "log" && " Choose SMTP or Microsoft 365 below to send real ones."}
      </p>
      {info.mail_status.last_ok_at && <p className={`mt-1 ${muted}`}>Last email sent <strong className="text-fg">{ago(info.mail_status.last_ok_at)}</strong>{info.mail_status.waiting ? `, ${info.mail_status.waiting} waiting to go out` : ""}.</p>}
      {!info.mail_status.last_ok_at && info.mail_status.waiting > 0 && <p className={`mt-1 ${muted}`}>{info.mail_status.waiting} waiting to go out.</p>}
      {info.mail_status.last_error && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">The last email failed {info.mail_status.last_error_at ? ago(info.mail_status.last_error_at) : ""}: {info.mail_status.last_error}. It is tried again automatically.</p>}
      <details className="group mt-4 rounded-xl border border-fg/15" open={info.mail === "off" || info.mail === "log"}>
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-fg">Email settings <span className="font-normal text-neutral-600 dark:text-neutral-400">({setup.mail.source === "saved" ? "saved here" : "from .env"})</span></summary>
        <div className="border-t border-fg/10 p-4"><MailSetup key={JSON.stringify(setup.mail)} s={setup} onSaved={() => void load()} /></div>
      </details>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <input className="min-w-0 flex-1 rounded-lg border border-fg/20 bg-surface px-3 py-2 text-sm text-fg placeholder:text-neutral-500" type="email" placeholder={info.admin_email} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send the test email to" />
        <button className={secondaryBtn} disabled={busy || info.mail === "off"} onClick={() => void testMail()}>Send a test email</button>
      </div>
    </section>
  );

  const backups = (
    <section className={card}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Backups</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${bk.healthy === false ? "bg-[#d92b33] text-white" : bk.healthy ? "bg-brand-green text-ink" : "bg-fg/10 text-fg"}`}>
          {!bk.enabled ? "Off" : bk.healthy ? "Healthy" : bk.last_ok ? "Needs attention" : "No backup yet"}
        </span>
        <button className={`${btn} ml-auto`} disabled={busy || bk.running} onClick={() => void backupNow()}>{bk.running ? "Backing up…" : "Back up now"}</button>
      </div>
      <p className={`mt-2 ${muted}`}>
        {bk.enabled ? `Every day after ${String(bk.hour).padStart(2, "0")}:00, keeping the newest ${bk.keep}. ` : "Automatic backups are switched off (BACKUP_ENABLED=0). "}
        {bk.last_ok ? <>Last good backup <strong className="text-fg">{ago(bk.last_ok.at)}</strong> ({size(bk.last_ok.bytes ?? 0)}).</> : "Nothing has been backed up yet."}
      </p>
      {bk.last && !bk.last.ok && <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">The last attempt failed: {bk.last.error}</p>}
      <p className={`mt-2 ${muted}`}>Stored in <code className="rounded bg-fg/10 px-1 break-all">{bk.dir}</code>{bk.uploads_mirrored ? ", with a copy of the uploaded files" : ""}.</p>
      {bk.inside_data && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This folder is on the same disk as the helpdesk, so it will not survive losing that disk. Set <code className="rounded bg-amber-100 px-1">BACKUP_DIR</code> to another disk or a NAS share, or download a copy now and then.
        </p>
      )}
      {bk.files.length > 0 && (
        <ul className="mt-3 divide-y divide-fg/10 rounded-xl border border-fg/10">
          {bk.files.slice(0, 10).map((f) => (
            <li key={f.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5 text-sm">
              <span className="font-mono text-fg">{f.name}</span>
              <span className={muted}>{when(f.at)} · {size(f.bytes)}</span>
              <a className="ml-auto font-semibold text-ok underline-offset-2 hover:underline" href={`/api/admin/backups/${f.name}`} download>Download</a>
            </li>
          ))}
        </ul>
      )}
      <details className={`mt-3 ${muted}`}>
        <summary className="cursor-pointer font-semibold text-fg">How to restore</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Stop the helpdesk: <code className="rounded bg-fg/10 px-1">docker compose stop helpdesk</code></li>
          <li>Unzip the backup you want (<code className="rounded bg-fg/10 px-1">gunzip</code> or 7-Zip) and replace <code className="rounded bg-fg/10 px-1">helpdesk.db</code> in the data folder with it. Delete <code className="rounded bg-fg/10 px-1">helpdesk.db-wal</code> and <code className="rounded bg-fg/10 px-1">helpdesk.db-shm</code> if they exist.</li>
          <li>Copy the files from the backup's <code className="rounded bg-fg/10 px-1">uploads</code> folder back into the data folder's <code className="rounded bg-fg/10 px-1">uploads</code> folder.</li>
          <li>Start it again: <code className="rounded bg-fg/10 px-1">docker compose start helpdesk</code></li>
        </ol>
      </details>
    </section>
  );

  const reset = (
    <section className="rounded-2xl border border-[#d92b33]/40 bg-surface p-5">
      <h2 className="text-base font-bold text-fg">Start fresh</h2>
      <p className={`mt-1 ${muted}`}>
        Deletes every ticket, message, attachment, computer, notification, the activity log, recurring tickets, and every person except the admins.
        Keeps your settings (address, email, Microsoft 365), help articles, saved replies, checklists and admin accounts. A backup is taken first, so it can be undone by restoring it.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <input className="w-48 rounded-lg border border-fg/20 bg-surface px-3 py-2 text-sm text-fg placeholder:text-neutral-500" placeholder="Type DELETE" value={wipeText} onChange={(e) => setWipeText(e.target.value)} aria-label="Type DELETE to enable the button" autoComplete="off" />
        <button className="rounded-lg bg-[#d92b33] px-4 py-2 text-sm font-bold text-white disabled:opacity-40" disabled={busy || wipeText !== "DELETE"} onClick={() => void wipe()}>Delete all data</button>
      </div>
    </section>
  );

  const body: Record<Section, ReactNode> = {
    overview,
    updates,
    signin: <SsoSetup key={JSON.stringify([setup.sso, setup.address.app_url, setup.mail.mode])} s={setup} onSaved={() => void load()} />,
    email,
    address: <AddressSetup key={JSON.stringify(setup.address)} s={setup} onSaved={() => void load()} />,
    backups,
    reset,
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
      {nav}
      <div className="min-w-0 max-w-5xl">
        <div key={section} className="page-in space-y-5">{body[section]}</div>
        {err && <p role="alert" className="mt-5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      </div>
    </div>
  );
}
