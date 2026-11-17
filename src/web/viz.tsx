import { useEffect, useRef, useState, type ReactNode } from "react";

/* Shared visual pieces for the live board and the admin console.
   Colours come from the .theme-light / .theme-dark variables in index.css. */

// Priority uses the reserved status colours, always paired with a text label.
export const PRIO: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "#d03b3b" },
  high: { label: "High", color: "#ec835a" },
  medium: { label: "Medium", color: "#fab219" },
  low: { label: "Low", color: "#0ca30c" },
};
export const STATUS: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting",
  resolved: "Resolved",
  closed: "Closed",
};

const accra = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Accra", ...o });
export const timeFmt = accra({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const dateFmt = accra({ weekday: "long", day: "numeric", month: "long" });

export function span(sec: number) {
  const a = Math.abs(sec);
  if (a < 3600) return `${Math.max(1, Math.round(a / 60))}m`;
  if (a < 48 * 3600) return `${Math.floor(a / 3600)}h`;
  return `${Math.floor(a / 86400)}d`;
}
export const ago = (ts: number, now: number) => `${span(now - ts)} ago`;

/** Average hours, shown as minutes when under an hour so quick fixes don't read as "0h". */
export function hrs(h: number | null | undefined): ReactNode {
  if (h == null) return "—";
  const unit = (n: number | string, u: string) => (
    <>{n}<span className="ml-1 text-xl font-semibold">{u}</span></>
  );
  return h < 1 ? unit(Math.round(h * 60), "m") : unit(h, "h");
}

export function PriorityChip({ p, locked, big }: { p: string; locked?: number; big?: boolean }) {
  const m = PRIO[p] ?? PRIO.medium;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-bold uppercase tracking-wide ${big ? "px-3 py-1 text-xs 2xl:text-sm" : "px-2.5 py-1 text-xs"}`}
      style={{ background: `${m.color}2e`, border: `1px solid ${m.color}`, color: "var(--v-ink)" }}
      title={locked ? "Priority set by an admin" : undefined}
    >
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: m.color }} />
      {m.label}
      {locked ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-label="locked by admin"><path d="M17 9V7a5 5 0 0 0-10 0v2H5v12h14V9h-2Zm-8 0V7a3 3 0 0 1 6 0v2H9Z" /></svg>
      ) : null}
    </span>
  );
}

export function Panel({ title, right, children, className = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-2xl p-4 2xl:p-6 ${className}`} style={{ background: "var(--v-surface)", border: "1px solid var(--v-border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-widest 2xl:text-sm" style={{ color: "var(--v-ink2)" }}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function HBars({ rows, label, value, empty }: { rows: any[]; label: string; value: string; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r[value]));
  if (!rows.length) return <p className="text-sm" style={{ color: "var(--v-muted)" }}>{empty}</p>;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r[label]} title={`${r[label]}: ${r[value]}`}>
          <div className="mb-1 flex justify-between text-xs 2xl:text-sm" style={{ color: "var(--v-ink)" }}>
            <span className="truncate pr-2">{r[label]}</span>
            <b>{r[value]}</b>
          </div>
          <div className="h-2.5 rounded-full" style={{ background: "var(--v-grid)" }}>
            <div className="h-2.5 rounded-full" style={{ width: `${Math.max(4, (r[value] / max) * 100)}%`, background: "var(--v-created)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Created vs resolved per day over `range` days. Two lines on one axis, legend + direct end labels, hover crosshair + tooltip. */
export function Trend({ created, resolved, now, range = 14 }: { created: any[]; resolved: any[]; now: number; range?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Size the SVG from its container in real pixels so text stays a constant size and the chart fills the panel.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 640, h: 200 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.max(320, Math.floor(e.contentRect.width)), h: Math.max(150, Math.floor(e.contentRect.height)) }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const days = Array.from({ length: range }, (_, i) => new Date((now - (range - 1 - i) * 86400) * 1000).toISOString().slice(0, 10));
  const every = Math.max(1, Math.ceil(range / 7)); // x-axis label spacing
  const cMap = new Map(created.map((r) => [r.day, r.n as number]));
  const rMap = new Map(resolved.map((r) => [r.day, r.n as number]));
  const cs = days.map((d) => cMap.get(d) ?? 0);
  const rs = days.map((d) => rMap.get(d) ?? 0);
  const step = Math.max(1, Math.ceil(Math.max(...cs, ...rs) / 4));
  const yMax = step * 4;
  const W = size.w, H = size.h, L = 32, R = 74, T = 10, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const x = (i: number) => L + (i * pw) / (days.length - 1);
  const y = (v: number) => T + ph - (v / yMax) * ph;
  const path = (a: number[]) => a.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const lab = (d: string) => accra({ day: "numeric", month: "short" }).format(new Date(d + "T12:00:00Z"));
  // keep the two end labels from overlapping when the last values are close
  let cy = y(cs.at(-1)!), ry = y(rs.at(-1)!);
  if (Math.abs(cy - ry) < 16) { const mid = (cy + ry) / 2; cy = cy <= ry ? mid - 8 : mid + 8; ry = cy <= ry ? mid + 8 : mid - 8; }
  const totalC = cs.reduce((a, b) => a + b, 0), totalR = rs.reduce((a, b) => a + b, 0);
  const ink2 = { fill: "var(--v-ink2)" }, muted = { fill: "var(--v-muted)" };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex gap-5 text-xs 2xl:text-sm" style={{ color: "var(--v-ink2)" }}>
        <span className="flex items-center gap-2"><i className="inline-block w-5" style={{ background: "var(--v-created)", height: 3 }} />Created ({totalC})</span>
        <span className="flex items-center gap-2"><i className="inline-block w-5" style={{ background: "var(--v-resolved)", height: 3 }} />Resolved ({totalR})</span>
      </div>
      <div ref={box} className="relative min-h-[150px] flex-1">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0" role="img" aria-label={`Tickets created and resolved per day, last ${range} days. ${totalC} created, ${totalR} resolved.`} onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3, 4].map((k) => (
            <g key={k}>
              <line x1={L} x2={W - R} y1={y(k * step)} y2={y(k * step)} style={{ stroke: k === 0 ? "var(--v-axis)" : "var(--v-grid)" }} strokeWidth={1} />
              <text x={L - 8} y={y(k * step) + 4} textAnchor="end" fontSize={11} style={muted}>{k * step}</text>
            </g>
          ))}
          {days.map((d, i) => (days.length - 1 - i) % every === 0 && (
            <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize={11} style={muted}>{lab(d)}</text>
          ))}
          <path d={path(cs)} fill="none" style={{ stroke: "var(--v-created)" }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <path d={path(rs)} fill="none" style={{ stroke: "var(--v-resolved)" }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <text x={x(days.length - 1) + 10} y={cy + 4} fontSize={12} fontWeight={600} style={ink2}>Created</text>
          <text x={x(days.length - 1) + 10} y={ry + 4} fontSize={12} fontWeight={600} style={ink2}>Resolved</text>
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ph} style={{ stroke: "var(--v-axis)" }} />
              <circle cx={x(hover)} cy={y(cs[hover])} r={5} strokeWidth={2} style={{ fill: "var(--v-created)", stroke: "var(--v-surface)" }} />
              <circle cx={x(hover)} cy={y(rs[hover])} r={5} strokeWidth={2} style={{ fill: "var(--v-resolved)", stroke: "var(--v-surface)" }} />
            </g>
          )}
          {days.map((d, i) => (
            <rect key={d} x={x(i) - pw / (days.length - 1) / 2} y={T} width={pw / (days.length - 1)} height={ph} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-2 rounded-lg px-3 py-2 text-xs shadow-lg 2xl:text-sm"
            style={{ left: x(hover), transform: hover > 8 ? "translateX(calc(-100% - 10px))" : "translateX(10px)", background: "var(--v-tip)", border: "1px solid var(--v-border)", color: "var(--v-ink)" }}
          >
            <div className="mb-1 font-semibold">{lab(days[hover])}</div>
            <div className="flex items-center gap-2"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--v-created)" }} />Created <b className="ml-auto pl-4">{cs[hover]}</b></div>
            <div className="flex items-center gap-2"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "var(--v-resolved)" }} />Resolved <b className="ml-auto pl-4">{rs[hover]}</b></div>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Tickets per day</caption>
        <thead><tr><th>Day</th><th>Created</th><th>Resolved</th></tr></thead>
        <tbody>{days.map((d, i) => <tr key={d}><td>{d}</td><td>{cs[i]}</td><td>{rs[i]}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** When do tickets arrive? Weekday x hour grid, one blue ramp (light = few, strong = many).
 *  `rows` use SQLite's weekday numbers (0 = Sunday); we show Monday first. */
export function Heatmap({ rows }: { rows: { dow: number; hr: number; n: number }[] }) {
  const grid = new Map(rows.map((r) => [`${r.dow}-${r.hr}`, r.n]));
  const max = Math.max(1, ...rows.map((r) => r.n));
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  const total = rows.reduce((a, r) => a + r.n, 0);
  const peak = rows.reduce((best, r) => (r.n > best.n ? r : best), { dow: 0, hr: 0, n: 0 });
  return (
    <div>
      <div
        role="img"
        aria-label={total ? `Tickets by weekday and hour. Busiest: ${DOW_FULL[(peak.dow + 6) % 7]} at ${String(peak.hr).padStart(2, "0")}:00 with ${peak.n}.` : "No tickets in this period."}
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: "34px repeat(24, minmax(0, 1fr))" }}
      >
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-center text-[10px] leading-4" style={{ color: "var(--v-muted)" }}>{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div>
        ))}
        {order.map((d, ri) => (
          <div key={d} className="contents">
            <div className="pr-1 text-right text-[11px] leading-5" style={{ color: "var(--v-muted)" }}>{DOW[ri]}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const n = grid.get(`${d}-${h}`) ?? 0;
              return (
                <div
                  key={h}
                  title={`${DOW_FULL[ri]} ${String(h).padStart(2, "0")}:00 · ${n} ticket${n === 1 ? "" : "s"}`}
                  className="h-5 rounded-[3px]"
                  style={{ background: n ? `color-mix(in oklab, var(--v-created) ${Math.round(18 + (n / max) * 82)}%, var(--v-surface))` : "var(--v-grid)" }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs" style={{ color: "var(--v-muted)" }}>
        <span>
          {total ? <>Busiest: <b style={{ color: "var(--v-ink)" }}>{DOW_FULL[(peak.dow + 6) % 7]} {String(peak.hr).padStart(2, "0")}:00</b> ({peak.n})</> : "No tickets in this period"}
        </span>
        <span className="flex items-center gap-1.5">Fewer
          <i className="inline-block h-2.5 w-24 rounded" style={{ background: "linear-gradient(90deg, color-mix(in oklab, var(--v-created) 18%, var(--v-surface)), var(--v-created))" }} />
        More</span>
      </div>
    </div>
  );
}
