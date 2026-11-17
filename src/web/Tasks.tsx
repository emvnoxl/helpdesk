import { useEffect, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { card, field } from "./ui";
import type { Checklist } from "./Workflows";

/* The checklist on a ticket (staff only): steps to tick off, with a progress bar. Steps come from a template (Library > Checklists),
   a recurring ticket, or are typed in here. Requesters never see it. */

export interface Task { id: number; text: string; done: number; done_at: number | null; done_by: string | null }

export function TaskList({ base, id, tasks, readOnly, onChanged }: { base: string; id: number; tasks: Task[]; readOnly: boolean; onChanged: () => void }) {
  const { toast } = useNotify();
  const [local, setLocal] = useState(tasks);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [lists, setLists] = useState<Checklist[] | null>(null);
  useEffect(() => setLocal(tasks), [tasks]);

  const call = async (path: string, init: RequestInit & { json?: unknown }, optimistic?: Task[]) => {
    if (optimistic) setLocal(optimistic);
    try {
      const r = await api<{ tasks: Task[] }>(`${base}/${id}/tasks${path}`, init);
      setLocal(r.tasks);
      onChanged();
      return true;
    } catch (e) {
      setLocal(tasks);
      toast((e as Error).message, "error", "Couldn't update the checklist");
      return false;
    }
  };
  const toggle = (k: Task) => void call(`/${k.id}`, { method: "PATCH", json: { done: !k.done } }, local.map((x) => (x.id === k.id ? { ...x, done: k.done ? 0 : 1 } : x)));
  const remove = (k: Task) => void call(`/${k.id}`, { method: "DELETE" }, local.filter((x) => x.id !== k.id));
  const add = async () => { if (text.trim() && (await call("", { method: "POST", json: { text } }))) setText(""); };
  const openAdd = () => { setAdding(true); if (!lists) void api<Checklist[]>("/staff/checklists").then(setLists, () => setLists([])); };

  const done = local.filter((k) => k.done).length;
  if (!local.length && readOnly) return null;

  return (
    <section className={card} aria-label="Checklist">
      <div className="flex items-center gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Checklist</h3>
        {local.length > 0 && <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${done === local.length ? "bg-brand-green text-ink" : "bg-stone-100 text-neutral-700"}`}>{done} of {local.length}</span>}
        {!readOnly && !adding && <button className="ml-auto text-xs font-semibold text-neutral-500 hover:text-fg hover:underline" onClick={openAdd}>{local.length ? "Add" : "Add steps or a checklist"}</button>}
      </div>
      {local.length > 0 && (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuemin={0} aria-valuemax={local.length} aria-valuenow={done} aria-label="Steps done">
            <div className="h-full rounded-full bg-brand-green transition-[width] duration-500" style={{ width: `${(done / local.length) * 100}%` }} />
          </div>
          <ul className="mt-3 space-y-0.5">
            {local.map((k) => (
              <li key={k.id} className="group flex items-start gap-1">
                <label className={`flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-stone-100 ${readOnly ? "pointer-events-none" : ""}`}>
                  <input type="checkbox" className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[#00a859]" checked={!!k.done} disabled={readOnly} onChange={() => toggle(k)} />
                  <span className={`min-w-0 break-words ${k.done ? "text-neutral-500 line-through" : ""}`} title={k.done && k.done_by ? `Ticked by ${k.done_by}` : undefined}>{k.text}</span>
                </label>
                {!readOnly && (
                  <button aria-label={`Remove step: ${k.text}`} title="Remove this step" onClick={() => remove(k)}
                    className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-neutral-400 opacity-0 hover:bg-stone-200 hover:text-red-700 focus:opacity-100 group-hover:opacity-100">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {adding && !readOnly && (
        <div className="mt-3 space-y-2 rounded-xl bg-stone-100 p-3">
          <div className="flex gap-2">
            <input autoFocus className={field} placeholder="Add a step…" aria-label="New step" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); if (e.key === "Escape") setAdding(false); }} />
            <button className="rounded-lg border border-stone-300 bg-surface px-3 text-sm font-semibold hover:bg-stone-50 disabled:opacity-40" disabled={!text.trim()} onClick={() => void add()}>Add</button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className={field + " !w-auto min-w-0 flex-1"} aria-label="Add a whole checklist" value="" onChange={(e) => { if (e.target.value) void call("", { method: "POST", json: { template_id: Number(e.target.value) } }); }}>
              <option value="">{lists ? "Or add a whole checklist…" : "Loading checklists…"}</option>
              {(lists ?? []).map((l) => <option key={l.id} value={l.id}>{l.name} ({l.items.length} steps)</option>)}
            </select>
            <button className="text-xs font-semibold text-neutral-500 hover:text-fg" onClick={() => setAdding(false)}>Done</button>
          </div>
        </div>
      )}
    </section>
  );
}
