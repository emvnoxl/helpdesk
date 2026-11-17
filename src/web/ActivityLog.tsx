import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { useLive } from "./live";
import { btn, field } from "./ui";
import { dateFmt, timeFmt } from "./viz";

/* Admin > Activity: everything that happens in the app, newest first, updating live. Never shows message text. */

interface Row { id: number; created_at: number; actor_id: number | null; actor_name: string; actor_role: string; action: string; category: string; ticket_id: number | null; summary: string; ip: string | null; device: string | null }

const CATS: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "ticket", label: "Tickets" },
  { id: "message", label: "Messages" },
  { id: "signin", label: "Sign-ins" },
  { id: "account", label: "Accounts" },
  { id: "admin", label: "Admin actions" },
  { id: "security", label: "Security" },
];
const RANGES: { id: string; label: string; secs: number }[] = [
  { id: "1h", label: "Last hour", secs: 3600 },
  { id: "today", label: "Today", secs: -1 },
  { id: "7d", label: "7 days", secs: 7 * 86400 },
  { id: "30d", label: "30 days", secs: 30 * 86400 },
  { id: "all", label: "All time", secs: 0 },
];
const ICON: Record<string, { d: string; cls: string }> = {
  ticket: { d: "M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4V7Z", cls: "bg-brand-green text-ink" },
  message: { d: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z", cls: "bg-ink text-white" },
  signin: { d: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3", cls: "bg-sky-100 text-sky-900" },
  account: { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM19 8v6M22 11h-6", cls: "bg-brand-amber text-ink" },
  admin: { d: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z", cls: "bg-purple-100 text-purple-900" },
  security: { d: "M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z", cls: "bg-red-100 text-red-800" },
};
const ROLE: Record<string, string> = { admin: "Admin", agent: "Agent", requester: "User", system: "System", unknown: "Unknown" };

const sinceOf = (range: string) => {
  const r = RANGES.find((x) => x.id === range)!;
  if (r.secs === 0) return 0;
  if (r.secs === -1) return Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  return Math.floor(Date.now() / 1000) - r.secs;
};

export function ActivityLog({ open, onExpired }: { open: (id: number) => void; onExpired: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [cat, setCat] = useState("");
  const [range, setRange] = useState("7d");
  const [q, setQ] = useState("");
  const [qNow, setQNow] = useState("");
  const [err, setErr] = useState("");
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const top = useRef(0);

  useEffect(() => { const t = setTimeout(() => setQNow(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const qs = useCallback((extra: Record<string, string | number> = {}) => {
    const p = new URLSearchParams();
    if (cat) p.set("cat", cat);
    if (qNow) p.set("q", qNow);
    const s = sinceOf(range);
    if (s) p.set("since", String(s));
    Object.entries(extra).forEach(([k, v]) => p.set(k, String(v)));
    return p.toString();
  }, [cat, qNow, range]);

  const load = useCallback(async (live = false) => {
    try {
      const r = await api<{ rows: Row[]; more: boolean; last24h: Record<string, number> }>(`/admin/activity?${qs({ limit: 50 })}`);
      if (live && top.current) {
        const ids = new Set(r.rows.filter((x) => x.id > top.current).map((x) => x.id));
        if (ids.size) {
          setFresh(ids);
          window.setTimeout(() => setFresh(new Set()), 2500);
        }
      }
      top.current = r.rows[0]?.id ?? top.current;
      setRows(r.rows); setMore(r.more); setCounts(r.last24h); setErr("");
    } catch (e) {
      if ((e as ApiError).status === 401) onExpired();
      else setErr((e as Error).message);
    }
  }, [qs, onExpired]);

  useEffect(() => { top.current = 0; setRows(null); void load(); }, [load]);
  useLive("/staff/stream", () => void load(true), ["audit", "open"]); // new lines appear by themselves

  async function older() {
    if (!rows?.length) return;
    setBusy(true);
    try {
      const r = await api<{ rows: Row[]; more: boolean }>(`/admin/activity?${qs({ limit: 50, before: rows[rows.length - 1]!.id })}`);
      setRows([...rows, ...r.rows]);
      setMore(r.more);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  let lastDay = "";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-extrabold">Activity log <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-600"><span className="live-dot inline-block h-2 w-2 rounded-full bg-brand-green" />Live</span></h2>
          <p className="text-sm text-neutral-500">Who did what, when and from where. Message text, passwords and temporary passwords are never recorded.</p>
        </div>
        <a className={btn + " no-underline"} href={`/api/admin/activity/export.csv?${qs()}`} download>Download CSV</a>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter by type">
        {CATS.map((c) => {
          const active = cat === c.id;
          const n = c.id ? counts[c.id] : Object.values(counts).reduce((a, b) => a + b, 0);
          return (
            <button key={c.id || "all"} role="tab" aria-selected={active} onClick={() => setCat(c.id)}
              className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${active ? "border-transparent bg-ink text-white dark:bg-brand-green dark:text-ink" : "border-stone-200 bg-surface text-neutral-600 hover:bg-stone-100"} ${c.id === "security" && n ? "ring-1 ring-red-300" : ""}`}>
              {c.label}
              <span className={`ml-1.5 text-xs ${active ? "opacity-80" : "text-neutral-500"}`} title="in the last 24 hours">{n ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <input className={field + " !w-full sm:!w-72"} type="search" placeholder="Search names, tickets, addresses…" aria-label="Search the log" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={field + " !w-auto"} aria-label="Time range" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </div>

      {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}

      <div className="overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm">
        {rows === null ? (
          <p className="p-8 text-center text-sm text-neutral-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-neutral-500">Nothing matches. Try a wider time range.</p>
        ) : (
          <ul>
            {rows.map((r) => {
              const d = new Date(r.created_at * 1000);
              const day = dateFmt.format(d);
              const head = day !== lastDay ? (lastDay = day) : "";
              const ic = ICON[r.category] ?? ICON.admin!;
              const bad = r.category === "security";
              return (
                <li key={r.id}>
                  {head && <div className="border-b border-stone-200 bg-stone-100 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-neutral-600">{head}</div>}
                  <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 px-4 py-2.5 last:border-b-0 ${bad ? "bg-red-50/60" : ""} ${fresh.has(r.id) ? "msg-in bg-brand-green/10" : ""}`}>
                    <span className="w-[4.6rem] shrink-0 text-xs tabular-nums text-neutral-500">{timeFmt.format(d)}</span>
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${ic.cls}`} title={r.category}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ic.d} /></svg>
                    </span>
                    <span className="min-w-0 flex-1 text-sm">
                      <b>{r.actor_name || "Someone"}</b> <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-600">{ROLE[r.actor_role] ?? r.actor_role}</span>
                      <span className="ml-2">{r.ticket_id ? <button className="text-left hover:underline" onClick={() => open(r.ticket_id!)}>{r.summary}</button> : r.summary}</span>
                    </span>
                    <span className="max-w-full truncate text-xs text-neutral-500" title={[r.ip, r.device].filter(Boolean).join(" · ")}>{[r.device, r.ip].filter(Boolean).join(" · ")}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {more && <button className={btn} disabled={busy} onClick={() => void older()}>{busy ? "Loading…" : "Show older"}</button>}
    </div>
  );
}
