import { Hono } from "hono";
import { compress } from "hono/compress";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { type AppEnv, requesterAuth, sameOrigin, staffAuth } from "./auth";
import { config } from "./config";
import { db } from "./db";
import { ensureAdmin, resetAdmin } from "./bootstrap";
import { identity } from "./identity";
import { publicConfig } from "./config-route";
import { board } from "./board";
import { tickets } from "./tickets";
import { notifications, pruneNotifications } from "./notifications";
import { stream } from "./bus";
import { devices } from "./devices";
import { pruneAudit } from "./audit";
import { staff } from "./staff";
import { admin } from "./admin";
import { startNotifier } from "./notifier";
import { pruneDrafts } from "./attachments";
import { kb, seedKb, seedKbPack } from "./kb";
import { replies, seedReplies } from "./replies";
import { startSla } from "./sla";
import { checklists, seedChecklists } from "./checklists";
import { startRecurring } from "./recurring";
import { inbound, startInbound } from "./inbound";
import { serveWeb } from "./static";
import { announceRestart, checkForUpdate } from "./system";
import { startBackups } from "./backup";
import { startUpdateChecks } from "./updates";
import { applyStoredSettings } from "./settings";
import { sso } from "./sso";
import { BUILD } from "./version";

// Command-line recovery: `node dist-server/index.js reset-admin <email>` (see bootstrap.ts), then exit without starting the server.
if (process.argv[2] === "reset-admin") {
  const done = await resetAdmin(process.argv[3] ?? "");
  db.close();
  process.exit(done ? 0 : 1);
}

const app = new Hono<AppEnv>();

app.use("*", compress());
const secure = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["https://www.youtube-nocookie.com"], // help-article videos (privacy-enhanced YouTube embeds) and nothing else
      imgSrc: ["'self'", "data:", "blob:"], // blob: = the thumbnail of a file chosen for upload, before it is sent
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "same-origin",
});
// Uploaded files carry their own, stricter policy (default-src 'none'; sandbox), which the site-wide one would overwrite.
app.use("*", (c, next) => (/\/attachments\/\d+$/.test(c.req.path) ? next() : secure(c, next)));
// Request log: only changes and problems, so polling doesn't flood `docker logs`.
app.use("/api/*", async (c, next) => {
  const t = Date.now();
  await next();
  if (c.req.method !== "GET" || c.res.status >= 400) console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t}ms`);
});
app.use("/api/*", sameOrigin);

app.get("/healthz", async (c) => {
  await db.prepare("SELECT 1").first();
  return c.json({ ok: true, version: BUILD.id });
});

app.route("/api", publicConfig); // GET /config (public)
app.route("/api/auth/microsoft", sso); // sign in with Microsoft 365: /start and /callback (browser navigations, no session needed)
app.route("/api/inbound", inbound); // POST /email: mail relays, authenticated by INBOUND_SECRET (404 when it is not set)

/* ---- normal users (name + company email) ---- */
app.route("/api", identity); // POST /identify, POST /signout, GET /me
app.use("/api/tickets/*", requesterAuth);
app.route("/api/tickets", tickets);
app.use("/api/stream", requesterAuth);
app.route("/api/stream", stream);
app.route("/api/devices", devices); // each route sets its own auth: the hardware script has no cookie, only a signed token
app.use("/api/kb/*", requesterAuth);
app.route("/api/kb", kb); // help articles for normal users (published only)
app.use("/api/notifications/*", requesterAuth);
app.route("/api/notifications", notifications);
app.use("/api/queue", requesterAuth);
app.use("/api/board", requesterAuth);
app.route("/api", board); // GET /queue, GET /board

/* ---- agents and admins (email + password) ---- */
app.route("/api/staff", staff); // login/logout are public, the rest needs a staff session
app.use("/api/staff/tickets/*", staffAuth());
app.route("/api/staff/tickets", tickets);
app.use("/api/staff/stream", staffAuth());
app.route("/api/staff/stream", stream);
app.use("/api/staff/kb/*", staffAuth());
app.route("/api/staff/kb", kb); // the same articles for staff, with write access
app.use("/api/staff/replies/*", staffAuth());
app.route("/api/staff/replies", replies);
app.use("/api/staff/checklists/*", staffAuth());
app.route("/api/staff/checklists", checklists);
app.use("/api/staff/notifications/*", staffAuth());
app.route("/api/staff/notifications", notifications);
app.route("/api/admin", admin); // admin only; looks non-existent to everyone else

app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : serveWeb(c)));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});
// Web app for everything that isn't the API; an unknown /api/... path is a JSON 404, never the web app.
app.get("*", async (c): Promise<Response> => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : serveWeb(c)));

await ensureAdmin();
await applyStoredSettings(); // address and email settings saved under Admin > System override .env
await seedKb();
await seedKbPack();
await seedReplies();
await seedChecklists();
await checkForUpdate();
const prune = () => { pruneNotifications(); pruneAudit(config.auditRetentionDays); void pruneDrafts().catch(() => {}); };
prune();
const pruneTimer = setInterval(prune, 6 * 3600_000);
pruneTimer.unref();
const stopNotifier = startNotifier();
const stopSla = startSla();
const stopRecurring = startRecurring();
const stopInbound = startInbound();
const stopBackups = startBackups();
const stopUpdateChecks = startUpdateChecks();
const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[server] Fortress Oil & Gas Helpdesk listening on http://localhost:${info.port}  (version ${BUILD.id}, data: ${config.dataDir})`);
  if (!config.companyDomain) console.warn("[server] COMPANY_EMAIL_DOMAIN is not set: normal users can use any email domain.");
});

function shutdown(signal: string) {
  console.log(`[server] ${signal} received, shutting down`);
  announceRestart(); // open screens say "being updated" and wait for the new version
  stopNotifier();
  stopSla();
  stopRecurring();
  stopInbound();
  stopBackups();
  stopUpdateChecks();
  // A moment for the notice to reach the browsers, then close (the live streams would otherwise hold the server open).
  setTimeout(() => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  }, 500);
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
