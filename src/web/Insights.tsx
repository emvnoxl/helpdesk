import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { Heatmap, HBars, Panel, PRIO, PriorityChip, Trend, hrs, span } from "./viz";

type Range = 7 | 30 | 90;
const RANGES: Range[] = [7, 30, 90];

/** Change vs the previous window, as text + arrow (never colour alone). */
function change(n: number, prev: number): { text: string; dir: "up" | "down" | "flat" | "new" | "none" } {
  if (!prev) return n ? { text: "new", dir: "new" } : { text: "—", dir: "none" };
  const p = Math.round(((n - prev) / prev) * 100);
  return p === 0 ? { text: "0%", dir: "flat" } : { text: `${Math.abs(p)}%`, dir: p > 0 ? "up" : "down" };
}
const ARROW = { up: "▲", down: "▼", flat: "▬", new: "★", none: "" };

function Delta({ n, prev, days }: { n: number; prev: number; days: number }) {
  const d = change(n, prev);
  return (
    <span className="whitespace-nowrap text-xs font-semibold" style={{ color: "var(--v-ink2)" }} title={`Compared with the previous ${days} days (${prev})`}>
      {ARROW[d.dir]} {d.text}
    </span>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent: string }) {
  return (
    <div className="rounded-2xl border bg-surface p-4 shadow-sm" style={{ borderColor: "var(--v-border)", borderLeft: `6px solid ${accent}` }}>
      <div className="text-xs font-bold uppercase tracking-wider" style={{ color: "var(--v-ink2)" }}>{label}</div>
      <div className="mt-1 text-3xl font-extrabold leading-none">{value}</div>
      <div className="mt-2 h-4 text-xs" style={{ color: "var(--v-muted)" }}>{sub}</div>
    </div>
  );
}

// Hours, or minutes when under an hour, so quick fixes never read as "0h".
const fmtH = (h: number | null | undefined) => (h == null ? "—" : h < 1 ? `${Math.round(h * 60)}m` : `${h}h`);

const th = "pb-2 text-left text-[11px] font-semibold uppercase tracking-wider";

export function Insights({ open, onExpired }: { open: (id: number) => void; onExpired: () => void }) {
  const [days, setDays] = useState<Range>(30);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (range: Range) => {
      setLoading(true);
      return api(`/admin/insights?days=${range}`)
        .then((r) => { setD(r); setErr(""); })
        .catch((e) => (e.status === 401 ? onExpired() : setErr(e.message)))
        .finally(() => setLoading(false));
    },
    [onExpired],
  );
  useEffect(() => void load(days), [days, load]);

  if (err && !d) return <p className="text-red-700">Couldn't load the dashboard: {err}</p>;
  if (!d) return <p className="text-neutral-500">Loading…</p>;

  const t = d.totals;
  const cats: any[] = d.categories;
  const totalCreated = cats.reduce((a, c) => a + c.n, 0);
  const maxN = Math.max(1, ...cats.map((c) => c.n));
  const top = cats.find((c) => c.name !== "Uncategorised") ?? cats[0];
  const slaN = d.sla.reduce((a: number, r: any) => a + r.n, 0);
  const slaMet = slaN ? Math.round((d.sla.reduce((a: number, r: any) => a + (r.n * (r.met_pct ?? 0)) / 100, 0) / slaN) * 100) : null;
  const slaRow = (p: string) => d.sla.find((r: any) => r.priority === p);
  const topChange = top ? change(top.n, top.prev) : null;

  return (
    <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">Everything below covers the last <b className="text-fg">{days} days</b>, compared with the {days} days before.</p>
        <div role="group" aria-label="Time range" className="inline-flex rounded-full bg-surface p-1 ring-1 ring-stone-300">
          {RANGES.map((r) => (
            <button
              key={r}
              aria-pressed={days === r}
              onClick={() => setDays(r)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${days === r ? "bg-ink text-white dark:bg-fg dark:text-ink" : "text-neutral-600 hover:bg-stone-100"}`}
            >
              {r} days
            </button>
          ))}
        </div>
      </div>

      {top && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-ink px-5 py-4 text-white">
          <span className="rounded-full bg-brand-amber px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-ink">Busiest category</span>
          <span className="text-xl font-extrabold">{top.name}</span>
          <span className="text-white/80">
            {top.n} ticket{top.n === 1 ? "" : "s"} · {Math.round((top.n / Math.max(1, totalCreated)) * 100)}% of all tickets
            {topChange && topChange.dir !== "none" && <> · {ARROW[topChange.dir]} {topChange.text} vs previous {days} days</>}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Created" accent="var(--v-created)" value={t.created ?? 0} sub={<Delta n={t.created} prev={t.created_prev} days={days} />} />
        <Kpi label="Resolved" accent="var(--v-resolved)" value={t.resolved ?? 0} sub={<Delta n={t.resolved} prev={t.resolved_prev} days={days} />} />
        <Kpi label="Met target" accent="#0ca30c" value={slaMet === null ? "—" : `${slaMet}%`} sub={slaN ? `${slaN} resolved` : "Nothing resolved yet"} />
        <Kpi label="First response" accent="#ffb400" value={hrs(t.avg_first_response_hrs)} sub="Average" />
        <Kpi label="Resolution" accent="#ec835a" value={hrs(t.avg_resolution_hrs)} sub="Average" />
        <Kpi label="Backlog" accent="#d03b3b" value={t.backlog ?? 0} sub={t.overdue ? `${t.overdue} overdue` : "None overdue"} />
        <Kpi label="Said it was fixed" accent="#00a859" value={t.rated ? `${Math.round((100 * (t.rated_good ?? 0)) / t.rated)}%` : "—"} sub={t.rated ? `${t.rated} rated · ${days} days` : "No feedback yet"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <Panel title="Where tickets come from" className="lg:col-span-2" right={<span className="text-xs" style={{ color: "var(--v-muted)" }}>{totalCreated} tickets</span>}>
          {cats.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ color: "var(--v-muted)" }}>
                    <th className={th + " w-6"}>#</th><th className={th}>Category</th>
                    <th className={th + " text-right"}>Tickets</th><th className={th + " text-right"}>Share</th>
                    <th className={th + " text-right"}>Change</th>
                    <th className={th + " hidden text-right sm:table-cell"}>Open now</th><th className={th + " hidden text-right sm:table-cell"}>Avg fix</th>
                  </tr>
                </thead>
                <tbody>
                  {cats.map((c, i) => (
                    <tr key={c.name} style={{ borderTop: "1px solid var(--v-grid)" }}>
                      <td className="py-2.5 pr-2 text-xs tabular-nums" style={{ color: "var(--v-muted)" }}>{i + 1}</td>
                      <td className="py-2.5 pr-3">
                        <div className={i === 0 ? "font-extrabold" : "font-semibold"}>{c.name}</div>
                        <div className="mt-1 h-2 rounded-full" style={{ background: "var(--v-grid)" }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.max(3, (c.n / maxN) * 100)}%`, background: "var(--v-created)" }} />
                        </div>
                      </td>
                      <td className="py-2.5 text-right font-bold tabular-nums">{c.n}</td>
                      <td className="py-2.5 text-right tabular-nums">{Math.round((c.n / Math.max(1, totalCreated)) * 100)}%</td>
                      <td className="py-2.5 text-right"><Delta n={c.n} prev={c.prev} days={days} /></td>
                      <td className="hidden py-2.5 text-right tabular-nums sm:table-cell">{c.open_now}</td>
                      <td className="hidden py-2.5 text-right tabular-nums sm:table-cell">{fmtH(c.avg_res_hrs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--v-muted)" }}>No tickets in the last {days} days.</p>
          )}
        </Panel>

        <div className="grid gap-4 xl:contents">
          <Panel title="Backlog age">
            <HBars
              rows={[
                { name: "Under 1 day", n: d.aging.d1 ?? 0 },
                { name: "1 to 3 days", n: d.aging.d3 ?? 0 },
                { name: "3 to 7 days", n: d.aging.d7 ?? 0 },
                { name: "Over 7 days", n: d.aging.older ?? 0 },
              ]}
              label="name" value="n" empty="No open tickets."
            />
          </Panel>
          <Panel title="Open by priority">
            <HBars
              rows={(["urgent", "high", "medium", "low"] as const).map((p) => ({ name: PRIO[p].label, n: d.openByPriority.find((r: any) => r.priority === p)?.n ?? 0 }))}
              label="name" value="n" empty="No open tickets."
            />
          </Panel>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <Panel title={`Created vs resolved · ${days} days`} className="min-h-[300px] lg:col-span-2">
          <Trend created={d.trend.created} resolved={d.trend.resolved} now={d.now} range={days} />
        </Panel>
        <Panel title="Speed vs target">
          <table className="w-full text-sm">
            <thead><tr style={{ color: "var(--v-muted)" }}><th className={th}>Priority</th><th className={th + " text-right"}>Avg</th><th className={th + " text-right"}>Target</th><th className={th + " text-right"}>On time</th></tr></thead>
            <tbody>
              {(["urgent", "high", "medium", "low"] as const).map((p) => {
                const r = slaRow(p);
                return (
                  <tr key={p} style={{ borderTop: "1px solid var(--v-grid)" }}>
                    <td className="py-2.5"><PriorityChip p={p} /></td>
                    <td className="py-2.5 text-right tabular-nums">{r ? fmtH(r.avg_hrs) : "—"}</td>
                    <td className="py-2.5 text-right tabular-nums" style={{ color: "var(--v-muted)" }}>{d.slaTargets[p]}h</td>
                    <td className="py-2.5 text-right font-bold tabular-nums">{r ? `${r.met_pct}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs" style={{ color: "var(--v-muted)" }}>Based on tickets resolved in this period.</p>
        </Panel>
        <Panel title="Team">
          {d.agents.length ? (
            <table className="w-full text-sm">
              <thead><tr style={{ color: "var(--v-muted)" }}><th className={th}>Agent</th><th className={th + " text-right"}>Open</th><th className={th + " text-right"}>Resolved</th><th className={th + " text-right"}>Avg</th></tr></thead>
              <tbody>
                {d.agents.map((a: any) => (
                  <tr key={a.name} style={{ borderTop: "1px solid var(--v-grid)" }}>
                    <td className="py-2 font-semibold">{a.name}</td>
                    <td className="py-2 text-right tabular-nums">{a.open_tickets}</td>
                    <td className="py-2 text-right tabular-nums">{a.resolved}</td>
                    <td className="py-2 text-right tabular-nums">{fmtH(a.avg_hrs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-sm" style={{ color: "var(--v-muted)" }}>No agents yet.</p>}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3 xl:grid-cols-4">
        <Panel title="When tickets arrive" className="lg:col-span-2">
          <Heatmap rows={d.heat} />
        </Panel>
        <Panel title="Overdue now">
          {d.overdue.length ? (
            <ul className="space-y-2.5 text-sm">
              {d.overdue.map((x: any) => (
                <li key={x.id} className="flex items-baseline gap-2">
                  <button onClick={() => open(x.id)} className="shrink-0 font-bold hover:underline">{x.ref}</button>
                  <span className="truncate" style={{ color: "var(--v-ink2)" }}>{x.title}</span>
                  <span className="ml-auto shrink-0 font-bold" style={{ color: "var(--v-late)" }}>{span(x.due_at - d.now)} late</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm" style={{ color: "var(--v-muted)" }}>Nothing is overdue.</p>}
        </Panel>
        <div className="grid content-start gap-4 lg:col-span-3 lg:grid-cols-2 xl:col-span-1 xl:grid-cols-1">
        {d.unhappy?.length > 0 && (
          <Panel title="Said it wasn't fixed">
            <ul className="space-y-2.5 text-sm">
              {d.unhappy.map((x: any) => (
                <li key={x.id}>
                  <div className="flex items-baseline gap-2"><button onClick={() => open(x.id)} className="shrink-0 font-bold hover:underline">{x.ref}</button><span className="truncate" style={{ color: "var(--v-ink2)" }}>{x.requester}</span><span className="ml-auto shrink-0 text-xs" style={{ color: "var(--v-muted)" }}>{x.assignee ?? "unassigned"}</span></div>
                  {x.comment && <p className="mt-0.5 line-clamp-2 text-xs" style={{ color: "var(--v-muted)" }}>“{x.comment}”</p>}
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel title="Top requesters">
          {d.requesters.length ? (
            <ul className="space-y-2.5 text-sm">
              {d.requesters.map((r: any) => (
                <li key={r.email} className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate"><b>{r.name}</b> <span className="text-xs" style={{ color: "var(--v-muted)" }}>{r.email}</span></span>
                  <b className="ml-auto tabular-nums">{r.n}</b>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm" style={{ color: "var(--v-muted)" }}>No tickets yet.</p>}
        </Panel>
        <Panel title="Devices with repeat tickets">
          {d.assets.length ? (
            <ul className="space-y-2.5 text-sm">
              {d.assets.map((a: any) => (
                <li key={a.asset_tag} className="flex items-baseline gap-2">
                  <b className="font-mono">{a.asset_tag}</b>
                  <span className="ml-auto tabular-nums">{a.n} tickets</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm" style={{ color: "var(--v-muted)" }}>No device has come back more than once. Tickets that include an asset tag are tracked here.</p>}
        </Panel>
        </div>
      </div>
    </div>
  );
}
