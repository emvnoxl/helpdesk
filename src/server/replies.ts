import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { getSetting, putSetting } from "./sla";

/* Saved replies for the staff composer. Mounted at /api/staff/replies (staff only).
   Shared replies (owner NULL) belong to the team and only admins change them; personal ones belong to whoever wrote them.
   Placeholders {name} (the requester's first name), {ref} and {agent} are filled in by the browser when a reply is inserted. */

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export const replies = new Hono<AppEnv>();

replies.get("/", async (c) => {
  const me = c.get("user").id;
  const { results } = await db
    .prepare("SELECT id, title, body, uses, owner_id IS NULL AS shared, owner_id = ? AS mine FROM canned_replies WHERE owner_id IS NULL OR owner_id = ? ORDER BY uses DESC, title COLLATE NOCASE LIMIT 300")
    .bind(me, me)
    .all();
  return c.json(results.map((r: any) => ({ id: r.id, title: r.title, body: r.body, uses: r.uses, shared: !!r.shared, mine: !!r.mine })));
});

replies.post("/", async (c) => {
  const user = c.get("user");
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const title = str(b.title, 80), body = str(b.body, 4000);
  if (title.length < 2) return c.json({ error: "Give the reply a short title." }, 400);
  if (body.length < 2) return c.json({ error: "Write the reply." }, 400);
  const shared = b.shared === true;
  if (shared && user.role !== "admin") return c.json({ error: "Only an admin can add a reply for the whole team." }, 403);
  const row = await db.prepare("INSERT INTO canned_replies (owner_id, title, body) VALUES (?, ?, ?) RETURNING id").bind(shared ? null : user.id, title, body).first<{ id: number }>();
  await audit(c, "reply.created", "admin", `Saved the ${shared ? "team " : ""}reply “${title}”`);
  return c.json({ id: row!.id }, 201);
});

async function mayChange(c: any, id: number) {
  const user = c.get("user");
  const r = await db.prepare("SELECT owner_id, title FROM canned_replies WHERE id = ?").bind(id).first<{ owner_id: number | null; title: string }>();
  if (!r) return { err: c.json({ error: "not found" }, 404) };
  if (r.owner_id === null ? user.role !== "admin" : r.owner_id !== user.id) return { err: c.json({ error: r.owner_id === null ? "Only an admin can change a team reply." : "That reply belongs to someone else." }, 403) };
  return { r };
}

replies.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const g = await mayChange(c, id);
  if (g.err) return g.err;
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const title = str(b.title, 80), body = str(b.body, 4000);
  if (title.length < 2 || body.length < 2) return c.json({ error: "A reply needs a title and some text." }, 400);
  await db.prepare("UPDATE canned_replies SET title = ?, body = ? WHERE id = ?").bind(title, body, id).run();
  return c.json({ ok: true });
});

replies.delete("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const g = await mayChange(c, id);
  if (g.err) return g.err;
  await db.prepare("DELETE FROM canned_replies WHERE id = ?").bind(id).run();
  await audit(c, "reply.deleted", "admin", `Deleted the reply “${g.r!.title}”`);
  return c.json({ ok: true });
});

// Popular replies float to the top.
replies.post("/:id{[0-9]+}/use", async (c) => {
  await db.prepare("UPDATE canned_replies SET uses = uses + 1 WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)").bind(Number(c.req.param("id")), c.get("user").id).run();
  return c.json({ ok: true });
});

const STARTERS: [string, string][] = [
  ["Restart and tell me", "Hi {name}, please restart the computer (a full restart, not just closing the lid) and let me know if the problem is still there. Thanks."],
  ["Need more details", "Hi {name}, to look into {ref} I need a bit more information:\n- What exactly do you see on the screen (the exact message if there is one)?\n- When did it start, and did anything change before that?\n\nA screenshot helps a lot. You can attach one right here."],
  ["Working on it", "Hi {name}, I'm on {ref} now and will update you here as soon as I know more."],
  ["Fixed, please confirm", "Hi {name}, I've made a change for {ref} and it should be working now. Please try again and tell me whether it's fixed."],
  ["Closing, no answer", "Hi {name}, I haven't heard back about {ref}, so I'm marking it as resolved. If it's still a problem, just reply here and it will reopen."],
];

export async function seedReplies() {
  if (await getSetting("replies_seeded")) return;
  for (const [title, body] of STARTERS) await db.prepare("INSERT INTO canned_replies (owner_id, title, body) VALUES (NULL, ?, ?)").bind(title, body).run();
  await putSetting("replies_seeded", "1");
}
