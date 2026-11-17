import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { db } from "./db";

/* In-app notifications: the bell, the toast and the sound. Rows are written where things happen (new ticket, message, status or
   assignee change, in tickets.ts) and read here. The same router is mounted for normal users (/api/notifications) and for
   agents/admins (/api/staff/notifications); each only ever sees its own rows. */

const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export const notifyUser = (userId: number, ticketId: number, kind: string, title: string, body: string, ts: number) =>
  db
    .prepare("INSERT INTO notifications (user_id, ticket_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(userId, ticketId, kind, clip(title, 100), clip(body), ts);

/** Everyone on the IT team who is active, except the person who did it. */
export const notifyStaff = (ticketId: number, kind: string, title: string, body: string, ts: number, exceptId: number) =>
  db
    .prepare(
      `INSERT INTO notifications (user_id, ticket_id, kind, title, body, created_at)
       SELECT id, ?, ?, ?, ?, ? FROM users WHERE role IN ('agent','admin') AND active = 1 AND id != ?`,
    )
    .bind(ticketId, kind, clip(title, 100), clip(body), ts, exceptId);

export const pruneNotifications = () =>
  db.prepare("DELETE FROM notifications WHERE created_at < unixepoch() - 30*86400").run();

export const notifications = new Hono<AppEnv>();

notifications.get("/", async (c) => {
  const me = c.get("user").id;
  const [items, unread] = await db.batch([
    db
      .prepare(
        `SELECT n.id, n.kind, n.title, n.body, n.ticket_id, n.created_at, n.read_at, t.ref
         FROM notifications n LEFT JOIN tickets t ON t.id = n.ticket_id
         WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30`,
      )
      .bind(me),
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(me),
  ]);
  return c.json({ items: items.results, unread: unread.results[0]?.n ?? 0 });
});

// { all: true } | { ticket_id } | { ids: number[] }
notifications.post("/read", async (c) => {
  const me = c.get("user").id;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const ts = Math.floor(Date.now() / 1000);
  if (body.all === true) {
    await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(ts, me).run();
  } else if (Number.isInteger(body.ticket_id)) {
    await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND ticket_id = ? AND read_at IS NULL").bind(ts, me, body.ticket_id).run();
  } else if (Array.isArray(body.ids)) {
    for (const id of body.ids.slice(0, 50)) {
      if (Number.isInteger(id)) await db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL").bind(ts, me, id).run();
    }
  } else return c.json({ error: "nothing to mark" }, 400);
  return c.json({ ok: true });
});
