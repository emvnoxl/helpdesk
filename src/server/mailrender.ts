import { signToken } from "./security";

/* How the helpdesk's emails look and what they say. Pure functions only (no database, no settings): everything they need comes in as arguments, so
   they can be tested on their own and used for the live preview. The wording of every email is a TEMPLATE an admin can change under
   Admin > System > Email templates (stored by mailtemplates.ts); the defaults below are what you get until then.

   Templates are plain text. `{name}`-style placeholders are filled in, **double stars** make bold, a new line is a line break. Nothing in a
   template is ever treated as HTML, so a template can't inject markup. Every email carries the same "this is genuine" block: who it is
   from, what IT will never ask for, and a link that opens a page on the helpdesk itself confirming the message (signed, so it can't be faked). */

export type Kind = "created" | "reply" | "status" | "assigned" | "digest" | "welcome" | "staff" | "report";

export interface Brand {
  name: string;        // the name at the top and in the footer, "Fortress Oil & Gas Helpdesk"
  team: string;        // who the emails are from
  greeting: string;    // "Hi {name},"
  signoff: string;     // "Kind regards,"
  contact: string;     // optional: how to reach IT ("Reply to this email, or call IT on ext 100")
  trust: string;       // the safety line ("IT will never ask for your password...")
  show_logo: boolean;
  show_verify: boolean;
}
export type KindText = Record<string, string>;
export interface Templates { brand: Brand; kinds: Record<Kind, KindText> }

export const DEFAULT_BRAND: Brand = {
  name: "Fortress Oil & Gas Helpdesk",
  team: "Fortress IT Team",
  greeting: "Hi {name},",
  signoff: "Kind regards,",
  contact: "",
  trust: "IT will never ask you for your password, PIN or bank details by email. If an email asks for them, it is not from us: please tell IT.",
  show_logo: true,
  show_verify: true,
};

export const DEFAULT_STEPS = [
  "Raise a ticket | Describe the problem in a few words and add a screenshot if you can. It takes less than a minute.",
  "Follow it | My queue shows where your ticket sits in line, and the Live board shows what IT is working on right now.",
  "Stay informed | You will get an email when your ticket is picked up, answered or resolved. You can also chat with IT on the ticket itself.",
  "Try the Help pages first | Short guides for common problems (Wi-Fi, printing, passwords, Microsoft 365) are there if you would like to fix something yourself.",
  "Share your computer's details | Under Account > This computer you can send IT your computer's specifications once, so problems are solved faster.",
].join("\n");

export const DEFAULT_KINDS: Record<Kind, KindText> = {
  created: { subject: "[{ref}] {title}", intro: "We have your ticket. IT will pick it up, and you will get an email when something changes.", intro2: "We have your email and raised a ticket for it.", note: "Reply to this email to add anything.", button: "Open my ticket" },
  reply: { subject: "[{ref}] {title}", intro: "**{agent}** from IT replied:", note: "Reply to this email to answer, or open the helpdesk.", note2: "Open the helpdesk to answer.", button: "Open the conversation" },
  status: { subject: "[{ref}] {title}", intro: "The status of your ticket is now **{status}**.", note: "If it is not fixed, open the ticket and say so: it goes straight back to IT.", button: "Open my ticket" },
  assigned: { subject: "[{ref}] {title}", intro: "**{agent}** is now working on your ticket.", intro2: "Your ticket is waiting to be assigned.", button: "Open my ticket" },
  digest: { subject: "[{ref}] {title}", intro: "There are updates on your ticket that you have not seen yet:", button: "Open my ticket" },
  welcome: { subject: "Welcome to the {helpdesk}", intro: "Welcome to the **{helpdesk}**. Your account is ready, and IT is here to help you get back to work quickly.", steps: DEFAULT_STEPS, button: "Open the helpdesk" },
  staff: { subject: "{count} updates waiting on the helpdesk", intro: "{count} things are waiting for you on the helpdesk:", button: "Open the ticket", button2: "Open the helpdesk" },
  report: { subject: "{helpdesk} report for {month}", intro: "Here is how the helpdesk did in **{month}**.", button: "Open the full report" },
};

/** What an admin sees for each email: what it is for, which parts can be changed, and which {placeholders} work. */
export interface FieldMeta { key: string; label: string; rows: number; hint?: string; required?: boolean }
export interface KindMeta { id: Kind; label: string; when: string; vars: string[]; fields: FieldMeta[] }
const VARS = ["name", "fullname", "ref", "title", "team", "helpdesk"];
export const KINDS: KindMeta[] = [
  { id: "created", label: "Ticket received", when: "Sent at once when someone raises a ticket (or emails IT).", vars: VARS, fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Message (ticket raised on the website)", rows: 3, required: true },
    { key: "intro2", label: "Message (ticket made from an email)", rows: 2, required: true },
    { key: "note", label: "Extra line when they can reply by email", rows: 1 },
    { key: "button", label: "Button", rows: 1, required: true },
  ] },
  { id: "reply", label: "IT replied", when: "Sent when IT replies and the person has not read it in the helpdesk after a few minutes. The reply itself is quoted underneath.", vars: [...VARS, "agent"], fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Line above the reply", rows: 2, required: true },
    { key: "note", label: "Line below (replies by email are read)", rows: 2 },
    { key: "note2", label: "Line below (replies by email are not read)", rows: 2 },
    { key: "button", label: "Button", rows: 1, required: true },
  ] },
  { id: "status", label: "Status changed", when: "Sent when the status changes (open, in progress, waiting, resolved, closed) and it has not been seen.", vars: [...VARS, "status"], fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Message", rows: 2, required: true },
    { key: "note", label: "Extra line when it is resolved", rows: 2 },
    { key: "button", label: "Button", rows: 1, required: true },
  ] },
  { id: "assigned", label: "Someone took it", when: "Sent when a person from IT is assigned to the ticket.", vars: [...VARS, "agent"], fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Message", rows: 2, required: true },
    { key: "intro2", label: "Message when it goes back to waiting", rows: 2, required: true },
    { key: "button", label: "Button", rows: 1, required: true },
  ] },
  { id: "digest", label: "Several updates at once", when: "Sent instead of separate emails when more than one update on a ticket has not been seen.", vars: VARS, fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Message", rows: 2, required: true },
    { key: "button", label: "Button", rows: 1, required: true },
  ] },
  { id: "welcome", label: "Welcome", when: "Sent once to someone who has just created their account.", vars: VARS, fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Message", rows: 3, required: true },
    { key: "steps", label: "The steps (one per line: Title | explanation)", rows: 7, hint: "Leave a line out to remove that step.", required: true },
    { key: "button", label: "Button", rows: 1, required: true },
  ] },
  { id: "staff", label: "For IT staff", when: "Sent to people in IT about things waiting for them that they have not seen in the helpdesk. One email, however many things.", vars: ["name", "fullname", "team", "helpdesk", "count"], fields: [
    { key: "subject", label: "Subject (when there are several)", rows: 1, required: true },
    { key: "intro", label: "Message (when there are several)", rows: 2, required: true },
    { key: "button", label: "Button (one ticket)", rows: 1, required: true },
    { key: "button2", label: "Button (several things)", rows: 1, required: true },
  ] },
  { id: "report", label: "Monthly report", when: "Sent once a month to the people chosen under System > Report email: the numbers for the month that just ended. It holds totals only, no ticket titles and no names.", vars: ["name", "fullname", "team", "helpdesk", "month"], fields: [
    { key: "subject", label: "Subject", rows: 1, required: true },
    { key: "intro", label: "Message", rows: 2, required: true },
    { key: "button", label: "Button (people who can sign in to the helpdesk)", rows: 1, required: true },
  ] },
];

export const BRAND_FIELDS: FieldMeta[] = [
  { key: "name", label: "Name shown at the top and in the footer", rows: 1, required: true },
  { key: "team", label: "Who the emails are from", rows: 1, required: true, hint: "Shown in the signature and on the “genuine message” line." },
  { key: "greeting", label: "Greeting", rows: 1, required: true, hint: "{name} is the person's first name." },
  { key: "signoff", label: "Sign-off", rows: 1, required: true },
  { key: "contact", label: "How to reach IT (optional)", rows: 2, hint: "For example: Reply to this email, or call IT on ext 100." },
  { key: "trust", label: "Safety line", rows: 3, hint: "Tells people what IT will never ask for. This is what makes a fake email stand out." },
];

const LIMIT: Record<string, number> = { subject: 160, intro: 700, intro2: 700, note: 500, note2: 500, button: 40, button2: 40, steps: 1800, name: 80, team: 80, greeting: 100, signoff: 80, contact: 240, trust: 500 };
const ONE_LINE = new Set(["subject", "button", "button2", "name", "team", "greeting", "signoff"]);
const clean = (s: unknown, key: string) => {
  let v = typeof s === "string" ? s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : "";
  v = ONE_LINE.has(key) ? v.replace(/\s+/g, " ").trim() : v.replace(/[ \t]+\n/g, "\n").trim();
  return v.slice(0, LIMIT[key] ?? 500);
};

/** The effective templates: the defaults with an admin's changes (a partial set) on top. */
export function merge(over: unknown): Templates {
  const o = (over && typeof over === "object" ? over : {}) as { brand?: Partial<Brand>; kinds?: Record<string, KindText> };
  const brand: Brand = { ...DEFAULT_BRAND };
  for (const f of BRAND_FIELDS) { const v = (o.brand as any)?.[f.key]; if (typeof v === "string") (brand as any)[f.key] = clean(v, f.key); }
  if (typeof o.brand?.show_logo === "boolean") brand.show_logo = o.brand.show_logo;
  if (typeof o.brand?.show_verify === "boolean") brand.show_verify = o.brand.show_verify;
  const kinds = {} as Record<Kind, KindText>;
  for (const k of KINDS) {
    kinds[k.id] = { ...DEFAULT_KINDS[k.id] };
    for (const f of k.fields) { const v = o.kinds?.[k.id]?.[f.key]; if (typeof v === "string") kinds[k.id][f.key] = clean(v, f.key); }
  }
  return { brand, kinds };
}

/** Checks what an admin typed; returns the cleaned templates or the first problem in plain words. */
export function validate(over: unknown): { ok: true; t: Templates } | { ok: false; error: string } {
  const t = merge(over);
  for (const f of BRAND_FIELDS) if (f.required && !(t.brand as any)[f.key]) return { ok: false, error: `“${f.label}” can't be empty.` };
  for (const k of KINDS) for (const f of k.fields) if (f.required && !t.kinds[k.id][f.key]) return { ok: false, error: `${k.label}: “${f.label}” can't be empty.` };
  const lines = t.kinds.welcome.steps!.split("\n").filter(Boolean);
  if (lines.length > 8) return { ok: false, error: "Welcome: at most 8 steps." };
  if (lines.some((l) => !l.includes("|") || !l.split("|")[0]!.trim() || !l.split("|").slice(1).join("|").trim())) return { ok: false, error: "Welcome: every step needs a title and an explanation, written as Title | explanation." };
  return { ok: true, t };
}

/** Only what differs from the defaults is stored, so a better default in a later version still reaches everyone who never changed it. */
export function diff(t: Templates): { brand: Partial<Brand>; kinds: Partial<Record<Kind, KindText>> } {
  const brand: Partial<Brand> = {};
  for (const key of Object.keys(DEFAULT_BRAND) as (keyof Brand)[]) if (t.brand[key] !== DEFAULT_BRAND[key]) (brand as any)[key] = t.brand[key];
  const kinds: Partial<Record<Kind, KindText>> = {};
  for (const k of KINDS) for (const f of k.fields) if (t.kinds[k.id][f.key] !== DEFAULT_KINDS[k.id][f.key]) (kinds[k.id] ??= {})[f.key] = t.kinds[k.id][f.key]!;
  return { brand, kinds };
}

/* ---------- the pieces of an email ---------- */
export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const rich = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
const plain = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1");
/** Fills {placeholders}; one that is not known is left as written so a typo is visible, not silent. */
export const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k]! : m));

export interface Block { html: string; text: string }
/* The look. The app's own font (Montserrat) comes first: Apple Mail, iOS, Samsung, Thunderbird and Gmail load it, and a program that cannot (Outlook on
   Windows) falls back to Segoe UI, which is close. Everything is inline styles and tables, because that is what mail programs reliably draw. */
export const FONT = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap";
const F = "font-family:" + FONT;
const P = "margin:0 0 16px;line-height:1.65;font-size:15px;color:#23272a;" + F;
const tpara = (t: string, at = ""): Block => ({ html: `<p${at} style="${P}">${rich(t)}</p>`, text: plain(t) });
const quote = (t: string): Block => ({
  html: `<blockquote style="margin:0 0 20px;padding:14px 18px;background:#f6f8f5;border-left:4px solid #00a859;border-radius:0 10px 10px 0;color:#2b2f31;font-size:15px;line-height:1.6;${F}">${esc(t).replace(/\n/g, "<br>")}</blockquote>`,
  text: t.split("\n").map((l) => "> " + l).join("\n"),
});
const ticketLine = (ref: string, title: string): Block => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;background:#f7f8f6;border:1px solid #eceee9;border-left:4px solid #00a859;border-radius:10px;border-collapse:separate"><tr><td style="padding:13px 16px;font-size:15px;line-height:1.5;color:#1b1f1d;${F}"><span style="display:inline-block;background:#e3f5ec;color:#007a3d;font-weight:800;font-size:12px;letter-spacing:.04em;padding:3px 9px;border-radius:6px;margin-right:10px">${esc(ref)}</span><b>${esc(title)}</b></td></tr></table>`,
  text: `${ref}: ${title}`,
});
const button = (label: string, href: string, at = ""): Block => ({
  html: `<p${at} style="margin:8px 0 6px"><a href="${esc(href)}" style="display:inline-block;background:#00a859;color:#0b0b0b;font-weight:700;font-size:15px;text-decoration:none;padding:14px 26px;border-radius:10px;${F}">${esc(label)} &#8594;</a></p>`,
  text: `${label}: ${href}`,
});
const step = (lead: string, rest: string, n = 0): Block => ({
  html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td width="42" valign="top"><div style="width:30px;height:30px;line-height:30px;border-radius:15px;background:#00a859;color:#0b0b0b;text-align:center;font-weight:800;font-size:13px;${F}">${n || "&#8226;"}</div></td><td valign="top" style="font-size:14px;line-height:1.55;color:#23272a;${F}"><b style="font-size:15px">${esc(lead)}</b><br><span style="color:#4b5257">${esc(rest)}</span></td></tr></table>`,
  text: `- ${lead}: ${rest}`,
});

/** Preview only: marks a block with the template field it shows, so the editor can open it for editing in place. Real emails get nothing. */
const ed = (x: { preview?: boolean }, key: string) => (x.preview ? ` data-edit="${key}"` : "");
/** Preview only: a clickable stand-in for an optional line that is empty right now. */
const slot = (x: { preview?: boolean }, key: string, label: string) => (x.preview ? `<p${ed(x, key)} style="margin:0 0 12px;font-size:13px;color:#8a8a84;font-style:italic">+ ${esc(label)}</p>` : "");

export interface Ctx {
  t: Templates;
  appUrl: string;
  repliesBack: boolean;   // do replies to our emails come back into the helpdesk?
  secret: string;         // signs the "verify this email" links
  preview?: boolean;      // the admin's live preview
  previewLogo?: string;   // ...where the logo is a data: address (the preview sits in a sandboxed frame that cannot fetch it, and cid: only works in a mail program)
  previewIcons?: { shield: string; lock: string }; // ...and the two small icons likewise
  now?: number;           // seconds (tests)
}
export interface Mail { to: string; subject: string; html: string; text: string; logo?: boolean; icons?: boolean }

const maskEmail = (e: string) => {
  const [u = "", d = ""] = e.split("@");
  return (u.length <= 2 ? u[0] ?? "" : u.slice(0, 2)) + "***@" + d;
};
const host = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

/** The link that opens a page on the helpdesk itself confirming this message. Signed with the server's secret: nobody else can make one that works. */
export function verifyUrl(x: Ctx, o: { to: string; kind: string; ref?: string }): string {
  if (!x.appUrl || !x.t.brand.show_verify || x.preview) return x.preview && x.appUrl ? x.appUrl + "/verify?m=preview" : "";
  const t = x.now ?? Math.floor(Date.now() / 1000);
  return `${x.appUrl}/verify?m=${signToken({ k: o.kind, r: o.ref ?? "", m: maskEmail(o.to), t, e: t + 400 * 86400 }, x.secret)}`;
}

/** What a message is called in the header badge and in the "genuine message" details. */
const KIND_LABEL: Record<string, string> = { created: "Ticket received", reply: "New reply", status: "Status update", assigned: "Ticket update", digest: "Ticket updates", welcome: "Welcome", staff: "IT update", report: "Monthly report", test: "Test email" };

/** One branded wrapper for every email: the three brand colours as a stripe, the logo or the name and a badge saying what this is, the content, the signature, and a
    "verified message" card (shield, who sent it, to whom, the safety line, and a link that proves it on the helpdesk itself). */
export function shell(x: Ctx, blocks: Block[], foot: string, o: { to: string; kind: string; ref?: string }): { html: string; text: string; logo: boolean; icons: boolean } {
  const b = x.t.brand;
  const logo = b.show_logo;
  const verify = verifyUrl(x, o);
  const where = x.appUrl ? host(x.appUrl) : "";
  const kindLabel = KIND_LABEL[o.kind] ?? "Message";
  const shield = x.preview && x.previewIcons ? x.previewIcons.shield : "cid:fgshield";
  const lock = x.preview && x.previewIcons ? x.previewIcons.lock : "cid:fglock";
  const head = logo
    ? `<img src="${x.preview && x.previewLogo ? x.previewLogo : "cid:fglogo"}" alt="${esc(b.name)}" height="46" style="display:block;height:46px;width:auto;border:0;outline:none;text-decoration:none">`
    : `<p${ed(x, "brand.name")} style="margin:0;font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#007a3d;${F}">${esc(b.name)}</p>`;
  const sign =
    `<p${ed(x, "brand.signoff")} style="margin:22px 0 2px;font-size:15px;line-height:1.5;color:#23272a;${F}">${esc(b.signoff)}</p>` +
    `<p${ed(x, "brand.team")} style="margin:0 0 ${b.contact || x.preview ? "4" : "8"}px;font-size:15px;line-height:1.5;color:#0b0b0b;${F}"><b>${esc(b.team)}</b></p>` +
    (b.contact ? `<p${ed(x, "brand.contact")} style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#5a6166;${F}">${rich(b.contact)}</p>` : slot(x, "brand.contact", "Add how to reach IT"));

  const rowS = "padding:7px 0;border-top:1px solid #d5ebdf;font-size:13px;line-height:1.45;" + F;
  const detail = (k: string, v: string) => `<tr><td width="84" valign="top" style="${rowS}color:#5b7466;font-weight:600">${k}</td><td valign="top" style="${rowS}color:#14352a;font-weight:700;word-break:break-word">${v}</td></tr>`;
  const genuine =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background:#f2faf6;border:1px solid #c6e6d6;border-radius:16px">` +
    // who says so
    `<tr><td style="padding:20px 22px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="62" valign="top"><img src="${shield}" width="48" height="48" alt="Verified" style="display:block;width:48px;height:48px;border:0"></td>` +
    `<td valign="middle" style="${F}"><div style="font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#007a3d">Verified message</div>` +
    `<div style="font-size:16px;font-weight:700;line-height:1.35;color:#14352a;margin-top:3px">A genuine message from the ${esc(b.team)}</div>` +
    `<div style="font-size:13px;line-height:1.5;color:#3d5a4c;margin-top:2px">Sent by the ${esc(b.name)}${where ? ` (${esc(where)})` : ""}</div></td></tr></table></td></tr>` +
    // the facts
    `<tr><td style="padding:8px 22px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${detail("Sent to", esc(o.to))}${o.ref ? detail("About", esc(o.ref)) : ""}${detail("Message", esc(kindLabel))}</table></td></tr>` +
    // what IT will never ask
    (b.trust
      ? `<tr><td style="padding:12px 22px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="26" valign="top" style="padding-top:3px"><img src="${lock}" width="16" height="16" alt="" style="display:block;width:16px;height:16px;border:0"></td><td valign="top"><div${ed(x, "brand.trust")} style="font-size:13px;line-height:1.6;color:#1f3d2d;${F}">${rich(b.trust)}</div></td></tr></table></td></tr>`
      : x.preview ? `<tr><td style="padding:12px 22px 0">${slot(x, "brand.trust", "Add a safety line")}</td></tr>` : "") +
    // the proof
    (verify
      ? `<tr><td style="padding:14px 22px 20px;${F}"><a href="${esc(verify)}" style="display:inline-block;border:2px solid #00a859;color:#007a3d;background:#ffffff;font-weight:700;font-size:13px;text-decoration:none;padding:9px 16px;border-radius:9px">&#128274;&#xFE0E; Verify this email</a>` +
        `<div style="font-size:12px;line-height:1.55;color:#3d5a4c;margin-top:9px">${where ? `Or type <b>${esc(where)}</b> into your browser yourself instead of using a link.` : ""}</div></td></tr>`
      : `<tr><td style="padding:0 22px 20px;font-size:0;line-height:0">&nbsp;</td></tr>`) +
    "</table>";

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><title>${esc(b.name)}</title>` +
    `<link href="${FONT_CSS}" rel="stylesheet"><style>@import url('${FONT_CSS}');body{margin:0}a{color:inherit}@media only screen and (max-width:620px){.fg-card{border-radius:0!important;border-left:0!important;border-right:0!important}.fg-pad{padding-left:22px!important;padding-right:22px!important}}</style></head>` +
    `<body style="margin:0;padding:0;background:#f1f2ee;${F}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f2ee"><tr><td align="center" style="padding:28px 12px">` +
    `<table role="presentation" class="fg-card" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e3e5df;border-radius:16px;border-collapse:separate;overflow:hidden;box-shadow:0 4px 18px rgba(11,11,11,.06)">` +
    // stripe
    `<tr><td style="font-size:0;line-height:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td height="5" width="34%" bgcolor="#00a859" style="font-size:0;line-height:0">&nbsp;</td><td height="5" width="33%" bgcolor="#ffb400" style="font-size:0;line-height:0">&nbsp;</td><td height="5" width="33%" bgcolor="#ee3239" style="font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>` +
    // header: logo and what this message is
    `<tr><td class="fg-pad" style="padding:24px 36px 20px;border-bottom:1px solid #eef0ec"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="middle">${head}</td><td align="right" valign="middle"><span style="display:inline-block;font-size:10px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#5a6166;border:1px solid #e3e5df;border-radius:20px;padding:6px 11px;${F}">${esc(kindLabel)}</span></td></tr></table></td></tr>` +
    // the message
    `<tr><td class="fg-pad" style="padding:30px 36px 8px">` + blocks.map((bl) => bl.html).join("") + sign + `</td></tr>` +
    // the verified-message card
    `<tr><td class="fg-pad" style="padding:14px 36px 32px">` + genuine + `</td></tr>` +
    // footer
    `<tr><td class="fg-pad" style="padding:18px 36px 26px;background:#f7f8f6;border-top:1px solid #eceee9;font-size:12px;line-height:1.6;color:#6b7177;${F}">${esc(foot)}<br><span style="color:#8a9096">${esc(b.name)}${where ? ` &middot; ${esc(where)}` : ""}</span></td></tr>` +
    `</table></td></tr></table></body></html>`;
  const text =
    blocks.map((bl) => bl.text).join("\n\n") +
    `\n\n${b.signoff}\n${b.team}${b.contact ? "\n" + plain(b.contact) : ""}` +
    `\n\n--\nA genuine message from the ${b.team}: sent by the ${b.name}${where ? ` (${where})` : ""} to ${o.to}${o.ref ? ` about ${o.ref}` : ""}.` +
    (b.trust ? "\n" + plain(b.trust) : "") +
    (verify ? `\nVerify this email: ${verify}` : "") +
    `\n${foot}`;
  return { html, text, logo, icons: true };
}

const first = (n: string) => n.split(" ")[0] || "there";
const baseVars = (x: Ctx, name: string, extra: Record<string, string> = {}): Record<string, string> => ({ name: first(name), fullname: name, team: x.t.brand.team, helpdesk: x.t.brand.name, ref: "", title: "", agent: "IT", status: "", count: "", ...extra });
const hello = (x: Ctx, v: Record<string, string>) => tpara(fill(x.t.brand.greeting, v), ed(x, "brand.greeting"));
const LABEL: Record<string, string> = { open: "Open", in_progress: "In progress", waiting: "Waiting for your reply", resolved: "Resolved", closed: "Closed" };
const ticketUrl = (x: Ctx, role: string, id: number) => (x.appUrl ? `${x.appUrl}${role === "admin" ? "/admin" : role === "agent" ? "/agent" : "/"}?t=${id}` : "");

export interface Pending {
  id: number; ticket_id: number; field: string; new_value: string | null; ref: string; title: string; source: string;
  to_email: string; to_name: string; new_assignee: string | null; actor: string | null; reply: string | null;
}
export interface StaffRow { id: number; user_id: number; kind: string; title: string; body: string; ticket_id: number | null; ref: string | null; email: string; name: string; role: string }

const FOOT_REQ = "You get these emails because of a ticket you raised. You can switch them off under Your account in the helpdesk.";

export function composeRequester(e: Pending, x: Ctx): Mail {
  const T = x.t.kinds;
  const v = baseVars(x, e.to_name, { ref: e.ref, title: e.title, agent: e.actor ?? "IT", status: LABEL[e.new_value ?? ""] ?? e.new_value ?? "updated" });
  const blocks: Block[] = [hello(x, v)];
  let k: Kind = "assigned";
  let btn = "";
  if (e.field === "reply") {
    k = "reply";
    btn = T.reply.button!;
    blocks.push(tpara(fill(T.reply.intro!, v), ed(x, "kinds.reply.intro")), quote(e.reply || "Sent an attachment."));
    const n = fill(x.repliesBack ? T.reply.note! : T.reply.note2!, v);
    if (n) blocks.push(tpara(n, ed(x, x.repliesBack ? "kinds.reply.note" : "kinds.reply.note2")));
  } else if (e.field === "created") {
    k = "created";
    btn = T.created.button!;
    blocks.push(tpara(fill(e.source === "email" ? T.created.intro2! + (x.repliesBack && T.created.note ? " " + T.created.note : "") : T.created.intro!, v), ed(x, e.source === "email" ? "kinds.created.intro2" : "kinds.created.intro")));
  } else if (e.field === "status") {
    k = "status";
    btn = T.status.button!;
    blocks.push(tpara(fill(T.status.intro!, v), ed(x, "kinds.status.intro")));
    if (e.new_value === "resolved" && T.status.note) blocks.push(tpara(fill(T.status.note, v), ed(x, "kinds.status.note")));
  } else {
    btn = T.assigned.button!;
    blocks.push(tpara(fill(e.new_assignee ? T.assigned.intro! : T.assigned.intro2!, { ...v, agent: e.new_assignee ?? v.agent! }), ed(x, e.new_assignee ? "kinds.assigned.intro" : "kinds.assigned.intro2")));
  }
  blocks.push(ticketLine(e.ref, e.title));
  const url = ticketUrl(x, "requester", e.ticket_id);
  if (url) blocks.push(button(btn, url, ed(x, `kinds.${k}.button`)));
  const s = shell(x, blocks, FOOT_REQ, { to: e.to_email, kind: k, ref: e.ref });
  return { to: e.to_email, subject: fill(T[k].subject!, v), html: s.html, text: s.text, logo: s.logo, icons: s.icons };
}

/** Several unseen updates on one ticket in one email: what changed, and only the latest few messages (never the whole conversation). */
export function composeRequesterGroup(events: Pending[], x: Ctx): Mail {
  if (events.length === 1) return composeRequester(events[0]!, x);
  const T = x.t.kinds;
  const e0 = events[0]!;
  const v = baseVars(x, e0.to_name, { ref: e0.ref, title: e0.title });
  const blocks: Block[] = [hello(x, v), tpara(fill(T.digest.intro!, v), ed(x, "kinds.digest.intro"))];
  const lastStatus = [...events].reverse().find((e) => e.field === "status");
  const lastAssign = [...events].reverse().find((e) => e.field === "assignee" && e.new_assignee);
  if (lastStatus) blocks.push(tpara(fill(T.status.intro!, { ...v, status: LABEL[lastStatus.new_value ?? ""] ?? lastStatus.new_value ?? "updated" }), ed(x, "kinds.status.intro")));
  if (lastAssign) blocks.push(tpara(fill(T.assigned.intro!, { ...v, agent: lastAssign.new_assignee! }), ed(x, "kinds.assigned.intro")));
  const replies = events.filter((e) => e.field === "reply");
  for (const r of replies.slice(-3)) {
    const text = r.reply || "Sent an attachment.";
    blocks.push(tpara(fill(T.reply.intro!, { ...v, agent: r.actor ?? "IT" }), ed(x, "kinds.reply.intro")), quote(text.length > 500 ? text.slice(0, 500).trimEnd() + "…" : text));
  }
  if (replies.length > 3) blocks.push(tpara(`…and ${replies.length - 3} earlier message${replies.length - 3 === 1 ? "" : "s"} in the conversation.`));
  if (replies.length) { const n = fill(x.repliesBack ? T.reply.note! : T.reply.note2!, v); if (n) blocks.push(tpara(n, ed(x, x.repliesBack ? "kinds.reply.note" : "kinds.reply.note2"))); }
  blocks.push(ticketLine(e0.ref, e0.title));
  const url = ticketUrl(x, "requester", e0.ticket_id);
  if (url) blocks.push(button(replies.length ? T.reply.button! : T.digest.button!, url, ed(x, replies.length ? "kinds.reply.button" : "kinds.digest.button")));
  const s = shell(x, blocks, "You get this email because you have not opened the ticket in the helpdesk yet. You can switch these emails off under Your account.", { to: e0.to_email, kind: "digest", ref: e0.ref });
  return { to: e0.to_email, subject: fill(T.digest.subject!, v), html: s.html, text: s.text, logo: s.logo, icons: s.icons };
}

/** One email per person per round: a single update reads like the bell, several become a short list. */
export function composeStaff(rows: StaffRow[], x: Ctx): Mail {
  const T = x.t.kinds.staff;
  const r0 = rows[0]!;
  const v = baseVars(x, r0.name, { count: String(rows.length) });
  const blocks: Block[] = [hello(x, v)];
  if (rows.length === 1) {
    blocks.push({ html: `<p style="${P}"><b>${esc(r0.title)}</b></p>`, text: r0.title }, { html: `<p style="${P}">${esc(r0.body)}</p>`, text: r0.body });
  } else {
    blocks.push(tpara(fill(T.intro!, v), ed(x, "kinds.staff.intro")));
    for (const r of rows.slice(0, 12)) blocks.push({ html: `<p style="margin:0 0 10px;font-size:14px;line-height:1.5"><b>${esc(r.title)}</b><br><span style="color:#4a4a45">${esc(r.body)}</span></p>`, text: `- ${r.title}${r.body ? ": " + r.body : ""}` });
    if (rows.length > 12) blocks.push(tpara(`…and ${rows.length - 12} more.`));
  }
  const only = rows.length === 1 && r0.ticket_id ? ticketUrl(x, r0.role, r0.ticket_id) : "";
  const home = x.appUrl ? `${x.appUrl}${r0.role === "admin" ? "/admin" : "/agent"}` : "";
  if (only) blocks.push(button(T.button!, only, ed(x, "kinds.staff.button")));
  else if (home) blocks.push(button(rows.length === 1 ? T.button! : T.button2!, home, ed(x, rows.length === 1 ? "kinds.staff.button" : "kinds.staff.button2")));
  const s = shell(x, blocks, "You are emailed only about things you have not already seen in the helpdesk. You can switch these emails off under Account.", { to: r0.email, kind: "staff", ref: rows.length === 1 ? r0.ref ?? undefined : undefined });
  return { to: r0.email, subject: rows.length === 1 ? r0.title : fill(T.subject!, v), html: s.html, text: s.text, logo: s.logo, icons: s.icons };
}

/** The one-time welcome for someone who has just created their account. */
export function composeWelcome(u: { name: string; email: string }, x: Ctx): Mail {
  const T = x.t.kinds.welcome;
  const v = baseVars(x, u.name);
  const blocks: Block[] = [hello(x, v), tpara(fill(T.intro!, v), ed(x, "kinds.welcome.intro")), tpara("Here is how it works:")];
  const steps: Block[] = [];
  for (const [i, line] of T.steps!.split("\n").filter(Boolean).entries()) {
    const [lead, ...rest] = line.split("|");
    steps.push(step(fill(lead!.trim(), v), fill(rest.join("|").trim(), v), i + 1));
  }
  blocks.push({ html: `<div${ed(x, "kinds.welcome.steps")}>${steps.map((b) => b.html).join("")}</div>`, text: steps.map((b) => b.text).join("\n\n") });
  if (x.appUrl) blocks.push(button(T.button!, x.appUrl, ed(x, "kinds.welcome.button")));
  const s = shell(x, blocks, "You are receiving this one-time message because an account was created for you on the helpdesk. You can switch off ticket emails under Your account.", { to: u.email, kind: "welcome" });
  return { to: u.email, subject: fill(T.subject!, v), html: s.html, text: s.text, logo: s.logo, icons: s.icons };
}

/* ---------- the monthly report ---------- */
export interface ReportMailData {
  label: string; partial: boolean;
  kpis: { created: number; resolved: number; closed: number; open_end: number; old_open_end: number; median_first_response_h: number | null; median_resolution_h: number | null; sla_pct: number | null; sla_measured: number; csat_pct: number | null; rated: number };
  prev_created: number | null;
  categories: { name: string; n: number; share: number; avg_resolution_h: number | null }[];
  priorities: { name: string; n: number; avg_resolution_h: number | null; sla_pct: number | null }[];
  summary: string;
}
const dur = (h: number | null) => (h == null ? "–" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 2.4) / 10} days`);
const change = (now: number, prev: number | null) => (prev == null || (prev === 0 && now === 0) ? "" : prev === 0 ? "new" : `${now >= prev ? "up" : "down"} ${Math.abs(Math.round(((now - prev) / prev) * 100))}% on last month`);

/** The report as a few totals and two small tables: nothing about individual tickets or people, so it is safe to send to anyone. */
export function composeReport(to: { name: string; email: string }, d: ReportMailData, x: Ctx): Mail {
  const T = x.t.kinds.report!;
  const month = d.label + (d.partial ? " (so far)" : "");
  const v = baseVars(x, to.name || "there", { month });
  const k = d.kpis;
  const cards: [string, string, string][] = [
    ["Tickets raised", String(k.created), change(k.created, d.prev_created)],
    ["Resolved", String(k.resolved), `${k.closed} closed`],
    ["First reply (typical)", dur(k.median_first_response_h), ""],
    ["Time to fix (typical)", dur(k.median_resolution_h), ""],
    ["Met their target time", k.sla_pct == null ? "–" : `${k.sla_pct}%`, k.sla_measured ? `of ${k.sla_measured} finished` : ""],
    ["Said it was fixed", k.csat_pct == null ? "–" : `${k.csat_pct}%`, k.rated ? `of ${k.rated} answer${k.rated === 1 ? "" : "s"}` : "no answers yet"],
  ];
  const cell = (c: [string, string, string]) =>
    `<td width="50%" valign="top" style="padding:0 6px 12px 0"><div style="border:1px solid #e3e3dc;border-left:4px solid #00a859;border-radius:8px;padding:10px 12px"><div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b6b66">${esc(c[0])}</div><div style="font-size:24px;font-weight:800;line-height:1.2;margin-top:2px">${esc(c[1])}</div><div style="font-size:12px;color:#4a4a45;min-height:15px">${esc(c[2])}</div></div></td>`;
  const grid: Block = {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 6px">${[0, 2, 4].map((i) => `<tr>${cell(cards[i]!)}${cell(cards[i + 1]!)}</tr>`).join("")}</table>`,
    text: cards.map((c) => `${c[0]}: ${c[1]}${c[2] ? ` (${c[2]})` : ""}`).join("\n"),
  };
  const open: Block = tpara(`Still open at the end of ${d.partial ? "the period" : "the month"}: **${k.open_end}**${k.old_open_end ? `, of which ${k.old_open_end} older than a week` : ""}.`);
  const th = "padding:6px 8px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#6b6b66;text-align:left;border-bottom:2px solid #e3e3dc";
  const td = "padding:7px 8px;font-size:14px;border-bottom:1px solid #eeeee8";
  const table = (title: string, head: string[], rows: string[][]): Block => ({
    html: `<p style="margin:14px 0 6px;font-size:15px;font-weight:700">${esc(title)}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 14px"><tr>${head.map((h, i) => `<th style="${th}${i ? ";text-align:right" : ""}">${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td style="${td}${i ? ";text-align:right" : ";font-weight:600"}">${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`,
    text: `${title}\n` + rows.map((r) => "- " + r.join(" | ")).join("\n"),
  });
  const cats = d.categories.slice(0, 5);
  const pris = d.priorities.filter((p) => p.n);
  const blocks: Block[] = [hello(x, v), tpara(fill(T.intro!, v), ed(x, "kinds.report.intro")), ...(d.summary ? [tpara(d.summary)] : []), grid, open];
  if (cats.length) blocks.push(table("Busiest categories", ["Category", "Tickets", "Share", "Typical fix"], cats.map((c) => [c.name, String(c.n), `${c.share}%`, dur(c.avg_resolution_h)])));
  if (pris.length) blocks.push(table("By priority", ["Priority", "Tickets", "Typical fix", "Met target"], pris.map((p) => [p.name[0]!.toUpperCase() + p.name.slice(1), String(p.n), dur(p.avg_resolution_h), p.sla_pct == null ? "–" : `${p.sla_pct}%`])));
  if (x.appUrl) blocks.push(button(T.button!, `${x.appUrl}/admin`, ed(x, "kinds.report.button")));
  const s = shell(x, blocks, "You get this once a month because an admin chose you under System > Report email. Totals only: no ticket titles and no names.", { to: to.email, kind: "report" });
  return { to: to.email, subject: fill(T.subject!, v), html: s.html, text: s.text, logo: s.logo, icons: s.icons };
}

/** The test email from System > Email: the same wrapper, so the admin sees the real look (logo, signature, genuine-message block). */
export function composeTest(to: string, x: Ctx): Mail {
  const v = baseVars(x, "there");
  const blocks: Block[] = [tpara("This is a test email from your helpdesk."), tpara("If you can read this, ticket emails will reach people. The real ones look like this, with the ticket and a button to open it."), ticketLine("FG-0000", "A sample ticket"), ...(x.appUrl ? [button("Open the helpdesk", x.appUrl)] : [])];
  void v;
  const s = shell(x, blocks, "Sent from Admin > System.", { to, kind: "test" });
  return { to, subject: `Test email from the ${x.t.brand.name}`, html: s.html, text: s.text, logo: s.logo, icons: s.icons };
}

/* ---------- samples for the live preview and "send me a test" ---------- */
export function sampleMail(kind: Kind, x: Ctx, to = "kofi.mensah@example.com"): Mail {
  const base: Pending = { id: 1, ticket_id: 42, field: "reply", new_value: "1", ref: "FG-0042", title: "Printer on floor 2 is offline", source: "web", to_email: to, to_name: "Kofi Mensah", new_assignee: null, actor: "Esi Mensah", reply: "Hi Kofi, I have restarted the print server. Could you try printing again and tell me if it still shows offline?" };
  switch (kind) {
    case "created": return composeRequester({ ...base, field: "created" }, x);
    case "reply": return composeRequester(base, x);
    case "status": return composeRequester({ ...base, field: "status", new_value: "resolved" }, x);
    case "assigned": return composeRequester({ ...base, field: "assignee", new_assignee: "Esi Mensah" }, x);
    case "digest": return composeRequesterGroup([{ ...base, field: "assignee", new_assignee: "Esi Mensah" }, { ...base, field: "reply", id: 2 }, { ...base, field: "status", new_value: "waiting", id: 3 }], x);
    case "welcome": return composeWelcome({ name: "Kofi Mensah", email: to }, x);
    case "report": return composeReport({ name: "Kofi Mensah", email: to }, {
      label: "October 2026", partial: false,
      kpis: { created: 64, resolved: 58, closed: 51, open_end: 9, old_open_end: 2, median_first_response_h: 0.6, median_resolution_h: 5.5, sla_pct: 92.3, sla_measured: 52, csat_pct: 88.9, rated: 18 },
      prev_created: 52,
      categories: [{ name: "Printing", n: 19, share: 29.7, avg_resolution_h: 3.2 }, { name: "Network", n: 14, share: 21.9, avg_resolution_h: 6.8 }, { name: "Accounts & Access", n: 11, share: 17.2, avg_resolution_h: 1.4 }, { name: "Hardware", n: 9, share: 14.1, avg_resolution_h: 22 }, { name: "Software", n: 6, share: 9.4, avg_resolution_h: 4.1 }],
      priorities: [{ name: "urgent", n: 4, avg_resolution_h: 1.9, sla_pct: 100 }, { name: "high", n: 12, avg_resolution_h: 3.6, sla_pct: 91.7 }, { name: "medium", n: 40, avg_resolution_h: 6.1, sla_pct: 92.5 }, { name: "low", n: 8, avg_resolution_h: 26, sla_pct: 87.5 }],
      summary: "In October 2026 the helpdesk received 64 tickets (up 23% on the month before), resolved 58 and closed 51. Printing was the busiest category with 19 tickets (29.7%).",
    }, x);
    case "staff": return composeStaff([
      { id: 1, user_id: 1, kind: "new_ticket", title: "New ticket FG-0043", body: "Wi-Fi keeps dropping in the boardroom · from Ama Boateng", ticket_id: 43, ref: "FG-0043", email: to, name: "Esi Mensah", role: "agent" },
      { id: 2, user_id: 1, kind: "message", title: "Kofi Mensah on FG-0042", body: "Still offline, sorry.", ticket_id: 42, ref: "FG-0042", email: to, name: "Esi Mensah", role: "agent" },
    ], x);
  }
}
