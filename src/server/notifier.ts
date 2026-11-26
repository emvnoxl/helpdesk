import nodemailer from "nodemailer";
import { config } from "./config";
import { db } from "./db";
import { composeRequester as renderRequester, composeRequesterGroup as renderGroup, composeStaff as renderStaff, composeTest, composeWelcome as renderWelcome, type Mail, type Pending, type StaffRow } from "./mailrender";
import { logoBytes, mailCtx, setMailSender } from "./mailtemplates";
import { LOCK_PNG_B64, SHIELD_PNG_B64 } from "./emailIcons";

/* Sends the helpdesk's emails. It runs inside the server on a timer: no cron service needed.
   Transport, in order of preference: MAIL_LOG_ONLY=1 (print to the log), Microsoft Graph (if configured), SMTP (if configured).

   Two streams:
   - REQUESTERS are emailed from ticket_events. "We have your ticket" goes at once. A staff reply, a status change or a new assignee is
     emailed only if the person has NOT looked at it in the helpdesk after REQUESTER_EMAIL_DELAY_SECONDS (300): opening the ticket or
     the bell marks it read, which cancels the email. Several unseen updates on one ticket become ONE email (the latest messages only).
   - IT STAFF are emailed from their bell notifications (new ticket, assigned to you, a requester wrote, a late ticket, a call request,
     an internal note) but only if they are still unread after STAFF_EMAIL_DELAY_SECONDS (so nothing is emailed while they are at the
     helpdesk), and several arriving together become ONE email.
   Anyone can switch their emails off (users.email_notify). Rows are marked sent only after a successful send; anything older than a day
   is dropped rather than sent late. */

/* What the emails SAY and look like lives in mailrender.ts (templates an admin can edit, see mailtemplates.ts). This file decides WHO gets what and WHEN,
   and carries it by Graph, SMTP or the log. */
export const composeRequester = (e: Pending) => renderRequester(e, mailCtx());
export const composeRequesterGroup = (events: Pending[]) => renderGroup(events, mailCtx());
export const composeStaff = (rows: StaffRow[]) => renderStaff(rows, mailCtx());
export const composeWelcome = (u: { name: string; email: string }) => renderWelcome(u, mailCtx());

/* ---------- transports ---------- */
type Sender = (m: Mail) => Promise<void>;

/** Microsoft says why in the body ("ErrorAccessDenied", "MailboxNotEnabledForRESTAPI", "invalid_client"...): show that, with a hint for the usual ones. */
async function graphReason(res: Response): Promise<string> {
  let code = "", text = "";
  try {
    const j = (await res.json()) as { error?: string | { code?: string; message?: string }; error_description?: string };
    code = typeof j.error === "string" ? j.error : (j.error?.code ?? "");
    text = (typeof j.error === "string" ? j.error_description : j.error?.message) ?? "";
  } catch { /* no body */ }
  const hint =
    /ErrorAccessDenied|Authorization_RequestDenied|AccessDenied/i.test(code) ? " (the app needs the Mail.Send APPLICATION permission with admin consent, and must be allowed to use that mailbox)"
    : /MailboxNotEnabledForRESTAPI|ResourceNotFound|ErrorInvalidUser|MailboxNotFound/i.test(code) ? " (the sender mailbox does not exist or has no Exchange Online licence)"
    : /invalid_client/i.test(code) ? " (wrong secret: use the secret VALUE, and check it has not expired)"
    : "";
  const detail = [code, text.split("\n")[0]].filter(Boolean).join(": ").replace(/\s+/g, " ").slice(0, 160);
  return detail ? ` - ${detail}${hint}` : "";
}

let cachedToken: { value: string; exp: number } | undefined;
/** The Graph credentials were changed: don't keep using a token issued for the old ones. */
export const forgetGraphToken = () => { cachedToken = undefined; };
/** An app-only Microsoft Graph token (cached until a minute before it expires). Also used to read the helpdesk mailbox (inbound.ts). */
export async function graphToken(): Promise<string> {
  const g = config.mail.graph;
  if (!cachedToken || cachedToken.exp < Date.now() + 60_000) {
    const res = await fetch(`https://login.microsoftonline.com/${g.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    if (!res.ok) throw new Error(`Graph token ${res.status}${await graphReason(res)}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  }
  return cachedToken.value;
}
/** The pictures an email shows (logo, shield, padlock) travel inside the message, referred to as cid:..., so they appear wherever it is read. */
export function inlineImages(m: Mail): { cid: string; name: string; bytes: Buffer }[] {
  return [
    ...(m.logo ? [{ cid: "fglogo", name: "logo.png", bytes: logoBytes() }] : []),
    ...(m.icons ? [{ cid: "fgshield", name: "verified.png", bytes: Buffer.from(SHIELD_PNG_B64, "base64") }, { cid: "fglock", name: "lock.png", bytes: Buffer.from(LOCK_PNG_B64, "base64") }] : []),
  ];
}
async function graphSender(): Promise<Sender> {
  const g = config.mail.graph;
  return async (m) => {
    const token = await graphToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(g.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: m.subject,
          body: { contentType: "HTML", content: m.html },
          toRecipients: [{ emailAddress: { address: m.to } }],
          // The pictures are attached to the message itself ("inline", referred to as cid:fglogo, cid:fgshield, cid:fglock), so they show wherever the email is read.
          ...(inlineImages(m).length ? { attachments: inlineImages(m).map((i) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: i.name, contentType: "image/png", contentBytes: i.bytes.toString("base64"), isInline: true, contentId: i.cid })) } : {}),
        },
        saveToSentItems: false,
      }),
    });
    if (!res.ok) throw new Error(`Graph sendMail ${res.status}${await graphReason(res)}`);
  };
}

function smtpSender(): Sender {
  const s = config.mail.smtp;
  const transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.pass } : undefined });
  const from = config.mail.from || s.user;
  return async (m) => {
    await transport.sendMail({ from, to: m.to, subject: m.subject, html: m.html, text: m.text, ...(inlineImages(m).length ? { attachments: inlineImages(m).map((i) => ({ filename: i.name, content: i.bytes, contentType: "image/png", cid: i.cid, contentDisposition: "inline" as const })) } : {}) });
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

/* ---------- what the System page shows ---------- */
const state = { okAt: 0, error: "", errorAt: 0 };
async function deliver(sender: { name: string; send: Sender }, m: Mail) {
  try {
    await sender.send(m);
    state.okAt = Math.floor(Date.now() / 1000);
    state.error = "";
  } catch (e) {
    state.error = `${sender.name}: ${(e as Error).message}`.slice(0, 200);
    state.errorAt = Math.floor(Date.now() / 1000);
    throw e;
  }
}

export async function mailInfo() {
  const [a, b, c] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE notified = 0 AND field IN ('status','assignee','reply','created') AND created_at > unixepoch() - 86400"),
    db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE emailed = 0 AND read_at IS NULL AND created_at > unixepoch() - 86400"),
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE welcome_pending = 1 AND created_at > unixepoch() - 86400"),
  ]);
  return { transport: pickSender()?.name ?? "off", last_ok_at: state.okAt || null, last_error: state.error || null, last_error_at: state.errorAt || null, waiting: (a.results[0]?.n ?? 0) + (b.results[0]?.n ?? 0) + (c.results[0]?.n ?? 0) };
}

/** An admin's "send me a test": the same path as the real emails, and the error (if any) comes straight back. */
export async function sendTest(to: string): Promise<string> {
  return sendOne(composeTest(to, mailCtx()));
}

/** Sends one email now through whatever is set up (used for tests and for "send me this email" in the template editor). */
export async function sendOne(m: Mail): Promise<string> {
  const sender = pickSender();
  if (!sender) throw new Error("Email is not set up. Set SMTP_* or GRAPH_* in .env (or MAIL_LOG_ONLY=1 to print emails to the log).");
  await deliver(sender, m);
  return sender.name;
}
setMailSender(sendOne);

/* ---------- the loop ---------- */
let warned = false;
let busy = false;

const PENDING_SELECT = `SELECT e.id, t.id AS ticket_id, e.field, e.new_value, t.ref, t.title, t.source, u.email AS to_email, u.name AS to_name,
              CASE WHEN e.field = 'assignee' THEN (SELECT name FROM users WHERE id = CAST(e.new_value AS INTEGER)) END AS new_assignee,
              (SELECT name FROM users WHERE id = e.actor_id) AS actor,
              CASE WHEN e.field = 'reply' THEN (SELECT CASE WHEN kind IN ('gif','giphy') AND body = '' THEN 'Sent a GIF.' ELSE body END FROM comments WHERE id = CAST(e.new_value AS INTEGER) AND internal = 0 AND deleted_at IS NULL) END AS reply
       FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id JOIN users u ON u.id = t.requester_id`;

async function sendRequesterEvents(sender: { name: string; send: Sender }): Promise<number> {
  // People who switched emails off: mark their events done without sending.
  await db.prepare("UPDATE ticket_events SET notified = 1 WHERE notified = 0 AND ticket_id IN (SELECT t.id FROM tickets t JOIN users u ON u.id = t.requester_id WHERE u.email_notify = 0 OR u.active = 0)").run();
  let sent = 0;

  // 1. "We have your ticket": at once.
  const created = await db
    .prepare(`${PENDING_SELECT} WHERE e.notified = 0 AND e.field = 'created' AND t.source IN ('email','web') ORDER BY e.created_at ASC LIMIT 25`)
    .all<Pending>();
  for (const e of created.results) {
    await deliver(sender, composeRequester(e));
    await db.prepare("UPDATE ticket_events SET notified = 1 WHERE id = ?").bind(e.id).run();
    sent++;
  }

  // 2. Replies, status changes, a new assignee: only when the person has NOT looked at them. The bell notification written with the event is
  //    marked read the moment they open the ticket (or the bell), so "no unread notification at or after this event" means they have seen it.
  const delay = config.mail.requesterDelaySeconds;
  await db
    .prepare(
      `UPDATE ticket_events SET notified = 1 WHERE notified = 0 AND field IN ('status','assignee','reply') AND created_at <= unixepoch() - ?
         AND NOT EXISTS (SELECT 1 FROM notifications n JOIN tickets t ON t.id = ticket_events.ticket_id
                         WHERE n.ticket_id = t.id AND n.user_id = t.requester_id AND n.read_at IS NULL AND n.created_at >= ticket_events.created_at)`,
    )
    .bind(delay)
    .run();
  const updates = await db
    .prepare(`${PENDING_SELECT} WHERE e.notified = 0 AND e.field IN ('status','assignee','reply') AND e.created_at <= unixepoch() - ? ORDER BY e.created_at ASC LIMIT 100`)
    .bind(delay)
    .all<Pending>();
  const byTicket = new Map<number, Pending[]>();
  for (const e of updates.results) byTicket.set(e.ticket_id, [...(byTicket.get(e.ticket_id) ?? []), e]);
  for (const group of byTicket.values()) {
    await deliver(sender, composeRequesterGroup(group));
    await db.prepare(`UPDATE ticket_events SET notified = 1 WHERE id IN (${group.map(() => "?").join(",")})`).bind(...group.map((e) => e.id)).run();
    sent++;
  }
  return sent;
}

async function sendWelcomes(sender: { name: string; send: Sender }): Promise<number> {
  // Nobody to welcome: switched off, not a requester, or too late (an account from before mail was set up must not get a "welcome" days later).
  await db.prepare("UPDATE users SET welcome_pending = 0 WHERE welcome_pending = 1 AND (email_notify = 0 OR active = 0 OR role <> 'requester' OR created_at < unixepoch() - 86400)").run();
  const { results } = await db.prepare("SELECT id, name, email FROM users WHERE welcome_pending = 1 ORDER BY id LIMIT 25").all<{ id: number; name: string; email: string }>();
  let sent = 0;
  for (const u of results) {
    await deliver(sender, composeWelcome(u));
    await db.prepare("UPDATE users SET welcome_pending = 0 WHERE id = ?").bind(u.id).run();
    sent++;
  }
  return sent;
}

const STAFF_KINDS = ["new_ticket", "assigned", "message", "note", "sla_breach", "call_request"];

async function sendStaffDigests(sender: { name: string; send: Sender }): Promise<number> {
  // Nothing to email: read already, too old, not staff, switched off, or not a kind worth an email.
  await db
    .prepare(
      `UPDATE notifications SET emailed = 1 WHERE emailed = 0 AND (
         read_at IS NOT NULL OR created_at < unixepoch() - 86400 OR kind NOT IN (${STAFF_KINDS.map(() => "?").join(",")})
         OR user_id IN (SELECT id FROM users WHERE role = 'requester' OR email_notify = 0 OR active = 0))`,
    )
    .bind(...STAFF_KINDS)
    .run();
  const { results } = await db
    .prepare(
      `SELECT n.id, n.user_id, n.kind, n.title, n.body, n.ticket_id, t.ref, u.email, u.name, u.role
       FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN tickets t ON t.id = n.ticket_id
       WHERE n.emailed = 0 AND n.read_at IS NULL AND n.created_at <= unixepoch() - ?
       ORDER BY n.id ASC LIMIT 200`,
    )
    .bind(config.mail.staffDelaySeconds)
    .all<StaffRow>();
  const byPerson = new Map<number, StaffRow[]>();
  for (const r of results) byPerson.set(r.user_id, [...(byPerson.get(r.user_id) ?? []), r]);
  let sent = 0;
  for (const rows of byPerson.values()) {
    await deliver(sender, composeStaff(rows));
    await db.prepare(`UPDATE notifications SET emailed = 1 WHERE id IN (${rows.map(() => "?").join(",")})`).bind(...rows.map((r) => r.id)).run();
    sent++;
  }
  return sent;
}

export async function sendPending(): Promise<number> {
  const sender = pickSender();
  if (!sender) {
    if (!warned) console.warn("[mail] email notifications are OFF (set SMTP_*, GRAPH_* or MAIL_LOG_ONLY=1 to enable them)");
    warned = true;
    return 0;
  }
  // Don't send stale news: anything over a day old is simply marked done.
  await db.prepare("UPDATE ticket_events SET notified = 1 WHERE notified = 0 AND created_at < unixepoch() - 86400").run();
  try {
    return (await sendWelcomes(sender)) + (await sendRequesterEvents(sender)) + (await sendStaffDigests(sender));
  } catch (err) {
    console.error(`[mail] ${sender.name} failed: ${(err as Error).message} (will retry)`);
    return 0; // the transport is probably down; try again on the next tick
  }
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
