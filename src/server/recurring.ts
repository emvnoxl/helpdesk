import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { db } from "./db";
import { applyTemplate } from "./tasks";
import { createTicket } from "./tickets";
import { EVERY, type Every, nextRunAfter } from "./worktime";

/* Recurring tickets: the jobs that come round again (check the backups, renew a licence, test the UPS). An admin sets them up under
   Library > Recurring (/api/admin/recurring); a timer in this process raises the ticket when its time comes and moves the date on.
   If the server was off when one was due, it raises ONE ticket at start-up and then skips ahead: no pile of missed copies. */

export const recurring = new Hono<AppEnv>();
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const now = () => Math.floor(Date.now() / 1000);
const PRIOS = ["low", "medium", "high", "urgent"] as const;
type Prio = (typeof PRIOS)[number];
const RUN_HOUR = 8; // 08:00 (Ghana time = UTC): there when the day starts

interface Row {
  id: number; title: string; description: string; category_id: number | null; priority: Prio; assignee_id: number | null; checklist_id: number | null;
  every: Every; anchor_day: number; next_at: number; last_run_at: number | null; last_ticket_id: number | null; active: number; created_by: number | null;
}

recurring.get("/", async (c) => {
  const { results } = await db
    .prepare(
      `SELECT r.*, c.name AS category, a.name AS assignee, k.name AS checklist, t.ref AS last_ref
       FROM recurring_tickets r
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN users a ON a.id = r.assignee_id AND a.active = 1 AND a.role IN ('agent','admin')
       LEFT JOIN checklist_templates k ON k.id = r.checklist_id
       LEFT JOIN tickets t ON t.id = r.last_ticket_id
       ORDER BY r.active DESC, r.next_at LIMIT 200`,
    )
    .all();
  return c.json(results);
});

/** "2026-12-01" -> 08:00 that day. */
function startOf(date: unknown): number | null {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), RUN_HOUR);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

async function read(b: Record<string, unknown>, existing?: Row) {
  const title = str(b.title, 200);
  if (title.length < 3) return { error: "Give it a title." };
  const every = EVERY.includes(b.every as Every) ? (b.every as Every) : null;
  if (!every) return { error: "Choose how often it repeats." };
  const priority = PRIOS.includes(b.priority as Prio) ? (b.priority as Prio) : "medium";
  let assigneeId: number | null = null;
  if (b.assignee_id !== null && b.assignee_id !== undefined && b.assignee_id !== "") {
    assigneeId = Number(b.assignee_id);
    if (!(await db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('agent','admin')").bind(assigneeId).first())) return { error: "That person can't be assigned tickets." };
  }
  const start = startOf(b.start);
  if (b.start !== undefined && start === null) return { error: "Pick the date of the next one." };
  if (start === null && !existing) return { error: "Pick the date of the first one." };
  const nextAt = start ?? existing!.next_at;
  return {
    title, description: str(b.description, 10000), every, priority, assigneeId,
    categoryId: Number(b.category_id) || null, checklistId: Number(b.checklist_id) || null,
    nextAt, anchorDay: start !== null ? new Date(start * 1000).getUTCDate() : existing!.anchor_day,
  };
}

recurring.post("/", async (c) => {
  const v = await read(await c.req.json().catch(() => ({})));
  if ("error" in v) return c.json({ error: v.error }, 400);
  const row = await db
    .prepare("INSERT INTO recurring_tickets (title, description, category_id, priority, assignee_id, checklist_id, every, anchor_day, next_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(v.title, v.description, v.categoryId, v.priority, v.assigneeId, v.checklistId, v.every, v.anchorDay, v.nextAt, c.get("user").id)
    .first<{ id: number }>();
  await audit(c, "recurring.created", "admin", `Set up the recurring ticket “${v.title}” (${v.every})`);
  return c.json({ id: row!.id }, 201);
});

const byId = (id: number) => db.prepare("SELECT * FROM recurring_tickets WHERE id = ?").bind(id).first<Row>();

recurring.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const cur = await byId(id);
  if (!cur) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  // Pause / resume on its own
  if (typeof b.active === "boolean" && b.title === undefined) {
    // Resuming something whose date has passed must not fire a stale ticket straight away.
    const nextAt = b.active && cur.next_at <= now() ? nextRunAfter(cur.every, cur.next_at, cur.anchor_day, now()) : cur.next_at;
    await db.prepare("UPDATE recurring_tickets SET active = ?, next_at = ? WHERE id = ?").bind(b.active ? 1 : 0, nextAt, id).run();
    await audit(c, b.active ? "recurring.resumed" : "recurring.paused", "admin", `${b.active ? "Resumed" : "Paused"} the recurring ticket “${cur.title}”`);
    return c.json({ ok: true });
  }
  const v = await read(b, cur);
  if ("error" in v) return c.json({ error: v.error }, 400);
  await db
    .prepare("UPDATE recurring_tickets SET title = ?, description = ?, category_id = ?, priority = ?, assignee_id = ?, checklist_id = ?, every = ?, anchor_day = ?, next_at = ? WHERE id = ?")
    .bind(v.title, v.description, v.categoryId, v.priority, v.assigneeId, v.checklistId, v.every, v.anchorDay, v.nextAt, id)
    .run();
  await audit(c, "recurring.updated", "admin", `Changed the recurring ticket “${v.title}”`);
  return c.json({ ok: true });
});

recurring.delete("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const cur = await byId(id);
  if (!cur) return c.json({ error: "not found" }, 404);
  await db.prepare("DELETE FROM recurring_tickets WHERE id = ?").bind(id).run();
  await audit(c, "recurring.deleted", "admin", `Deleted the recurring ticket “${cur.title}” (tickets already raised are kept)`);
  return c.json({ ok: true });
});

// Raise one now, without touching the schedule.
recurring.post("/:id{[0-9]+}/run", async (c) => {
  const cur = await byId(Number(c.req.param("id")));
  if (!cur) return c.json({ error: "not found" }, 404);
  const t = await raise(cur, false);
  if (!t) return c.json({ error: "There is no active admin to raise it for." }, 409);
  await audit(c, "recurring.run", "admin", `Raised ${t.ref} now from the recurring ticket “${cur.title}”`, { ticketId: t.id });
  return c.json(t, 201);
});

/** The ticket needs a requester: whoever set the schedule up if they are still on the team, otherwise any active admin. */
async function raise(r: Row, scheduled: boolean): Promise<{ id: number; ref: string } | null> {
  const owner = await db
    .prepare("SELECT id, name FROM users WHERE active = 1 AND role IN ('agent','admin') ORDER BY id = ? DESC, role = 'admin' DESC, id LIMIT 1")
    .bind(r.created_by)
    .first<{ id: number; name: string }>();
  if (!owner) return null;
  const assignee = r.assignee_id ? await db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('agent','admin')").bind(r.assignee_id).first<{ id: number }>() : null;
  const t = await createTicket(
    { id: owner.id, name: "Scheduled" },
    { title: r.title, description: r.description || r.title, categoryId: r.category_id, priority: r.priority, assigneeId: assignee?.id ?? null, source: "recurring", tellEveryone: true },
  );
  if (r.checklist_id) await applyTemplate(t.id, r.checklist_id);
  await db.prepare("UPDATE recurring_tickets SET last_run_at = ?, last_ticket_id = ? WHERE id = ?").bind(now(), t.id, r.id).run();
  if (scheduled) await audit(null, "ticket.created", "ticket", `Raised ${t.ref} on schedule (${r.every}): ${r.title}`, { ticketId: t.id, who: SYSTEM });
  return t;
}

export async function runDue(): Promise<number> {
  const ts = now();
  const { results } = await db.prepare("SELECT * FROM recurring_tickets WHERE active = 1 AND next_at <= ? ORDER BY next_at LIMIT 25").bind(ts).all<Row>();
  let n = 0;
  for (const r of results) {
    // Move the date first: if raising fails the job is not retried every minute for ever.
    await db.prepare("UPDATE recurring_tickets SET next_at = ? WHERE id = ?").bind(nextRunAfter(r.every, r.next_at, r.anchor_day, ts), r.id).run();
    try {
      if (await raise(r, true)) n++;
    } catch (e) {
      console.error(`[recurring] could not raise “${r.title}”:`, (e as Error).message);
    }
  }
  return n;
}

export function startRecurring() {
  const run = () => void runDue().catch((e) => console.error("[recurring]", (e as Error).message));
  const t = setInterval(run, 60_000);
  t.unref();
  setTimeout(run, 4_000).unref();
  return () => clearInterval(t);
}
