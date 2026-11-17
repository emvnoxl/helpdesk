import { audit, SYSTEM } from "./audit";
import { changed as liveChanged } from "./bus";
import { db } from "./db";
import { notifyUser } from "./notifications";
import { type WorkCalendar, DEFAULT_CALENDAR, addWorkSeconds, cleanCalendar, workSecondsBetween } from "./worktime";

/* Response targets ("SLA"): how many hours each priority gets. The numbers live in the settings table so an admin can change them
   (Library > Response targets); these are the starting values.

   A ticket's due_at = created_at + target hours + the time it spent 'waiting' (the clock stops while IT waits for the requester).
   With working hours switched on (settings.business_hours) all three are counted in working time only: a ticket raised on Friday
   evening starts its clock on Monday morning, and paused_secs holds working seconds.
   The watcher below runs every minute and, once per ticket, tells the team when a ticket is close to its target and again when it is late. */

export const PRIORITY_KEYS = ["urgent", "high", "medium", "low"] as const;
export type PriorityKey = (typeof PRIORITY_KEYS)[number];
export type SlaHours = Record<PriorityKey, number>;
export const DEFAULT_SLA_HOURS: SlaHours = { urgent: 4, high: 8, medium: 24, low: 72 };

let cache: SlaHours | null = null;
let calendar: WorkCalendar = DEFAULT_CALENDAR;

export async function getSetting(key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}
export async function putSetting(key: string, value: string) {
  await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** The office calendar. Loaded once at start-up (below) and replaced when an admin saves it, so the maths can stay synchronous. */
export const workCalendar = () => calendar;
/** Working seconds between two moments (plain seconds while working hours are off). */
export const workBetween = (a: number, b: number) => workSecondsBetween(calendar, a, b);

export async function slaHours(): Promise<SlaHours> {
  if (cache) return cache;
  const out = { ...DEFAULT_SLA_HOURS };
  try {
    const raw = JSON.parse((await getSetting("sla_hours")) ?? "{}") as Record<string, unknown>;
    for (const k of PRIORITY_KEYS) if (typeof raw[k] === "number" && raw[k] > 0 && raw[k] <= 24 * 90) out[k] = raw[k] as number;
  } catch {
    /* unreadable setting: the defaults apply */
  }
  return (cache = out);
}

/** Validates what an admin typed (whole or half hours, 1 to 720) and saves it. Returns an error text or the saved values. */
export async function saveSlaHours(input: unknown): Promise<{ error: string } | { hours: SlaHours }> {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const next = {} as SlaHours;
  for (const k of PRIORITY_KEYS) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v) || v < 0.5 || v > 720) return { error: `Give ${k} a target between 0.5 and 720 hours.` };
    next[k] = Math.round(v * 2) / 2;
  }
  await putSetting("sla_hours", JSON.stringify(next));
  cache = next;
  await recomputeOpen();
  return { hours: next };
}

export const dueAt = (hours: SlaHours, priority: PriorityKey, createdAt: number, pausedSecs = 0) => addWorkSeconds(calendar, createdAt, pausedSecs + Math.round(hours[priority] * 3600));

/** Open tickets follow new targets or new working hours straight away (time already spent waiting still doesn't count). Alerts can fire again. */
async function recomputeOpen() {
  const hours = await slaHours();
  const { results } = await db
    .prepare("SELECT id, priority, created_at, paused_secs FROM tickets WHERE status NOT IN ('resolved','closed') LIMIT 5000")
    .all<{ id: number; priority: PriorityKey; created_at: number; paused_secs: number }>();
  if (results.length) {
    await db.batch(results.map((t) => db.prepare("UPDATE tickets SET sla_alert = 0, due_at = ? WHERE id = ?").bind(dueAt(hours, t.priority, t.created_at, t.paused_secs), t.id)));
  }
  liveChanged();
}

export async function saveCalendar(input: unknown): Promise<{ error: string } | { calendar: WorkCalendar }> {
  const next = cleanCalendar(input);
  if (next.enabled && !next.days.length) return { error: "Pick at least one working day." };
  if (next.enabled && next.end - next.start < 60) return { error: "The working day must be at least an hour long." };
  // Time already spent waiting was counted on the old calendar; convert it so a paused ticket is not short-changed.
  const { results } = await db
    .prepare("SELECT id, paused_secs FROM tickets WHERE status NOT IN ('resolved','closed') AND paused_secs > 0 LIMIT 5000")
    .all<{ id: number; paused_secs: number }>();
  const perDay = (c: WorkCalendar) => (c.enabled ? ((c.end - c.start) * 60 * c.days.length) / 7 : 86400);
  const ratio = perDay(next) / perDay(calendar);
  await putSetting("business_hours", JSON.stringify(next));
  if (results.length && ratio !== 1) await db.batch(results.map((t) => db.prepare("UPDATE tickets SET paused_secs = ? WHERE id = ?").bind(Math.round(t.paused_secs * ratio), t.id)));
  calendar = next;
  await recomputeOpen();
  return { calendar: next };
}

/** Warn when a ticket has this share of its target left (but never later than 30 minutes before it). */
const WARN_SHARE = 0.2;
const WARN_MIN_SECONDS = 1800;

export async function checkSla() {
  const now = Math.floor(Date.now() / 1000);
  const hours = await slaHours();
  // Not yet warned, or warned and now past the target. The "close to target" test is done here, in working time.
  const { results } = await db
    .prepare(
      `SELECT id, ref, title, priority, assignee_id, due_at, sla_alert FROM tickets
       WHERE status IN ('open','in_progress') AND due_at IS NOT NULL AND (sla_alert = 0 OR (sla_alert = 1 AND due_at <= ?))
       ORDER BY due_at LIMIT 500`,
    )
    .bind(now)
    .all<{ id: number; ref: string; title: string; priority: PriorityKey; assignee_id: number | null; due_at: number; sla_alert: number }>();

  for (const t of results) {
    const late = t.due_at <= now;
    const workLeft = workBetween(now, t.due_at);
    if (!late && workLeft > Math.max(WARN_MIN_SECONDS, hours[t.priority] * 3600 * WARN_SHARE)) continue;
    const level = late ? 2 : 1;
    if (t.sla_alert >= level) continue;
    const kind = late ? "sla_breach" : "sla_warn";
    const title = late ? `${t.ref} is past its target` : `${t.ref} is close to its target`;
    const left = Math.max(1, Math.round(workLeft / 60));
    const body = late ? `${t.title} · ${t.priority} priority` : `${t.title} · about ${left < 90 ? `${left} min` : `${Math.round(left / 60)} h`}${calendar.enabled ? " of working time" : ""} left`;
    // The person on it, or the whole team if nobody has it yet. Admins hear about late tickets either way.
    const who = (
      await db
        .prepare(`SELECT id FROM users WHERE active = 1 AND role IN ('agent','admin') AND (id = ? OR (? IS NULL AND ?) OR (role = 'admin' AND ?))`)
        .bind(t.assignee_id, t.assignee_id, 1, late ? 1 : 0)
        .all<{ id: number }>()
    ).results;
    await db.batch([db.prepare("UPDATE tickets SET sla_alert = ? WHERE id = ?").bind(level, t.id), ...who.map((u) => notifyUser(u.id, t.id, kind, title, body, now))]);
    if (late) await audit(null, "ticket.sla_breach", "ticket", `${t.ref} went past its response target (${t.priority})`, { ticketId: t.id, who: SYSTEM });
    liveChanged(t.id);
  }
}

export function startSla() {
  const run = () => void checkSla().catch((e) => console.error("[sla]", (e as Error).message));
  const t = setInterval(run, 60_000);
  t.unref();
  setTimeout(run, 5_000).unref();
  return () => clearInterval(t);
}

// Loaded before the first request: everything above reads the calendar synchronously.
try {
  calendar = cleanCalendar(JSON.parse((await getSetting("business_hours")) ?? "{}"));
} catch {
  calendar = DEFAULT_CALENDAR;
}
