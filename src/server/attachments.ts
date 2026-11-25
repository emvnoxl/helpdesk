import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, isStaff } from "./auth";
import { audit } from "./audit";
import { changed as liveChanged } from "./bus";
import { config } from "./config";
import { db } from "./db";

/* Files on tickets (screenshots, logs, documents). The bytes sit in <DATA_DIR>/uploads under random names; the attachments table says
   which ticket and message a file belongs to and who may fetch it. Safety rules, all enforced here and not in the browser:
     - only a short whitelist of types, and the first bytes must match the type (a renamed .exe is refused);
     - the type we send back comes from our own table, never from what the uploader claimed, with nosniff and a sandbox CSP;
     - only images are shown inline, everything else downloads;
     - a file on an internal note is hidden from the requester, a draft is visible only to whoever uploaded it. */

const DIR = path.join(config.dataDir, "uploads");
export const UPLOAD_DIR = DIR;
mkdirSync(DIR, { recursive: true });

const MAX_BYTES = config.maxUploadMb * 1024 * 1024;
const MAX_PER_TICKET = 40;
const MAX_DRAFTS = 12;
const DESCRIPTION_WINDOW = 30 * 60; // a requester can add to the description for 30 minutes; after that it is a message

type Sniff = (b: Buffer) => boolean;
const starts = (...sig: number[]): Sniff => (b) => sig.every((v, i) => b[i] === v);
const text: Sniff = (b) => !b.subarray(0, 4096).includes(0);
const zip = starts(0x50, 0x4b);
const ole = starts(0xd0, 0xcf, 0x11, 0xe0);

interface Kind { mime: string; inline: boolean; ok: Sniff }
export const KINDS: Record<string, Kind> = {
  png: { mime: "image/png", inline: true, ok: starts(0x89, 0x50, 0x4e, 0x47) },
  jpg: { mime: "image/jpeg", inline: true, ok: starts(0xff, 0xd8, 0xff) },
  jpeg: { mime: "image/jpeg", inline: true, ok: starts(0xff, 0xd8, 0xff) },
  gif: { mime: "image/gif", inline: true, ok: starts(0x47, 0x49, 0x46, 0x38) },
  webp: { mime: "image/webp", inline: true, ok: (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP" },
  pdf: { mime: "application/pdf", inline: false, ok: starts(0x25, 0x50, 0x44, 0x46) },
  txt: { mime: "text/plain; charset=utf-8", inline: false, ok: text },
  log: { mime: "text/plain; charset=utf-8", inline: false, ok: text },
  csv: { mime: "text/csv; charset=utf-8", inline: false, ok: text },
  eml: { mime: "message/rfc822", inline: false, ok: text },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", inline: false, ok: zip },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", inline: false, ok: zip },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", inline: false, ok: zip },
  zip: { mime: "application/zip", inline: false, ok: zip },
  doc: { mime: "application/msword", inline: false, ok: ole },
  xls: { mime: "application/vnd.ms-excel", inline: false, ok: ole },
  ppt: { mime: "application/vnd.ms-powerpoint", inline: false, ok: ole },
  msg: { mime: "application/vnd.ms-outlook", inline: false, ok: ole },
};
export const ALLOWED_EXTENSIONS = Object.keys(KINDS);

const cleanName = (raw: string) => {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const n = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").trim().slice(-120);
  return n && n !== "." && n !== ".." ? n : "file";
};

export interface FileRow { id: number; comment_id: number | null; name: string; mime: string; size: number; created_at: number }

/** Sent files for a ticket, grouped by message. Requesters never get files that belong to an internal note. */
export async function filesFor(ticketId: number, staffView: boolean) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.comment_id, a.scope, a.name, a.mime, a.size, a.created_at FROM attachments a
       LEFT JOIN comments c ON c.id = a.comment_id
       WHERE a.ticket_id = ? AND a.scope IN ('ticket','comment') ${staffView ? "" : "AND COALESCE(c.internal, 0) = 0"}
       ORDER BY a.id LIMIT 200`,
    )
    .bind(ticketId)
    .all<FileRow & { scope: string }>();
  const byComment = new Map<number, FileRow[]>();
  const ticket: FileRow[] = [];
  for (const r of results) {
    const f = { id: r.id, comment_id: r.comment_id, name: r.name, mime: r.mime, size: r.size, created_at: r.created_at };
    if (r.scope === "ticket") ticket.push(f);
    else if (r.comment_id) byComment.set(r.comment_id, [...(byComment.get(r.comment_id) ?? []), f]);
  }
  return { ticket, byComment };
}

/** Which of these draft ids can this person attach to a message on this ticket? */
export async function usableDrafts(ticketId: number, userId: number, ids: unknown): Promise<number[]> {
  if (!Array.isArray(ids)) return [];
  const want = [...new Set(ids.filter((x): x is number => Number.isInteger(x)))].slice(0, MAX_DRAFTS);
  if (!want.length) return [];
  const { results } = await db
    .prepare(`SELECT id FROM attachments WHERE ticket_id = ? AND uploader_id = ? AND scope = 'draft' AND id IN (${want.map(() => "?").join(",")})`)
    .bind(ticketId, userId, ...want)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** Drafts that were never sent (the person closed the tab) are removed after a couple of hours. */
export async function pruneDrafts() {
  const { results } = await db.prepare("SELECT id, stored FROM attachments WHERE scope = 'draft' AND created_at < unixepoch() - 7200 LIMIT 500").all<{ id: number; stored: string }>();
  for (const r of results) {
    await unlink(path.join(DIR, r.stored)).catch(() => {});
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(r.id).run();
  }
}

export const attachments = new Hono<AppEnv>();

// Mounted inside the tickets router, so it is available at /api/tickets/... for normal users and /api/staff/tickets/... for staff.
async function ticketFor(c: { get: (k: "user") => AppEnv["Variables"]["user"] }, id: number) {
  const user = c.get("user");
  const t = await db.prepare("SELECT id, ref, status, requester_id, created_at FROM tickets WHERE id = ?").bind(id).first<{ id: number; ref: string; status: string; requester_id: number; created_at: number }>();
  if (!t || (!isStaff(user) && t.requester_id !== user.id)) return null;
  return t;
}

attachments.get("/attachment-rules", (c) => c.json({ maxMb: config.maxUploadMb, extensions: ALLOWED_EXTENSIONS }));

attachments.post(
  "/:id{[0-9]+}/attachments",
  bodyLimit({ maxSize: MAX_BYTES + 256 * 1024, onError: (c) => c.json({ error: `That file is too big. The limit is ${config.maxUploadMb} MB.` }, 413, { Connection: "close" }) }),
  async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const t = await ticketFor(c, id);
    if (!t) return c.json({ error: "not found" }, 404);
    if (t.status === "closed") return c.json({ error: "This ticket is closed, so files can't be added." }, 409);

    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!file || typeof file === "string") return c.json({ error: "Choose a file to attach." }, 400);
    if (file.size === 0) return c.json({ error: "That file is empty." }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: `That file is too big. The limit is ${config.maxUploadMb} MB.` }, 413);

    const name = cleanName(file.name || "file");
    const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
    const kind = KINDS[ext];
    if (!kind) return c.json({ error: `.${ext || "?"} files can't be attached. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.` }, 415);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!kind.ok(bytes)) return c.json({ error: "That file doesn't look like a real ." + ext + " file, so it was refused." }, 415);

    // "for=ticket" adds to the description (only the requester, and only just after raising it); everything else is a draft for the next message.
    const forTicket = c.req.query("for") === "ticket";
    if (forTicket && (t.requester_id !== user.id || Math.floor(Date.now() / 1000) - t.created_at > DESCRIPTION_WINDOW)) return c.json({ error: "Attach it to a message instead." }, 403);
    const [count, drafts] = await db.batch([
      db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE ticket_id = ?").bind(id),
      db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE ticket_id = ? AND uploader_id = ? AND scope = 'draft'").bind(id, user.id),
    ]);
    if ((count.results[0]?.n ?? 0) >= MAX_PER_TICKET) return c.json({ error: "This ticket has reached its file limit." }, 409);
    if (!forTicket && (drafts.results[0]?.n ?? 0) >= MAX_DRAFTS) return c.json({ error: "Send your message first, then add more files." }, 409);

    const stored = randomBytes(20).toString("hex");
    await writeFile(path.join(DIR, stored), bytes, { mode: 0o600 });
    const row = await db
      .prepare("INSERT INTO attachments (ticket_id, uploader_id, scope, name, mime, size, stored) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(id, user.id, forTicket ? "ticket" : "draft", name, kind.mime.split(";")[0], bytes.length, stored)
      .first<{ id: number }>();
    await audit(c, "attachment.added", "ticket", `Attached ${name} to ${t.ref}`, { ticketId: id });
    if (forTicket) liveChanged(id);
    return c.json({ id: row!.id, name, mime: kind.mime.split(";")[0], size: bytes.length }, 201);
  },
);

// Download / show. Images inline, everything else as a download.
attachments.get("/:id{[0-9]+}/attachments/:aid{[0-9]+}", async (c) => {
  const user = c.get("user");
  const t = await ticketFor(c, Number(c.req.param("id")));
  if (!t) return c.json({ error: "not found" }, 404);
  const a = await db
    .prepare(
      `SELECT a.name, a.mime, a.stored, a.scope, a.uploader_id, COALESCE(c.internal, 0) AS internal FROM attachments a
       LEFT JOIN comments c ON c.id = a.comment_id WHERE a.id = ? AND a.ticket_id = ?`,
    )
    .bind(Number(c.req.param("aid")), t.id)
    .first<{ name: string; mime: string; stored: string; scope: string; uploader_id: number; internal: number }>();
  if (!a || (a.scope === "draft" && a.uploader_id !== user.id) || (a.internal && !isStaff(user))) return c.json({ error: "not found" }, 404);
  const bytes = await readFile(path.join(DIR, a.stored)).catch(() => null);
  if (!bytes) return c.json({ error: "not found" }, 404);
  const inline = a.mime.startsWith("image/") && c.req.query("download") !== "1";
  const ascii = a.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": a.mime,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// Take back a file that hasn't been sent yet.
attachments.delete("/:id{[0-9]+}/attachments/:aid{[0-9]+}", async (c) => {
  const user = c.get("user");
  const t = await ticketFor(c, Number(c.req.param("id")));
  if (!t) return c.json({ error: "not found" }, 404);
  const a = await db.prepare("SELECT stored FROM attachments WHERE id = ? AND ticket_id = ? AND uploader_id = ? AND scope = 'draft'").bind(Number(c.req.param("aid")), t.id, user.id).first<{ stored: string }>();
  if (!a) return c.json({ error: "not found" }, 404);
  await db.prepare("DELETE FROM attachments WHERE id = ?").bind(Number(c.req.param("aid"))).run();
  if (existsSync(path.join(DIR, a.stored))) await unlink(path.join(DIR, a.stored)).catch(() => {});
  return c.json({ ok: true });
});
