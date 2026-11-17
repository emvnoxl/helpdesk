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
  },

  /** Calls: only needed when computers can't reach each other directly (separate VLANs or sites). A TURN relay such as coturn, on your own network. */
  turn: { url: (env.TURN_URL ?? "").trim(), username: env.TURN_USERNAME ?? "", password: env.TURN_PASSWORD ?? "" },

  /** Tickets by email (see inbound.ts). Off unless a mailbox (read through Microsoft Graph) or a webhook secret is set. */
  inbound: {
    mailbox: (env.INBOUND_MAILBOX ?? "").trim().toLowerCase(),
    secret: (env.INBOUND_SECRET ?? "").trim().length >= 16 ? (env.INBOUND_SECRET ?? "").trim() : "",
    intervalSeconds: Math.max(15, Number(env.INBOUND_INTERVAL_SECONDS) || 60),
  },
};

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
