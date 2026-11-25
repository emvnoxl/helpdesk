import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit } from "./audit";
import { UPLOAD_DIR } from "./attachments";
import { db } from "./db";
import { seal, unseal } from "./settings";
import { getSetting, putSetting } from "./sla";

/* GIFs for the chat, from two places that share one picker:
   - GIPHY, the way GIPHY asks for it: each person's BROWSER talks to GIPHY directly through GIPHY's own web SDK (search, trending, showing the
     GIF, usage reporting). This server never searches for them, never proxies a picture, and never keeps a copy: a message stores only the GIF's
     id, and GIPHY's servers show it. The API key is a public SDK key (it is meant to sit in the page), so signed-in people are handed it by
     /config. An admin can switch GIPHY off for everyone; the page's security policy then does not even allow GIPHY's addresses.
   - A shared library of the company's own GIFs, uploaded by admins. Those are ordinary files, saved with the ticket like any attachment. */

const MAX_GIF = 3 * 1024 * 1024;
const MAX_LIBRARY = 200;
export const GIPHY_ID = /^[A-Za-z0-9]{5,30}$/;
const isGif = (b: Buffer) => b.length > 10 && b.subarray(0, 4).toString("latin1") === "GIF8";

let state: { key: string; source: "saved" | "env" | "none"; enabled: boolean } = { key: "", source: "none", enabled: false };

/** Reads the key and the on/off switch (at start-up and after every change). */
export async function loadGiphyState() {
  const saved = await getSetting("giphy_key");
  const k = saved ? unseal(saved) : "";
  const key = k || process.env.GIPHY_API_KEY || "";
  state = { key, source: k ? "saved" : key ? "env" : "none", enabled: (await getSetting("giphy_enabled")) !== "0" };
}
/** Is GIPHY on? (The security policy in index.ts asks this on every page, so it is a plain variable.) */
export const giphyOn = () => state.enabled && !!state.key;

/** For every signed-in person (normal users at /api/gifs, staff at /api/staff/gifs). */
export const gifs = new Hono<AppEnv>();

gifs.get("/config", async (c) => {
  const lib = await db.prepare("SELECT COUNT(*) AS n FROM gif_library").first<{ n: number }>();
  return c.json({ giphy: giphyOn() ? { key: state.key } : null, library: lib?.n ?? 0 });
});

/** A library GIF's bytes. */
export async function readLibraryGif(id: number): Promise<{ title: string; bytes: Buffer } | null> {
  const row = await db.prepare("SELECT title, stored FROM gif_library WHERE id = ?").bind(id).first<{ title: string; stored: string }>();
  if (!row) return null;
  try { return { title: row.title, bytes: await readFile(path.join(UPLOAD_DIR, row.stored)) }; } catch { return null; }
}

gifs.get("/library", async (c) => {
  const { results } = await db.prepare("SELECT id, title FROM gif_library ORDER BY title COLLATE NOCASE LIMIT 300").all<{ id: number; title: string }>();
  return c.json({ items: results });
});
gifs.get("/library/:id{[0-9]+}/img", async (c) => {
  const g = await readLibraryGif(Number(c.req.param("id")));
  if (!g) return c.json({ error: "not found" }, 404);
  return c.body(new Uint8Array(g.bytes), 200, { "Content-Type": "image/gif", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
});

/** Admin only (mounted at /api/admin/gifs): the GIPHY key and switch, and the company library. */
export const gifAdmin = new Hono<AppEnv>();

gifAdmin.get("/", async (c) => {
  const { results } = await db.prepare("SELECT id, title, size, created_at FROM gif_library ORDER BY title COLLATE NOCASE LIMIT 300").all();
  return c.json({ giphy: { configured: !!state.key, enabled: state.enabled, source: state.source }, library: results, max_mb: MAX_GIF / 1024 / 1024, max_items: MAX_LIBRARY });
});

// { key?, enabled? }: a blank key keeps the saved one, "-" removes it.
gifAdmin.put("/settings", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const k = typeof b.key === "string" ? b.key.trim() : "";
  if (k && k !== "-" && (/\s/.test(k) || k.length < 10 || k.length > 100)) return c.json({ error: "That does not look like a GIPHY API key (no spaces, 10 to 100 characters)." }, 400);
  if (k) await putSetting("giphy_key", k === "-" ? "" : seal(k));
  if (typeof b.enabled === "boolean") await putSetting("giphy_enabled", b.enabled ? "1" : "0");
  await loadGiphyState();
  await audit(c, "system.settings", "admin", `GIPHY: key ${k === "-" ? "removed" : k ? "changed" : "unchanged"}, ${state.enabled ? "on" : "off"} for everyone`);
  return c.json({ ok: true });
});

gifAdmin.post("/library", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!file || typeof file === "string") return c.json({ error: "Choose a GIF file." }, 400);
  if (file.size === 0 || file.size > MAX_GIF) return c.json({ error: `A library GIF must be under ${MAX_GIF / 1024 / 1024} MB.` }, 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!isGif(bytes)) return c.json({ error: "That is not a real GIF file." }, 415);
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM gif_library").first<{ n: number }>())?.n ?? 0;
  if (n >= MAX_LIBRARY) return c.json({ error: `The library is full (${MAX_LIBRARY} GIFs).` }, 409);
  const raw = typeof form?.title === "string" && form.title.trim() ? form.title : (file.name || "GIF").replace(/\.gif$/i, "");
  const title = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "GIF";
  const stored = randomBytes(16).toString("hex");
  await writeFile(path.join(UPLOAD_DIR, stored), bytes);
  const row = await db.prepare("INSERT INTO gif_library (title, stored, size, created_by) VALUES (?, ?, ?, ?) RETURNING id").bind(title, stored, bytes.length, c.get("user").id).first<{ id: number }>();
  await audit(c, "gif.library_added", "admin", `Added "${title}" to the GIF library`);
  return c.json({ id: row!.id, title }, 201);
});

gifAdmin.delete("/library/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const row = await db.prepare("SELECT title, stored FROM gif_library WHERE id = ?").bind(id).first<{ title: string; stored: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  await db.prepare("DELETE FROM gif_library WHERE id = ?").bind(id).run();
  await unlink(path.join(UPLOAD_DIR, row.stored)).catch(() => {});
  await audit(c, "gif.library_removed", "admin", `Removed "${row.title}" from the GIF library`);
  return c.json({ ok: true });
});
