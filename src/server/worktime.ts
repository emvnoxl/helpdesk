/* Pure date and text helpers with no database behind them, unit-tested in tests/analytics.mjs:
   - working-hours maths for the response targets (Ghana is UTC+0, so UTC hours are office hours),
   - the next date of a recurring ticket,
   - turning an incoming email into the few lines the person actually wrote. */

/* ---------------- working hours ---------------- */

export interface WorkCalendar {
  enabled: boolean;
  days: number[];      // 0 = Sunday ... 6 = Saturday
  start: number;       // minutes after midnight
  end: number;
  holidays: string[];  // "YYYY-MM-DD"
}
export const DEFAULT_CALENDAR: WorkCalendar = { enabled: false, days: [1, 2, 3, 4, 5], start: 8 * 60, end: 17 * 60, holidays: [] };

const DAY = 86400;
const MAX_DAYS = 4000; // a calendar with no working day left must not loop for ever
const usable = (c: WorkCalendar) => c.enabled && c.days.length > 0 && c.end > c.start;

/** The working window of the UTC day starting at `dayStart`, or null if the office is shut that day. */
function windowOf(c: WorkCalendar, dayStart: number): [number, number] | null {
  const d = new Date(dayStart * 1000);
  if (!c.days.includes(d.getUTCDay())) return null;
  if (c.holidays.length && c.holidays.includes(d.toISOString().slice(0, 10))) return null;
  return [dayStart + c.start * 60, dayStart + c.end * 60];
}

/** The moment `secs` of working time after `start`. With the calendar off this is plain addition. */
export function addWorkSeconds(c: WorkCalendar, start: number, secs: number): number {
  if (secs <= 0) return start;
  if (!usable(c)) return start + secs;
  let left = secs;
  let day = Math.floor(start / DAY) * DAY;
  for (let i = 0; i < MAX_DAYS; i++, day += DAY) {
    const w = windowOf(c, day);
    if (!w) continue;
    const from = Math.max(w[0], start);
    if (from >= w[1]) continue;
    if (left <= w[1] - from) return from + left;
    left -= w[1] - from;
  }
  return start + secs;
}

/** Working seconds between two moments (0 if `b` is not after `a`). */
export function workSecondsBetween(c: WorkCalendar, a: number, b: number): number {
  if (b <= a) return 0;
  if (!usable(c)) return b - a;
  let total = 0;
  let day = Math.floor(a / DAY) * DAY;
  for (let i = 0; i < MAX_DAYS && day < b; i++, day += DAY) {
    const w = windowOf(c, day);
    if (!w) continue;
    total += Math.max(0, Math.min(w[1], b) - Math.max(w[0], a));
  }
  return total;
}

/** Cleans whatever was stored or typed into a calendar that is safe to use. */
export function cleanCalendar(x: unknown): WorkCalendar {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const mins = (v: unknown, d: number) => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.min(1440, Math.max(0, Math.round(v)));
    const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
    return m ? Math.min(1440, Number(m[1]) * 60 + Number(m[2])) : d;
  };
  const days = Array.isArray(r.days) ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULT_CALENDAR.days;
  const holidays = Array.isArray(r.holidays)
    ? [...new Set(r.holidays.filter((h): h is string => typeof h === "string" && /^\d{4}-\d{2}-\d{2}$/.test(h) && !Number.isNaN(Date.parse(h))))].sort().slice(0, 200)
    : [];
  return { enabled: r.enabled === true, days, start: mins(r.start, DEFAULT_CALENDAR.start), end: mins(r.end, DEFAULT_CALENDAR.end), holidays };
}

/* ---------------- recurring tickets ---------------- */

export const EVERY = ["daily", "weekdays", "weekly", "monthly", "quarterly", "yearly"] as const;
export type Every = (typeof EVERY)[number];

/** The run after `t`. Month-based rules land on `anchorDay` (the day first chosen), or the month's last day if it is shorter. */
export function nextRun(every: Every, t: number, anchorDay: number): number {
  if (every === "daily") return t + DAY;
  if (every === "weekly") return t + 7 * DAY;
  if (every === "weekdays") {
    let n = t + DAY;
    while ([0, 6].includes(new Date(n * 1000).getUTCDay())) n += DAY;
    return n;
  }
  const d = new Date(t * 1000);
  const months = every === "monthly" ? 1 : every === "quarterly" ? 3 : 12;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Math.floor(Date.UTC(y, m, Math.min(Math.max(1, anchorDay), last), d.getUTCHours(), d.getUTCMinutes()) / 1000);
}

/** Steps forward until the run is in the future, so a server that was off for a month raises one ticket, not thirty. */
export function nextRunAfter(every: Every, from: number, anchorDay: number, now: number): number {
  let n = nextRun(every, from, anchorDay);
  for (let i = 0; i < 5000 && n <= now; i++) n = nextRun(every, n, anchorDay);
  return n;
}

/* ---------------- incoming email ---------------- */

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { const c = Number(n); return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : " "; });
}

export const REPLY_MARKER = "Reply above this line";

/** What the person wrote, without the quoted earlier messages, the signature block or our own notification underneath. */
export function cleanEmailBody(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n").replace(/[​﻿]/g, "");
  const cuts = [
    s.indexOf(REPLY_MARKER),
    s.search(/^-{2,} ?Original Message ?-{2,}/im),
    s.search(/^_{10,}\s*$/m),                                  // Outlook on the web
    s.search(/^On [^\n]{5,200}(\n[^\n]{0,120})?\bwrote:\s*$/m),  // Gmail, Apple Mail (the line may wrap)
    s.search(/^From:[^\n]+\n(?:[^\n]*\n){0,3}?(Sent|Date):/m),   // Outlook desktop
    s.search(/^-- $/m),                                         // signature delimiter
    s.search(/^Sent from (my|Outlook)/im),
  ].filter((i) => i >= 0);
  if (cuts.length) {
    let at = Math.min(...cuts);
    if (s.startsWith(REPLY_MARKER, at)) at = s.lastIndexOf("\n", at) + 1; // drop the whole marker line, dashes included
    s = s.slice(0, at);
  }
  const lines = s.split("\n");
  while (lines.length && (/^\s*>/.test(lines[lines.length - 1]!) || !lines[lines.length - 1]!.trim())) lines.pop(); // trailing quote block
  return lines.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 10000);
}

/** "RE: FW: [FG-0042] Printer offline" -> "Printer offline" */
export function cleanSubject(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/^(re|fw|fwd|aw|tr)\s*:\s*/i, "").replace(/^\[?FG-\d{3,}\]?\s*:?\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.slice(0, 200);
}

/** The ticket reference in a subject line ("RE: [FG-0042] ..." -> "FG-0042"), if any. */
export const refIn = (subject: string): string | null => /\bFG-(\d{3,9})\b/i.exec(subject)?.[0]?.toUpperCase() ?? null;

/** "ama.boateng@x" -> "Ama Boateng", for a first email from someone the helpdesk has not met. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local.replace(/[._\-+]+/g, " ").replace(/\d+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join(" ").slice(0, 100) || "Unknown sender";
}
