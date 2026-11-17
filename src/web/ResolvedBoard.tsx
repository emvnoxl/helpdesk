import { Badge } from "./TicketView";
import { btn } from "./ui";
import { ago } from "./viz";

/** Fixed but not yet closed. Everyone on the team sees it; an admin sweeps it at the end of the day (or closes tickets one by one).
    Resolved tickets stay open for replies until then, so a requester can say "it's back" and the ticket returns to the queue. */
export function ResolvedBoard({
  rows, now, admin, busy, open, onClose, onCloseAll,
}: {
  rows: any[]; now: number; admin: boolean; busy: number | null; open: (id: number) => void; onClose: (id: number) => void; onCloseAll: () => void;
}) {
  const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  const when = (t: any): number => t.resolved_at ?? t.updated_at;
  const today = rows.filter((t) => when(t) >= startOfToday);
  const earlier = rows.filter((t) => when(t) < startOfToday);

  const group = (title: string, list: any[], offset: number) =>
    list.length > 0 && (
      <section>
        <h3 className="mb-2 mt-1 text-xs font-bold uppercase tracking-wider text-neutral-500">{title} · {list.length}</h3>
        <ul className="space-y-2.5">
          {list.map((t, i) => (
            <li key={t.id} className="rise-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm" style={{ ["--i" as string]: offset + i }}>
              <Badge v="resolved" />
              <button onClick={() => open(t.id)} className="font-bold hover:underline">{t.ref}</button>
              <button onClick={() => open(t.id)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline">{t.title}</button>
              <span className="text-sm text-neutral-500">{t.requester}{t.category ? ` · ${t.category}` : ""}{t.assignee ? ` · fixed by ${t.assignee}` : ""}</span>
              <span className="text-sm text-neutral-500">{ago(when(t), now)}</span>
              {admin && (
                <button className={btn} disabled={busy === t.id} onClick={() => onClose(t.id)}>{busy === t.id ? "Closing…" : "Close"}</button>
              )}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm">
        <div className="min-w-0 flex-1">
          <h2 className="font-extrabold">Resolved, waiting to be closed</h2>
          <p className="text-sm text-neutral-500">
            {admin
              ? "Fixed tickets stay open for replies during the day, in case the same issue comes back. Close them when you're done for the day."
              : "These are fixed. An admin closes them at the end of the day, so a requester can still reply until then."}
          </p>
        </div>
        {admin && rows.length > 0 && <button className={btn} onClick={onCloseAll}>Close all {rows.length}</button>}
      </div>
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-10 text-center text-sm text-neutral-500">Nothing is waiting to be closed.</div>
      ) : (
        <>{group("Resolved today", today, 0)}{group("Earlier", earlier, today.length)}</>
      )}
    </div>
  );
}
