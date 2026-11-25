import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { secondaryBtn } from "./SystemSetup";
import { btn, field } from "./ui";

/* Admin > System > Alerts: post to a Microsoft Teams channel when something needs a person. The webhook address is a secret: it is kept
   sealed on the server and never shown again. */

export interface TeamsInfo {
  configured: boolean;
  events: Record<string, boolean>;
  available: { id: string; label: string; hint: string }[];
  last: { at: number; ok: boolean; error?: string } | null;
}
const card = "rounded-2xl border border-fg/10 bg-surface p-5";
const muted = "text-sm text-neutral-600 dark:text-neutral-400";
const ago = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

export function useTeamsInfo() {
  const [info, setInfo] = useState<TeamsInfo | null>(null);
  const load = useCallback(async () => { try { setInfo(await api<TeamsInfo>("/admin/teams")); } catch { /* shown by the panel */ } }, []);
  useEffect(() => { void load(); }, [load]);
  return { info, load };
}

export function TeamsSetup({ info, onChanged }: { info: TeamsInfo; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(info.events);
  const [busy, setBusy] = useState(false);
  const dirty = !!url.trim() || JSON.stringify(events) !== JSON.stringify(info.events);

  const save = async () => {
    setBusy(true);
    try {
      await api("/admin/teams", { method: "PUT", json: { url, events } });
      setUrl("");
      onChanged();
      toast("Saved. Press “Send a test message” to see it arrive in the channel.", "success", "Teams alerts");
    } catch (e) { toast((e as Error).message, "error", "Couldn't save"); }
    setBusy(false);
  };
  const test = async () => {
    setBusy(true);
    try { await api("/admin/teams/test", { method: "POST" }); toast("Sent. Look in the Teams channel.", "success", "Test message"); }
    catch (e) { toast((e as Error).message, "error", "The test failed"); }
    onChanged();
    setBusy(false);
  };
  const remove = async () => {
    if (!(await confirm({ title: "Stop posting to Teams?", body: "The saved webhook address is removed.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy(true);
    try { await api("/admin/teams", { method: "PUT", json: { url: "-" } }); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };

  return (
    <section className={card}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Alerts in Microsoft Teams</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${!info.configured ? "bg-fg/10 text-fg" : info.last && !info.last.ok ? "bg-[#d92b33] text-white" : "bg-brand-green text-ink"}`}>
          {!info.configured ? "Not set up" : info.last && !info.last.ok ? "Last post failed" : "On"}
        </span>
        {info.configured && <button className={`${secondaryBtn} ml-auto`} disabled={busy} onClick={() => void test()}>Send a test message</button>}
      </div>
      <p className={`mt-2 ${muted}`}>A short card in a Teams channel, with a button that opens the ticket, for the things worth interrupting someone for. Email can be slow; Teams is where people already are. Only the ticket number, title and who raised it are sent.</p>
      {info.last && <p className={`mt-1 ${muted}`}>Last post {ago(info.last.at)}{info.last.ok ? "" : <>: <span className="text-red-700">{info.last.error}</span></>}.</p>}

      <details className="mt-3 rounded-xl border border-fg/15" open={!info.configured}>
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-fg">How to get the webhook address</summary>
        <ol className="list-decimal space-y-1.5 border-t border-fg/10 px-8 py-4 text-sm text-neutral-700 dark:text-neutral-300">
          <li>In Teams, open the channel for IT alerts. Choose <b>…</b> (More options) &gt; <b>Workflows</b>.</li>
          <li>Pick <b>“Post to a channel when a webhook request is received”</b>, name it "Helpdesk", and finish the steps.</li>
          <li>Teams shows a long web address. <b>Copy it</b> and paste it below. Anyone with that address can post in the channel, so treat it like a password.</li>
        </ol>
      </details>

      <div className="mt-4 space-y-4">
        <label className="block text-sm font-semibold text-fg">Webhook address
          <input className={`${field} mt-1 text-fg`} type="password" autoComplete="new-password" spellCheck={false} placeholder={info.configured ? "Saved. Paste a new one to replace it." : "https://…logic.azure.com/…"} value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <fieldset>
          <legend className="text-sm font-semibold text-fg">Post when</legend>
          <div className="mt-2 space-y-2">
            {info.available.map((e) => (
              <label key={e.id} className="flex cursor-pointer items-start gap-3 text-sm text-fg">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={!!events[e.id]} onChange={(x) => setEvents({ ...events, [e.id]: x.target.checked })} />
                <span>{e.label}<span className="block text-xs text-neutral-600 dark:text-neutral-400">{e.hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <button className={btn} disabled={busy || !dirty} onClick={() => void save()}>Save</button>
          {info.configured && <button className={secondaryBtn} disabled={busy} onClick={() => void remove()}>Remove the address</button>}
        </div>
      </div>
    </section>
  );
}
