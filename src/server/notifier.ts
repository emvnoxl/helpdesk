import nodemailer from "nodemailer";
import { config } from "./config";
import { db } from "./db";

/* Sends "your ticket changed" emails. It runs inside the server on a timer: no cron service needed.
   Transport, in order of preference: Microsoft Graph (if configured), SMTP (if configured), or just the log (MAIL_LOG_ONLY=1).
   Events are marked sent only after a successful send; anything older than a day is dropped rather than sent late. */

interface Pending {
  id: number;
  field: string;
  new_value: string | null;
  ref: string;
  title: string;
  to_email: string;
  to_name: string;
  new_assignee: string | null;
  actor: string | null;
  reply: string | null;
}

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", waiting: "Waiting for your reply", resolved: "Resolved", closed: "Closed" };

/** True when replies to our emails come back into the helpdesk, so the email may say "just reply". */
const repliesComeBack = () => !!(config.inbound.secret || (config.inbound.mailbox && config.mail.graph.tenantId));

function compose(e: Pending): Mail {
  const first = e.to_name.split(" ")[0] || "there";
  let what: string;
  if (e.field === "reply") what = `<b>${esc(e.actor ?? "IT")}</b> from IT replied:</p><blockquote style="margin:0 0 0 4px;padding:2px 12px;border-left:3px solid #00a859">${esc(e.reply ?? "").replace(/\n/g, "<br>")}</blockquote><p>${repliesComeBack() ? "Reply to this email to answer, or open the helpdesk." : "Open the helpdesk to answer."}`;
  else if (e.field === "created") what = `We have your email and raised a ticket for it.${repliesComeBack() ? " Reply to this email to add anything." : ""}`;
  else if (e.field === "status") what = `The status of your ticket is now <b>${esc(LABEL[e.new_value ?? ""] ?? e.new_value ?? "updated")}</b>.`;
  else if (e.new_assignee) what = `<b>${esc(e.new_assignee)}</b> is now working on your ticket.`;
  else what = "Your ticket is waiting to be assigned.";
  const link = config.appUrl ? `<p><a href="${esc(config.appUrl)}">Open the helpdesk</a></p>` : "";
  const html = `<p>Hi ${esc(first)},</p><p>${what}</p><p><b>${esc(e.ref)}</b>: ${esc(e.title)}</p>${link}`;
  const text = html.replace(/<br>/g, "\n").replace(/<\/(p|blockquote)>/g, "\n\n").replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { to: e.to_email, subject: `[${e.ref}] ${e.title}`, html, text };
}

/* ---------- transports ---------- */
type Sender = (m: Mail) => Promise<void>;

let cachedToken: { value: string; exp: number } | undefined;
/** An app-only Microsoft Graph token (cached until a minute before it expires). Also used to read the helpdesk mailbox (inbound.ts). */
export async function graphToken(): Promise<string> {
  const g = config.mail.graph;
  if (!cachedToken || cachedToken.exp < Date.now() + 60_000) {
    const res = await fetch(`https://login.microsoftonline.com/${g.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Graph token ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  }
  return cachedToken.value;
}
async function graphSender(): Promise<Sender> {
  const g = config.mail.graph;
  return async (m) => {
    const token = await graphToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(g.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject: m.subject, body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] }, saveToSentItems: false }),
    });
    if (!res.ok) throw new Error(`Graph sendMail ${res.status}`);
  };
}

function smtpSender(): Sender {
  const s = config.mail.smtp;
  const transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined });
  const from = config.mail.from || s.user;
  return async (m) => {
    await transport.sendMail({ from, to: m.to, subject: m.subject, html: m.html, text: m.text });
  };
}

const logSender: Sender = async (m) => console.log(`[mail] to=${m.to} subject="${m.subject}" :: ${m.text}`);

function pickSender(): { name: string; send: Sender } | null {
  const g = config.mail.graph;
  if (config.mail.logOnly) return { name: "log", send: logSender };
  if (g.tenantId && g.clientId && g.clientSecret && g.sender) return { name: "graph", send: (m) => graphSender().then((s) => s(m)) };
  if (config.mail.smtp.host) return { name: "smtp", send: smtpSender() };
  return null;
}

/* ---------- the loop ---------- */
let warned = false;
let busy = false;

export async function sendPending(): Promise<number> {
  const sender = pickSender();
  if (!sender) {
    if (!warned) console.warn("[mail] email notifications are OFF (set SMTP_*, GRAPH_* or MAIL_LOG_ONLY=1 to enable them)");
    warned = true;
    return 0;
  }
  // Don't send stale news: anything over a day old is simply marked done.
  await db.prepare("UPDATE ticket_events SET notified = 1 WHERE notified = 0 AND created_at < unixepoch() - 86400").run();
  const { results } = await db
    .prepare(
      `SELECT e.id, e.field, e.new_value, t.ref, t.title, u.email AS to_email, u.name AS to_name,
              CASE WHEN e.field = 'assignee' THEN (SELECT name FROM users WHERE id = CAST(e.new_value AS INTEGER)) END AS new_assignee,
              (SELECT name FROM users WHERE id = e.actor_id) AS actor,
              CASE WHEN e.field = 'reply' THEN (SELECT body FROM comments WHERE id = CAST(e.new_value AS INTEGER) AND internal = 0) END AS reply
       FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id JOIN users u ON u.id = t.requester_id
       WHERE e.notified = 0 AND (e.field IN ('status','assignee','reply') OR (e.field = 'created' AND t.source = 'email'))
       ORDER BY e.created_at ASC LIMIT 25`,
    )
    .all<Pending>();

  let sent = 0;
  for (const e of results) {
    try {
      await sender.send(compose(e));
      await db.prepare("UPDATE ticket_events SET notified = 1 WHERE id = ?").bind(e.id).run();
      sent++;
    } catch (err) {
      console.error(`[mail] ${sender.name} failed for event ${e.id}: ${(err as Error).message} (will retry)`);
      break; // the transport is probably down; try again on the next tick
    }
  }
  return sent;
}

export function startNotifier() {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await sendPending();
    } catch (e) {
      console.error("[mail] notifier error:", (e as Error).message);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, config.mail.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
