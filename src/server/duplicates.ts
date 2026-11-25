import type { Context, Hono } from "hono";
import { type AppEnv, requireRole } from "./auth";
import { audit } from "./audit";
import { changed as liveChanged } from "./bus";
import { db } from "./db";
import { notifyUser } from "./notifications";

/* "Same problem as another ticket". When five people report the same outage, IT answers one ticket and the rest follow it:
   - a duplicate is linked to a main ticket (tickets.duplicate_of); its requester is told so in the chat, and it follows the main ticket's target time;
   - one reply on the main ticket can go to all its duplicates too (the "also send to linked tickets" box);
   - when the main ticket is resolved, every duplicate that is still open is resolved with a message.
   Staff only. A requester sees only that IT is handling their ticket together with another. */

const now = () => Math.floor(Date.now() / 1000);

interface Deps {
  addComment: (c: Context<any> | null, user: any, id: number, t: any, text: string, o?: { internal?: boolean; draftIds?: number[] }) => Promise<void>;
  ticketForComment: (id: number) => Promise<any>;
}
interface T { id: number; ref: string; title: string; status: string; requester_id: number; duplicate_of: number | null; due_at: number | null }
const load = (id: number) => db.prepare("SELECT id, ref, title, status, requester_id, duplicate_of, due_at FROM tickets WHERE id = ?").bind(id).first<T>();

export function dupRoutes(r: Hono<AppEnv>, deps: Deps) {
  // { of: the main ticket's id, message? }
  r.post("/:id{[0-9]+}/duplicate", requireRole("agent", "admin"), async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const src = await load(id);
    if (!src) return c.json({ error: "not found" }, 404);
    let root = Number.isInteger(b.of) ? await load(b.of as number) : null;
    if (!root) return c.json({ error: "That ticket was not found." }, 404);
    if (root.duplicate_of) root = (await load(root.duplicate_of)) ?? root; // always point at the main ticket, never at another duplicate
    if (root.id === id) return c.json({ error: "A ticket can't be a duplicate of itself." }, 400);
    if (src.status === "closed") return c.json({ error: "This ticket is closed." }, 409);
    if (root.status === "closed") return c.json({ error: `${root.ref} is closed. Pick a ticket that is still open.` }, 409);
    const ts = now();
    await db.batch([
      db.prepare("UPDATE tickets SET duplicate_of = ? WHERE duplicate_of = ?").bind(root.id, src.id), // its own duplicates follow it
      db.prepare("UPDATE tickets SET duplicate_of = ?, due_at = ?, sla_alert = 2, updated_at = ? WHERE id = ?").bind(root.id, root.due_at, ts, src.id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'duplicate', NULL, ?, 1, ?)").bind(src.id, user.id, root.ref, ts),
    ]);
    const who = await db.prepare("SELECT name FROM users WHERE id = ?").bind(src.requester_id).first<{ name: string }>();
    const text = typeof b.message === "string" && b.message.trim() ? b.message.trim().slice(0, 2000) : `Hi ${(who?.name ?? "").split(" ")[0] || "there"}, this is the same problem that others have reported (${root.ref}). IT is working on it there and will update you here as soon as it is fixed.`;
    await deps.addComment(c, user, id, await deps.ticketForComment(id), text);
    await audit(c, "ticket.duplicate", "ticket", `${src.ref} marked as a duplicate of ${root.ref}`, { ticketId: id });
    liveChanged(id);
    liveChanged(root.id);
    return c.json({ ok: true, of: { id: root.id, ref: root.ref } });
  });

  r.delete("/:id{[0-9]+}/duplicate", requireRole("agent", "admin"), async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const src = await load(id);
    if (!src || !src.duplicate_of) return c.json({ error: "not found" }, 404);
    const root = await load(src.duplicate_of);
    const ts = now();
    await db.batch([
      db.prepare("UPDATE tickets SET duplicate_of = NULL, updated_at = ? WHERE id = ?").bind(ts, id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'duplicate', ?, NULL, 1, ?)").bind(id, user.id, root?.ref ?? null, ts),
    ]);
    await audit(c, "ticket.duplicate_unlinked", "ticket", `${src.ref} is no longer a duplicate of ${root?.ref ?? "another ticket"}`, { ticketId: id });
    liveChanged(id);
    if (root) liveChanged(root.id);
    return c.json({ ok: true });
  });
}

/** The still-open duplicates of a ticket. */
export async function openDuplicates(rootId: number) {
  const { results } = await db
    .prepare("SELECT id, ref, title, status, requester_id FROM tickets WHERE duplicate_of = ? AND status NOT IN ('resolved','closed') ORDER BY id LIMIT 100")
    .bind(rootId)
    .all<{ id: number; ref: string; title: string; status: string; requester_id: number }>();
  return results;
}

/** The main ticket was resolved or closed: resolve every duplicate that is still open, and tell each requester. Returns how many. */
export async function resolveDuplicates(deps: Deps, c: Context<any>, user: any, rootId: number, rootRef: string): Promise<number> {
  const dups = await openDuplicates(rootId);
  for (const d of dups) {
    const ts = now();
    await db.batch([
      db.prepare("UPDATE tickets SET status = 'resolved', resolved_at = ?, updated_at = ?, paused_at = NULL WHERE id = ?").bind(ts, ts, d.id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, created_at) VALUES (?, ?, 'status', ?, 'resolved', ?)").bind(d.id, user.id, d.status, ts),
      notifyUser(d.requester_id, d.id, "status", `${d.ref} is now resolved`, d.title, ts),
    ]);
    await deps.addComment(c, user, d.id, await deps.ticketForComment(d.id), `Good news: ${rootRef}, the same problem, has been fixed. If it is still a problem for you, just reply here and it comes straight back to us.`);
    liveChanged(d.id);
  }
  if (dups.length) await audit(c, "ticket.duplicates_resolved", "ticket", `${rootRef} resolved: ${dups.length} duplicate${dups.length === 1 ? "" : "s"} resolved with it (${dups.map((d) => d.ref).join(", ")})`, { ticketId: rootId });
  return dups.length;
}
