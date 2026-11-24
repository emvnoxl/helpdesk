import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/* All configuration comes from environment variables (see .env.example). Nothing here needs a cloud service. */

const env = process.env;
const flag = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").toLowerCase());
const appUrl = (env.APP_URL ?? "").trim().replace(/\/+$/, "");

export const config = {
  port: Number(env.PORT) || 3000,
  production: env.NODE_ENV === "production",
  dataDir: path.resolve(env.DATA_DIR || "./data"),

  /** Normal users must give an email on this domain (e.g. "fortressghana.com"). Empty = any domain is accepted. */
  companyDomain: (env.COMPANY_EMAIL_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, ""),

  /** First-run admin. Created only if no admin exists yet. If the password is empty a random one is generated and printed once. */
  adminEmail: (env.ADMIN_EMAIL ?? "").trim().toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD ?? "",

  appUrl,
  /** Other addresses the same helpdesk answers on (name and IP, old and new name), comma separated. The hardware-report script tries them if the first one fails. */
  altUrls: (env.ALT_URLS ?? "").split(",").map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean),
  /** Sign-in attempts allowed per client address per 10 minutes (staff login). Leave at the default; tests raise it. */
  loginRateLimit: Number(env.LOGIN_RATE_LIMIT) || 15,

  /** Largest file a person can attach to a ticket (megabytes). */
  maxUploadMb: Math.min(Math.max(Number(env.MAX_UPLOAD_MB) || 10, 1), 50),

  /** How long the activity log is kept (days). */
  auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS) || 365,

  /** Behind a reverse proxy (nginx, Traefik, Caddy...) set TRUST_PROXY=1 so client IPs and https are read from X-Forwarded-* headers. */
  trustProxy: flag(env.TRUST_PROXY),
  /** "Secure" cookies are on automatically when APP_URL is https; force with COOKIE_SECURE=1/0. */
  secureCookies: env.COOKIE_SECURE !== undefined ? flag(env.COOKIE_SECURE) : appUrl.startsWith("https://"),

  /** Nightly copy of the database (and the uploads folder). BACKUP_DIR can be a mounted NAS share; BACKUP_HOUR is UTC (= Ghana time). */
  backup: {
    enabled: env.BACKUP_ENABLED === undefined ? true : flag(env.BACKUP_ENABLED),
    dir: path.resolve(env.BACKUP_DIR || path.join(path.resolve(env.DATA_DIR || "./data"), "backups")),
    keep: Math.min(Math.max(Number(env.BACKUP_KEEP) || 14, 1), 365),
    hour: Math.min(Math.max(env.BACKUP_HOUR !== undefined && env.BACKUP_HOUR.trim() !== "" && Number.isFinite(Number(env.BACKUP_HOUR)) ? Math.floor(Number(env.BACKUP_HOUR)) : 2, 0), 23),
  },

  mail: {
    from: env.MAIL_FROM ?? "",
    smtp: {
      host: env.SMTP_HOST ?? "",
      port: Number(env.SMTP_PORT) || 587,
      secure: flag(env.SMTP_SECURE), // true = implicit TLS (port 465); false = STARTTLS when offered
      user: env.SMTP_USER ?? "",
      pass: env.SMTP_PASS ?? "",
    },
    graph: {
      tenantId: env.GRAPH_TENANT_ID ?? "",
      clientId: env.GRAPH_CLIENT_ID ?? "",
      clientSecret: env.GRAPH_CLIENT_SECRET ?? "",
      sender: env.GRAPH_SENDER ?? "",
    },
    /** "log" prints emails to the server log instead of sending them (handy for trying things out). */
    logOnly: flag(env.MAIL_LOG_ONLY),
    intervalSeconds: Number(env.NOTIFY_INTERVAL_SECONDS) || 30,
    /** IT staff are emailed about a bell notification only if they have not read it after this many seconds (so no email while they are at the helpdesk). */
    staffDelaySeconds: env.STAFF_EMAIL_DELAY_SECONDS !== undefined && env.STAFF_EMAIL_DELAY_SECONDS.trim() !== "" && Number.isFinite(Number(env.STAFF_EMAIL_DELAY_SECONDS)) ? Math.max(0, Number(env.STAFF_EMAIL_DELAY_SECONDS)) : 120,
  },

  /** Calls: only needed when computers can't reach each other directly (separate VLANs or sites). A TURN relay such as coturn, on your own network. */
  turn: { url: (env.TURN_URL ?? "").trim(), username: env.TURN_USERNAME ?? "", password: env.TURN_PASSWORD ?? "" },

  /** Sign in with Microsoft 365 (see sso.ts): an Entra app registration (tenant, client, secret). Also editable under Admin > System.
      `enforced` removes the PIN sign-in for normal users and the password sign-in for agents (admins keep a local password as a way back in).
      `authority` and `graphUrl` are only ever changed by the tests. */
  sso: {
    tenantId: (env.SSO_TENANT_ID ?? "").trim(),
    clientId: (env.SSO_CLIENT_ID ?? "").trim(),
    clientSecret: env.SSO_CLIENT_SECRET ?? "",
    enforced: flag(env.SSO_ENFORCED),
    authority: (env.SSO_AUTHORITY || "https://login.microsoftonline.com").trim().replace(/\/+$/, ""),
    graphUrl: (env.SSO_GRAPH_URL || "https://graph.microsoft.com/v1.0").trim().replace(/\/+$/, ""),
  },

  /** Tickets by email (see inbound.ts). Off unless a mailbox (read through Microsoft Graph) or a webhook secret is set. */
  inbound: {
    mailbox: (env.INBOUND_MAILBOX ?? "").trim().toLowerCase(),
    secret: (env.INBOUND_SECRET ?? "").trim().length >= 16 ? (env.INBOUND_SECRET ?? "").trim() : "",
    intervalSeconds: Math.max(15, Number(env.INBOUND_INTERVAL_SECONDS) || 60),
  },
};

/** Is Microsoft sign-in set up (credentials present)? Enforced = the old sign-ins are switched off. */
export const ssoReady = () => !!(config.sso.tenantId && config.sso.clientId && config.sso.clientSecret);
export const ssoEnforced = () => ssoReady() && config.sso.enforced;

mkdirSync(config.dataDir, { recursive: true });

/** Signing key for session cookies: SESSION_SECRET if set, otherwise generated once and kept in the data volume. */
export function sessionSecret(): string {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) return env.SESSION_SECRET;
  const file = path.join(config.dataDir, "session.secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const made = randomBytes(32).toString("hex");
  writeFileSync(file, made, { mode: 0o600 });
  return made;
}
