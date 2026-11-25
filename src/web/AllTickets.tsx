import { useEffect, useState } from "react";
import { api, fmt } from "./api";
import { useNotify } from "./notify";
import { Badge } from "./TicketView";
import { btn, card, field } from "./ui";

const STATUS = ["open", "in_progress", "waiting", "resolved", "closed"];

/** Every ticket, for agents and admins, with status and assignee filters. Tick several to change them all at once. */
export function AllTickets({ open }: { open: (id: number) => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<any[] | null>(null);
  const [filter, setFilter] = useState("open");
  const [who, setWho] = useState("all");
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [agents, setAgents] = useState<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = (before?: number) =>
    api<any[]>(`/staff/tickets?limit=25&status=${filter}${who !== "all" ? `&assignee=${who}` : ""}${before ? `&before=${before}` : ""}`).then(
      (r) => { setRows((p) => (before && p ? [...p, ...r] : r)); setMore(r.length === 25); setErr(""); },
      (e) => setErr(e.message),
    );
  useEffect(() => {
    setRows(null);
    setSel(new Set());
    void load();
  }, [filter, who]);
  useEffect(() => { void api<{ id: number; name: string }[]>("/staff/tickets/agents").then(setAgents).catch(() => {}); }, []);

  const shown = rows ?? [];
  const all = shown.length > 0 && shown.every((t) => sel.has(t.id));
  const toggle = (id: number) => setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  /** The same PATCH one ticket at a time, so every rule (who may close, a locked priority) is checked for each. A few at once. */
  async function apply(label: string, json: Record<string, unknown>) {
    const ids = [...sel];
    if (!ids.length) return;
    if (json.status === "resolved" || json.status === "closed") {
      if (!(await confirm({ title: `${label} ${ids.length} ticket${ids.length === 1 ? "" : "s"}?`, body: "Their requesters are told. You can still reopen them one by one.", confirmLabel: label }))) return;
    }
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    const byId = new Map(shown.map((t) => [t.id, t]));
    const queue = [...ids];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift()!;
        try { await api(`/staff/tickets/${id}`, { method: "PATCH", json }); done++; }
        catch (e) { failed.push(`${byId.get(id)?.ref ?? id}: ${(e as Error).message}`); }
      }
    }));
    setBusy(false);
    setSel(new Set());
    toast(failed.length ? `${done} done. ${failed.length} could not be changed (${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "; …" : ""}).` : `${done} ticket${done === 1 ? "" : "s"} updated.`, failed.length ? "error" : "success", "Bulk change");
    setRows(null);
    await load();
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <select aria-label="Status" className={field + " !w-auto"} value={filter} onChange={(e) => setFilter(e.target.value)}>
          {STATUS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <select aria-label="Assignee" className={field + " !w-auto"} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="all">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
        </select>
      </div>
      {sel.size > 0 && (
        <div className="sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-brand-green bg-surface px-4 py-2.5 shadow-lg" role="region" aria-label="Change the selected tickets">
          <span className="text-sm font-bold text-fg">{sel.size} selected</span>
          <select aria-label="Assign the selected tickets" className={field + " !w-auto"} value="" disabled={busy} onChange={(e) => { if (e.target.value) void apply("Assign", { assignee_id: e.target.value === "none" ? null : Number(e.target.value) }); }}>
            <option value="">Assign to…</option>
            <option value="none">Nobody (back to triage)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select aria-label="Set the status of the selected tickets" className={field + " !w-auto"} value="" disabled={busy} onChange={(e) => { if (e.target.value) void apply(e.target.value === "resolved" ? "Resolve" : e.target.value === "closed" ? "Close" : "Update", { status: e.target.value }); }}>
            <option value="">Set status…</option>
            {STATUS.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
          </select>
          <select aria-label="Set the priority of the selected tickets" className={field + " !w-auto"} value="" disabled={busy} onChange={(e) => { if (e.target.value) void apply("Update", { priority: e.target.value }); }}>
            <option value="">Set priority…</option>
            {["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button type="button" className="ml-auto text-sm font-semibold text-neutral-600 hover:text-fg" onClick={() => setSel(new Set())}>Clear</button>
          {busy && <span className="text-sm text-neutral-600" role="status">Working…</span>}
        </div>
      )}
      {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <div className={card + " overflow-x-auto !p-0"}>
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-xs uppercase text-neutral-500">
            <tr>
              <th className="w-10 p-3"><input type="checkbox" aria-label="Select all shown" className="h-4 w-4 accent-[#00a859]" checked={all} onChange={() => setSel(all ? new Set() : new Set(shown.map((t) => t.id)))} /></th>
              <th>Ref</th><th>Title</th><th>Requester</th><th>Assigned</th><th>Status</th><th>Priority</th><th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t, i) => (
              <tr key={t.id} className={`rise-in cursor-pointer border-b last:border-0 hover:bg-stone-50 ${sel.has(t.id) ? "bg-brand-green/10" : ""}`} style={{ ["--i" as string]: i }} onClick={() => open(t.id)}>
                <td className="p-3" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${t.ref}`} className="h-4 w-4 accent-[#00a859]" checked={sel.has(t.id)} onChange={() => toggle(t.id)} /></td>
                <td className="font-semibold">{t.ref}</td><td>{t.title}</td><td>{t.requester}</td>
                <td>{t.assignee ?? <span className="text-neutral-400">Unassigned</span>}</td>
                <td><Badge v={t.status} /></td><td><Badge v={t.priority} /></td><td className="whitespace-nowrap">{fmt(t.updated_at)}</td>
              </tr>
            ))}
            {rows && !rows.length && <tr><td className="p-6 text-center text-neutral-500" colSpan={8}>No tickets here.</td></tr>}
            {!rows && <tr><td className="p-6 text-center text-neutral-500" colSpan={8}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      {more && rows && <button className={btn + " mt-3"} onClick={() => load(rows[rows.length - 1].id)}>Load more</button>}
    </div>
  );
}
