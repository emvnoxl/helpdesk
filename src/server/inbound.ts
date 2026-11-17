import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { audit } from "./audit";
import { config } from "./config";
import { db } from "./db";
import { graphToken } from "./notifier";
import { RateLimiter } from "./security";
import { addComment, createTicket, ticketForComment } from "./tickets";
import { cleanEmailBody, cleanSubject, htmlToText, nameFromEmail, refIn } from "./worktime";

/* Tickets by email. An email to the helpdesk mailbox becomes a ticket; a reply to one of our notifications ("RE: [FG-0042] ...")
   becomes a message on that ticket. Two ways in, both ending in ingestEmail():
   - a poller that reads the unread mail of INBOUND_MAILBOX through Microsoft Graph (the same app registration as sending, plus the
     Mail.ReadWrite application permission) and marks each message read once it has been dealt with;
   - POST /api/inbound/email with "Authorization: Bearer INBOUND_SECRET", for any mail relay or script that can post JSON.

   An email's From line can be forged, so email is trusted only as far as a requester is: it can raise a ticket in the sender's name
   and add a message to a ticket that sender raised. It can never act as IT, and never reads anything back. Attachments are not taken. */

export interface InMail { from: string; name?: string; subject?: string; text?: string; html?: string; messageId?: string; auto?: boolean }
export interface Outcome { outcome: "created" | "replied" | "ignored"; reason?: string; ticket?: { id: number; ref: string } }

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ROBOT = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?)[@+]/i;
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|undeliverable|delivery (status|failure)|mail delivery|returned mail|read:|not read:)/i;
const perSender = new RateLimiter(20, 3600_000); // a mail loop or a stuck script can't flood the queue

const addressOf = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();
/** Addresses that are the helpdesk itself: mail from them is never taken in (that would be a loop). */
const ours = () => new Set([config.mail.from, config.mail.graph.sender, config.mail.smtp.user, config.inbound.mailbox].map(addressOf).filter(Boolean));

export const inboundEnabled = () => !!(config.inbound.secret || graphInbound());
const graphInbound = () => {
  const g = config.mail.graph;
  return !!(config.inbound.mailbox && g.tenantId && g.clientId && g.clientSecret);
};

export async function ingestEmail(m: InMail): Promise<Outcome> {
  const from = addressOf(String(m.from ?? ""));
  const subjectRaw = String(m.subject ?? "").slice(0, 400);
  const skip = async (reason: string): Promise<Outcome> => {
    if (m.messageId) await db.prepare("UPDATE inbound_mail SET outcome = ? WHERE message_id = ?").bind(`ignored:${reason}`, m.messageId).run();
    return { outcome: "ignored", reason };
  };
  if (!EMAIL.test(from) || from.length > 200) return { outcome: "ignored", reason: "bad sender" };
  // The same message twice (a poll that was interrupted, a relay that retries) is dealt with once.
  if (m.messageId) {
    const r = await db.prepare("INSERT OR IGNORE INTO inbound_mail (message_id, sender) VALUES (?, ?)").bind(m.messageId.slice(0, 300), from).run();
    if (!r.meta.changes) return { outcome: "ignored", reason: "duplicate" };
    m = { ...m, messageId: m.messageId.slice(0, 300) };
  }
  if (m.auto || ROBOT.test(from) || AUTO_SUBJECT.test(subjectRaw.trim())) return skip("automatic");
  if (ours().has(from)) return skip("own address");
  if (config.companyDomain && !from.endsWith("@" + config.companyDomain)) return skip("outside the company");
  if (!perSender.take(from)) return skip("too many");

  const body = cleanEmailBody(m.text?.trim() ? m.text : htmlToText(m.html ?? ""));
  const subject = cleanSubject(subjectRaw);

  let user = await db.prepare("SELECT id, name, active FROM users WHERE email = ?").bind(from).first<{ id: number; name: string; active: number }>();
  if (user && !user.active) return skip("account disabled");
  if (!user) {
    // First contact. The account has no PIN yet; the person creates one the first time they open the helpdesk.
    const name = (m.name ?? "").replace(/[<>"]/g, "").trim().slice(0, 100) || nameFromEmail(from);
    const row = await db.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, 'requester') RETURNING id").bind(from, name).first<{ id: number }>();
    user = { id: row!.id, name, active: 1 };
    await audit(null, "account.registered", "account", `New account created from an email: ${name} (${from}), no PIN yet`, { who: { id: user.id, name, role: "requester" } });
  }
  // Whatever their role in the helpdesk, by email they are only ever "the person who wrote in".
  const who = { id: user.id, name: user.name, role: "requester" as const };
  const done = async (outcome: "created" | "replied", ticket: { id: number; ref: string }): Promise<Outcome> => {
    if (m.messageId) await db.prepare("UPDATE inbound_mail SET outcome = ?, ticket_id = ? WHERE message_id = ?").bind(outcome, ticket.id, m.messageId).run();
    return { outcome, ticket };
  };

  // A reply to one of ours: goes onto that ticket, if this person raised it and it is still open for messages.
  const ref = refIn(subjectRaw);
  const known = ref ? await db.prepare("SELECT id FROM tickets WHERE ref = ?").bind(ref).first<{ id: number }>() : null;
  const t = known ? await ticketForComment(known.id) : null;
  let followUp = "";
  if (known && t && t.requester_id === user.id) {
    if (t.status !== "closed") {
      if (!body) return skip("empty reply");
      await addComment(null, who, known.id, t, body, { via: "email" });
      return done("replied", { id: known.id, ref: t.ref });
    }
    followUp = `Follow-up to ${t.ref}, which is closed.\n\n`;
  }

  if (!subject && !body) return skip("empty");
  const title = subject || body.split("\n")[0]!.slice(0, 120) || "(no subject)";
  const ticket = await createTicket(who, { title, description: followUp + (body || title), source: "email" });
  await audit(null, "ticket.created", "ticket", `Raised ${ticket.ref} by email: ${title}`, { ticketId: ticket.id, who });
  return done("created", ticket);
}

/* ---------- way in 1: any relay that can POST ---------- */
export const inbound = new Hono();
inbound.post("/email", async (c) => {
  const secret = config.inbound.secret;
  if (!secret) return c.json({ error: "not found" }, 404);
  const given = Buffer.from((c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return c.json({ error: "unauthorized" }, 401);
  if (Number(c.req.header("content-length") ?? 0) > 300_000) return c.json({ error: "too large" }, 413);
  const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b.from !== "string") return c.json({ error: "from is required" }, 400);
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  return c.json(await ingestEmail({ from: b.from, name: s(b.name), subject: s(b.subject), text: s(b.text), html: s(b.html), messageId: s(b.message_id), auto: b.auto === true }));
});

/* ---------- way in 2: the Microsoft 365 mailbox ---------- */
interface GraphMessage {
  id: string; subject?: string; internetMessageId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name: string; value: string }[];
}

export async function pollMailbox(): Promise<number> {
  const token = await graphToken();
  const base = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.inbound.mailbox)}`;
  const res = await fetch(`${base}/mailFolders/inbox/messages?$filter=isRead eq false&$top=15&$select=id,subject,from,body,internetMessageId,internetMessageHeaders`, {
    headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
  });
  if (!res.ok) throw new Error(`Graph inbox ${res.status}`);
  const { value } = (await res.json()) as { value: GraphMessage[] };
  let taken = 0;
  for (const msg of [...value].reverse()) { // oldest first
    const head = (n: string) => msg.internetMessageHeaders?.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const auto = (!!head("auto-submitted") && head("auto-submitted").toLowerCase() !== "no") || /^(bulk|junk|list|auto_reply)$/i.test(head("precedence"));
    const html = msg.body?.contentType?.toLowerCase() === "html";
    try {
      const r = await ingestEmail({
        from: msg.from?.emailAddress?.address ?? "", name: msg.from?.emailAddress?.name, subject: msg.subject,
        text: html ? undefined : msg.body?.content, html: html ? msg.body?.content : undefined, messageId: msg.internetMessageId || msg.id, auto,
      });
      if (r.outcome !== "ignored") taken++;
      else if (r.reason !== "duplicate") console.log(`[inbound] left out a message from ${msg.from?.emailAddress?.address ?? "?"}: ${r.reason}`);
    } catch (e) {
      console.error("[inbound] could not take in a message:", (e as Error).message);
    }
    // Read = dealt with (taken in, or deliberately left out). It stays in the mailbox for a person to look at.
    await fetch(`${base}/messages/${msg.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ isRead: true }) }).catch(() => {});
  }
  return taken;
}

export function startInbound() {
  if (!graphInbound()) {
    if (config.inbound.mailbox) console.warn("[inbound] INBOUND_MAILBOX is set but GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET are not: the mailbox is not being read.");
    return () => {};
  }
  console.log(`[inbound] reading ${config.inbound.mailbox} every ${config.inbound.intervalSeconds}s`);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await pollMailbox(); } catch (e) { console.error("[inbound]", (e as Error).message); } finally { busy = false; }
  };
  const t = setInterval(tick, config.inbound.intervalSeconds * 1000);
  t.unref();
  return () => clearInterval(t);
}
