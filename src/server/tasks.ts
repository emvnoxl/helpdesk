import { Hono } from "hono";
import { type AppEnv, requireRole } from "./auth";
import { audit } from "./audit";
import { changed } from "./bus";
import { db } from "./db";

/* The checklist on a ticket: steps staff tick off as they go (set up the account, hand over the laptop...). Staff only: the ticket API
   leaves `tasks` out for requesters. Steps come from a template (checklists.ts), a recurring ticket, or are typed in one at a time. */

const MAX_TASKS = 60;
const now = () => Math.floor(Date.now() / 1000);

export const tasksFor = async (ticketId: number) =>
  (
    await db
      .prepare(
        `SELECT k.id, k.text, k.done, k.done_at, u.name AS done_by FROM ticket_tasks k LEFT JOIN users u ON u.id = k.done_by
         WHERE k.ticket_id = ? ORDER BY k.position, k.id LIMIT ?`,
      )
      .bind(ticketId, MAX_TASKS)
      .all<{ id: number; text: string; done: number; done_at: number | null; done_by: string | null }>()
  ).results;

export const cleanItems = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [])
    .map((x) => (typeof x === "string" ? x.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim().slice(0, 200) : ""))
    .filter(Boolean)
    .slice(0, MAX_TASKS);

/** Adds steps to the end of a ticket's checklist. Returns how many were added (the list is capped). */
export async function addTasks(ticketId: number, items: string[]): Promise<number> {
  const have = await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM ticket_tasks WHERE ticket_id = ?").bind(ticketId).first<{ n: number; last: number }>();
  const room = Math.max(0, MAX_TASKS - (have?.n ?? 0));
  const add = items.slice(0, room);
  if (add.length) await db.batch(add.map((text, i) => db.prepare("INSERT INTO ticket_tasks (ticket_id, position, text) VALUES (?, ?, ?)").bind(ticketId, (have?.last ?? 0) + i + 1, text)));
  return add.length;
}

/** Copies a template's steps onto a ticket. */
export async function applyTemplate(ticketId: number, templateId: number): Promise<{ name: string; added: number } | null> {
  const tpl = await db.prepare("SELECT name, items FROM checklist_templates WHERE id = ?").bind(templateId).first<{ name: string; items: string }>();
  if (!tpl) return null;
  let items: string[] = [];
  try { items = cleanItems(JSON.parse(tpl.items)); } catch { /* unreadable template: nothing to add */ }
  return { name: tpl.name, added: await addTasks(ticketId, items) };
}

export const taskRoutes = new Hono<AppEnv>();
const staffOnly = requireRole("agent", "admin");
const ticketRef = (id: number) => db.prepare("SELECT ref FROM tickets WHERE id = ?").bind(id).first<{ ref: string }>();

// { text } adds one step, { template_id } adds a whole checklist
taskRoutes.post("/:id{[0-9]+}/tasks", staffOnly, async (c) => {
  const id = Number(c.req.param("id"));
  const t = await ticketRef(id);
  if (!t) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (Number.isInteger(body.template_id)) {
    const r = await applyTemplate(id, body.template_id as number);
    if (!r) return c.json({ error: "That checklist no longer exists." }, 404);
    if (!r.added) return c.json({ error: "This ticket's checklist is full." }, 400);
    await audit(c, "ticket.checklist", "ticket", `Added the “${r.name}” checklist to ${t.ref} (${r.added} steps)`, { ticketId: id });
  } else {
    const [text] = cleanItems([body.text]);
    if (!text) return c.json({ error: "Write the step." }, 400);
    if (!(await addTasks(id, [text]))) return c.json({ error: "This ticket's checklist is full." }, 400);
  }
  changed(id);
  return c.json({ ok: true, tasks: await tasksFor(id) }, 201);
});

taskRoutes.patch("/:id{[0-9]+}/tasks/:task{[0-9]+}", staffOnly, async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id")), taskId = Number(c.req.param("task"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.done !== "boolean") return c.json({ error: "done must be true or false" }, 400);
  const k = await db.prepare("SELECT k.text, k.done, t.ref FROM ticket_tasks k JOIN tickets t ON t.id = k.ticket_id WHERE k.id = ? AND k.ticket_id = ?").bind(taskId, id).first<{ text: string; done: number; ref: string }>();
  if (!k) return c.json({ error: "not found" }, 404);
  if (!!k.done !== body.done) {
    await db.prepare("UPDATE ticket_tasks SET done = ?, done_by = ?, done_at = ? WHERE id = ?").bind(body.done ? 1 : 0, body.done ? user.id : null, body.done ? now() : null, taskId).run();
    await audit(c, body.done ? "ticket.step_done" : "ticket.step_undone", "ticket", `${k.ref}: ${body.done ? "ticked" : "unticked"} “${k.text}”`, { ticketId: id });
    changed(id);
  }
  return c.json({ ok: true, tasks: await tasksFor(id) });
});

taskRoutes.delete("/:id{[0-9]+}/tasks/:task{[0-9]+}", staffOnly, async (c) => {
  const id = Number(c.req.param("id")), taskId = Number(c.req.param("task"));
  const r = await db.prepare("DELETE FROM ticket_tasks WHERE id = ? AND ticket_id = ?").bind(taskId, id).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  changed(id);
  return c.json({ ok: true, tasks: await tasksFor(id) });
});
