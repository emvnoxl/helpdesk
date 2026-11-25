import { randomBytes } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Context, Hono } from "hono";
import { type AppEnv, isStaff } from "./auth";
import { audit } from "./audit";
import { UPLOAD_DIR } from "./attachments";
import { changed as liveChanged, typing } from "./bus";
import { db } from "./db";
import { GIPHY_ID, giphyOn, readLibraryGif } from "./gifs";
import { RateLimiter } from "./security";

/* The chat extras on a ticket, mounted inside the tickets router (so they exist at /api/tickets/... for normal users and
   /api/staff/tickets/... for staff, with the same visibility rules as the ticket itself):
     PATCH  /:id/comments/:cid          edit your own message (for a few minutes)
     DELETE /:id/comments/:cid          delete your own message (an admin can delete any)
     POST   /:id/comments/:cid/react    toggle an emoji reaction
     POST   /:id/typing                 "is typing..." (live only, nothing stored)
     POST   /:id/gif                    send a GIF (GIPHY or the company library) as a message
   Read receipts are written when a ticket is opened (see the GET in tickets.ts). */

export const EDIT_WINDOW = 15 * 60; // seconds you can change or take back your own message
const now = () => Math.floor(Date.now() / 1000);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const oneEmoji = (s: string) => {
  if (!s || s.length > 16 || !/\p{Extended_Pictographic}/u.test(s)) return false;
  return [...new Intl.Segmenter().segment(s)].length === 1;
};

type Ctx = Context<AppEnv>;
interface Found {
  t: { id: number; ref: string; status: string; requester_id: number };
  m: { id: number; author_id: number; body: string; internal: number; created_at: number; kind: string; deleted_at: number | null };
}

/** The ticket and message, only if this person may see them (a normal user never reaches an internal note). */
async function find(c: Ctx, ticketId: number, commentId: number): Promise<Found | null> {
  const user = c.get("user");
  const t = await db.prepare("SELECT id, ref, status, requester_id FROM tickets WHERE id = ?").bind(ticketId).first<Found["t"]>();
  if (!t || (!isStaff(user) && t.requester_id !== user.id)) return null;
  const m = await db
    .prepare("SELECT id, author_id, body, internal, created_at, kind, deleted_at FROM comments WHERE id = ? AND ticket_id = ?")
    .bind(commentId, ticketId)
    .first<Found["m"]>();
  if (!m || (!isStaff(user) && m.internal)) return null;
  return { t, m };
}

const lastTyping = new Map<string, number>();
const gifLimiter = new RateLimiter(20, 60_000);

interface Deps {
  addComment: (c: Context<any> | null, user: any, id: number, t: any, text: string, o?: { internal?: boolean; draftIds?: number[]; kind?: "text" | "gif" | "giphy"; ref?: string }) => Promise<void>;
  ticketForComment: (id: number) => Promise<any>;
}

export function chatRoutes(r: Hono<AppEnv>, deps: Deps) {
  // ---- edit ----
  r.patch("/:id{[0-9]+}/comments/:cid{[0-9]+}", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const f = await find(c, id, Number(c.req.param("cid")));
    if (!f) return c.json({ error: "not found" }, 404);
    const { t, m } = f;
    if (m.author_id !== user.id) return c.json({ error: "You can only change your own messages." }, 403);
    if (m.deleted_at) return c.json({ error: "That message was deleted." }, 409);
    if (m.kind !== "text") return c.json({ error: "A GIF can't be edited. You can delete it." }, 400);
    if (t.status === "closed") return c.json({ error: "This ticket is closed, so messages are turned off." }, 409);
    if (now() - m.created_at > EDIT_WINDOW) return c.json({ error: `Messages can only be changed for ${EDIT_WINDOW / 60} minutes after they were sent.` }, 403);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const text = str(body.body, 10000);
    if (!text) return c.json({ error: "A message can't be empty. Delete it instead." }, 400);
    if (text === m.body) return c.json({ ok: true, changed: false });
    await db.prepare("UPDATE comments SET body = ?, edited_at = ? WHERE id = ?").bind(text, now(), m.id).run();
    await audit(c, "message.edited", "message", `Edited a message on ${t.ref}`, { ticketId: id });
    liveChanged(id);
    return c.json({ ok: true, changed: true });
  });

  // ---- delete (soft: the place stays, the words and files go) ----
  r.delete("/:id{[0-9]+}/comments/:cid{[0-9]+}", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const f = await find(c, id, Number(c.req.param("cid")));
    if (!f) return c.json({ error: "not found" }, 404);
    const { t, m } = f;
    const moderator = user.role === "admin" && m.author_id !== user.id;
    if (!moderator) {
      if (m.author_id !== user.id) return c.json({ error: "You can only delete your own messages." }, 403);
      if (t.status === "closed") return c.json({ error: "This ticket is closed, so messages are turned off." }, 409);
      if (now() - m.created_at > EDIT_WINDOW) return c.json({ error: `Messages can only be deleted for ${EDIT_WINDOW / 60} minutes after they were sent.` }, 403);
    }
    if (m.deleted_at) return c.json({ ok: true });
    const { results: files } = await db.prepare("SELECT stored FROM attachments WHERE comment_id = ?").bind(m.id).all<{ stored: string }>();
    await db.batch([
      db.prepare("UPDATE comments SET body = '', deleted_at = ?, edited_at = NULL WHERE id = ?").bind(now(), m.id),
      db.prepare("DELETE FROM attachments WHERE comment_id = ?").bind(m.id),
      db.prepare("DELETE FROM comment_reactions WHERE comment_id = ?").bind(m.id),
      // An email about it that has not gone out yet is cancelled.
      db.prepare("UPDATE ticket_events SET notified = 1 WHERE ticket_id = ? AND field = 'reply' AND new_value = ? AND notified = 0").bind(id, String(m.id)),
    ]);
    for (const x of files) await unlink(path.join(UPLOAD_DIR, x.stored)).catch(() => {});
    await audit(c, "message.deleted", "message", `${moderator ? "Removed someone's message on" : "Deleted a message on"} ${t.ref}`, { ticketId: id });
    liveChanged(id);
    return c.json({ ok: true });
  });

  // ---- reactions: the same emoji again takes it back ----
  r.post("/:id{[0-9]+}/comments/:cid{[0-9]+}/react", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const f = await find(c, id, Number(c.req.param("cid")));
    if (!f) return c.json({ error: "not found" }, 404);
    if (f.m.deleted_at) return c.json({ error: "That message was deleted." }, 409);
    if (f.t.status === "closed") return c.json({ error: "This ticket is closed." }, 409);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const emoji = typeof body.emoji === "string" ? body.emoji.trim() : "";
    if (!oneEmoji(emoji)) return c.json({ error: "Pick a single emoji." }, 400);
    const had = await db.prepare("SELECT 1 AS x FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?").bind(f.m.id, user.id, emoji).first();
    if (had) {
      await db.prepare("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?").bind(f.m.id, user.id, emoji).run();
    } else {
      const kinds = (await db.prepare("SELECT COUNT(DISTINCT emoji) AS n FROM comment_reactions WHERE comment_id = ?").bind(f.m.id).first<{ n: number }>())?.n ?? 0;
      if (kinds >= 20) return c.json({ error: "That message has plenty of reactions already." }, 409);
      await db.prepare("INSERT OR IGNORE INTO comment_reactions (comment_id, user_id, emoji) VALUES (?, ?, ?)").bind(f.m.id, user.id, emoji).run();
    }
    liveChanged(id);
    return c.json({ ok: true, on: !had });
  });

  // ---- typing ----
  r.post("/:id{[0-9]+}/typing", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const t = await db.prepare("SELECT requester_id FROM tickets WHERE id = ?").bind(id).first<{ requester_id: number }>();
    if (!t || (!isStaff(user) && t.requester_id !== user.id)) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    if (body.internal === true) return c.json({ ok: true }); // a note for IT is not announced to the requester
    const key = `${user.role}${user.id}:${id}`;
    const at = Date.now();
    if (at - (lastTyping.get(key) ?? 0) < 1500) return c.json({ ok: true });
    lastTyping.set(key, at);
    if (lastTyping.size > 2000) for (const [k, v] of lastTyping) if (at - v > 60_000) lastTyping.delete(k);
    typing(isStaff(user), t.requester_id, JSON.stringify({ ticket: id, name: user.name.split(" ")[0] || user.name, staff: isStaff(user) }));
    return c.json({ ok: true });
  });

  // ---- GIFs: { source: "giphy" | "library", id, caption?, internal? }. A GIPHY GIF is only an id (shown by GIPHY's SDK); a library GIF is copied in as an attachment. ----
  r.post("/:id{[0-9]+}/gif", async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const t = await deps.ticketForComment(id);
    if (!t || (!isStaff(user) && t.requester_id !== user.id)) return c.json({ error: "not found" }, 404);
    if (t.status === "closed") return c.json({ error: "This ticket is closed, so messages are turned off." }, 409);
    if (!gifLimiter.take(`${user.role}${user.id}`)) return c.json({ error: "That's a lot of GIFs. Wait a minute." }, 429);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    let bytes: Buffer;
    let name: string;
    if (body.source === "giphy") {
      // GIPHY's rules: no copies. The message keeps only the id; every browser shows it from GIPHY with their SDK.
      const gid = typeof body.id === "string" ? body.id : "";
      if (!GIPHY_ID.test(gid)) return c.json({ error: "That GIF could not be found." }, 400);
      if (!giphyOn()) return c.json({ error: "GIPHY GIFs are switched off." }, 409);
      await deps.addComment(c, user, id, t, str(body.caption, 500), { internal: isStaff(user) && body.internal === true, kind: "giphy", ref: gid });
      return c.json({ ok: true }, 201);
    } else if (body.source === "library") {
      const lib = await readLibraryGif(Number(body.id));
      if (!lib) return c.json({ error: "That GIF is no longer in the library." }, 404);
      bytes = lib.bytes;
      name = `${lib.title}.gif`.slice(-120);
    } else {
      return c.json({ error: "Choose a GIF first." }, 400);
    }
    const stored = randomBytes(16).toString("hex");
    await writeFile(path.join(UPLOAD_DIR, stored), bytes);
    const row = await db
      .prepare("INSERT INTO attachments (ticket_id, uploader_id, scope, name, mime, size, stored) VALUES (?, ?, 'draft', ?, 'image/gif', ?, ?) RETURNING id")
      .bind(id, user.id, name, bytes.length, stored)
      .first<{ id: number }>();
    await deps.addComment(c, user, id, t, str(body.caption, 500), { internal: isStaff(user) && body.internal === true, draftIds: [row!.id], kind: "gif" });
    return c.json({ ok: true }, 201);
  });
}

