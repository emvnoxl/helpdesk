import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import { AllTickets } from "./AllTickets";
import { Insights } from "./Insights";
import { Reports } from "./Reports";
import { ActivityLog } from "./ActivityLog";
import { PeoplePanel } from "./PeoplePanel";
import { Assets } from "./Assets";
import { UsersPanel } from "./UsersPanel";
import { CountUp } from "./motion";
import { useNotify } from "./notify";
import { useLive } from "./live";
import { SlidingTabs } from "./Tabs";
import { btn, field } from "./ui";
import { ResolvedBoard } from "./ResolvedBoard";
import { Library } from "./Library";
import { SlaChip } from "./Sla";
import { PriorityChip, STATUS, ago } from "./viz";

/* The work area shared by both portals. Agents get: my queue, needs triage, all tickets.
   Admins also get the analytics dashboard and staff accounts. */

type Tab = "dashboard" | "mine" | "triage" | "resolved" | "tickets" | "library" | "reports" | "activity" | "people" | "assets" | "users";

function Tile({ label, value, accent, sub, i = 0 }: { label: string; value: ReactNode; accent: string; sub?: string; i?: number }) {
  const text = typeof value === "string";
  return (
    <div className="rise-in rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm" style={{ borderLeft: `6px solid ${accent}`, ["--i" as string]: i }}>
      <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`mt-1 truncate font-extrabold leading-none ${text && value.length > 5 ? "text-2xl leading-[2.25rem]" : "text-4xl"}`} title={text ? value : undefined}>{value}</div>
      {sub && <div className="mt-2 truncate text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-10 text-center text-sm text-neutral-500">{children}</div>;
}

export function StaffConsole({ role, meId, open, onExpired }: { role: "agent" | "admin"; meId: number; open: (id: number) => void; onExpired: () => void }) {
  const admin = role === "admin";
  const { toast, confirm } = useNotify();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>(admin ? "dashboard" : "mine");
  const [busy, setBusy] = useState<number | null>(null);

  const fail = useCallback((e: unknown) => ((e as ApiError).status === 401 ? onExpired() : setErr((e as Error).message)), [onExpired]);
  const load = useCallback(() => api("/staff/overview").then((r) => { setD(r); setErr(""); }, fail), [fail]);
  useEffect(() => void load(), [load]);
  useLive("/staff/stream", () => void load()); // new tickets, replies, resolved ones: lists update by themselves

  const act = async (id: number, json: object) => {
    setBusy(id);
    try {
      await api(`/staff/tickets/${id}`, { method: "PATCH", json });
      await load();
    } catch (e) {
      if ((e as ApiError).status === 401) onExpired();
      else toast((e as Error).message, "error", "Couldn't update the ticket");
    } finally {
      setBusy(null);
    }
  };

  const closeAll = async () => {
    const n = d.resolved.length;
    const yes = await confirm({
      title: `Close ${n} resolved ticket${n === 1 ? "" : "s"}?`,
      body: "Requesters are told their ticket is closed and messaging on it stops. If the same issue comes back, they raise a new ticket. You can reopen any closed ticket from its page.",
      confirmLabel: `Close ${n === 1 ? "it" : `all ${n}`}`,
    });
    if (!yes) return;
    try {
      const r = await api("/admin/tickets/close-resolved", { method: "POST", json: {} });
      toast(`${r.closed} ticket${r.closed === 1 ? "" : "s"} closed. Requesters have been told.`, "success", "All done for the day");
      await load();
    } catch (e) {
      if ((e as ApiError).status === 401) onExpired();
      else toast((e as Error).message, "error", "Couldn't close the tickets");
    }
  };

  if (err && !d) return <p className="text-red-700">Can't load your work: {err}</p>;
  if (!d) return <p className="text-neutral-500">Loading…</p>;

  const c = d.counts;
  // "Current task" = the in-progress ticket I touched most recently; the rest of my in-progress work gets a calm edge.
  const working = [...d.mine].filter((t: any) => t.status === "in_progress").sort((a: any, b: any) => b.updated_at - a.updated_at);
  const currentId: number | undefined = working[0]?.id;

  const tabs: { id: Tab; label: ReactNode }[] = [
    ...(admin ? [{ id: "dashboard" as Tab, label: "Dashboard" }] : []),
    { id: "mine", label: <>My queue <span className="ml-1.5 rounded-full bg-fg/10 px-2 py-0.5 text-xs">{d.mine.length}</span></> },
    { id: "triage", label: <>Needs triage <span className="ml-1.5 rounded-full bg-fg/10 px-2 py-0.5 text-xs">{d.triage.length}</span></> },
    { id: "resolved", label: <>Resolved <span className={`ml-1.5 rounded-full px-2 py-0.5 text-xs ${d.resolved.length ? "bg-brand-green text-ink" : "bg-fg/10"}`}>{d.resolved.length}</span></> },
    { id: "tickets", label: "All tickets" },
    { id: "library", label: "Library" },
    ...(admin ? [{ id: "reports" as Tab, label: "Reports" }, { id: "activity" as Tab, label: "Activity" }, { id: "people" as Tab, label: "People" }, { id: "assets" as Tab, label: "Computers" }, { id: "users" as Tab, label: "Staff" }] : []),
  ];

  return (
    <div className="space-y-5">
      <div className={`grid grid-cols-2 gap-3 ${admin ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
        <Tile i={0} label="Assigned to me" value={<CountUp value={d.mine.length} />} accent="var(--v-created)" sub="Open tickets" />
        <Tile i={1} label="Needs triage" value={<CountUp value={c.unassigned ?? 0} />} accent="#ffb400" sub="Not yet assigned" />
        <Tile i={2} label="Urgent" value={<CountUp value={c.urgent ?? 0} />} accent="#d03b3b" sub="Open, all agents" />
        <Tile i={3} label="Overdue" value={<CountUp value={c.overdue ?? 0} />} accent="#ec835a" sub="Past target time" />
        {admin && <Tile i={4} label="Busiest category" value={d.topCategory?.name ?? "—"} accent="#0ca30c" sub={d.topCategory ? `${d.topCategory.n} tickets · 30 days` : "No tickets yet"} />}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SlidingTabs<Tab> variant="pill" label="Sections" value={tab} onChange={setTab} tabs={tabs} />
        <button className="ml-auto text-sm font-semibold text-neutral-500 hover:text-fg" onClick={() => void load()}>Refresh</button>
      </div>

      {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}

      {/* Each panel is keyed by its tab, so it eases in every time you switch. */}
      <div key={tab} className="page-in">
        {tab === "dashboard" && admin && <Insights open={open} onExpired={onExpired} />}

        {tab === "mine" &&
          (d.mine.length ? (
            <ul className="space-y-2.5">
              {d.mine.map((t: any, i: number) => {
                const now = t.id === currentId;
                const soft = !now && t.status === "in_progress";
                return (
                  <li key={t.id} className="rise-in" style={{ ["--i" as string]: i }}>
                    <button
                      onClick={() => open(t.id)}
                      className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border bg-surface p-4 text-left shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${
                        now ? "glow-now border-transparent" : soft ? "glow-soft border-transparent" : "border-stone-200 hover:border-stone-400"
                      }`}
                    >
                      {now && <span className="inline-flex items-center gap-2 rounded-full bg-ink px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider text-white"><span className="now-dot" />Now <span className="working-dots"><i /><i /><i /></span></span>}
                      <PriorityChip p={t.priority} locked={t.priority_locked} />
                      <span className="font-bold">{t.ref}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                      <span className="text-sm text-neutral-500">{t.requester}{t.category ? ` · ${t.category}` : ""}</span>
                      <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-700">{STATUS[t.status] ?? t.status}</span>
                      <SlaChip t={t} short />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>Nothing is assigned to you right now. Take something from the <b>Needs triage</b> tab.</Empty>
          ))}

        {tab === "triage" &&
          (d.triage.length ? (
            <ul className="space-y-2.5">
              {d.triage.map((t: any, i: number) => (
                <li key={t.id} className="rise-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm" style={{ ["--i" as string]: i }}>
                  <PriorityChip p={t.priority} locked={t.priority_locked} />
                  <button onClick={() => open(t.id)} className="font-bold hover:underline">{t.ref}</button>
                  <button onClick={() => open(t.id)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline">{t.title}</button>
                  <span className="text-sm text-neutral-500">{t.requester}{t.category ? ` · ${t.category}` : ""} · {ago(t.created_at, d.now)}</span>
                  <select
                    aria-label={`Priority for ${t.ref}`}
                    className={field + " !w-auto"}
                    value={t.priority}
                    disabled={busy === t.id || (!!t.priority_locked && !admin)}
                    onChange={(e) => void act(t.id, { priority: e.target.value })}
                    title={admin ? "Setting a priority as admin locks it for agents" : t.priority_locked ? "An admin set this priority" : undefined}
                  >
                    {["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <button className={btn} disabled={busy === t.id} onClick={() => void act(t.id, { assignee_id: meId, status: "in_progress" })}>
                    {busy === t.id ? "Working…" : "Take it"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Everything open has been assigned. Nice.</Empty>
          ))}

        {tab === "resolved" && (
          <ResolvedBoard rows={d.resolved} now={d.now} admin={admin} busy={busy} open={open} onClose={(id) => void act(id, { status: "closed" })} onCloseAll={closeAll} />
        )}

        {tab === "tickets" && <AllTickets open={open} />}
        {tab === "library" && <Library admin={admin} open={open} onExpired={onExpired} />}
        {tab === "reports" && admin && <Reports onExpired={onExpired} />}
        {tab === "activity" && admin && <ActivityLog open={open} onExpired={onExpired} />}
        {tab === "people" && admin && <PeoplePanel onExpired={onExpired} />}
        {tab === "assets" && admin && <Assets onExpired={onExpired} />}
        {tab === "users" && admin && <UsersPanel meId={meId} onExpired={onExpired} />}
      </div>
    </div>
  );
}
