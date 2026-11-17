import { Hono } from "hono";
import { type AppEnv, isStaff } from "./auth";
import { rankArticles } from "./analytics";
import { audit } from "./audit";
import { db } from "./db";
import { getSetting, putSetting } from "./sla";
import { PACK } from "./kb-pack";

/* Help articles. One router, mounted twice like the tickets one: /api/kb for normal users (published articles only, read and vote)
   and /api/staff/kb for agents and admins (everything, plus create / edit / delete). The same isStaff(user) check decides. */

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** A short plain-text summary for lists: headings are skipped, list items and paragraphs are joined with " · ", links and markup removed,
    and it is cut at a word boundary. */
const excerpt = (body: string) => {
  const parts = body
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*/g, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^#{1,3}\s/.test(l.trim()))
    .map((l) => l.trim().replace(/^[-*]\s+|^\d+[.)]\s+/, "").replace(/[:;,]$/, ""))
    .filter(Boolean);
  const text = parts.join(" · ").replace(/\s+/g, " ");
  if (text.length <= 170) return text;
  const cut = text.slice(0, 170);
  return cut.slice(0, Math.max(60, cut.lastIndexOf(" "))).replace(/[\s·,;:.\-]+$/, "") + "…";
};

interface Row { id: number; title: string; body: string; category_id: number | null; category: string | null; published: number; views: number; helpful: number; not_helpful: number; updated_at: number }
const SELECT = `SELECT k.id, k.title, k.body, k.category_id, c.name AS category, k.published, k.views, k.helpful, k.not_helpful, k.updated_at
                FROM kb_articles k LEFT JOIN categories c ON c.id = k.category_id`;
const brief = (r: Row) => ({ id: r.id, title: r.title, excerpt: excerpt(r.body), category: r.category, category_id: r.category_id, published: !!r.published, video: /(?:youtube\.com|youtu\.be)\//i.test(r.body), views: r.views, helpful: r.helpful, not_helpful: r.not_helpful, updated_at: r.updated_at });

export const kb = new Hono<AppEnv>();

kb.get("/", async (c) => {
  const staff = isStaff(c.get("user"));
  const q = str(c.req.query("q"), 120);
  const { results } = await db.prepare(`${SELECT} ${staff ? "" : "WHERE k.published = 1"} ORDER BY k.title COLLATE NOCASE LIMIT 500`).all<Row>();
  if (!q) return c.json(results.map(brief));
  const hits = rankArticles(results, q, { min: 0.2, limit: 50 });
  return c.json(hits.map(brief));
});

// While someone writes a ticket: the few articles most likely to answer it.
kb.get("/suggest", async (c) => {
  const q = str(c.req.query("q"), 200);
  if (q.length < 3) return c.json([]);
  const { results } = await db.prepare(`${SELECT} WHERE k.published = 1 LIMIT 500`).all<Row>();
  const hits = rankArticles(results, q, { categoryId: Number(c.req.query("category_id")) || null, limit: 3 });
  return c.json(hits.map(brief));
});

kb.get("/:id{[0-9]+}", async (c) => {
  const user = c.get("user");
  const staff = isStaff(user);
  const id = Number(c.req.param("id"));
  const r = await db.prepare(`${SELECT} WHERE k.id = ? ${staff ? "" : "AND k.published = 1"}`).bind(id).first<Row>();
  if (!r) return c.json({ error: "not found" }, 404);
  if (!staff) await db.prepare("UPDATE kb_articles SET views = views + 1 WHERE id = ?").bind(id).run();
  const mine = staff ? null : await db.prepare("SELECT helpful FROM kb_votes WHERE article_id = ? AND user_id = ?").bind(id, user.id).first<{ helpful: number }>();
  return c.json({ ...brief(r), body: r.body, my_vote: mine ? (mine.helpful ? "yes" : "no") : null });
});

// "This solved it" / "Not what I needed". One vote per person per article; voting again changes it.
kb.post("/:id{[0-9]+}/vote", async (c) => {
  const user = c.get("user");
  if (isStaff(user)) return c.json({ error: "Only the people who read articles can vote." }, 403);
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.helpful !== "boolean") return c.json({ error: "helpful must be true or false" }, 400);
  const art = await db.prepare("SELECT id FROM kb_articles WHERE id = ? AND published = 1").bind(id).first();
  if (!art) return c.json({ error: "not found" }, 404);
  await db.batch([
    db.prepare("INSERT INTO kb_votes (article_id, user_id, helpful) VALUES (?, ?, ?) ON CONFLICT(article_id, user_id) DO UPDATE SET helpful = excluded.helpful").bind(id, user.id, body.helpful ? 1 : 0),
    db.prepare(
      `UPDATE kb_articles SET helpful = (SELECT COUNT(*) FROM kb_votes WHERE article_id = ?1 AND helpful = 1),
                              not_helpful = (SELECT COUNT(*) FROM kb_votes WHERE article_id = ?1 AND helpful = 0) WHERE id = ?1`,
    ).bind(id),
  ]);
  return c.json({ ok: true });
});

/* ---- staff: write ---- */
const staffOnly = async (c: any) => (isStaff(c.get("user")) ? null : c.json({ error: "not found" }, 404));

function readArticle(body: Record<string, unknown>) {
  const title = str(body.title, 160), text = str(body.body, 20000);
  if (title.length < 4) return { error: "Give the article a title (at least 4 characters)." };
  if (text.length < 20) return { error: "Write the steps or the answer (at least 20 characters)." };
  const category = body.category_id === null || body.category_id === "" || body.category_id === undefined ? null : Number(body.category_id) || null;
  return { title, text, category, published: body.published === false ? 0 : 1 };
}

kb.post("/", async (c) => {
  const denied = await staffOnly(c);
  if (denied) return denied;
  const a = readArticle(await c.req.json().catch(() => ({})));
  if ("error" in a) return c.json({ error: a.error }, 400);
  const row = await db.prepare("INSERT INTO kb_articles (title, body, category_id, published, author_id) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(a.title, a.text, a.category, a.published, c.get("user").id).first<{ id: number }>();
  await audit(c, "kb.created", "admin", `Wrote the help article “${a.title}”${a.published ? "" : " (draft)"}`);
  return c.json({ id: row!.id }, 201);
});

kb.patch("/:id{[0-9]+}", async (c) => {
  const denied = await staffOnly(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const cur = await db.prepare("SELECT title FROM kb_articles WHERE id = ?").bind(id).first<{ title: string }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  const a = readArticle(await c.req.json().catch(() => ({})));
  if ("error" in a) return c.json({ error: a.error }, 400);
  await db.prepare("UPDATE kb_articles SET title = ?, body = ?, category_id = ?, published = ?, updated_at = unixepoch() WHERE id = ?").bind(a.title, a.text, a.category, a.published, id).run();
  await audit(c, "kb.updated", "admin", `Edited the help article “${a.title}”`);
  return c.json({ ok: true });
});

kb.delete("/:id{[0-9]+}", async (c) => {
  const denied = await staffOnly(c);
  if (denied) return denied;
  const id = Number(c.req.param("id"));
  const cur = await db.prepare("SELECT title FROM kb_articles WHERE id = ?").bind(id).first<{ title: string }>();
  if (!cur) return c.json({ error: "not found" }, 404);
  await db.prepare("DELETE FROM kb_articles WHERE id = ?").bind(id).run();
  await audit(c, "kb.deleted", "admin", `Deleted the help article “${cur.title}”`);
  return c.json({ ok: true });
});

/* ---- starter content, written once on a new installation (edit or delete freely; deleting them all doesn't bring them back) ---- */
const STARTERS: { title: string; category: string; body: string }[] = [
  {
    title: "My computer is slow or keeps freezing",
    category: "Hardware",
    body: `## Try these first
1. Save your work, then restart the computer. A full restart (not just closing the lid) clears most slowness.
2. Close programs and browser tabs you aren't using.
3. Check free space: open File Explorer > This PC. If the C: drive is almost full (red bar), delete old downloads and empty the Recycle Bin.
4. Make sure Windows updates aren't stuck: Start > Settings > Windows Update.

## Still slow?
Raise a ticket and tell us what you were doing when it slowed down and how long since your last restart.`,
  },
  {
    title: "I can't connect to the office Wi-Fi",
    category: "Network",
    body: `## Quick checks
- Turn Wi-Fi off and on again (the airplane-mode key on a laptop).
- Choose the company Wi-Fi network from the list, and make sure you aren't on the guest network.
- Forget the network (Settings > Network > Wi-Fi > Manage known networks) and connect again with your details.
- Restart the computer.

## Other people affected?
If colleagues near you also lost Wi-Fi, don't wait: raise a ticket with your location (floor and room) so we can look at the access point.`,
  },
  {
    title: "The printer is offline or won't print",
    category: "Printing",
    body: `## Check the printer
- Is it switched on, with paper and no error light or message on its screen?
- Is the cable or network connection in?

## Check your computer
1. Open Settings > Printers & scanners and select the printer.
2. Open the print queue and cancel stuck jobs.
3. If it says Offline, turn the printer off and on again, wait a minute, then print a test page.

## Still not printing?
Raise a ticket with the printer's name (the label on the front) and what the screen says.`,
  },
  {
    title: "I forgot my password or my account is locked",
    category: "Accounts & Access",
    body: `## Microsoft 365 / email password
- Go to the sign-in page and choose "Forgot my password" if self-service reset is enabled for you.
- Accounts lock for a short time after several wrong attempts. Wait 15 minutes before trying again, and don't keep retrying.

## Not working?
Raise a ticket. For your security IT will confirm it's you before resetting anything. Never write your password in a ticket.`,
  },
  {
    title: "Outlook won't open or keeps asking for my password",
    category: "Microsoft 365",
    body: `## Try these
1. Close Outlook completely and open it again.
2. Check you are online (open a web page).
3. Sign in at office.com in your browser. If that works, your account is fine and only the app needs fixing.
4. Restart the computer.

## Still stuck?
Raise a ticket and copy any message Outlook shows exactly. A photo of the screen helps.`,
  },
];

export async function seedKb() {
  if (await getSetting("kb_seeded")) return;
  const cats = new Map((await db.prepare("SELECT id, name FROM categories").all<{ id: number; name: string }>()).results.map((c) => [c.name, c.id]));
  for (const s of STARTERS) await db.prepare("INSERT INTO kb_articles (title, body, category_id) VALUES (?, ?, ?)").bind(s.title, s.body, cats.get(s.category) ?? null).run();
  await putSetting("kb_seeded", "1");
}

/** The larger starter library (kb-pack.ts), added once; an article is skipped if one with the same title already exists. */
export async function seedKbPack() {
  if (await getSetting("kb_pack_1")) return;
  const cats = new Map((await db.prepare("SELECT id, name FROM categories").all<{ id: number; name: string }>()).results.map((c) => [c.name, c.id]));
  for (const a of PACK) {
    if (await db.prepare("SELECT 1 FROM kb_articles WHERE title = ?").bind(a.title).first()) continue;
    await db.prepare("INSERT INTO kb_articles (title, body, category_id) VALUES (?, ?, ?)").bind(a.title, a.body, cats.get(a.category) ?? null).run();
  }
  await putSetting("kb_pack_1", "1");
}
