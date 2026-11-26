import { useEffect, useMemo, useRef, useState } from "react";

/* A calendar and a time list in one card, drawn by us (the browser's own date-and-time box looks different in every browser and loses its icons
   in dark or light mode). Values are plain "2026-12-05T08:30" strings with no time zone: the helpdesk reads them as Ghana time (UTC).
   Keyboard: arrows move by day or week, PageUp/PageDown by month, Enter or Space picks. */

const pad = (n: number) => String(n).padStart(2, "0");
interface P { y: number; mo: number; d: number; h: number; mi: number }
const parse = (v: string): P | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  return m ? { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]! } : null;
};
const fmt = (p: P) => `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
const day = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const full = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function Chevron({ dir }: { dir: "left" | "right" }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={dir === "left" ? "m15 6-6 6 6 6" : "m9 6 6 6-6 6"} /></svg>;
}

export function DateTimePicker({ value, min, onChange, label = "Date and time" }: { value: string; min: string; onChange: (v: string) => void; label?: string }) {
  const cur = parse(value);
  const lo = parse(min);
  const seed = cur ?? lo ?? { y: new Date().getUTCFullYear(), mo: new Date().getUTCMonth() + 1, d: 1, h: 8, mi: 0 };
  const [view, setView] = useState({ y: seed.y, mo: seed.mo });
  const [focus, setFocus] = useState<{ y: number; mo: number; d: number } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const hoursRef = useRef<HTMLDivElement>(null);
  const minsRef = useRef<HTMLDivElement>(null);
  const minDay = lo ? day(lo.y, lo.mo, lo.d) : "";

  // a value chosen elsewhere (a quick pick) brings the calendar to its month
  useEffect(() => { if (cur) setView({ y: cur.y, mo: cur.mo }); }, [cur?.y, cur?.mo]); // eslint-disable-line react-hooks/exhaustive-deps

  const cells = useMemo(() => {
    const first = (new Date(Date.UTC(view.y, view.mo - 1, 1)).getUTCDay() + 6) % 7; // Monday first
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(Date.UTC(view.y, view.mo - 1, 1 - first + i)); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }; });
  }, [view.y, view.mo]);
  const rows = cells.slice(35).every((c) => c.mo !== view.mo) ? 5 : 6; // no empty last week
  const todayStr = (lo ? day(lo.y, lo.mo, lo.d) : "");

  const setDay = (y: number, mo: number, d: number) => {
    let next: P = { y, mo, d, h: cur?.h ?? lo?.h ?? 8, mi: cur?.mi ?? 0 };
    if (lo && fmt(next) < min) next = { ...next, h: lo.h, mi: lo.mi }; // same day as the earliest moment: keep the time allowed
    onChange(fmt(next));
  };
  const setTime = (h: number, mi: number) => { if (cur) onChange(fmt({ ...cur, h, mi })); };
  const shift = (months: number) => { const d = new Date(Date.UTC(view.y, view.mo - 1 + months, 1)); setView({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 }); };

  // keep the chosen hour and minute in sight inside their lists
  useEffect(() => {
    for (const [ref, sel] of [[hoursRef, cur?.h], [minsRef, cur?.mi]] as const) {
      const box = ref.current, el = box?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (box && el && sel !== undefined) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
    }
  }, [cur?.h, cur?.mi, cur?.d]);

  // roving focus for the arrow keys
  useEffect(() => { if (focus) grid.current?.querySelector<HTMLElement>(`[data-day="${day(focus.y, focus.mo, focus.d)}"]`)?.focus(); }, [focus]);
  const onKey = (e: React.KeyboardEvent, c: { y: number; mo: number; d: number }) => {
    const by = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
    if (by !== undefined || e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      const d = by !== undefined ? new Date(Date.UTC(c.y, c.mo - 1, c.d + by)) : new Date(Date.UTC(c.y, c.mo - 1 + (e.key === "PageUp" ? -1 : 1), c.d));
      const t = { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
      setView({ y: t.y, mo: t.mo });
      setFocus(t);
    }
  };

  const minsList = useMemo(() => { const l = Array.from({ length: 12 }, (_, i) => i * 5); if (cur && !l.includes(cur.mi)) l.push(cur.mi); return l.sort((a, b) => a - b); }, [cur?.mi]); // eslint-disable-line react-hooks/exhaustive-deps
  const sameMinDay = !!(cur && lo && day(cur.y, cur.mo, cur.d) === minDay);
  const hourOff = (h: number) => sameMinDay && h < lo!.h;
  const minOff = (m: number) => sameMinDay && cur!.h === lo!.h && m < lo!.mi;
  const pill = "rounded-lg px-2 py-1 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <div role="group" aria-label={label} className="w-full max-w-[26rem] rounded-2xl border border-fg/15 bg-surface p-3 text-fg shadow-sm">
      <div className="mb-2 flex items-center gap-2 rounded-xl bg-fg/5 px-3 py-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        <p className="min-w-0 truncate text-sm" aria-live="polite">{cur ? <><b>{new Date(Date.UTC(cur.y, cur.mo - 1, cur.d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</b> · <b>{pad(cur.h)}:{pad(cur.mi)}</b></> : "Pick a day"}</p>
      </div>

      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center justify-between">
            <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="grid h-8 w-8 place-items-center rounded-lg text-fg hover:bg-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green"><Chevron dir="left" /></button>
            <span className="text-sm font-extrabold" aria-live="polite">{MONTHS[view.mo - 1]} {view.y}</span>
            <button type="button" onClick={() => shift(1)} aria-label="Next month" className="grid h-8 w-8 place-items-center rounded-lg text-fg hover:bg-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green"><Chevron dir="right" /></button>
          </div>
          <div className="grid grid-cols-7 text-center text-[11px] font-bold uppercase tracking-wide text-neutral-600 dark:text-neutral-400" aria-hidden>{WEEK.map((w) => <span key={w} className="py-1">{w}</span>)}</div>
          <div ref={grid} className="grid grid-cols-7 gap-y-0.5" role="grid" aria-label={`${MONTHS[view.mo - 1]} ${view.y}`}>
            {cells.slice(0, rows * 7).map((c) => {
              const s = day(c.y, c.mo, c.d), inMonth = c.mo === view.mo, sel = !!cur && s === day(cur.y, cur.mo, cur.d), off = !!minDay && s < minDay, today = s === todayStr;
              const tab = focus ? s === day(focus.y, focus.mo, focus.d) : cur ? sel && inMonth : c.mo === view.mo && c.d === 1;
              return (
                <button key={s} type="button" role="gridcell" data-day={s} disabled={off} tabIndex={tab ? 0 : -1} aria-selected={sel} aria-label={full(c.y, c.mo, c.d)}
                  onClick={() => setDay(c.y, c.mo, c.d)} onKeyDown={(e) => onKey(e, c)}
                  className={`mx-auto grid h-9 w-9 place-items-center rounded-full text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green disabled:cursor-not-allowed disabled:opacity-25 ${sel ? "bg-brand-green font-extrabold text-ink" : `${inMonth ? "font-semibold text-fg" : "text-neutral-500"} hover:bg-fg/10`} ${today && !sel ? "ring-1 ring-inset ring-brand-green" : ""}`}>
                  {c.d}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex w-[8.5rem] shrink-0 flex-col" aria-label="Time">
          <div className="mb-1 grid h-8 place-items-center text-sm font-extrabold">Time</div>
          <div className="grid grid-cols-2 gap-1.5 text-center text-[11px] font-bold uppercase tracking-wide text-neutral-600 dark:text-neutral-400" aria-hidden><span className="py-1">Hour</span><span className="py-1">Min</span></div>
          <div className="grid h-[13.25rem] grid-cols-2 gap-1.5">
            {([[hoursRef, Array.from({ length: 24 }, (_, h) => h), cur?.h, hourOff, (h: number) => setTime(h, cur!.mi), "hour"], [minsRef, minsList, cur?.mi, minOff, (m: number) => setTime(cur!.h, m), "minute"]] as const).map(([ref, list, sel, off, pick, name]) => (
              <div key={name} ref={ref} className="relative flex flex-col gap-0.5 overflow-y-auto rounded-xl bg-fg/5 p-1" role="listbox" aria-label={name === "hour" ? "Hour" : "Minute"}>
                {list.map((n) => (
                  <button key={n} type="button" role="option" aria-selected={sel === n} aria-pressed={sel === n} disabled={!cur || off(n)} onClick={() => pick(n)}
                    className={`${pill} ${sel === n ? "bg-brand-green text-ink" : "text-fg hover:bg-fg/10"}`}>{pad(n)}</button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
