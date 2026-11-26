import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv } from "./auth";
import { audit } from "./audit";
import { config, sessionSecret } from "./config";
import { DEFAULT_LOGO_PNG_B64 } from "./emailLogo";
import { LOCK_PNG_B64, SHIELD_PNG_B64 } from "./emailIcons";
import { BRAND_FIELDS, DEFAULT_BRAND, DEFAULT_KINDS, KINDS, diff, merge, sampleMail, validate, type Ctx, type Kind, type Mail, type Templates } from "./mailrender";
import { getSetting, putSetting } from "./sla";

/* The emails' wording and look, editable by an admin (Admin > System > Email templates). What is stored is only what differs from the defaults in
   mailrender.ts, in settings.email_templates. The logo that goes at the top of every email is the helpdesk's own, or a PNG an admin uploaded. */

let tpl: Templates = merge({});
export async function loadTemplates() {
  try { tpl = merge(JSON.parse((await getSetting("email_templates")) ?? "null")); } catch { tpl = merge({}); }
}

/** What the renderers need, from the live settings. */
export const mailCtx = (): Ctx => ({
  t: tpl,
  appUrl: config.appUrl,
  repliesBack: !!(config.inbound.secret || (config.inbound.mailbox && config.mail.graph.tenantId)),
  secret: sessionSecret(),
});

const LOGO_FILE = path.join(config.dataDir, "email-logo.png");
export const hasCustomLogo = () => existsSync(LOGO_FILE);
export function logoBytes(): Buffer {
  try { if (existsSync(LOGO_FILE)) return readFileSync(LOGO_FILE); } catch { /* fall back to the built-in one */ }
  return Buffer.from(DEFAULT_LOGO_PNG_B64, "base64");
}

/** The notifier registers how to send one email now (the transport lives there). */
let send: (m: Mail) => Promise<string> = async () => { throw new Error("Email is not set up."); };
export const setMailSender = (fn: (m: Mail) => Promise<string>) => { send = fn; };

/** The preview sits in a sandboxed frame that cannot fetch cid: pictures, so it gets them as data: addresses. */
export const previewImages = () => ({
  previewLogo: "data:image/png;base64," + logoBytes().toString("base64"),
  previewIcons: { shield: "data:image/png;base64," + SHIELD_PNG_B64, lock: "data:image/png;base64," + LOCK_PNG_B64 },
});

const isKind = (k: unknown): k is Kind => KINDS.some((x) => x.id === k);

/** Admin only (mounted at /api/admin/email-templates). */
export const emailTemplates = new Hono<AppEnv>();

emailTemplates.get("/", (c) =>
  c.json({
    templates: tpl,
    defaults: { brand: DEFAULT_BRAND, kinds: DEFAULT_KINDS },
    kinds: KINDS,
    brand_fields: BRAND_FIELDS,
    custom_logo: hasCustomLogo(),
    app_url_set: !!config.appUrl,
    customised: (() => { const d = diff(tpl); return Object.keys(d.brand).length + Object.values(d.kinds).reduce((n, k) => n + Object.keys(k ?? {}).length, 0); })(),
  }),
);

// The whole set of templates as the page has it (it is checked, cleaned and compared with the defaults).
emailTemplates.put("/", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const r = validate(b);
  if (!r.ok) return c.json({ error: r.error }, 400);
  tpl = r.t;
  await putSetting("email_templates", JSON.stringify(diff(r.t)));
  const d = diff(r.t);
  const changed = [...(Object.keys(d.brand).length ? ["branding"] : []), ...Object.keys(d.kinds)];
  await audit(c, "system.settings", "admin", `Email templates saved (${changed.length ? "changed: " + changed.join(", ") : "all back to the defaults"})`);
  return c.json({ ok: true, templates: tpl });
});

// { kind, templates? }: what the email would look like (with the draft the admin is typing, if sent). Problems come back as { error }, not as a failure.
emailTemplates.post("/preview", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (!isKind(b.kind)) return c.json({ error: "Choose an email." }, 400);
  let t = tpl;
  if (b.templates) {
    const r = validate(b.templates);
    if (!r.ok) return c.json({ error: r.error });
    t = r.t;
  }
  const m = sampleMail(b.kind, { ...mailCtx(), t, preview: true, ...previewImages() });
  return c.json({ subject: m.subject, html: m.html });
});

// { kind, templates? }: sends the sample to the admin's own address through the real transport.
emailTemplates.post("/test", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (!isKind(b.kind)) return c.json({ error: "Choose an email." }, 400);
  let t = tpl;
  if (b.templates) {
    const r = validate(b.templates);
    if (!r.ok) return c.json({ error: r.error }, 400);
    t = r.t;
  }
  const to = c.get("user").email;
  try {
    const via = await send(sampleMail(b.kind, { ...mailCtx(), t }, to));
    await audit(c, "system.test_email", "admin", `Sent a sample "${KINDS.find((k) => k.id === b.kind)!.label}" email to ${to} (${via})`);
    return c.json({ ok: true, via, to });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ---- the logo ----
emailTemplates.get("/logo", (c) => c.body(new Uint8Array(logoBytes()), 200, { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }));

const MAX_LOGO = 300 * 1024;
emailTemplates.put("/logo", bodyLimit({ maxSize: MAX_LOGO + 64 * 1024, onError: (c) => c.json({ error: "That logo is too big (the limit is 300 KB)." }, 413, { Connection: "close" }) }), async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.file;
  if (!file || typeof file === "string" || file.size === 0) return c.json({ error: "Choose a PNG file." }, 400);
  if (file.size > MAX_LOGO) return c.json({ error: "That logo is too big (the limit is 300 KB)." }, 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return c.json({ error: "The logo must be a PNG picture (mail programs do not show SVG)." }, 415);
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (w < 100 || h < 20 || w / h > 8 || h / w > 3) return c.json({ error: "That picture is too small or an odd shape for a logo. Use one at least 100 pixels wide, roughly as wide as it is tall or wider." }, 422);
  writeFileSync(LOGO_FILE, bytes);
  await audit(c, "system.settings", "admin", `Email logo replaced (${w}×${h})`);
  return c.json({ ok: true, width: w, height: h });
});

emailTemplates.delete("/logo", async (c) => {
  rmSync(LOGO_FILE, { force: true });
  await audit(c, "system.settings", "admin", "Email logo set back to the helpdesk's own");
  return c.json({ ok: true });
});
