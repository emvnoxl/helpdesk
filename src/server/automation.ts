import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { changed } from "./bus";
import { db } from "./db";
import { notifyUser } from "./notifications";
import { getSetting, putSetting } from "./sla";

/* Housekeeping IT would otherwise do by hand. Today: close tickets that have been "resolved" for N days (an admin closes them by hand
   otherwise, which is the end-of-day sweep on the Resolved tab). A requester who writes back on a resolved ticket reopens it, so a
   ticket they are still talking about is never closed under them. Runs every 10 minutes; admin sets N under System > Automation. */

export const AUTO_CLOSE_CHOICES = [0, 1, 2, 3, 5, 7, 14, 30]; // 0 = off
interface Settings { auto_close_days: number; last: { at: number; closed: number } | null }
let cfg: Settings = { auto_close_days: 0, last: null };
const now = () => Math.floor(Date.now() / 1000);

export async function loadAutomation() {
  try {
    const s = JSON.parse((await getSetting("automation")) ?? "null") as Partial<Settings> | null;
    cfg = { auto_close_days: AUTO_CLOSE_CHOICES.includes(Number(s?.auto_close_days)) ? Number(s?.auto_close_days) : 0, last: s?.last ?? null };
  } catch { cfg = { auto_close_days: 0, last: null }; }
}
const save = () => putSetting("automation", JSON.stringify(cfg));

const eligible = (days: number) => `status = 'resolved' AND COALESCE(resolved_at, updated_at) <= ${now() - days * 86400}`;

/** Closes what has been resolved long enough. Returns how many. */
export async function runAutoClose(): Promise<number> {
  if (!cfg.auto_close_days) return 0;
  const { results } = await db
    .prepare(`SELECT id, ref, title, requester_id FROM tickets WHERE ${eligible(cfg.auto_close_days)} ORDER BY id LIMIT 200`)
    .all<{ id: number; ref: string; title: string; requester_id: number }>();
  if (!results.length) return 0;
  const ts = now();
  await db.batch(
    results.flatMap((r) => [
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'resolved'").bind(ts, ts, r.id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, created_at) VALUES (?, NULL, 'status', 'resolved', 'closed', ?)").bind(r.id, ts),
      notifyUser(r.requester_id, r.id, "status", `${r.ref} is now closed`, r.title, ts),
    ]),
  );
  cfg.last = { at: ts, closed: results.length };
  await save();
  await audit(null, "automation.auto_close", "admin", `Closed ${results.length} ticket${results.length === 1 ? "" : "s"} resolved for ${cfg.auto_close_days}+ days (${results.map((r) => r.ref).slice(0, 12).join(", ")}${results.length > 12 ? ", …" : ""})`, { who: SYSTEM });
  changed();
  return results.length;
}

export function startAutomation() {
  const run = () => void runAutoClose().catch((e) => console.error("[automation]", (e as Error).message));
  const first = setTimeout(run, 90_000);
  const t = setInterval(run, 10 * 60_000);
  first.unref?.();
  t.unref?.();
  return () => { clearTimeout(first); clearInterval(t); };
}

/** Admin only (mounted at /api/admin/automation). */
export const automation = new Hono<AppEnv>();

automation.get("/", async (c) => {
  const days = cfg.auto_close_days;
  const n = days ? (await db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE ${eligible(days)}`).first<{ n: number }>())?.n ?? 0 : 0;
  return c.json({ auto_close_days: days, choices: AUTO_CLOSE_CHOICES, due_now: n, last: cfg.last });
});

// { auto_close_days }
automation.put("/", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const d = Number(b.auto_close_days);
  if (!AUTO_CLOSE_CHOICES.includes(d)) return c.json({ error: "Choose one of the listed numbers of days." }, 400);
  cfg.auto_close_days = d;
  await save();
  await audit(c, "automation.settings", "admin", d ? `Resolved tickets now close by themselves after ${d} day${d === 1 ? "" : "s"}` : "Automatic closing of resolved tickets switched off");
  const closed = d ? await runAutoClose() : 0; // takes effect now, not in ten minutes
  return c.json({ ok: true, closed });
});
