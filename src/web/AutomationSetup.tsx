import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { field } from "./ui";

/* Admin > System > Automation: housekeeping the helpdesk can do by itself. */

export interface AutomationInfo { auto_close_days: number; choices: number[]; due_now: number; last: { at: number; closed: number } | null }
const card = "rounded-2xl border border-fg/10 bg-surface p-5";
const muted = "text-sm text-neutral-600 dark:text-neutral-400";
const ago = (ts: number) => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

export function useAutomationInfo() {
  const [info, setInfo] = useState<AutomationInfo | null>(null);
  const load = useCallback(async () => { try { setInfo(await api<AutomationInfo>("/admin/automation")); } catch { /* shown by the panel */ } }, []);
  useEffect(() => { void load(); }, [load]);
  return { info, load };
}

export function AutomationSetup({ info, onChanged }: { info: AutomationInfo; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [busy, setBusy] = useState(false);

  const set = async (days: number) => {
    if (days && days < info.auto_close_days || (days && !info.auto_close_days)) {
      // Choosing a number acts straight away on everything already that old, so say what that is.
      const ok = await confirm({ title: `Close tickets ${days} day${days === 1 ? "" : "s"} after they are resolved?`, body: "Any ticket that has already been resolved for that long is closed right now, and its requester is told. A requester who writes back on a resolved ticket reopens it, so nothing they are still discussing is closed.", confirmLabel: "Turn it on" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api<{ closed: number }>("/admin/automation", { method: "PUT", json: { auto_close_days: days } });
      toast(days ? (r.closed ? `On. ${r.closed} ticket${r.closed === 1 ? "" : "s"} closed now.` : "On. Nothing was old enough to close yet.") : "Switched off. You close resolved tickets by hand again.", "success", "Automation");
      onChanged();
    } catch (e) { toast((e as Error).message, "error", "Couldn't save"); }
    setBusy(false);
  };

  return (
    <section className={card}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Close resolved tickets automatically</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${info.auto_close_days ? "bg-brand-green text-ink" : "bg-fg/10 text-fg"}`}>{info.auto_close_days ? `After ${info.auto_close_days} day${info.auto_close_days === 1 ? "" : "s"}` : "Off"}</span>
      </div>
      <p className={`mt-2 ${muted}`}>
        Agents mark tickets <b className="text-fg">resolved</b>, and only an admin can close them. Instead of closing them by hand at the end of the day, the helpdesk can close a ticket once it has been resolved for a few days. The requester is told, and a requester who writes back before then reopens it, so nothing still being discussed is closed.
      </p>
      <label className="mt-4 block text-sm font-semibold text-fg">Close a resolved ticket after
        <select className={`${field} mt-1 !w-auto text-fg`} value={info.auto_close_days} disabled={busy} onChange={(e) => void set(Number(e.target.value))}>
          {info.choices.map((d) => <option key={d} value={d}>{d === 0 ? "Never (I close them myself)" : `${d} day${d === 1 ? "" : "s"}`}</option>)}
        </select>
      </label>
      {info.last && <p className={`mt-3 ${muted}`}>Last automatic close: <b className="text-fg">{info.last.closed}</b> ticket{info.last.closed === 1 ? "" : "s"}, {ago(info.last.at)}.</p>}
    </section>
  );
}
