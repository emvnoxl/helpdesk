import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { db } from "./db";

export const dashboard = new Hono<AppEnv>();

const OPEN = "status NOT IN ('resolved','closed')";

// The full IT live board. Mounted under /api/admin/board, so only an admin signed in to the admin portal can read it.
// It is deliberately small: a monitor polls this every minute, so it runs five
// cheap, bounded queries in one D1 batch. Detailed analytics live in the admin-only /api/admin.
dashboard.get("/", async (c) => {
  const [summary, today, board, inProgress, recent] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS open,
              COALESCE(SUM(priority='urgent'),0) AS urgent,
              COALESCE(SUM(status != 'waiting' AND due_at IS NOT NULL AND due_at < unixepoch()),0) AS overdue,
              COALESCE(SUM(assignee_id IS NULL),0) AS unassigned
       FROM tickets WHERE ${OPEN}`,
    ),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tickets WHERE created_at  >= CAST(strftime('%s','now','start of day') AS INTEGER)) AS opened_today,
         (SELECT COUNT(*) FROM tickets WHERE resolved_at >= CAST(strftime('%s','now','start of day') AS INTEGER)) AS resolved_today`,
    ),
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.status, t.priority, t.priority_locked, t.updated_at, a.name AS assignee
       FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.${OPEN} ORDER BY t.priority_rank DESC, t.created_at ASC LIMIT 8`,
    ),
    db.prepare(
      `SELECT t.id, t.ref, t.title, a.name AS assignee, t.updated_at
       FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.status = 'in_progress' ORDER BY t.updated_at DESC LIMIT 5`,
    ),
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.resolved_at
       FROM tickets t WHERE t.resolved_at IS NOT NULL ORDER BY t.resolved_at DESC LIMIT 3`,
    ),
  ]);

  return c.json({
    now: Math.floor(Date.now() / 1000),
    summary: summary.results[0] ?? {},
    today: today.results[0] ?? {},
    board: board.results,
    inProgress: inProgress.results,
    recentlyResolved: recent.results,
  });
});
