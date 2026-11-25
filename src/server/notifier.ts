import nodemailer from "nodemailer";
import { config } from "./config";
import { db } from "./db";

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

interface Pending {
  id: number;
  ticket_id: number;
  field: string;
  new_value: string | null;
  ref: string;
  title: string;
  source: string;
  to_email: string;
  to_name: string;
  new_assignee: string | null;
  actor: string | null;
  reply: string | null;
}
interface StaffRow { id: number; user_id: number; kind: string; title: string; body: string; ticket_id: number | null; ref: string | null; email: string; name: string; role: string }

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

/* ---------- the look of an email ---------- */
type Part = string | { b: string };
interface Block { html: string; text: string }
const para = (...parts: Part[]): Block => ({
  html: `<p style="margin:0 0 14px;line-height:1.55;font-size:15px">${parts.map((x) => (typeof x === "string" ? esc(x) : `<b>${esc(x.b)}</b>`)).join("")}</p>`,
  text: parts.map((x) => (typeof x === "string" ? x : x.b)).join(""),
});
const quote = (t: string): Block => ({
  html: `<blockquote style="margin:0 0 14px;padding:4px 14px;border-left:3px solid #00a859;color:#2b2b2b;font-size:15px;line-height:1.55">${esc(t).replace(/\n/g, "<br>")}</blockquote>`,
  text: t.split("\n").map((l) => "> " + l).join("\n"),
});
const ticketLine = (ref: string, title: string): Block => ({
  html: `<p style="margin:0 0 18px;padding:10px 14px;background:#f4f4f1;border-radius:8px;font-size:14px"><b>${esc(ref)}</b> &nbsp;${esc(title)}</p>`,
  text: `${ref}: ${title}`,
});
const button = (label: string, href: string): Block => ({
  html: `<p style="margin:6px 0 4px"><a href="${esc(href)}" style="display:inline-block;background:#00a859;color:#0b0b0b;font-weight:700;font-size:15px;text-decoration:none;padding:11px 20px;border-radius:8px">${esc(label)}</a></p>`,
  text: `${label}: ${href}`,
});

/** One branded wrapper for every email: the three brand colours as a stripe, the name, the content, and how to switch them off. */
function shell(blocks: Block[], foot: string): { html: string; text: string } {
  const html =
    `<!doctype html><html><body style="margin:0;padding:0;background:#efefea">` +
    `<div style="padding:24px 12px;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#0b0b0b">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e3dc;border-radius:12px;overflow:hidden">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>` +
    `<td height="5" width="34%" bgcolor="#00a859" style="font-size:0;line-height:0">&nbsp;</td><td height="5" width="33%" bgcolor="#ffb400" style="font-size:0;line-height:0">&nbsp;</td><td height="5" width="33%" bgcolor="#ee3239" style="font-size:0;line-height:0">&nbsp;</td></tr></table>` +
    `<div style="padding:24px 28px 8px">` +
    `<p style="margin:0 0 18px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#007a3d">Fortress Oil &amp; Gas Helpdesk</p>` +
    blocks.map((b) => b.html).join("") +
    `</div><div style="padding:14px 28px 22px;border-top:1px solid #eeeee8;font-size:12px;line-height:1.5;color:#6b6b66">${esc(foot)}</div>` +
    `</div></div></body></html>`;
  const text = blocks.map((b) => b.text).join("\n\n") + "\n\n--\nFortress Oil & Gas Helpdesk\n" + foot;
  return { html, text };
}

/** A link straight to a ticket (needs APP_URL). Requesters land in the normal app, staff in their own portal. */
const ticketUrl = (role: string, id: number) => (config.appUrl ? `${config.appUrl}${role === "admin" ? "/admin" : role === "agent" ? "/agent" : "/"}?t=${id}` : "");

export function composeRequester(e: Pending): Mail {
  const first = e.to_name.split(" ")[0] || "there";
  const blocks: Block[] = [para(`Hi ${first},`)];
  let button_label = "Open my ticket";
  if (e.field === "reply") {
    blocks.push(para({ b: e.actor ?? "IT" }, " from IT replied:"), quote(e.reply || "Sent an attachment."), para(repliesComeBack() ? "Reply to this email to answer, or open the helpdesk." : "Open the helpdesk to answer."));
    button_label = "Open the conversation";
  } else if (e.field === "created") {
    blocks.push(e.source === "email"
      ? para("We have your email and raised a ticket for it.", repliesComeBack() ? " Reply to this email to add anything." : "")
      : para("We have your ticket. IT will pick it up, and you will get an email when something changes."));
  } else if (e.field === "status") {
    blocks.push(para("The status of your ticket is now ", { b: LABEL[e.new_value ?? ""] ?? e.new_value ?? "updated" }, "."));
    if (e.new_value === "resolved") blocks.push(para("If it is not fixed, open the ticket and say so: it goes straight back to IT."));
  } else if (e.new_assignee) blocks.push(para({ b: e.new_assignee }, " is now working on your ticket."));
  else blocks.push(para("Your ticket is waiting to be assigned."));
  blocks.push(ticketLine(e.ref, e.title));
  const url = ticketUrl("requester", e.ticket_id);
  if (url) blocks.push(button(button_label, url));
  const { html, text } = shell(blocks, "You get these emails because of a ticket you raised. You can switch them off under Your account in the helpdesk.");
  return { to: e.to_email, subject: `[${e.ref}] ${e.title}`, html, text };
}

/** The one-time welcome for someone who has just created their account. */
export function composeWelcome(u: { name: string; email: string }): Mail {
  const first = u.name.split(" ")[0] || "there";
  const step = (lead: string, rest: string): Block => ({
    html: `<p style="margin:0 0 10px;padding-left:14px;border-left:3px solid #00a859;line-height:1.5;font-size:14px"><b>${esc(lead)}</b><br><span style="color:#3a3a36">${esc(rest)}</span></p>`,
    text: `- ${lead}: ${rest}`,
  });
  const blocks: Block[] = [
    para(`Hi ${first},`),
    para("Welcome to the ", { b: "Fortress Oil & Gas Helpdesk" }, ". Your account is ready, and IT is here to help you get back to work quickly."),
    para("Here is how it works:"),
    step("Raise a ticket", "Describe the problem in a few words and add a screenshot if you can. It takes less than a minute."),
    step("Follow it", "My queue shows where your ticket sits in line, and the Live board shows what IT is working on right now."),
    step("Stay informed", "You will get an email when your ticket is picked up, answered or resolved. You can also chat with IT on the ticket itself."),
    step("Try the Help pages first", "Short guides for common problems (Wi-Fi, printing, passwords, Microsoft 365) are there if you would like to fix something yourself."),
    step("Share your computer's details", "Under Account > This computer you can send IT your computer's specifications once, so problems are solved faster."),
  ];
  if (config.appUrl) blocks.push(button("Open the helpdesk", config.appUrl));
  blocks.push(para("Kind regards,"), para({ b: "IT Support" }, ", Fortress Oil & Gas"));
  const { html, text } = shell(blocks, "You are receiving this one-time message because an account was created for you on the helpdesk. You can switch off ticket emails under Your account.");
  return { to: u.email, subject: "Welcome to the Fortress Oil & Gas Helpdesk", html, text };
}

/** Several unseen updates on one ticket in one email: what changed, and only the latest few messages (never the whole conversation). */
export function composeRequesterGroup(events: Pending[]): Mail {
  if (events.length === 1) return composeRequester(events[0]!);
  const e0 = events[0]!;
  const first = e0.to_name.split(" ")[0] || "there";
  const blocks: Block[] = [para(`Hi ${first},`), para("There are updates on your ticket that you have not seen yet:")];
  const lastStatus = [...events].reverse().find((e) => e.field === "status");
  const lastAssign = [...events].reverse().find((e) => e.field === "assignee" && e.new_assignee);
  if (lastStatus) blocks.push(para("The status is now ", { b: LABEL[lastStatus.new_value ?? ""] ?? lastStatus.new_value ?? "updated" }, "."));
  if (lastAssign) blocks.push(para({ b: lastAssign.new_assignee! }, " is now working on your ticket."));
  const replies = events.filter((e) => e.field === "reply");
  for (const r of replies.slice(-3)) blocks.push(para({ b: r.actor ?? "IT" }, " from IT replied:"), quote((r.reply || "Sent an attachment.").length > 500 ? (r.reply || "").slice(0, 500).trimEnd() + "…" : r.reply || "Sent an attachment."));
  if (replies.length > 3) blocks.push(para(`…and ${replies.length - 3} earlier message${replies.length - 3 === 1 ? "" : "s"} in the conversation.`));
  if (replies.length) blocks.push(para(repliesComeBack() ? "Reply to this email to answer, or open the helpdesk." : "Open the helpdesk to answer."));
  blocks.push(ticketLine(e0.ref, e0.title));
  const url = ticketUrl("requester", e0.ticket_id);
  if (url) blocks.push(button(replies.length ? "Open the conversation" : "Open my ticket", url));
  const { html, text } = shell(blocks, "You get this email because you have not opened the ticket in the helpdesk yet. You can switch these emails off under Your account.");
  return { to: e0.to_email, subject: `[${e0.ref}] ${e0.title}`, html, text };
}

/** One email per person per round: a single update reads like the bell, several become a short list. */
export function composeStaff(rows: StaffRow[]): Mail {
  const r0 = rows[0]!;
  const first = r0.name.split(" ")[0] || "there";
  const blocks: Block[] = [para(`Hi ${first},`)];
  if (rows.length === 1) {
    blocks.push(para({ b: r0.title }), para(r0.body));
  } else {
    blocks.push(para(`${rows.length} things are waiting for you on the helpdesk:`));
    for (const r of rows.slice(0, 12)) blocks.push({ html: `<p style="margin:0 0 10px;font-size:14px;line-height:1.5"><b>${esc(r.title)}</b><br><span style="color:#4a4a45">${esc(r.body)}</span></p>`, text: `- ${r.title}${r.body ? ": " + r.body : ""}` });
    if (rows.length > 12) blocks.push(para(`…and ${rows.length - 12} more.`));
  }
  const only = rows.length === 1 && r0.ticket_id ? ticketUrl(r0.role, r0.ticket_id) : "";
  const home = config.appUrl ? `${config.appUrl}${r0.role === "admin" ? "/admin" : "/agent"}` : "";
  if (only) blocks.push(button("Open the ticket", only));
  else if (home) blocks.push(button("Open the helpdesk", home));
  const { html, text } = shell(blocks, "You are emailed only about things you have not already seen in the helpdesk. You can switch these emails off under Account.");
  return { to: r0.email, subject: rows.length === 1 ? r0.title : `${rows.length} updates waiting on the helpdesk`, html, text };
}

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
async function graphSender(): Promise<Sender> {
  const g = config.mail.graph;
  return async (m) => {
    const token = await graphToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(g.sender)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { subject: m.subject, body: { contentType: "HTML", content: m.html }, toRecipients: [{ emailAddress: { address: m.to } }] }, saveToSentItems: false }),
    });
    if (!res.ok) throw new Error(`Graph sendMail ${res.status}${await graphReason(res)}`);
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
  const sender = pickSender();
  if (!sender) throw new Error("Email is not set up. Set SMTP_* or GRAPH_* in .env (or MAIL_LOG_ONLY=1 to print emails to the log).");
  const { html, text } = shell(
    [para("This is a test email from your helpdesk."), para("If you can read this, ticket emails will reach people. The real ones look like this, with the ticket and a button to open it."), ticketLine("FG-0000", "A sample ticket"), ...(config.appUrl ? [button("Open the helpdesk", config.appUrl)] : [])],
    "Sent from Admin > System.",
  );
  await deliver(sender, { to, subject: "Test email from the Fortress Oil & Gas Helpdesk", html, text });
  return sender.name;
}

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
