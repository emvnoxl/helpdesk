import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { db } from "./db";
import { staffOnline } from "./bus";

/* What normal users see: their own queue, and a simple live board of what IT is doing and who is next.
   Both rest on one bounded scan of the "waiting to start" line (status 'open', most urgent first, then oldest),
   so a page that refreshes every couple of minutes stays cheap. Other people's ticket titles are never returned. */

export const board = new Hono<AppEnv>();

const LINE_LIMIT = 200;
const OPEN = "status NOT IN ('resolved','closed')";

const waitingLine = () =>
  db.prepare(
    `SELECT t.id, t.ref, t.requester_id, cat.name AS category
     FROM tickets t LEFT JOIN categories cat ON cat.id = t.category_id
     WHERE t.status = 'open' ORDER BY t.priority_rank DESC, t.created_at ASC LIMIT ${LINE_LIMIT}`,
  );

// My queue: my open tickets, and where each one sits in the line.
board.get("/queue", async (c) => {
  const user = c.get("user");
  const now = Math.floor(Date.now() / 1000);
  const [items, recent, line] = await db.batch([
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.status, t.priority, t.created_at, t.updated_at, a.name AS assignee
       FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.requester_id = ? AND t.${OPEN} ORDER BY t.created_at DESC LIMIT 25`,
    ).bind(user.id),
    db.prepare(
      `SELECT id, ref, title, status, resolved_at, updated_at FROM tickets
       WHERE requester_id = ? AND status IN ('resolved','closed') ORDER BY created_at DESC LIMIT 5`,
    ).bind(user.id),
    waitingLine(),
  ]);
  const place = new Map((line.results as { id: number }[]).map((r, i) => [r.id, i + 1]));
  return c.json({
    now,
    items: (items.results as { id: number; status: string }[]).map((t) => ({ ...t, position: place.get(t.id) ?? null })),
    recent: recent.results,
    waiting_total: line.results.length,
    capped: line.results.length >= LINE_LIMIT,
  });
});

// Live board: everything being worked on, who is next, and where I am.
board.get("/board", async (c) => {
  const user = c.get("user");
  const now = Math.floor(Date.now() / 1000);
  const [working, line, counts, today, mine] = await db.batch([
    db.prepare(
      `SELECT t.id, t.ref, t.requester_id, cat.name AS category, a.name AS assignee, t.updated_at
       FROM tickets t LEFT JOIN categories cat ON cat.id = t.category_id LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.status = 'in_progress' ORDER BY t.updated_at DESC LIMIT 20`,
    ),
    waitingLine(),
    db.prepare(
      `SELECT COALESCE(SUM(status = 'open'), 0) AS waiting, COALESCE(SUM(status = 'in_progress'), 0) AS working,
              COALESCE(SUM(status = 'waiting'), 0) AS paused
       FROM tickets WHERE ${OPEN}`,
    ),
    db.prepare(`SELECT COUNT(*) AS resolved_today FROM tickets WHERE resolved_at >= CAST(strftime('%s','now','start of day') AS INTEGER)`),
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.status, a.name AS assignee, t.updated_at
       FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.requester_id = ? AND t.${OPEN} ORDER BY t.created_at DESC LIMIT 10`,
    ).bind(user.id),
  ]);

  const order = line.results as { id: number; ref: string; requester_id: number; category: string | null }[];
  const place = new Map(order.map((r, i) => [r.id, i + 1]));
  return c.json({
    now,
    summary: { ...(counts.results[0] ?? {}), ...(today.results[0] ?? {}) },
    it_online: staffOnline(), // someone from IT has the helpdesk open
    // Reference + category only for other people's tickets; "mine" lets the page highlight the viewer's own.
    working: (working.results as any[]).map((t) => ({ ref: t.ref, category: t.category, assignee: t.assignee, updated_at: t.updated_at, mine: t.requester_id === user.id })),
    next: order.slice(0, 12).map((t, i) => ({ position: i + 1, ref: t.ref, category: t.category, mine: t.requester_id === user.id })),
    mine: (mine.results as any[]).map((t) => ({ ...t, position: place.get(t.id) ?? null })),
    capped: order.length >= LINE_LIMIT,
  });
});
