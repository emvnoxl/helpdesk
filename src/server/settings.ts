import { Hono } from "hono";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type AppEnv } from "./auth";
import { audit } from "./audit";
import { config, sessionSecret, ssoEnforced, ssoReady } from "./config";
import { forgetGraphToken } from "./notifier";
import { getSetting, putSetting } from "./sla";

/* Setup that used to need .env edits and a restart, now editable by an admin under Admin > System: the helpdesk's address
   (APP_URL, ALT_URLS, TRUST_PROXY) and how email is sent (off, trial log, SMTP or Microsoft Graph).
   What an admin saves is kept in the database (settings.app_settings) and OVERRIDES the same setting in .env, immediately.
   The SMTP password and the Graph client secret are encrypted at rest (AES-256-GCM, key derived from the session secret) and are
   NEVER sent back to the browser: the page only learns that one is set, and a blank field on save means "keep it". */

type Mode = "off" | "log" | "smtp" | "graph";
interface Stored {
  appUrl?: string;
  altUrls?: string[];
  trustProxy?: boolean;
  sso?: { useMailApp: boolean; tenantId: string; clientId: string; clientSecret: string; enforced: boolean };
  mail?: {
    mode: Mode;
    from: string;
    smtp: { host: string; port: number; secure: boolean; user: string; pass: string };
    graph: { tenantId: string; clientId: string; clientSecret: string; sender: string };
  };
}

const KEY = createHash("sha256").update("fortress-helpdesk-settings:" + sessionSecret()).digest();
const seal = (plain: string): string => {
  if (!plain) return "";
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "enc1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
};
/** "" when it can't be read (the session secret changed): the admin is asked to enter it again. */
const unseal = (s: string): string => {
  if (!s.startsWith("enc1:")) return "";
  try {
    const b = Buffer.from(s.slice(5), "base64");
    const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return "";
  }
};

// What .env said, before anything saved here is applied (for "from .env" labels).
const ENV0 = { appUrl: config.appUrl, altUrls: [...config.altUrls], trustProxy: config.trustProxy, mail: JSON.parse(JSON.stringify(config.mail)) as typeof config.mail, sso: { ...config.sso } };
const cookieFromEnv = process.env.COOKIE_SECURE !== undefined;

async function read(): Promise<Stored> {
  try { return (JSON.parse((await getSetting("app_settings")) ?? "{}") as Stored) ?? {}; } catch { return {}; }
}

/** Puts what is saved on top of what .env gave us. Called at start-up and after every save. */
export async function applyStoredSettings() {
  const s = await read();
  config.appUrl = s.appUrl !== undefined ? s.appUrl : ENV0.appUrl;
  config.altUrls = s.altUrls ?? [...ENV0.altUrls];
  config.trustProxy = s.trustProxy ?? ENV0.trustProxy;
  if (!cookieFromEnv) config.secureCookies = config.appUrl.startsWith("https://");
  if (s.mail) {
    const m = s.mail;
    config.mail.from = m.from;
    config.mail.logOnly = m.mode === "log";
    const smtp = m.mode === "smtp" ? m.smtp : { host: "", port: 587, secure: false, user: "", pass: "" };
    config.mail.smtp.host = smtp.host;
    config.mail.smtp.port = smtp.port;
    config.mail.smtp.secure = smtp.secure;
    config.mail.smtp.user = smtp.user;
    config.mail.smtp.pass = m.mode === "smtp" ? unseal(smtp.pass) : "";
    const g = m.mode === "graph" ? m.graph : { tenantId: "", clientId: "", clientSecret: "", sender: "" };
    config.mail.graph.tenantId = g.tenantId;
    config.mail.graph.clientId = g.clientId;
    config.mail.graph.clientSecret = m.mode === "graph" ? unseal(g.clientSecret) : "";
    config.mail.graph.sender = g.sender;
  } else {
    Object.assign(config.mail, { from: ENV0.mail.from, logOnly: ENV0.mail.logOnly });
    Object.assign(config.mail.smtp, ENV0.mail.smtp);
    Object.assign(config.mail.graph, ENV0.mail.graph);
  }
  // Microsoft sign-in (after the mail section, because it can reuse the email app registration)
  if (s.sso) {
    const x = s.sso;
    config.sso.tenantId = x.useMailApp ? config.mail.graph.tenantId : x.tenantId;
    config.sso.clientId = x.useMailApp ? config.mail.graph.clientId : x.clientId;
    config.sso.clientSecret = x.useMailApp ? config.mail.graph.clientSecret : unseal(x.clientSecret);
    config.sso.enforced = x.enforced;
  } else {
    Object.assign(config.sso, ENV0.sso);
  }
  forgetGraphToken();
}

const effectiveMode = (): Mode =>
  config.mail.logOnly ? "log" : config.mail.graph.tenantId && config.mail.graph.clientId ? "graph" : config.mail.smtp.host ? "smtp" : "off";

async function view() {
  const s = await read();
  const verifiedAt = Number(await getSetting("sso_verified_at")) || 0;
  const m = config.mail;
  return {
    address: { app_url: config.appUrl, alt_urls: config.altUrls, trust_proxy: config.trustProxy, source: s.appUrl !== undefined || s.altUrls || s.trustProxy !== undefined ? "saved" : "env", cookies_secure: config.secureCookies },
    sso: {
      configured: ssoReady(),
      enforced: ssoEnforced(),
      use_mail_app: !!s.sso?.useMailApp,
      tenant_id: config.sso.tenantId,
      client_id: config.sso.clientId,
      has_secret: !!config.sso.clientSecret,
      verified_at: verifiedAt || null,
      source: s.sso ? "saved" : "env",
    },
    mail: {
      mode: effectiveMode(),
      from: m.from,
      smtp: { host: m.smtp.host, port: m.smtp.port, secure: m.smtp.secure, user: m.smtp.user, has_pass: !!m.smtp.pass },
      graph: { tenant_id: m.graph.tenantId, client_id: m.graph.clientId, has_secret: !!m.graph.clientSecret, sender: m.graph.sender },
      source: s.mail ? "saved" : "env",
    },
  };
}

const URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const GUID_RE = /^[0-9a-fA-F-]{36}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const cleanUrl = (v: unknown) => str(v).replace(/\/+$/, "");

export const settingsRoutes = new Hono<AppEnv>();

settingsRoutes.get("/", async (c) => c.json(await view()));

// { address?: { app_url, alt_urls: string[] | string, trust_proxy }, mail?: { mode, from, smtp: {...}, graph: {...} } }
settingsRoutes.put("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const stored = await read();
  const notes: string[] = [];

  if (body.address && typeof body.address === "object") {
    const a = body.address;
    const appUrl = cleanUrl(a.app_url);
    if (appUrl && !URL_RE.test(appUrl)) return c.json({ error: "The address should look like https://helpdesk.yourcompany.com (no path, no spaces)." }, 400);
    const altRaw: unknown[] = Array.isArray(a.alt_urls) ? a.alt_urls : typeof a.alt_urls === "string" ? a.alt_urls.split(/[,\s]+/) : [];
    const alt: string[] = [...new Set(altRaw.map((u) => cleanUrl(u)).filter(Boolean))].slice(0, 8);
    if (alt.some((u) => !URL_RE.test(u))) return c.json({ error: "Every other address should look like http://192.168.1.20:3000 or https://helpdesk.yourcompany.com." }, 400);
    const proxy = a.trust_proxy === true;
    // Saving an https address while you are on plain http would switch on Secure cookies, and you could no longer sign in over http.
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
    const onHttps = proto === "https" && (proxy || config.trustProxy || new URL(c.req.url).protocol === "https:");
    if (appUrl.startsWith("https://") && !onHttps) return c.json({ error: "You are using the helpdesk over plain http right now. Open it through that https address first (and turn on the reverse-proxy box if a proxy provides the https), then save it here. Otherwise you would be signed out and could not get back in." }, 400);
    stored.appUrl = appUrl;
    stored.altUrls = alt;
    stored.trustProxy = proxy;
    notes.push(`Address set to ${appUrl || "(none)"}${alt.length ? ` with ${alt.length} other` : ""}${proxy ? ", behind a reverse proxy" : ""}`);
  }

  if (body.mail && typeof body.mail === "object") {
    const m = body.mail;
    const mode = m.mode as Mode;
    if (!["off", "log", "smtp", "graph"].includes(mode)) return c.json({ error: "Choose how email is sent." }, 400);
    const from = str(m.from);
    if (from && !EMAIL_RE.test(from)) return c.json({ error: "The From address should look like helpdesk@yourcompany.com." }, 400);
    // Start from what is in force now, so a blank password means "keep the one we have" (even one that came from .env).
    const cur = config.mail;
    const prev = stored.mail;
    const smtp = { host: str(m.smtp?.host, 253), port: Number(m.smtp?.port) || 587, secure: m.smtp?.secure === true, user: str(m.smtp?.user), pass: typeof m.smtp?.pass === "string" && m.smtp.pass !== "" ? seal(m.smtp.pass.slice(0, 300)) : prev?.smtp.pass ?? seal(cur.smtp.pass) };
    const graph = { tenantId: str(m.graph?.tenant_id), clientId: str(m.graph?.client_id), clientSecret: typeof m.graph?.client_secret === "string" && m.graph.client_secret !== "" ? seal(m.graph.client_secret.slice(0, 300)) : prev?.graph.clientSecret ?? seal(cur.graph.clientSecret), sender: str(m.graph?.sender) };
    if (mode === "smtp") {
      if (!HOST_RE.test(smtp.host)) return c.json({ error: "Enter the mail server's name, for example smtp.office365.com." }, 400);
      if (!Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535) return c.json({ error: "The port should be a number such as 587 or 465." }, 400);
      if (!from && !smtp.user) return c.json({ error: "Enter the address emails come from." }, 400);
      if (smtp.user && !smtp.pass) return c.json({ error: "Enter the password for that username." }, 400);
    }
    if (mode === "graph") {
      if (!GUID_RE.test(graph.tenantId) || !GUID_RE.test(graph.clientId)) return c.json({ error: "The tenant ID and client ID are the long codes from the app registration in Microsoft Entra (like 0a1b2c3d-...)." }, 400);
      if (!graph.clientSecret) return c.json({ error: "Enter the client secret from the app registration." }, 400);
      if (!EMAIL_RE.test(graph.sender)) return c.json({ error: "Enter the mailbox emails are sent from, for example helpdesk@yourcompany.com." }, 400);
    }
    stored.mail = { mode, from, smtp, graph };
    notes.push(mode === "smtp" ? `Email set to SMTP (${smtp.host}:${smtp.port})` : mode === "graph" ? `Email set to Microsoft 365 (sending as ${graph.sender})` : mode === "log" ? "Email set to trial mode (printed to the log)" : "Email switched off");
  }

  if (body.sso && typeof body.sso === "object") {
    const x = body.sso;
    const useMail = x.use_mail_app === true;
    const prev = stored.sso;
    const tenant = useMail ? "" : str(x.tenant_id);
    const client = useMail ? "" : str(x.client_id);
    const secret = typeof x.client_secret === "string" && x.client_secret !== "" ? seal(x.client_secret.slice(0, 300)) : prev?.clientSecret ?? seal(config.sso.clientSecret);
    const enforced = x.enforced === true;
    const configuring = useMail || !!tenant || !!client;
    if (useMail && !(config.mail.graph.tenantId && config.mail.graph.clientId && config.mail.graph.clientSecret)) return c.json({ error: "Email is not set up with Microsoft 365 yet, so there is no app registration to reuse. Enter the IDs and secret here instead." }, 400);
    if (configuring && !useMail) {
      if (!GUID_RE.test(tenant) || !GUID_RE.test(client)) return c.json({ error: "The tenant ID and client ID are the long codes from the app registration in Microsoft Entra (like 0a1b2c3d-...)." }, 400);
      if (!secret) return c.json({ error: "Enter the client secret from the app registration." }, 400);
    }
    const next = configuring
      ? { tenantId: useMail ? config.mail.graph.tenantId : tenant, clientId: useMail ? config.mail.graph.clientId : client, secret: useMail ? config.mail.graph.clientSecret : unseal(secret) }
      : { tenantId: "", clientId: "", secret: "" };
    // New or changed credentials are untested: an admin has to get in with them (Test sign-in) before the old sign-ins can be switched off.
    const credsChanged = next.tenantId !== config.sso.tenantId || next.clientId !== config.sso.clientId || next.secret !== config.sso.clientSecret;
    if (enforced) {
      if (!configuring) return c.json({ error: "Set up Microsoft sign-in first." }, 400);
      if (credsChanged || !(Number(await getSetting("sso_verified_at")) > 0)) return c.json({ error: "Press 'Test sign-in' and sign in with your own Microsoft account first. The PIN and password sign-ins can only be switched off once you have seen Microsoft sign-in work with these settings, otherwise you could lock everyone out." }, 400);
    }
    if (credsChanged) await putSetting("sso_verified_at", "");
    stored.sso = { useMailApp: useMail, tenantId: tenant, clientId: client, clientSecret: configuring && !useMail ? secret : "", enforced: configuring ? enforced : false };
    notes.push(!configuring ? "Microsoft sign-in switched off" : enforced ? "Microsoft 365 is now the only way to sign in (PINs and agent passwords are off)" : "Microsoft sign-in settings saved");
  }

  if (!notes.length) return c.json({ error: "Nothing to save." }, 400);
  await putSetting("app_settings", JSON.stringify(stored));
  await applyStoredSettings();
  for (const n of notes) await audit(c, "system.settings", "admin", n);
  return c.json(await view());
});
