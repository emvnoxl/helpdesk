import { Hono } from "hono";
import { type AppEnv, staffAuth } from "./auth";
import { notifyUser } from "./notifications";
import { audit } from "./audit";
import { changed } from "./bus";
import { activity } from "./activity";
import { shapeDevice } from "./devices";
import { reports } from "./reports";
import { db } from "./db";
import { MIN_PASSWORD } from "./staff";
import { saveCalendar, saveSlaHours, slaHours, workCalendar } from "./sla";
import { recurring } from "./recurring";
import { dashboard } from "./dashboard";
import { system } from "./system";
import { gifAdmin } from "./gifs";
import { teams } from "./teams";
import { automation } from "./automation";
import { forms } from "./forms";
import { emailTemplates } from "./mailtemplates";
import { backups } from "./backup";
import { hashPassword, randomPassword } from "./security";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

/* Admin-only API (/api/admin). A signed-in agent gets a plain 404, exactly as if none of this existed. */
export const admin = new Hono<AppEnv>();
admin.use("*", staffAuth({ roles: ["admin"], hide: true }));

const now = () => Math.floor(Date.now() / 1000);
const OPEN = "status NOT IN ('resolved','closed')";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Replies written by someone who is later deleted stay on the ticket, attributed to this placeholder (it can never sign in).
const FORMER = "former.team.member@helpdesk.invalid";
// The same for a deleted client: their tickets can stay (for the history and the reports) under this placeholder.
const FORMER_USER = "former.user@helpdesk.invalid";

// The full IT live board (office display and admin portal only).
admin.route("/board", dashboard);
admin.route("/activity", activity);
admin.route("/email-templates", emailTemplates); // the wording and look of the emails
admin.route("/forms", forms); // the questions asked per category
admin.route("/automation", automation); // housekeeping rules (auto-close)
admin.route("/teams", teams); // alerts in a Teams channel
admin.route("/gifs", gifAdmin); // the GIPHY key and the company GIF library
admin.route("/reports", reports);
admin.route("/recurring", recurring);
admin.route("/system", system);
admin.route("/backups", backups);

/* ---------- response targets (hours per priority) ---------- */
admin.get("/sla", async (c) => c.json({ hours: await slaHours(), calendar: workCalendar() }));
// Working hours: with these on, the targets count office time only (nights, weekends and listed holidays don't run the clock).
admin.put("/sla/calendar", async (c) => {
  const r = await saveCalendar(await c.req.json().catch(() => ({})));
  if ("error" in r) return c.json({ error: r.error }, 400);
  const k = r.calendar, hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  await audit(c, "sla.calendar", "admin", k.enabled ? `Response targets now count working hours only (${hm(k.start)}-${hm(k.end)}, ${k.days.length} days a week, ${k.holidays.length} holidays)` : "Response targets now run around the clock");
  return c.json(r);
});
admin.put("/sla", async (c) => {
  const r = await saveSlaHours(await c.req.json().catch(() => ({})));
  if ("error" in r) return c.json({ error: r.error }, 400);
  await audit(c, "sla.updated", "admin", `Changed the response targets: urgent ${r.hours.urgent}h, high ${r.hours.high}h, medium ${r.hours.medium}h, low ${r.hours.low}h`);
  return c.json(r);
});

/* ---------- staff accounts: the admin creates agents and resets their passwords ---------- */

admin.get("/users", async (c) => {
  const { results } = await db
    .prepare(
      `SELECT id, name, email, role, active, must_change_password, last_login_at, created_at,
              (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = users.id AND t.${OPEN}) AS open_tickets
       FROM users WHERE role IN ('agent','admin') AND email != ? ORDER BY active DESC, role, name`,
    )
    .bind(FORMER)
    .all();
  return c.json(results);
});

// Create an agent (or another admin). A temporary password is generated and shown once; they must change it at first sign-in.
admin.post("/users", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 200) : "";
  const role = body.role === "admin" ? "admin" : "agent";
  if (name.length < 2) return c.json({ error: "Enter the person's name." }, 400);
  if (!EMAIL.test(email)) return c.json({ error: "Enter a valid email address." }, 400);

  const existing = await db.prepare("SELECT id, role FROM users WHERE email = ?").bind(email).first<{ id: number; role: string }>();
  if (existing && existing.role !== "requester") return c.json({ error: "A staff account with that email already exists." }, 409);

  const temp = randomPassword();
  const hash = await hashPassword(temp);
  let id: number;
  if (existing) {
    // They had been using the helpdesk as a normal user: promote the same account, keeping their ticket history.
    await db
      .prepare("UPDATE users SET role = ?, name = ?, password_hash = ?, must_change_password = 1, credential_version = credential_version + 1, active = 1 WHERE id = ?")
      .bind(role, name, hash, existing.id)
      .run();
    id = existing.id;
  } else {
    const row = await db
      .prepare("INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, 1) RETURNING id")
      .bind(email, name, role, hash)
      .first<{ id: number }>();
    id = row!.id;
  }
  await audit(c, "account.created", "account", `Created ${role} account for ${name} (${email})${existing ? ", promoted from a normal user" : ""}`);
  return c.json({ id, email, name, role, temp_password: temp }, 201);
});

admin.patch("/users/:id{[0-9]+}", async (c) => {
  const me = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const target = await db.prepare("SELECT id, role, active, name FROM users WHERE id = ? AND role IN ('agent','admin')").bind(id).first<{ id: number; role: string; active: number; name: string }>();
  if (!target) return c.json({ error: "not found" }, 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.name === "string" && body.name.trim().length >= 2) (sets.push("name = ?"), binds.push(body.name.trim().slice(0, 100)));
  const newRole = body.role === "admin" || body.role === "agent" ? body.role : undefined;
  const newActive = typeof body.active === "boolean" ? (body.active ? 1 : 0) : undefined;

  // Guard rails: you can't lock yourself out, and there must always be an active admin.
  const losingAdmin = target.role === "admin" && ((newRole && newRole !== "admin") || newActive === 0);
  if (id === me.id && (newActive === 0 || (newRole && newRole !== me.role))) return c.json({ error: "You can't change your own role or disable yourself." }, 400);
  if (losingAdmin) {
    const others = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").bind(id).first<{ n: number }>();
    if (!others || others.n < 1) return c.json({ error: "There must always be at least one active admin." }, 400);
  }
  if (newRole && newRole !== target.role) (sets.push("role = ?", "credential_version = credential_version + 1"), binds.push(newRole));
  if (newActive !== undefined && newActive !== target.active) {
    sets.push("active = ?", "credential_version = credential_version + 1"); // ends any open session straight away
    binds.push(newActive);
  }
  if (!sets.length) return c.json({ ok: true, changed: false });

  const stmts = [db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id)];
  if (newActive === 0) {
    // Their unfinished tickets go back to the triage list instead of sitting with someone who can't sign in.
    stmts.push(
      db.prepare(
        `INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at)
         SELECT id, ?, 'assignee', CAST(assignee_id AS TEXT), NULL, 1, ? FROM tickets WHERE assignee_id = ? AND ${OPEN}`,
      ).bind(me.id, now(), id),
      db.prepare(`UPDATE tickets SET assignee_id = NULL, status = CASE WHEN status = 'in_progress' THEN 'open' ELSE status END, updated_at = ? WHERE assignee_id = ? AND ${OPEN}`).bind(now(), id),
    );
  }
  await db.batch(stmts);
  if (newActive !== undefined && newActive !== target.active) await audit(c, newActive ? "account.enabled" : "account.disabled", "account", `${newActive ? "Re-enabled" : "Disabled"} ${target.name}${newActive ? "" : " (open tickets returned to triage)"}`);
  if (newRole && newRole !== target.role) await audit(c, "account.role", "account", `Changed ${target.name} from ${target.role} to ${newRole}`);
  if (typeof body.name === "string" && body.name.trim().length >= 2 && body.name.trim() !== target.name) await audit(c, "account.renamed", "account", `Renamed ${target.name} to ${body.name.trim().slice(0, 100)}`);
  changed();
  return c.json({ ok: true, changed: true });
});

// Permanently remove a staff account. History is preserved: their replies stay (as "Former team member"), their open
// tickets go back to triage, and the audit trail keeps its entries with the actor blanked. If the person also raised
// tickets as a normal user, they are removed from the team instead (so those tickets keep their requester).
admin.delete("/users/:id{[0-9]+}", async (c) => {
  const me = c.get("user");
  const id = Number(c.req.param("id"));
  const target = await db
    .prepare("SELECT id, role, active, name, email FROM users WHERE id = ? AND role IN ('agent','admin') AND email != ?")
    .bind(id, FORMER)
    .first<{ id: number; role: string; active: number; name: string; email: string }>();
  if (!target) return c.json({ error: "not found" }, 404);
  if (id === me.id) return c.json({ error: "You can't delete your own account." }, 400);
  if (target.role === "admin" && target.active) {
    const others = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?").bind(id).first<{ n: number }>();
    if (!others || others.n < 1) return c.json({ error: "There must always be at least one active admin." }, 400);
  }

  await db.prepare("INSERT OR IGNORE INTO users (email, name, role, active) VALUES (?, 'Former team member', 'agent', 0)").bind(FORMER).run();
  const ghost = await db.prepare("SELECT id FROM users WHERE email = ?").bind(FORMER).first<{ id: number }>();
  const own = await db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE requester_id = ?").bind(id).first<{ n: number }>();
  const keepAsRequester = !!own && own.n > 0;
  const ts = now();

  await db.batch([
    db.prepare(
      `INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at)
       SELECT id, ?, 'assignee', CAST(assignee_id AS TEXT), NULL, 1, ? FROM tickets WHERE assignee_id = ? AND ${OPEN}`,
    ).bind(me.id, ts, id),
    db.prepare(`UPDATE tickets SET assignee_id = NULL, status = CASE WHEN status = 'in_progress' THEN 'open' ELSE status END, updated_at = ? WHERE assignee_id = ? AND ${OPEN}`).bind(ts, id),
    db.prepare("UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ?").bind(id),
    db.prepare("UPDATE comments SET author_id = ? WHERE author_id = ?").bind(ghost!.id, id),
    db.prepare("UPDATE ticket_events SET actor_id = NULL WHERE actor_id = ?").bind(id),
    db.prepare("DELETE FROM notifications WHERE user_id = ?").bind(id),
    keepAsRequester
      ? db
          .prepare("UPDATE users SET role = 'requester', password_hash = NULL, must_change_password = 0, credential_version = credential_version + 1, failed_attempts = 0, locked_until = 0 WHERE id = ?")
          .bind(id)
      : db.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  await audit(c, "account.deleted", "account", `${keepAsRequester ? "Removed from the team" : "Deleted account of"} ${target.name} (${target.email}); history kept`);
  changed();
  return c.json({ ok: true, mode: keepAsRequester ? "removed_from_team" : "deleted" });
});

admin.post("/users/:id{[0-9]+}/reset-password", async (c) => {
  const id = Number(c.req.param("id"));
  const target = await db.prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('agent','admin') AND active = 1").bind(id).first<{ id: number; name: string }>();
  if (!target) return c.json({ error: "not found" }, 404);
  const temp = randomPassword();
  await db
    .prepare("UPDATE users SET password_hash = ?, must_change_password = 1, credential_version = credential_version + 1, failed_attempts = 0, locked_until = 0 WHERE id = ?")
    .bind(await hashPassword(temp), id)
    .run();
  await audit(c, "account.password_reset", "account", `Reset the password for ${target.name} (a new temporary one was issued)`);
  return c.json({ ok: true, temp_password: temp, min_length: MIN_PASSWORD });
});

// The advanced dashboard. `days` picks the window; each figure is also compared with the window before it.
// Every query is bounded by a created_at / resolved_at window or an open-ticket filter, and indexed (see schema.sql).
// End-of-day sweep: close every resolved ticket (or just the given ids). Requesters are told, and messaging on them stops.
admin.post("/tickets/close-resolved", async (c) => {
  const me = c.get("user");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const only = Array.isArray(body.ids) ? (body.ids as unknown[]).filter((x): x is number => Number.isInteger(x)).slice(0, 500) : null;
  const { results } = await db
    .prepare("SELECT id, ref, title, requester_id FROM tickets WHERE status = 'resolved' ORDER BY id LIMIT 500")
    .all<{ id: number; ref: string; title: string; requester_id: number }>();
  const rows = only ? results.filter((r) => only.includes(r.id)) : results;
  if (!rows.length) return c.json({ ok: true, closed: 0 });
  const ts = Math.floor(Date.now() / 1000);
  await db.batch(
    rows.flatMap((r) => [
      db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'resolved'").bind(ts, ts, r.id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, created_at) VALUES (?, ?, 'status', 'resolved', 'closed', ?)").bind(r.id, me.id, ts),
      notifyUser(r.requester_id, r.id, "status", `${r.ref} is now closed`, r.title, ts),
    ]),
  );
  await audit(c, "admin.close_resolved", "admin", `Closed ${rows.length} resolved ticket${rows.length === 1 ? "" : "s"} (${rows.map((r) => r.ref).slice(0, 12).join(", ")}${rows.length > 12 ? ", …" : ""})`);
  changed();
  return c.json({ ok: true, closed: rows.length });
});

// Normal users: find someone and clear a forgotten PIN. They create a new one at their next sign-in and every computer of theirs is signed out.
admin.get("/people", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
  const { results } = await db
    .prepare(
      `SELECT id, name, email, active, last_login_at, created_at, pin_hash IS NOT NULL AS has_pin,
              (SELECT COUNT(*) FROM tickets t WHERE t.requester_id = users.id) AS tickets,
              (SELECT COUNT(*) FROM devices d WHERE d.user_id = users.id) AS computers,
              (SELECT COUNT(*) FROM devices d WHERE d.user_id = users.id AND d.hardware IS NOT NULL) AS reported
       FROM users WHERE role = 'requester' AND email NOT IN (?, ?) ${q ? "AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')" : ""}
       ORDER BY COALESCE(last_login_at, created_at) DESC LIMIT 100`,
    )
    .bind(FORMER, FORMER_USER, ...(q ? [like, like] : []))
    .all();
  return c.json(results);
});

admin.get("/people/:id{[0-9]+}/devices", async (c) => {
  const id = Number(c.req.param("id"));
  const { results } = await db
    .prepare("SELECT id, first_seen, last_seen, last_ip, browser, hardware, hardware_at FROM devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20")
    .bind(id)
    .all<any>();
  return c.json(results.map(shapeDevice));
});

// The asset register: every computer the helpdesk has seen, with whoever uses it. The browser groups the rows by serial number
// (one machine, several people or browsers) and works out the health flags.
admin.get("/assets", async (c) => {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.first_seen, d.last_seen, d.last_ip, d.browser, d.hardware, d.hardware_at, d.user_id, u.name AS owner, u.email AS owner_email,
              (SELECT COUNT(*) FROM tickets t WHERE t.device_id = d.id) AS tickets,
              (SELECT COUNT(*) FROM tickets t WHERE t.device_id = d.id AND t.${OPEN}) AS open_tickets
       FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.browser IS NOT NULL OR d.hardware IS NOT NULL
       ORDER BY d.last_seen DESC LIMIT 1000`,
    )
    .all<any>();
  return c.json(results.map((r) => ({ ...shapeDevice(r), user_id: r.user_id, owner: r.owner, owner_email: r.owner_email, tickets: r.tickets, open_tickets: r.open_tickets })));
});

admin.post("/people/:id{[0-9]+}/reset-pin", async (c) => {
  const id = Number(c.req.param("id"));
  const target = await db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'requester'").bind(id).first<{ id: number; name: string; email: string }>();
  if (!target) return c.json({ error: "not found" }, 404);
  await db.prepare("UPDATE users SET pin_hash = NULL, session_version = session_version + 1, failed_attempts = 0, locked_until = 0 WHERE id = ?").bind(id).run();
  await audit(c, "account.pin_reset", "account", `Cleared the PIN for ${target.name} (${target.email}); they were signed out everywhere`);
  return c.json({ ok: true });
});

// Disable or re-enable a client (normal user). A disabled person cannot sign in (PIN, Microsoft or email), is signed out at once and gets no
// emails; their tickets and history stay exactly as they are. Staff accounts are managed under Staff, never here.
admin.post("/people/:id{[0-9]+}/active", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.active !== "boolean") return c.json({ error: "active must be true or false" }, 400);
  const target = await db.prepare("SELECT id, name, email, active FROM users WHERE id = ? AND role = 'requester' AND email NOT IN (?, ?)").bind(id, FORMER, FORMER_USER).first<{ id: number; name: string; email: string; active: number }>();
  if (!target) return c.json({ error: "not found" }, 404);
  await db.prepare("UPDATE users SET active = ?, session_version = session_version + 1, failed_attempts = 0, locked_until = 0 WHERE id = ?").bind(body.active ? 1 : 0, id).run();
  await audit(c, body.active ? "account.enabled" : "account.disabled", "account", `${body.active ? "Re-enabled" : "Disabled"} the account of ${target.name} (${target.email})${body.active ? "" : "; they were signed out everywhere"}`);
  changed();
  return c.json({ ok: true, active: body.active });
});

// Permanently delete a client. ?tickets=keep (default): their tickets stay for the history and reports, shown as "Former user".
// ?tickets=delete: their tickets, messages and files go too. Either way the account, computers, notifications and sign-ins are gone,
// and the activity log keeps its lines (it holds no message text). Staff accounts are not touched by this route.
admin.delete("/people/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const mode = c.req.query("tickets") === "delete" ? "delete" : "keep";
  const target = await db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'requester' AND email NOT IN (?, ?)").bind(id, FORMER, FORMER_USER).first<{ id: number; name: string; email: string }>();
  if (!target) return c.json({ error: "not found" }, 404);
  const own = (await db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE requester_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;

  let files: string[] = [];
  if (mode === "delete") {
    const { results } = await db.prepare("SELECT stored FROM attachments WHERE ticket_id IN (SELECT id FROM tickets WHERE requester_id = ?)").bind(id).all<{ stored: string }>();
    files = results.map((r) => r.stored);
    await db.batch([
      db.prepare("DELETE FROM tickets WHERE requester_id = ?").bind(id), // comments, events, attachments rows, steps and notifications go with them
      db.prepare("DELETE FROM attachments WHERE uploader_id = ? AND scope = 'draft'").bind(id),
      db.prepare("DELETE FROM kb_votes WHERE user_id = ?").bind(id),
      db.prepare("DELETE FROM users WHERE id = ?").bind(id), // devices and notifications cascade
    ]);
  } else {
    await db.prepare("INSERT OR IGNORE INTO users (email, name, role, active) VALUES (?, 'Former user', 'requester', 0)").bind(FORMER_USER).run();
    const ghost = await db.prepare("SELECT id FROM users WHERE email = ?").bind(FORMER_USER).first<{ id: number }>();
    await db.batch([
      db.prepare("UPDATE tickets SET requester_id = ? WHERE requester_id = ?").bind(ghost!.id, id),
      db.prepare("UPDATE comments SET author_id = ? WHERE author_id = ?").bind(ghost!.id, id),
      db.prepare("UPDATE ticket_events SET actor_id = NULL WHERE actor_id = ?").bind(id),
      db.prepare("UPDATE tickets SET device_id = NULL WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)").bind(id),
      db.prepare("DELETE FROM kb_votes WHERE user_id = ?").bind(id),
      db.prepare("DELETE FROM users WHERE id = ?").bind(id),
    ]);
  }
  for (const f of files) await unlink(path.join(config.dataDir, "uploads", f)).catch(() => {});
  await audit(c, "account.client_deleted", "account", `Deleted the account of ${target.name} (${target.email}); ${own ? (mode === "delete" ? `their ${own} ticket${own === 1 ? "" : "s"} were deleted too` : `their ${own} ticket${own === 1 ? "" : "s"} were kept as "Former user"`) : "they had no tickets"}`);
  changed();
  return c.json({ ok: true, mode, tickets: own });
});

admin.get("/insights", async (c) => {
  const requested = Number(c.req.query("days"));
  const days = [7, 30, 90].includes(requested) ? requested : 30;
  const t = now();
  const from = t - days * 86400;
  const prev = from - days * 86400;

  const [cats, totals, created, resolved, heat, aging, sla, reqs, assets, agents, openByPriority, overdue, unhappy] = await db.batch([
    // Category leaderboard with change vs the previous window
    db.prepare(
      `SELECT COALESCE(c.name,'Uncategorised') AS name,
              COALESCE(SUM(t.created_at >= ?),0) AS n,
              COALESCE(SUM(t.created_at < ?),0) AS prev,
              COALESCE(SUM(t.created_at >= ? AND t.status NOT IN ('resolved','closed')),0) AS open_now,
              ROUND(AVG(CASE WHEN t.created_at >= ? AND t.resolved_at IS NOT NULL THEN t.resolved_at - t.created_at END)/3600.0,1) AS avg_res_hrs
       FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.created_at >= ? GROUP BY t.category_id ORDER BY n DESC, prev DESC`,
    ).bind(from, from, from, from, prev),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tickets WHERE created_at >= ?) AS created,
         (SELECT COUNT(*) FROM tickets WHERE created_at >= ? AND created_at < ?) AS created_prev,
         (SELECT COUNT(*) FROM tickets WHERE resolved_at >= ?) AS resolved,
         (SELECT COUNT(*) FROM tickets WHERE resolved_at >= ? AND resolved_at < ?) AS resolved_prev,
         (SELECT ROUND(AVG(first_response_at - created_at)/3600.0,1) FROM tickets WHERE created_at >= ? AND first_response_at IS NOT NULL) AS avg_first_response_hrs,
         (SELECT ROUND(AVG(resolved_at - created_at)/3600.0,1) FROM tickets WHERE resolved_at >= ?) AS avg_resolution_hrs,
         (SELECT COUNT(*) FROM tickets WHERE ${OPEN}) AS backlog,
         (SELECT COUNT(*) FROM tickets WHERE ${OPEN} AND status != 'waiting' AND due_at IS NOT NULL AND due_at < unixepoch()) AS overdue,
         (SELECT COUNT(*) FROM tickets WHERE rated_at >= ?) AS rated,
         (SELECT COUNT(*) FROM tickets WHERE rated_at >= ? AND rating = 1) AS rated_good`,
    ).bind(from, prev, from, from, prev, from, from, from, from, from),
    db.prepare(`SELECT date(created_at,'unixepoch') AS day, COUNT(*) AS n FROM tickets WHERE created_at >= ? GROUP BY day ORDER BY day`).bind(from),
    db.prepare(`SELECT date(resolved_at,'unixepoch') AS day, COUNT(*) AS n FROM tickets WHERE resolved_at >= ? GROUP BY day ORDER BY day`).bind(from),
    // When do tickets arrive? weekday (0=Sun) x hour. Ghana is UTC+0, so UTC hours are local hours.
    db.prepare(
      `SELECT CAST(strftime('%w', created_at, 'unixepoch') AS INTEGER) AS dow,
              CAST(strftime('%H', created_at, 'unixepoch') AS INTEGER) AS hr, COUNT(*) AS n
       FROM tickets WHERE created_at >= ? GROUP BY dow, hr`,
    ).bind(from),
    // Backlog age: how long open tickets have been waiting
    db.prepare(
      `SELECT COALESCE(SUM(created_at >= ?),0) AS d1,
              COALESCE(SUM(created_at < ? AND created_at >= ?),0) AS d3,
              COALESCE(SUM(created_at < ? AND created_at >= ?),0) AS d7,
              COALESCE(SUM(created_at < ?),0) AS older
       FROM tickets WHERE ${OPEN}`,
    ).bind(t - 86400, t - 86400, t - 3 * 86400, t - 3 * 86400, t - 7 * 86400, t - 7 * 86400),
    // Resolution speed vs target, by priority
    db.prepare(
      `SELECT priority, COUNT(*) AS n, ROUND(AVG(resolved_at - created_at)/3600.0,1) AS avg_hrs,
              ROUND(100.0 * SUM(due_at IS NOT NULL AND resolved_at <= due_at) / COUNT(*), 0) AS met_pct
       FROM tickets WHERE resolved_at >= ? GROUP BY priority`,
    ).bind(from),
    db.prepare(
      `SELECT u.email, u.name AS name, COUNT(*) AS n
       FROM tickets t JOIN users u ON u.id = t.requester_id
       WHERE t.created_at >= ? GROUP BY u.id ORDER BY n DESC LIMIT 5`,
    ).bind(from),
    // Devices that keep coming back
    db.prepare(
      `SELECT asset_tag, COUNT(*) AS n FROM tickets
       WHERE asset_tag IS NOT NULL AND created_at >= ? GROUP BY asset_tag HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5`,
    ).bind(from),
    db.prepare(
      `SELECT a.name,
              (SELECT COUNT(*) FROM tickets x WHERE x.assignee_id = a.id AND x.${OPEN}) AS open_tickets,
              COUNT(t.id) AS resolved,
              ROUND(AVG(t.resolved_at - t.created_at)/3600.0,1) AS avg_hrs
       FROM users a LEFT JOIN tickets t ON t.assignee_id = a.id AND t.resolved_at >= ?
       WHERE a.role IN ('agent','admin') AND a.active = 1
       GROUP BY a.id ORDER BY resolved DESC, open_tickets DESC LIMIT 8`,
    ).bind(from),
    db.prepare(`SELECT priority, COUNT(*) AS n FROM tickets WHERE ${OPEN} GROUP BY priority`),
    db.prepare(
      `SELECT id, ref, title, priority, due_at FROM tickets
       WHERE ${OPEN} AND status != 'waiting' AND due_at IS NOT NULL AND due_at < unixepoch() ORDER BY due_at ASC LIMIT 8`,
    ),
    // People who said it wasn't fixed (latest first): the tickets worth a second look
    db.prepare(
      `SELECT t.id, t.ref, t.title, t.rating_comment AS comment, t.rated_at, u.name AS requester, a.name AS assignee
       FROM tickets t JOIN users u ON u.id = t.requester_id LEFT JOIN users a ON a.id = t.assignee_id
       WHERE t.rating = -1 AND t.rated_at >= ? ORDER BY t.rated_at DESC LIMIT 6`,
    ).bind(from),
  ]);

  return c.json({
    now: t,
    days,
    categories: cats.results,
    totals: totals.results[0] ?? {},
    trend: { created: created.results, resolved: resolved.results },
    heat: heat.results,
    aging: aging.results[0] ?? {},
    sla: sla.results,
    slaTargets: await slaHours(),
    requesters: reqs.results,
    assets: assets.results,
    agents: agents.results,
    openByPriority: openByPriority.results,
    overdue: overdue.results,
    unhappy: unhappy.results,
  });
});
