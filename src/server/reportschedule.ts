/* When the monthly report goes out. Pure date arithmetic (no database, no clock unless passed in), so it can be tested on its own.
   Every time here is UTC, which is Ghana wall-clock time all year. A schedule is "this moment, then the same day of the month and the
   same time every month"; a day that a short month lacks (the 31st in June) falls on that month's last day. */

/** "2026-12-05T08:30" (what a date-and-time picker gives) -> seconds since 1970, or null if it is not a real date and time. */
export function parseLocal(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(t);
  if (y < 2020 || y > 2100 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi) return null;
  return Math.floor(t / 1000);
}

/** Seconds since 1970 -> "2026-12-05T08:30" (for a date-and-time picker). */
export const toLocal = (t: number) => new Date(t * 1000).toISOString().slice(0, 16);

/** The same day of the month (`day`, clamped to the month's length) and time, one month after `t`. */
export function addMonthKeepDay(t: number, day: number): number {
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 2, 0)).getUTCDate(); // length of NEXT month
  return Math.floor(Date.UTC(y, m + 1, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes()) / 1000);
}

/** After a send: the next slot that is still in the future (after downtime this is ONE email, never a backlog). */
export function nextAfter(t: number, day: number, nowS: number): number {
  let n = t;
  for (let i = 0; i < 240 && n <= nowS; i++) n = addMonthKeepDay(n, day);
  return n;
}

/** The suggestion for a new schedule: the 1st of next month at 08:00. */
export function firstOfNextMonth(nowS: number): number {
  const d = new Date(nowS * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 8, 0) / 1000);
}

/** "2026-10": the month before the one `t` falls in. A report sent on 5 Dec covers November. */
export function reportMonthFor(t: number): string {
  const d = new Date(t * 1000);
  const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return `${p.getUTCFullYear()}-${String(p.getUTCMonth() + 1).padStart(2, "0")}`;
}
