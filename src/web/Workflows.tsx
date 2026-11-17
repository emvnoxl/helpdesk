import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { useNotify } from "./notify";
import { btn, btnGhost, card, field } from "./ui";

/* Staff > Library: checklists (jobs with many steps: a new starter, a leaver) and, for admins, recurring tickets (jobs that come
   round again: backup checks, renewals) and the working hours the response targets count in. */

export interface Checklist { id: number; name: string; description: string; category_id: number | null; category: string | null; items: string[] }
interface Named { id: number; name: string }

const label = "block text-sm font-semibold";
const small = "text-xs font-bold uppercase tracking-wider text-neutral-500";
const guard = (onExpired: () => void, toast: (t: string, k?: any, title?: string) => void, title: string) => (e: unknown) =>
  (e as ApiError).status === 401 ? onExpired() : toast((e as Error).message, "error", title);

/* ---------------- checklists ---------------- */
interface ListDraft { id: number | null; name: string; description: string; category_id: string; items: string }

export function Checklists({ admin, open, onExpired }: { admin: boolean; open: (id: number) => void; onExpired: () => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<Checklist[] | null>(null);
  const [cats, setCats] = useState<Named[]>([]);
  const [d, setD] = useState<ListDraft | null>(null);
  const [starting, setStarting] = useState<{ id: number; subject: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = guard(onExpired, toast, "Couldn't save the checklist");
  const load = useCallback(() => api<Checklist[]>("/staff/checklists").then(setRows, fail), []);
  useEffect(() => { void load(); void api<Named[]>("/staff/tickets/categories").then(setCats, () => {}); }, [load]);

  const save = async () => {
    if (!d) return;
    const json = { name: d.name, description: d.description, category_id: d.category_id ? Number(d.category_id) : null, items: d.items.split("\n") };
    try {
      if (d.id) await api(`/staff/checklists/${d.id}`, { method: "PATCH", json });
      else await api("/staff/checklists", { method: "POST", json });
      setD(null);
      await load();
    } catch (e) { fail(e); }
  };
  const del = async (k: Checklist) => {
    if (!(await confirm({ title: "Delete this checklist?", body: `“${k.name}”. Tickets already started keep their steps.`, confirmLabel: "Delete", tone: "danger" }))) return;
    await api(`/staff/checklists/${k.id}`, { method: "DELETE" }).then(load, fail);
  };
  const start = async () => {
    if (!starting) return;
    setBusy(true);
    try {
      const t = await api<{ id: number; ref: string }>(`/staff/checklists/${starting.id}/start`, { method: "POST", json: { subject: starting.subject, note: starting.note } });
      setStarting(null);
      toast("It is in your queue with every step on it.", "success", `${t.ref} started`);
      open(t.id);
    } catch (e) { guard(onExpired, toast, "Couldn't start the checklist")(e); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-neutral-500">For jobs with many steps, where one is easily missed. <b>Start</b> raises a ticket in your queue with the steps on it; tick them off as you go. You can also add a checklist to any ticket from its page.</p>
        {admin && <button className={btn} onClick={() => setD({ id: null, name: "", description: "", category_id: "", items: "" })}>New checklist</button>}
      </div>

      {d && (
        <div className={card + " space-y-3"}>
          <input className={field} placeholder="Name, e.g. New starter" aria-label="Checklist name" maxLength={80} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          <input className={field} placeholder="What it is for (optional)" aria-label="Description" maxLength={1000} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
          <select className={field + " !w-auto"} aria-label="Category of the ticket" value={d.category_id} onChange={(e) => setD({ ...d, category_id: e.target.value })}>
            <option value="">No category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <textarea className={field + " min-h-48"} placeholder={"One step per line\nCreate the account\nPrepare a laptop"} aria-label="Steps, one per line" value={d.items} onChange={(e) => setD({ ...d, items: e.target.value })} />
          <div className="flex gap-3"><button className={btn} onClick={() => void save()}>Save checklist</button><button className={btnGhost} onClick={() => setD(null)}>Cancel</button></div>
        </div>
      )}

      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {(rows ?? []).map((k) => (
          <li key={k.id} className={card + " flex min-w-0 flex-col"}>
            <div className="flex items-start gap-2">
              <h3 className="min-w-0 flex-1 truncate text-lg font-extrabold">{k.name}</h3>
              <span className="whitespace-nowrap rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-600">{k.items.length} steps</span>
            </div>
            {k.description && <p className="mt-0.5 text-sm text-neutral-500">{k.description}</p>}
            <ol className="mt-3 flex-1 space-y-1 text-sm text-neutral-600">
              {k.items.slice(0, 4).map((it, i) => <li key={i} className="flex gap-2"><span className="mt-1 h-3.5 w-3.5 shrink-0 rounded border border-stone-400" aria-hidden /><span className="min-w-0 truncate">{it}</span></li>)}
              {k.items.length > 4 && <li className="pl-5.5 text-xs text-neutral-500">and {k.items.length - 4} more</li>}
            </ol>
            {starting?.id === k.id ? (
              <div className="mt-4 space-y-2 rounded-xl bg-stone-100 p-3">
                <input autoFocus className={field} placeholder="Who or what is it for? e.g. Ama Boateng" aria-label="Who or what is it for" maxLength={120} value={starting.subject}
                  onChange={(e) => setStarting({ ...starting, subject: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && starting.subject.trim()) void start(); }} />
                <textarea className={field} rows={2} placeholder="Notes (optional): start date, department, manager…" aria-label="Notes" value={starting.note} onChange={(e) => setStarting({ ...starting, note: e.target.value })} />
                <div className="flex gap-2"><button className={btn} disabled={busy || !starting.subject.trim()} onClick={() => void start()}>{busy ? "Starting…" : "Start"}</button><button className={btnGhost} onClick={() => setStarting(null)}>Cancel</button></div>
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-3 text-xs">
                <button className={btn} onClick={() => setStarting({ id: k.id, subject: "", note: "" })}>Start</button>
                {admin && <><button className="ml-auto font-semibold hover:underline" onClick={() => setD({ id: k.id, name: k.name, description: k.description, category_id: k.category_id ? String(k.category_id) : "", items: k.items.join("\n") })}>Edit</button><button className="font-semibold text-red-700 hover:underline" onClick={() => void del(k)}>Delete</button></>}
              </div>
            )}
          </li>
        ))}
        {rows && !rows.length && <li className="text-sm text-neutral-500">No checklists yet.</li>}
      </ul>
    </div>
  );
}

/* ---------------- recurring tickets (admin) ---------------- */
const EVERY: [string, string][] = [["daily", "Every day"], ["weekdays", "Every weekday"], ["weekly", "Every week"], ["monthly", "Every month"], ["quarterly", "Every 3 months"], ["yearly", "Every year"]];
const everyLabel = (v: string) => EVERY.find(([k]) => k === v)?.[1] ?? v;
// Runs are stored as 08:00 UTC, which is 08:00 in Ghana; shown as a plain date.
const dateOf = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const isoOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

interface Rec {
  id: number; title: string; description: string; category_id: number | null; category: string | null; priority: string; assignee_id: number | null; assignee: string | null;
  checklist_id: number | null; checklist: string | null; every: string; next_at: number; last_run_at: number | null; last_ticket_id: number | null; last_ref: string | null; active: number;
}
interface RecDraft { id: number | null; title: string; description: string; every: string; start: string; priority: string; category_id: string; assignee_id: string; checklist_id: string }

export function Recurring({ open, onExpired }: { open: (id: number) => void; onExpired: () => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [cats, setCats] = useState<Named[]>([]);
  const [agents, setAgents] = useState<Named[]>([]);
  const [lists, setLists] = useState<Checklist[]>([]);
  const [d, setD] = useState<RecDraft | null>(null);
  const fail = guard(onExpired, toast, "Couldn't save it");
  const load = useCallback(() => api<Rec[]>("/admin/recurring").then(setRows, fail), []);
  useEffect(() => {
    void load();
    void api<Named[]>("/staff/tickets/categories").then(setCats, () => {});
    void api<Named[]>("/staff/tickets/agents").then(setAgents, () => {});
    void api<Checklist[]>("/staff/checklists").then(setLists, () => {});
  }, [load]);

  const tomorrow = isoOf(Math.floor(Date.now() / 1000) + 86400);
  const blank = (): RecDraft => ({ id: null, title: "", description: "", every: "monthly", start: tomorrow, priority: "medium", category_id: "", assignee_id: "", checklist_id: "" });
  const edit = (r: Rec): RecDraft => ({
    id: r.id, title: r.title, description: r.description, every: r.every, start: isoOf(r.next_at), priority: r.priority,
    category_id: r.category_id ? String(r.category_id) : "", assignee_id: r.assignee_id && r.assignee ? String(r.assignee_id) : "", checklist_id: r.checklist_id && r.checklist ? String(r.checklist_id) : "",
  });
  const save = async () => {
    if (!d) return;
    const json = { ...d, category_id: d.category_id ? Number(d.category_id) : null, assignee_id: d.assignee_id ? Number(d.assignee_id) : null, checklist_id: d.checklist_id ? Number(d.checklist_id) : null };
    try {
      if (d.id) await api(`/admin/recurring/${d.id}`, { method: "PATCH", json });
      else await api("/admin/recurring", { method: "POST", json });
      setD(null);
      await load();
    } catch (e) { fail(e); }
  };
  const toggle = (r: Rec) => api(`/admin/recurring/${r.id}`, { method: "PATCH", json: { active: !r.active } }).then(load, fail);
  const runNow = async (r: Rec) => {
    try {
      const t = await api<{ id: number; ref: string }>(`/admin/recurring/${r.id}/run`, { method: "POST", json: {} });
      toast("The schedule itself is unchanged.", "success", `${t.ref} raised`);
      await load();
    } catch (e) { fail(e); }
  };
  const del = async (r: Rec) => {
    if (!(await confirm({ title: "Delete this recurring ticket?", body: `“${r.title}”. Tickets it already raised are kept.`, confirmLabel: "Delete", tone: "danger" }))) return;
    await api(`/admin/recurring/${r.id}`, { method: "DELETE" }).then(load, fail);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-neutral-500">Jobs that come round again: backup checks, licence renewals, UPS tests. The ticket appears at 8:00 on the day, so it is in the queue instead of in someone's memory.</p>
        <button className={btn} onClick={() => setD(blank())}>New recurring ticket</button>
      </div>

      {d && (
        <div className={card + " space-y-3"}>
          <input className={field} placeholder="Title, e.g. Check last night's backups" aria-label="Title" maxLength={200} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <textarea className={field} rows={3} placeholder="What needs doing (optional)" aria-label="Description" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label className={label}>Repeats
              <select className={field + " mt-1"} value={d.every} onChange={(e) => setD({ ...d, every: e.target.value })}>{EVERY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </label>
            <label className={label}>{d.id ? "Next one on" : "First one on"}
              <input type="date" className={field + " mt-1"} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} />
            </label>
            <label className={label}>Priority
              <select className={field + " mt-1 capitalize"} value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })}>{["low", "medium", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</select>
            </label>
            <label className={label}>Category
              <select className={field + " mt-1"} value={d.category_id} onChange={(e) => setD({ ...d, category_id: e.target.value })}><option value="">None</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
            <label className={label}>Assign to
              <select className={field + " mt-1"} value={d.assignee_id} onChange={(e) => setD({ ...d, assignee_id: e.target.value })}><option value="">Nobody (goes to triage)</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </label>
            <label className={label}>Checklist
              <select className={field + " mt-1"} value={d.checklist_id} onChange={(e) => setD({ ...d, checklist_id: e.target.value })}><option value="">None</option>{lists.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select>
            </label>
          </div>
          <div className="flex gap-3"><button className={btn} onClick={() => void save()}>Save</button><button className={btnGhost} onClick={() => setD(null)}>Cancel</button></div>
        </div>
      )}

      <ul className="space-y-2.5">
        {(rows ?? []).map((r) => (
          <li key={r.id} className={`${card} flex flex-wrap items-center gap-x-4 gap-y-2 ${r.active ? "" : "opacity-60"}`}>
            <div className="min-w-0 flex-1 basis-64">
              <div className="truncate font-bold">{r.title}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-neutral-500">
                <span>{everyLabel(r.every)}</span>
                <span>{r.assignee ? `→ ${r.assignee}` : "→ triage"}</span>
                {r.checklist && <span>with “{r.checklist}”</span>}
                {r.category && <span>{r.category}</span>}
              </div>
            </div>
            <div className="text-sm">
              <div className={small}>{r.active ? "Next" : "Paused"}</div>
              <div className="font-semibold">{r.active ? dateOf(r.next_at) : "—"}</div>
            </div>
            <div className="w-24 text-sm">
              <div className={small}>Last</div>
              {r.last_ref && r.last_ticket_id ? <button className="font-semibold hover:underline" onClick={() => open(r.last_ticket_id!)}>{r.last_ref}</button> : <span className="text-neutral-500">Never</span>}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <button className="rounded-lg border border-stone-300 px-3 py-1.5 font-semibold hover:bg-stone-100" onClick={() => void runNow(r)}>Raise now</button>
              <button className="font-semibold hover:underline" onClick={() => void toggle(r)}>{r.active ? "Pause" : "Resume"}</button>
              <button className="font-semibold hover:underline" onClick={() => setD(edit(r))}>Edit</button>
              <button className="font-semibold text-red-700 hover:underline" onClick={() => void del(r)}>Delete</button>
            </div>
          </li>
        ))}
        {rows && !rows.length && <li className="rounded-2xl border border-dashed border-stone-300 bg-surface p-8 text-center text-sm text-neutral-500">Nothing recurring yet. A monthly “Check the backups restore” is a good first one.</li>}
      </ul>
    </div>
  );
}

/* ---------------- working hours for the response targets (admin) ---------------- */
interface Cal { enabled: boolean; days: number[]; start: number; end: number; holidays: string[] }
const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const mins = (s: string) => { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

export function WorkingHours({ calendar, hours, onSaved, onExpired }: { calendar: Cal; hours: Record<string, string>; onSaved: (c: Cal) => void; onExpired: () => void }) {
  const { toast } = useNotify();
  const [c, setC] = useState<Cal>(calendar);
  const [holidays, setHolidays] = useState(calendar.holidays.join("\n"));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ calendar: Cal }>("/admin/sla/calendar", { method: "PUT", json: { ...c, holidays: holidays.split(/[\s,]+/).filter(Boolean) } });
      setC(r.calendar);
      setHolidays(r.calendar.holidays.join("\n"));
      onSaved(r.calendar);
      toast(r.calendar.enabled ? "Nights, weekends and holidays no longer count against IT." : "The clock runs around the clock again.", "success", "Working hours saved");
    } catch (e) { guard(onExpired, toast, "Couldn't save the working hours")(e); } finally { setBusy(false); }
  };
  const dayLen = Math.max(0, c.end - c.start) / 60;
  const medium = Number(hours.medium) || 24;

  return (
    <div className={card + " mx-auto max-w-xl space-y-4"}>
      <div>
        <h2 className="text-lg font-extrabold">Working hours</h2>
        <p className="mt-1 text-sm text-neutral-500">Count the targets in office time only. A ticket raised on Friday evening then starts its clock on Monday morning instead of being overdue by the time anyone is in.</p>
      </div>
      <label className="flex items-center gap-3 text-sm font-semibold">
        <input type="checkbox" className="h-5 w-5 accent-[#00a859]" checked={c.enabled} onChange={(e) => setC({ ...c, enabled: e.target.checked })} />
        Count working hours only
      </label>
      <div className={c.enabled ? "space-y-4" : "pointer-events-none space-y-4 opacity-50"} aria-disabled={!c.enabled}>
        <div>
          <div className={small + " mb-1.5"}>Working days</div>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map(([n, name]) => {
              const on = c.days.includes(n);
              return <button key={n} type="button" aria-pressed={on} tabIndex={c.enabled ? 0 : -1} onClick={() => setC({ ...c, days: on ? c.days.filter((x) => x !== n) : [...c.days, n] })}
                className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors ${on ? "bg-ink text-white ring-ink dark:bg-brand-green dark:text-ink dark:ring-brand-green" : "text-neutral-600 ring-stone-300 hover:bg-stone-100"}`}>{name}</button>;
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>From<input type="time" tabIndex={c.enabled ? 0 : -1} className={field + " mt-1"} value={hm(c.start)} onChange={(e) => setC({ ...c, start: mins(e.target.value) })} /></label>
          <label className={label}>To<input type="time" tabIndex={c.enabled ? 0 : -1} className={field + " mt-1"} value={hm(c.end)} onChange={(e) => setC({ ...c, end: mins(e.target.value) })} /></label>
        </div>
        <label className={label}>Public holidays <span className="font-normal text-neutral-500">(one date per line, like 2026-12-25)</span>
          <textarea tabIndex={c.enabled ? 0 : -1} className={field + " mt-1 font-mono"} rows={3} placeholder={"2026-12-25\n2026-12-26"} value={holidays} onChange={(e) => setHolidays(e.target.value)} />
        </label>
        {dayLen > 0 && <p className="text-xs text-neutral-500">With a {Math.round(dayLen * 10) / 10}-hour day, the medium target of {medium} hours is about {Math.round((medium / dayLen) * 10) / 10} working days. Adjust the targets above if that is longer than you mean. Times are Ghana time.</p>}
      </div>
      <button className={btn} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save working hours"}</button>
    </div>
  );
}
