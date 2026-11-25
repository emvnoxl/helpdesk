import { useEffect, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { Badge } from "./TicketView";
import { btn, card, field } from "./ui";

/* Staff: "same problem as another ticket". Link a ticket to the main one, so IT answers once and everyone follows. */

interface Linked { id: number; ref: string; title: string; status: string; requester?: string }

const open = (role: string, id: number) => `${role === "admin" ? "/admin" : "/agent"}?t=${id}`;

export function DuplicatesCard({ base, id, role, ticket, duplicateOf, duplicates, closed, onChanged }: { base: string; id: number; role: string; ticket: { ref: string; requester: string }; duplicateOf: Linked | null; duplicates: Linked[]; closed: boolean; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<any[]>([]);
  const [chosen, setChosen] = useState<any | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!picking || chosen) return;
    const t = setTimeout(() => {
      void api<any[]>(`/staff/tickets?status=open&limit=15&q=${encodeURIComponent(q.trim())}`)
        .then((r) => setFound(r.filter((x) => x.id !== id)))
        .catch(() => setFound([]));
    }, q.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [picking, q, chosen, id]);

  const close = () => { setPicking(false); setChosen(null); setQ(""); setMessage(""); };
  const mark = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api(`${base}/${id}/duplicate`, { method: "POST", json: { of: chosen.id, message: message.trim() || undefined } });
      toast(`${ticket.ref} now follows ${chosen.ref}. ${ticket.requester.split(" ")[0]} has been told.`, "success", "Linked");
      close();
      onChanged();
    } catch (e) { toast((e as Error).message, "error", "Couldn't link the tickets"); }
    setBusy(false);
  };
  const unlink = async () => {
    if (!(await confirm({ title: `Unlink ${ticket.ref}?`, body: `It stops following ${duplicateOf?.ref}. The message already sent to the requester stays.`, confirmLabel: "Unlink" }))) return;
    try { await api(`${base}/${id}/duplicate`, { method: "DELETE" }); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
  };

  return (
    <section className={card + " space-y-3"} aria-label="Same problem as another ticket">
      <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Same problem?</h3>
      {duplicateOf ? (
        <div className="space-y-2">
          <p className="text-sm text-fg">This follows <a className="font-bold underline underline-offset-2" href={open(role, duplicateOf.id)}>{duplicateOf.ref}</a>: {duplicateOf.title}. <Badge v={duplicateOf.status} /></p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">Answer it there. When {duplicateOf.ref} is resolved, this one is resolved with it.</p>
          {!closed && <button type="button" className="text-sm font-semibold text-red-700 underline underline-offset-2" onClick={() => void unlink()}>Unlink</button>}
        </div>
      ) : (
        !closed && <button type="button" className={btn + " !py-1.5"} onClick={() => setPicking(true)}>Mark as a duplicate…</button>
      )}
      {duplicates.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-semibold text-fg">{duplicates.length} other ticket{duplicates.length === 1 ? " follows" : "s follow"} this one</p>
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 text-sm">
            {duplicates.map((x) => (
              <li key={x.id} className="flex items-center gap-2 px-3 py-1.5">
                <a className="font-bold underline underline-offset-2" href={open(role, x.id)}>{x.ref}</a>
                <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-400">{x.requester}</span>
                <Badge v={x.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {!duplicateOf && !duplicates.length && !picking && <p className="text-xs text-neutral-600 dark:text-neutral-400">Several people reporting the same outage? Link them to one ticket: you answer once and everyone is told.</p>}

      {picking && (
        <div className="fixed inset-0 z-[95] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Mark as a duplicate" onKeyDown={(e) => e.key === "Escape" && close()}>
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl" style={{ borderTop: "5px solid #00a859" }}>
            <div className="space-y-3 p-5">
              <h3 className="text-lg font-extrabold">{chosen ? `Tell the requester` : `${ticket.ref} is the same problem as…`}</h3>
              {!chosen ? (
                <>
                  <input autoFocus className={`${field} text-fg`} type="search" placeholder="Search an open ticket by number, title or name…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tickets" />
                  <ul className="max-h-64 divide-y divide-stone-200 overflow-y-auto rounded-xl border border-stone-200">
                    {found.map((x) => (
                      <li key={x.id}>
                        <button type="button" onClick={() => setChosen(x)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fg/5 focus:outline-none focus-visible:bg-fg/5">
                          <b>{x.ref}</b><span className="min-w-0 flex-1 truncate">{x.title}</span><span className="shrink-0 text-xs text-neutral-500">{x.requester}</span>
                        </button>
                      </li>
                    ))}
                    {!found.length && <li className="px-3 py-6 text-center text-sm text-neutral-500">{q.trim() ? "No open ticket matches." : "Loading…"}</li>}
                  </ul>
                </>
              ) : (
                <>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">{ticket.ref} will follow <b className="text-fg">{chosen.ref}</b>. This message goes to {ticket.requester.split(" ")[0]} on their ticket (leave it empty to send the standard one):</p>
                  <textarea className={`${field} min-h-[6rem] text-fg`} maxLength={2000} placeholder={`Hi ${ticket.requester.split(" ")[0]}, this is the same problem that others have reported (${chosen.ref}). IT is working on it there and will update you here as soon as it is fixed.`} value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Message to the requester" />
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-fg/5 px-5 py-3">
              {chosen && <button type="button" className="mr-auto text-sm font-semibold text-neutral-600 hover:text-fg" onClick={() => setChosen(null)}>← Pick another</button>}
              <button type="button" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-fg/10" onClick={close}>Cancel</button>
              {chosen && <button type="button" className={btn} disabled={busy} onClick={() => void mark()}>{busy ? "Linking…" : "Mark as duplicate"}</button>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
