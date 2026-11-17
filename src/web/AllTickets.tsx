import { useEffect, useState } from "react";
import { api, fmt } from "./api";
import { Badge } from "./TicketView";
import { btn, card, field } from "./ui";

/** Every ticket, for agents and admins, with status and assignee filters. */
export function AllTickets({ open }: { open: (id: number) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [filter, setFilter] = useState("open");
  const [who, setWho] = useState("all");
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");

  const load = (before?: number) =>
    api<any[]>(`/staff/tickets?limit=25&status=${filter}${who !== "all" ? `&assignee=${who}` : ""}${before ? `&before=${before}` : ""}`).then(
      (r) => { setRows((p) => (before && p ? [...p, ...r] : r)); setMore(r.length === 25); setErr(""); },
      (e) => setErr(e.message),
    );
  useEffect(() => {
    setRows(null);
    void load();
  }, [filter, who]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <select aria-label="Status" className={field + " !w-auto"} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {["open", "in_progress", "waiting", "resolved", "closed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <select aria-label="Assignee" className={field + " !w-auto"} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="all">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
      </div>
      {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <div className={card + " overflow-x-auto !p-0"}>
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-xs uppercase text-neutral-500">
            <tr><th className="p-3">Ref</th><th>Title</th><th>Requester</th><th>Assigned</th><th>Status</th><th>Priority</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {(rows ?? []).map((t, i) => (
              <tr key={t.id} className="rise-in cursor-pointer border-b last:border-0 hover:bg-stone-50" style={{ ["--i" as string]: i }} onClick={() => open(t.id)}>
                <td className="p-3 font-semibold">{t.ref}</td><td>{t.title}</td><td>{t.requester}</td>
                <td>{t.assignee ?? <span className="text-neutral-400">Unassigned</span>}</td>
                <td><Badge v={t.status} /></td><td><Badge v={t.priority} /></td><td className="whitespace-nowrap">{fmt(t.updated_at)}</td>
              </tr>
            ))}
            {rows && !rows.length && <tr><td className="p-6 text-center text-neutral-500" colSpan={7}>No tickets here.</td></tr>}
            {!rows && <tr><td className="p-6 text-center text-neutral-500" colSpan={7}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      {more && rows && <button className={btn + " mt-3"} onClick={() => load(rows[rows.length - 1].id)}>Load more</button>}
    </div>
  );
}
