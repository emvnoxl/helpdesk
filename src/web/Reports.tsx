import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import { Heatmap, Panel } from "./viz";
import { btn, field } from "./ui";
import { useTheme } from "./theme";
import { useNotify } from "./notify";

/* Admin > Reports: pick a month, read the numbers and the smart analysis, download the tickets as CSV, or print / save as PDF. */

type Sev = "alert" | "watch" | "info" | "good";
interface Report {
  month: string; label: string; previous_label: string; partial: boolean; generated_at: number; months: string[];
  kpis: Kpis; previous: Kpis | null;
  daily: { date: string; created: number; resolved: number }[];
  categories: { name: string; n: number; share: number; prev: number; avg_resolution_h: number | null; sla_pct: number | null; measured: number }[];
  priorities: { name: string; n: number; avg_resolution_h: number | null; sla_pct: number | null; measured: number }[];
  agents: { id: number; name: string; assigned: number; resolved: number; avg_resolution_h: number | null; open_now: number }[];
  requesters: { name: string; n: number }[]; assets: { tag: string; n: number }[];
  heatmap: { dow: number; hr: number; n: number }[]; history: { month: string; created: number }[];
  smart: {
    summary: string;
    insights: { severity: Sev; title: string; detail: string; action?: string }[];
    clusters: { size: number; requesters: number; label: string; category: string | null; refs: string[]; examples: string[] }[];
    spikes: { date: string; n: number; normal: number; topCategory: string | null }[];
    slowest: { ref: string; title: string; hours: number }[];
    forecast: { value: number; low: number; high: number } | null;
  };
}
interface Kpis {
  created: number; resolved: number; closed: number; urgent: number; open_end: number; old_open_end: number; reopened: number; messages: number; internal_notes: number;
  avg_first_response_h: number | null; median_first_response_h: number | null; avg_resolution_h: number | null; median_resolution_h: number | null; p90_resolution_h: number | null;
  sla_measured: number; sla_pct: number | null; rated: number; rated_good: number; csat_pct: number | null;
}

const fmtH = (h: number | null | undefined) => (h == null ? "—" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h} h` : `${Math.round(h / 2.4) / 10} days`);
const SEV: Record<Sev, { label: string; bar: string; chip: string; icon: string }> = {
  alert: { label: "Needs attention", bar: "#d03b3b", chip: "bg-[#d03b3b] text-white", icon: "M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" },
  watch: { label: "Worth a look", bar: "#ffb400", chip: "bg-brand-amber text-ink", icon: "M12 8v5M12 16.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  info: { label: "Good to know", bar: "#3b82c4", chip: "bg-stone-200 text-fg", icon: "M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  good: { label: "Going well", bar: "#00a859", chip: "bg-brand-green text-ink", icon: "M5 13l4 4L19 7" },
};

/** A change against the previous month as arrow + text (never colour alone). `lowerBetter` flips which direction is good. */
function Delta({ now, prev, lowerBetter = false, unit = "" }: { now: number | null; prev: number | null | undefined; lowerBetter?: boolean; unit?: string }) {
  if (now == null || prev == null || (prev === 0 && now === 0)) return <span className="text-neutral-400">no change data</span>;
  if (prev === 0) return <span className="font-semibold text-neutral-600">★ new</span>;
  const p = Math.round(((now - prev) / Math.abs(prev)) * 100);
  if (p === 0) return <span className="font-semibold text-neutral-600">▬ same as last month</span>;
  const good = lowerBetter ? p < 0 : p > 0;
  return <span className={`font-semibold ${good ? "text-ok" : "text-red-700"}`}>{p > 0 ? "▲" : "▼"} {Math.abs(p)}%{unit} <span className="font-normal text-neutral-500">vs last month</span></span>;
}

function Tile({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent: string }) {
  return (
    <div className="print-keep rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm" style={{ borderLeft: `6px solid ${accent}` }}>
      <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 text-3xl font-extrabold leading-none">{value}</div>
      <div className="mt-2 min-h-4 text-xs">{sub}</div>
    </div>
  );
}

function DailyChart({ daily, spikes, partial }: { daily: Report["daily"]; spikes: Report["smart"]["spikes"]; partial: boolean }) {
  const W = 900, H = 190, L = 28, B = 22, T = 8;
  const today = new Date().toISOString().slice(0, 10);
  const shown = partial ? daily.filter((d) => d.date <= today) : daily;
  const max = Math.max(4, ...daily.map((d) => Math.max(d.created, d.resolved)));
  const step = (W - L) / daily.length, bw = Math.max(3, step * 0.62);
  const y = (n: number) => T + (H - T - B) * (1 - n / max);
  const spike = new Set(spikes.map((s) => s.date));
  const line = shown.map((d, i) => `${i ? "L" : "M"}${(L + step * i + step / 2).toFixed(1)},${y(d.resolved).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tickets raised and resolved each day">
        {[0, 0.5, 1].map((f) => (
          <g key={f}><line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--v-grid)" /><text x={L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="var(--v-muted)">{Math.round(max * f)}</text></g>
        ))}
        {shown.map((d, i) => (
          <g key={d.date}>
            <rect x={L + step * i + (step - bw) / 2} y={y(d.created)} width={bw} height={Math.max(0, H - B - y(d.created))} rx="2" fill={spike.has(d.date) ? "#ffb400" : "var(--v-created)"}>
              <title>{`${d.date}: ${d.created} raised, ${d.resolved} resolved${spike.has(d.date) ? " (unusual spike)" : ""}`}</title>
            </rect>
            {(i % 5 === 0 || i === daily.length - 1) && <text x={L + step * i + step / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--v-muted)">{Number(d.date.slice(8))}</text>}
          </g>
        ))}
        <path d={line} fill="none" stroke="#00a859" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex flex-wrap gap-4 text-xs text-neutral-500">
        <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "var(--v-created)" }} /> Raised</span>
        <span className="flex items-center gap-1.5"><i className="inline-block h-0.5 w-4 rounded" style={{ background: "#00a859" }} /> Resolved</span>
        {spikes.length > 0 && <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-amber" /> Unusual spike</span>}
      </div>
    </div>
  );
}

const th = "pb-2 text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500";
const td = "border-t border-stone-200 py-2 pr-3";

export function Reports({ onExpired }: { onExpired: () => void }) {
  const [month, setMonth] = useState<string>("");
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const { mode, toggle } = useTheme();
  const { toast, confirm } = useNotify();
  const [mailing, setMailing] = useState(false);

  // Send the month on screen to the people chosen under System > Report email.
  const emailIt = async () => {
    if (!rep) return;
    setMailing(true);
    try {
      const cfg = await api<{ recipient_count: number }>("/admin/report-email");
      if (!cfg.recipient_count) { toast("Choose who gets it under System > Report email first.", "info", "No one to send it to"); setMailing(false); return; }
      const yes = await confirm({ title: `Email the ${rep.label} report to ${cfg.recipient_count} ${cfg.recipient_count === 1 ? "person" : "people"}?`, body: "It goes to everyone chosen under System > Report email, now. The email holds totals only (no ticket titles, no names).", confirmLabel: "Send it" });
      if (yes) {
        const r = await api<{ sent: number; failed: { email: string }[] }>("/admin/report-email/send", { method: "POST", json: { month: rep.month, to: "saved" } });
        toast(r.failed.length ? `Sent to ${r.sent}; ${r.failed.length} failed.` : `Sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}.`, r.failed.length ? "error" : "success", "Report sent");
      }
    } catch (e) {
      if ((e as ApiError).status === 401) onExpired();
      else toast((e as Error).message, "error", "Not sent");
    }
    setMailing(false);
  };

  const load = useCallback(async (m: string) => {
    try {
      setRep(await api<Report>(`/admin/reports${m ? `?month=${m}` : ""}`));
      setErr("");
    } catch (e) {
      if ((e as ApiError).status === 401) onExpired();
      else setErr((e as Error).message);
    }
  }, [onExpired]);
  useEffect(() => void load(month), [month, load]);

  // Printing in dark mode would waste a lot of ink: print in light, then put the choice back.
  const print = () => {
    const finish = () => mode === "dark" && toggle();
    window.addEventListener("afterprint", finish, { once: true });
    if (mode === "dark") { toggle(); window.setTimeout(() => window.print(), 520); } else window.print();
  };

  if (err && !rep) return <p className="text-red-700">Couldn't build the report: {err}</p>;
  if (!rep) return <p className="text-neutral-500">Building the report…</p>;
  const k = rep.kpis, p = rep.previous;
  const idx = rep.months.indexOf(rep.month);
  const maxHist = Math.max(1, ...rep.history.map((h) => h.created));
  const mlabel = (m: string) => new Date(m + "-15T12:00:00Z").toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center gap-2">
        <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={idx >= rep.months.length - 1} onClick={() => setMonth(rep.months[idx + 1]!)} aria-label="Previous month">← Earlier</button>
        <select className={field + " !w-auto font-semibold"} value={rep.month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
          {rep.months.map((m) => <option key={m} value={m}>{new Date(m + "-15T12:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}</option>)}
        </select>
        <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={idx <= 0} onClick={() => setMonth(rep.months[idx - 1]!)} aria-label="Next month">Later →</button>
        <span className="ml-auto flex flex-wrap gap-2">
          <a className={btn + " no-underline"} href={`/api/admin/reports/tickets.csv?month=${rep.month}`} download>Download tickets (CSV)</a>
          <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={mailing} onClick={() => void emailIt()}>{mailing ? "Working…" : "Email this report"}</button>
          <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-stone-100" onClick={print}>Print / save as PDF</button>
        </span>
      </div>

      <div>
        <h2 className="text-2xl font-extrabold">Monthly report · {rep.label}</h2>
        <p className="text-sm text-neutral-500">
          {rep.partial ? <b className="mr-2 rounded-full bg-brand-amber px-2 py-0.5 text-xs text-ink">Month in progress</b> : null}
          Generated {new Date(rep.generated_at * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · compared with {rep.previous_label} · times are Ghana time (UTC)
        </p>
      </div>

      {/* smart analysis */}
      <section className="print-keep overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm">
        <div className="brand-stripe" />
        <div className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-extrabold">Smart analysis</h3>
            <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-600" title="Statistics and text matching run on this server. No data leaves it and no language model is used.">Calculated on this server · nothing leaves the building</span>
          </div>
          <p className="mt-3 max-w-4xl text-[15px] leading-relaxed">{rep.smart.summary}</p>
          {rep.smart.insights.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">Nothing unusual to point out this month.</p>
          ) : (
            <ul className="mt-4 grid gap-3 lg:grid-cols-2">
              {rep.smart.insights.map((i, n) => (
                <li key={n} className="print-keep rounded-xl border border-stone-200 p-3.5" style={{ borderLeft: `5px solid ${SEV[i.severity].bar}` }}>
                  <div className="flex items-start gap-2.5">
                    <svg className="mt-0.5 shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={SEV[i.severity].bar} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={SEV[i.severity].icon} /></svg>
                    <div className="min-w-0 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <b>{i.title}</b>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEV[i.severity].chip}`}>{SEV[i.severity].label}</span>
                      </div>
                      <p className="mt-0.5 text-neutral-600">{i.detail}</p>
                      {i.action && <p className="mt-1"><b>What to do:</b> <span className="text-neutral-600">{i.action}</span></p>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* headline numbers */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile accent="var(--v-created)" label="Tickets raised" value={k.created} sub={<Delta now={k.created} prev={p?.created} />} />
        <Tile accent="#00a859" label="Resolved" value={k.resolved} sub={<span className="text-neutral-500">{k.closed} closed this month</span>} />
        <Tile accent="#ffb400" label="Open at month end" value={k.open_end} sub={<span className="text-neutral-500">{k.old_open_end ? `${k.old_open_end} older than 7 days` : "none older than 7 days"}</span>} />
        <Tile accent="#d03b3b" label="Urgent tickets" value={k.urgent} sub={<Delta now={k.urgent} prev={p?.urgent} lowerBetter />} />
        <Tile accent="var(--v-created)" label="First reply (median)" value={fmtH(k.median_first_response_h)} sub={<Delta now={k.median_first_response_h} prev={p?.median_first_response_h} lowerBetter />} />
        <Tile accent="#00a859" label="Time to resolve (median)" value={fmtH(k.median_resolution_h)} sub={<span className="text-neutral-500">slowest 10%: {fmtH(k.p90_resolution_h)}</span>} />
        <Tile accent="#ffb400" label="Met target time" value={k.sla_pct == null ? "—" : `${k.sla_pct}%`} sub={<span className="text-neutral-500">{k.sla_measured} finished tickets measured</span>} />
        <Tile accent="#d03b3b" label="Came back after resolved" value={k.reopened} sub={<span className="text-neutral-500">{k.messages} messages, {k.internal_notes} internal notes</span>} />
        <Tile accent="#00a859" label="Said it was fixed" value={k.csat_pct == null ? "—" : `${k.csat_pct}%`} sub={<span className="text-neutral-500">{k.rated ? `${k.rated_good} of ${k.rated} who answered` : "no feedback this month"}</span>} />
        <Tile accent="var(--v-created)" label="Messages" value={k.messages} sub={<span className="text-neutral-500">{k.internal_notes} of them internal notes</span>} />
      </div>

      <Panel title="Tickets per day" right={<span className="text-xs text-neutral-500">{k.created} raised · {k.resolved} resolved</span>}>
        <DailyChart daily={rep.daily} spikes={rep.smart.spikes} partial={rep.partial} />
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="By category">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>Category</th><th className={th}>Tickets</th><th className={th}>vs last month</th><th className={th}>Avg fix</th><th className={th}>On time</th></tr></thead>
              <tbody>
                {rep.categories.map((c) => (
                  <tr key={c.name}>
                    <td className={td + " font-medium"}>{c.name}<div className="mt-1 h-1.5 w-28 rounded-full" style={{ background: "var(--v-grid)" }}><div className="h-1.5 rounded-full" style={{ width: `${Math.max(3, c.share)}%`, background: "var(--v-created)" }} /></div></td>
                    <td className={td}><b>{c.n}</b> <span className="text-xs text-neutral-500">{c.share}%</span></td>
                    <td className={td + " text-xs"}>{c.prev === 0 ? (c.n ? "★ new" : "—") : c.n === c.prev ? "▬ same" : `${c.n > c.prev ? "▲" : "▼"} ${Math.abs(Math.round(((c.n - c.prev) / c.prev) * 100))}% (${c.prev})`}</td>
                    <td className={td}>{fmtH(c.avg_resolution_h)}</td>
                    <td className={td}>{c.sla_pct == null ? "—" : `${c.sla_pct}%`}</td>
                  </tr>
                ))}
                {!rep.categories.length && <tr><td className={td + " text-neutral-500"} colSpan={5}>No tickets this month.</td></tr>}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel title="By priority">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>Priority</th><th className={th}>Tickets</th><th className={th}>Avg fix</th><th className={th}>On time</th></tr></thead>
              <tbody>
                {rep.priorities.map((x) => (
                  <tr key={x.name}><td className={td + " font-medium capitalize"}>{x.name}</td><td className={td}><b>{x.n}</b></td><td className={td}>{fmtH(x.avg_resolution_h)}</td><td className={td}>{x.sla_pct == null ? "—" : `${x.sla_pct}%`}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Team">
            <table className="w-full text-sm">
              <thead><tr><th className={th}>Person</th><th className={th}>Resolved</th><th className={th}>Avg fix</th><th className={th}>Open now</th></tr></thead>
              <tbody>
                {rep.agents.map((a) => (
                  <tr key={a.id}><td className={td + " font-medium"}>{a.name}</td><td className={td}><b>{a.resolved}</b></td><td className={td}>{fmtH(a.avg_resolution_h)}</td><td className={td}>{a.open_now}</td></tr>
                ))}
                {!rep.agents.length && <tr><td className={td + " text-neutral-500"} colSpan={4}>No team activity this month.</td></tr>}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>

      <Panel title="Recurring problems" right={<span className="text-xs text-neutral-500">similar tickets grouped by wording</span>}>
        {rep.smart.clusters.length === 0 ? (
          <p className="text-sm text-neutral-500">No problem was reported three or more times this month.</p>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {rep.smart.clusters.map((c) => (
              <li key={c.refs[0]} className="print-keep rounded-xl border border-stone-200 p-3.5 text-sm">
                <div className="flex flex-wrap items-center gap-2"><b className="capitalize">{c.label}</b><span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold text-white dark:bg-brand-green dark:text-ink">{c.size} tickets</span><span className="text-xs text-neutral-500">{c.requesters} {c.requesters === 1 ? "person" : "people"}{c.category ? ` · ${c.category}` : ""}</span></div>
                <ul className="mt-1.5 list-disc pl-5 text-neutral-600">{c.examples.map((e) => <li key={e}>{e}</li>)}</ul>
                <p className="mt-1.5 text-xs text-neutral-500">{c.refs.slice(0, 8).join(", ")}{c.refs.length > 8 ? ", …" : ""}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="When tickets arrive"><Heatmap rows={rep.heatmap} /></Panel>
        <Panel title="Last six months" right={rep.smart.forecast ? <span className="text-xs text-neutral-500">next month ≈ {rep.smart.forecast.value} ({rep.smart.forecast.low}–{rep.smart.forecast.high})</span> : undefined}>
          <div className="flex h-40 items-end gap-3" role="img" aria-label="Tickets raised in each of the last six months">
            {rep.history.map((h) => (
              <div key={h.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${mlabel(h.month)}: ${h.created}`}>
                <b className="text-xs">{h.created}</b>
                <div className="w-full rounded-t-md" style={{ height: `${Math.max(4, Math.round((h.created / maxHist) * 92))}px`, background: h.month === rep.month ? "#00a859" : "var(--v-created)" }} />
                <span className="text-[11px] text-neutral-500">{mlabel(h.month)}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="Top requesters">
          {rep.requesters.length ? <ol className="space-y-1.5 text-sm">{rep.requesters.map((r, i) => <li key={r.name + i} className="flex justify-between gap-2"><span className="truncate">{i + 1}. {r.name}</span><b>{r.n}</b></li>)}</ol> : <p className="text-sm text-neutral-500">No tickets this month.</p>}
        </Panel>
        <Panel title="Devices reported more than once">
          {rep.assets.length ? <ul className="space-y-1.5 text-sm">{rep.assets.map((a) => <li key={a.tag} className="flex justify-between gap-2"><span className="truncate">{a.tag}</span><b>{a.n}</b></li>)}</ul> : <p className="text-sm text-neutral-500">No device was reported twice.</p>}
        </Panel>
        <Panel title="Slowest tickets">
          {rep.smart.slowest.length ? (
            <ul className="space-y-1.5 text-sm">{rep.smart.slowest.map((s) => <li key={s.ref} className="flex justify-between gap-2"><span className="truncate"><b>{s.ref}</b> {s.title}</span><span className="shrink-0 text-neutral-500">{fmtH(s.hours)}</span></li>)}</ul>
          ) : <p className="text-sm text-neutral-500">Nothing took unusually long.</p>}
        </Panel>
      </div>
      <p className="no-print text-xs text-neutral-500">Tip: “Download tickets (CSV)” opens in Excel with one row per ticket, including the times and whether each met its target, for your own pivot tables. Looking for who did what? See the Activity tab.</p>
    </div>
  );
}
