import { useEffect, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { Portal } from "./Portal";
import { btn, field } from "./ui";

/* Restore a backup from Admin > System > Backups. Two steps for safety: look at what is inside (and compare with now), then type RESTORE.
   Everything risky is handled on the server (a safety backup first, a swap at the next start, the old database kept aside). */

interface Counts { users: number; tickets: number; comments: number }
export interface Inspection { ok: boolean; error?: string; users?: number; admins?: number; tickets?: number; comments?: number; version?: number; bytes?: number }
export interface RestoreTarget { from: string; title: string; at?: number; inspection?: Inspection; now?: Counts; upload?: boolean }

const when = (ts: number) => new Date(ts * 1000).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function RestoreDialog({ target, onClose }: { target: RestoreTarget; onClose: () => void }) {
  const { toast } = useNotify();
  const [info, setInfo] = useState<{ inspection: Inspection; now: Counts; at?: number } | null>(target.inspection && target.now ? { inspection: target.inspection, now: target.now, at: target.at } : null);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<{ safety: string } | null>(null);

  useEffect(() => {
    if (info || !target.from.startsWith("backup:")) return;
    void api<{ inspection: Inspection; now: Counts; at: number }>(`/admin/backups/${target.from.slice(7)}/inspect`)
      .then(setInfo)
      .catch((e) => setInfo({ inspection: { ok: false, error: (e as Error).message }, now: { users: 0, tickets: 0, comments: 0 } }));
  }, [info, target.from]);

  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ safety: string }>("/admin/backups/restore", { method: "POST", json: { from: target.from, confirm: "RESTORE" } });
      setStarted(r);
    } catch (e) {
      toast((e as Error).message, "error", "Nothing was changed");
      setBusy(false);
    }
  };

  const i = info?.inspection;
  const row = (label: string, was: number | undefined, now: number | undefined) => (
    <tr className="border-t border-stone-200">
      <td className="py-1.5 pr-4 text-neutral-600 dark:text-neutral-400">{label}</td>
      <td className="py-1.5 pr-4 font-bold text-fg">{was ?? "?"}</td>
      <td className="py-1.5 text-neutral-600 dark:text-neutral-400">{now ?? "?"}{" "}{was !== undefined && now !== undefined && was < now ? <span className="ml-2 text-xs font-semibold text-red-700">{now - was} will be lost</span> : null}</td>
    </tr>
  );

  return (
    <Portal>
    <div className="fixed inset-0 z-[95] grid place-items-center overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Restore a backup" onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}>
      <div className="my-auto w-full max-w-lg overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl" style={{ borderTop: "5px solid #d92b33" }}>
        {started ? (
          <div className="space-y-3 p-6 text-center">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-fg/15 border-t-brand-green" aria-hidden />
            <h3 className="text-lg font-extrabold">Restoring…</h3>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">The helpdesk is restarting with the restored data. This page comes back by itself in about a minute. Your previous state was saved as <span className="font-mono text-fg">{started.safety}</span>, so you can undo this from the same list.</p>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">If nothing happens for two minutes, start the helpdesk again (<span className="font-mono">docker compose up -d</span>): the restore is applied as it starts.</p>
          </div>
        ) : (
          <>
            <div className="space-y-4 p-5">
              <div>
                <h3 className="text-lg font-extrabold">Restore this backup?</h3>
                <p className="mt-0.5 break-all text-sm text-neutral-600 dark:text-neutral-400">{target.title}{info?.at ? ` · made ${when(info.at)}` : ""}</p>
              </div>
              {!info && <p className="text-sm text-neutral-500">Checking the backup…</p>}
              {i && !i.ok && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{i.error}</p>}
              {i?.ok && info && (
                <>
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-neutral-500"><th className="pb-1 pr-4 font-semibold"> </th><th className="pb-1 pr-4 font-semibold">In the backup</th><th className="pb-1 font-semibold">Right now</th></tr></thead>
                    <tbody>{row("Tickets", i.tickets, info.now.tickets)}{row("Messages", i.comments, info.now.comments)}{row("People", i.users, info.now.users)}</tbody>
                  </table>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
                    <li><b className="text-fg">A backup of today's state is taken first</b>, so you can undo this from the same list.</li>
                    <li>Everything done since this backup is replaced: tickets, messages, people and settings.</li>
                    <li>The helpdesk restarts for about a minute. Open screens show "being updated" and come back by themselves.</li>
                    <li>Uploaded files are never deleted.</li>
                    {target.upload && <li>A backup from another computer was encrypted with that computer's key: saved email and Microsoft passwords may need entering again.</li>}
                  </ul>
                  <label className="block text-sm font-semibold">Type <span className="font-mono">RESTORE</span> to go ahead
                    <input autoFocus className={`${field} mt-1 text-fg`} value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" spellCheck={false} placeholder="RESTORE" />
                  </label>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-fg/5 px-5 py-3">
              <button type="button" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-fg/10" onClick={onClose} disabled={busy}>Cancel</button>
              {i?.ok && <button type="button" className={`${btn} !bg-[#d92b33] !text-white hover:!brightness-110`} disabled={busy || word !== "RESTORE"} onClick={() => void go()}>{busy ? "Starting…" : "Restore now"}</button>}
            </div>
          </>
        )}
      </div>
    </div>
    </Portal>
  );
}
