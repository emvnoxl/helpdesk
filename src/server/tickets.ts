import { Hono, type Context } from "hono";
import { type AppEnv, type User, isStaff, requireRole } from "./auth";
import { notifyStaff, notifyUser } from "./notifications";
import { audit } from "./audit";
import { shapeDevice } from "./devices";
import { changed as liveChanged } from "./bus";
import { db } from "./db";
import { attachments, filesFor, usableDrafts } from "./attachments";
import { dueAt, slaHours, workBetween } from "./sla";
import { taskRoutes, tasksFor } from "./tasks";
import { callRoutes, pendingRequest } from "./calls";
import { chatRoutes, EDIT_WINDOW } from "./chat";
import { teamsNotify } from "./teams";
import { dupRoutes, openDuplicates, resolveDuplicates } from "./duplicates";
import { validateAnswers } from "./forms";

const PRIORITIES = { low: 1, medium: 2, high: 3, urgent: 4 } as const;
const STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
type Priority = keyof typeof PRIORITIES;
type Status = (typeof STATUSES)[number];

const isPriority = (v: unknown): v is Priority => typeof v === "string" && v in PRIORITIES;
const isStatus = (v: unknown): v is Status => STATUSES.includes(v as Status);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const now = () => Math.floor(Date.now() / 1000);

/* Mounted twice: at /api/tickets (normal users: their own tickets only) and at /api/staff/tickets (agents and admins).
   The same rules apply either way: isStaff(user) decides what a request may see and do. */
export const tickets = new Hono<AppEnv>();

tickets.route("/", attachments); // files on tickets: /:id/attachments
tickets.route("/", taskRoutes); // checklist steps on tickets (staff): /:id/tasks
tickets.route("/", callRoutes); // voice calls and screen sharing: /:id/call, /calls/...

/** Writes a new ticket with its reference, "created" event and the bell for the IT team. Used by the form (below), by incoming email,
    by checklists and by the recurring-ticket scheduler. The caller writes the activity-log line, because only it knows who and why. */
export async function createTicket(
  who: { id: number; name: string },
  o: { title: string; description: string; categoryId?: number | null; assetTag?: string | null; deviceId?: number | null; priority?: Priority; assigneeId?: number | null; answers?: string | null; source?: "web" | "email" | "checklist" | "recurring"; tellEveryone?: boolean },
): Promise<{ id: number; ref: string }> {
  const priority: Priority = o.priority ?? "medium";
  const ts = now();
  const row = await db
    .prepare(
      `INSERT INTO tickets (title, description, priority, priority_rank, category_id, requester_id, assignee_id, asset_tag, due_at, created_at, updated_at, device_id, source, answers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(o.title, o.description, priority, PRIORITIES[priority], o.categoryId ?? null, who.id, o.assigneeId ?? null, o.assetTag ?? null, dueAt(await slaHours(), priority, ts), ts, ts, o.deviceId ?? null, o.source ?? "web", o.answers ?? null)
    .first<{ id: number }>();
  if (!row) throw new Error("create failed");
  const ref = `FG-${String(row.id).padStart(4, "0")}`;
  const via = o.source === "email" ? " · by email" : "";
  await db.batch([
    db.prepare("UPDATE tickets SET ref = ? WHERE id = ?").bind(ref, row.id),
    db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, new_value, created_at) VALUES (?, ?, 'created', ?, ?)").bind(row.id, who.id, "open", ts),
    // The scheduler has no person behind it, so nobody is left out of the bell.
    notifyStaff(row.id, "new_ticket", `New ticket ${ref}`, `${o.title} · from ${who.name}${via}`, ts, o.tellEveryone ? 0 : who.id),
  ]);
  liveChanged(row.id);
  if (o.source === "web" || o.source === "email" || !o.source) teamsNotify("new_ticket", { ticketId: row.id, title: `New ticket ${ref}: ${o.title}`.slice(0, 200), text: `From ${who.name}${via}` });
  return { id: row.id, ref };
}

tickets.get("/categories", async (c) => {
  const { results } = await db.prepare("SELECT id, name, form FROM categories ORDER BY name").all<{ id: number; name: string; form: string | null }>();
  return c.json(results.map((r) => ({ id: r.id, name: r.name, fields: (() => { try { const v = JSON.parse(r.form ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })() })));
});

// Staff-only: who a ticket can be assigned to
tickets.get("/agents", requireRole("agent", "admin"), async (c) => {
  const { results } = await db.prepare("SELECT id, name FROM users WHERE role IN ('agent','admin') AND active = 1 ORDER BY name").all();
  return c.json(results);
});

// List. Normal users only ever see their own. Staff can filter and paginate (keyset on id).
tickets.get("/", async (c) => {
  const user = c.get("user");
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 50);
  const before = Number(c.req.query("before")) || 0;
  const where: string[] = [];
  const binds: unknown[] = [];

  if (!isStaff(user)) {
    where.push("t.requester_id = ?");
    binds.push(user.id);
  } else {
    const status = c.req.query("status");
    if (status === "open") where.push("t.status NOT IN ('resolved','closed')");
    else if (isStatus(status)) (where.push("t.status = ?"), binds.push(status));
    if (c.req.query("assignee") === "me") (where.push("t.assignee_id = ?"), binds.push(user.id));
    if (c.req.query("assignee") === "none") where.push("t.assignee_id IS NULL");
    const q = (c.req.query("q") ?? "").trim().slice(0, 80);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
      where.push("(t.ref LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')");
      binds.push(like, like, like);
    }
  }
  if (before) (where.push("t.id < ?"), binds.push(before));

  const sql = `SELECT t.id, t.ref, t.title, t.status, t.priority, t.due_at, t.created_at, t.updated_at,
         u.name AS requester, a.name AS assignee, cat.name AS category
       FROM tickets t
       JOIN users u ON u.id = t.requester_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN categories cat ON cat.id = t.category_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY t.id DESC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...binds, limit).all();
  return c.json(results);
});

// Create. The requester is always the signed-in person; their name and email come from their account.
tickets.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const title = str(body.title, 200);
  const description = str(body.description, 10000);
  if (!title || !description) return c.json({ error: "title and description required" }, 400);
  // Requesters never choose priority: every ticket starts at "medium" and IT triages it.
  const priority: Priority = "medium";
  const categoryId = Number(body.category_id) || null;
  const assetTag = str(body.asset_tag, 100) || null;
  // Remember which computer this was raised from, so IT sees the machine inside the ticket.
  const devKey = typeof body.device_key === "string" && /^[a-f0-9]{32}$/.test(body.device_key) ? body.device_key : null;
  const dev = devKey ? await db.prepare("SELECT id FROM devices WHERE user_id = ? AND device_key = ?").bind(user.id, devKey).first<{ id: number }>() : null;
  const ans = await validateAnswers(categoryId, body.answers);
  if (!ans.ok) return c.json({ error: ans.error }, 400);
  const row = await createTicket(user, { title, description, priority, categoryId, assetTag, deviceId: dev?.id ?? null, answers: ans.json });
  const ref = row.ref;
  await audit(c, "ticket.created", "ticket", `Raised ${ref}: ${title}`, { ticketId: row.id });
  return c.json({ id: row.id, ref }, 201);
});

// Detail + thread. Internal notes are filtered here, server-side, for normal users.
tickets.get("/:id{[0-9]+}", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const t = await db
    .prepare(
      `SELECT t.*, u.name AS requester, u.email AS requester_email, a.name AS assignee, cat.name AS category
       FROM tickets t JOIN users u ON u.id = t.requester_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN categories cat ON cat.id = t.category_id
       WHERE t.id = ?`,
    )
    .bind(id)
    .first<{ requester_id: number; device_id: number | null }>();
  if (!t || (!isStaff(user) && t.requester_id !== user.id)) return c.json({ error: "not found" }, 404);

  const staffView = isStaff(user);
  const [thread, log] = await db.batch([
    db
      .prepare(
        `SELECT c.id, c.body, c.internal, c.created_at, c.edited_at, c.deleted_at, c.kind, c.gif_ref, c.author_id, u.name AS author, u.role AS author_role
         FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.ticket_id = ? ${staffView ? "" : "AND c.internal = 0"}
         ORDER BY c.created_at ASC, c.id ASC LIMIT 300`,
      )
      .bind(id),
    // Status/assignee changes shown inline in the chat. Priority changes are for staff only.
    db
      .prepare(
        `SELECT e.id, e.field, e.old_value, e.new_value, e.created_at, a.name AS actor, n.name AS new_name
         FROM ticket_events e
         LEFT JOIN users a ON a.id = e.actor_id
         LEFT JOIN users n ON e.field = 'assignee' AND CAST(n.id AS TEXT) = e.new_value
         WHERE e.ticket_id = ? AND e.field IN (${staffView ? "'status','assignee','call','call_request','priority','duplicate'" : "'status','assignee','call','call_request'"})
         ORDER BY e.created_at ASC, e.id ASC LIMIT 200`,
      )
      .bind(id),
  ]);
  // Staff also see the computer the ticket was raised from.
  let device = null;
  if (staffView && t.device_id) {
    const d = await db.prepare("SELECT id, first_seen, last_seen, last_ip, browser, hardware, hardware_at FROM devices WHERE id = ?").bind(t.device_id).first<any>();
    if (d) device = shapeDevice(d);
  }
  const files = await filesFor(id, staffView);
  // Reactions under each message: emoji, how many, whether I gave it, and who (a few names for the tooltip).
  const ids = thread.results.map((m: any) => m.id as number);
  const reactions = new Map<number, { emoji: string; n: number; mine: boolean; names: string[] }[]>();
  if (ids.length) {
    const { results } = await db
      .prepare(`SELECT r.comment_id, r.emoji, r.user_id, u.name FROM comment_reactions r JOIN users u ON u.id = r.user_id WHERE r.comment_id IN (${ids.map(() => "?").join(",")}) ORDER BY r.created_at`)
      .bind(...ids)
      .all<{ comment_id: number; emoji: string; user_id: number; name: string }>();
    for (const r of results) {
      const list = reactions.get(r.comment_id) ?? [];
      let e = list.find((x) => x.emoji === r.emoji);
      if (!e) { e = { emoji: r.emoji, n: 0, mine: false, names: [] }; list.push(e); }
      e.n++;
      if (r.user_id === user.id) e.mine = true;
      if (e.names.length < 6) e.names.push(r.user_id === user.id ? "You" : r.name);
      reactions.set(r.comment_id, list);
    }
  }
  // Read receipts: opening the ticket (a visible tab: the browser sends peek=1 from a hidden one) records the newest message this person
  // has had on screen. A requester's marker only ever covers messages a requester can see.
  const lastVisible = ids.length ? Math.max(...ids) : 0;
  if (c.req.query("peek") !== "1" && lastVisible) {
    const r = await db
      .prepare(
        `INSERT INTO ticket_reads (ticket_id, user_id, last_comment_id, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (ticket_id, user_id) DO UPDATE SET last_comment_id = excluded.last_comment_id, seen_at = excluded.seen_at WHERE excluded.last_comment_id > ticket_reads.last_comment_id`,
      )
      .bind(id, user.id, lastVisible, now())
      .run();
    if (r.meta.changes) liveChanged(id); // the other side's "Seen" appears at once
  }
  // ...and the other side's marker: staff see whether the requester has seen; the requester sees whether IT has.
  const seen = staffView
    ? await db.prepare("SELECT r.last_comment_id AS id, r.seen_at AS at, u.name AS seen_by FROM ticket_reads r JOIN users u ON u.id = r.user_id WHERE r.ticket_id = ? AND r.user_id = ?").bind(id, t.requester_id).first<{ id: number; at: number; seen_by: string }>()
    : await db.prepare("SELECT r.last_comment_id AS id, r.seen_at AS at, u.name AS seen_by FROM ticket_reads r JOIN users u ON u.id = r.user_id WHERE r.ticket_id = ? AND u.role IN ('agent','admin') ORDER BY r.last_comment_id DESC, r.seen_at DESC LIMIT 1").bind(id).first<{ id: number; at: number; seen_by: string }>();
  const comments = thread.results.map((m: any) => ({ ...m, files: files.byComment.get(m.id) ?? [], reactions: reactions.get(m.id) ?? [] }));
  // Same-problem links: staff see both directions with titles; a requester only learns that theirs is being handled with another.
  const dupOfId = (t as any).duplicate_of as number | null;
  const dupOf = dupOfId ? await db.prepare("SELECT id, ref, title, status FROM tickets WHERE id = ?").bind(dupOfId).first<{ id: number; ref: string; title: string; status: string }>() : null;
  const duplicates = staffView
    ? (await db.prepare("SELECT t.id, t.ref, t.title, t.status, u.name AS requester FROM tickets t JOIN users u ON u.id = t.requester_id WHERE t.duplicate_of = ? ORDER BY t.id LIMIT 50").bind(id).all()).results
    : [];
  let answers: unknown[] = [];
  try { const v = JSON.parse((t as any).answers ?? "[]"); if (Array.isArray(v)) answers = v; } catch { /* none */ }
  return c.json({
    ticket: t, comments, events: log.results, me: user.id, device, files: files.ticket, tasks: staffView ? await tasksFor(id) : undefined, call_request: await pendingRequest(id),
    seen: seen ? { id: seen.id, at: seen.at, by: seen.seen_by } : null, now: now(), edit_window: EDIT_WINDOW,
    duplicate_of: dupOf ? (staffView ? dupOf : { ref: dupOf.ref }) : null, duplicates, answers,
  });
});

// Staff update: status / priority / assignee, with event log + timestamps
tickets.patch("/:id{[0-9]+}", requireRole("agent", "admin"), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const cur = await db
    .prepare("SELECT ref, title, requester_id, status, priority, priority_locked, assignee_id, created_at, paused_at, paused_secs FROM tickets WHERE id = ?")
    .bind(id)
    .first<{ ref: string; title: string; requester_id: number; status: Status; priority: Priority; priority_locked: number; assignee_id: number | null; created_at: number; paused_at: number | null; paused_secs: number }>();
  if (!cur) return c.json({ error: "not found" }, 404);

  const ts = now();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [ts];
  const events: [string, string | null, string | null][] = [];
  let changed = false; // true for changes that don't produce an event (lock/unlock)
  const admin = user.role === "admin";
  // The response-target clock stops while the ticket is 'waiting' (on the requester) and the paused time is added back when work resumes.
  let newPriority: Priority = cur.priority, pausedAt = cur.paused_at, pausedSecs = cur.paused_secs, dueDirty = false;

  if (body.status !== undefined) {
    if (!isStatus(body.status)) return c.json({ error: "invalid status" }, 400);
    if (body.status !== cur.status) {
      // Agents resolve; only an admin closes a ticket (end-of-day sweep) or brings a closed one back.
      if (!admin && (body.status === "closed" || cur.status === "closed")) return c.json({ error: "Only an admin can close or reopen a ticket" }, 403);
      sets.push("status = ?");
      binds.push(body.status);
      if (body.status === "resolved") (sets.push("resolved_at = ?"), binds.push(ts));
      if (body.status === "closed") (sets.push("closed_at = ?"), binds.push(ts));
      events.push(["status", cur.status, body.status]);
      if (body.status === "waiting") (pausedAt = ts, dueDirty = true);
      else if (cur.status === "waiting") (pausedSecs += pausedAt ? workBetween(pausedAt, ts) : 0, pausedAt = null, dueDirty = true);
    }
  }
  if (body.priority !== undefined) {
    const p: unknown = body.priority;
    if (!isPriority(p)) return c.json({ error: "invalid priority" }, 400);
    if (p !== cur.priority) {
      // An admin's priority is final: agents can't override a locked one.
      if (cur.priority_locked && !admin) return c.json({ error: "Priority was set by an admin and can't be changed" }, 403);
      // The target is measured from creation, so due_at is recomputed (below) from created_at.
      sets.push("priority = ?", "priority_rank = ?");
      binds.push(p, PRIORITIES[p]);
      newPriority = p;
      dueDirty = true;
      events.push(["priority", cur.priority, p]);
    }
    // Any priority an admin sets (even confirming the current one) locks it.
    if (admin && !cur.priority_locked) {
      sets.push("priority_locked = 1");
      changed = true;
    }
  }
  // Admin-only: hand priority back to agents.
  if (body.priority_locked === false && admin && cur.priority_locked) {
    sets.push("priority_locked = 0");
    changed = true;
  }
  if (body.assignee_id !== undefined) {
    const aid = body.assignee_id === null ? null : Number(body.assignee_id);
    if (aid !== null) {
      const ok = await db.prepare("SELECT 1 FROM users WHERE id = ? AND active = 1 AND role IN ('agent','admin')").bind(aid).first();
      if (!ok) return c.json({ error: "invalid assignee" }, 400);
    }
    if (aid !== cur.assignee_id) {
      sets.push("assignee_id = ?");
      binds.push(aid);
      events.push(["assignee", cur.assignee_id === null ? null : String(cur.assignee_id), aid === null ? null : String(aid)]);
    }
  }
  if (dueDirty) {
    sets.push("due_at = ?", "paused_at = ?", "paused_secs = ?", "sla_alert = 0");
    binds.push(dueAt(await slaHours(), newPriority, cur.created_at, pausedSecs), pausedAt, pausedSecs);
  }
  if (!events.length && !changed) return c.json({ ok: true, changed: false });

  // Tell the people concerned: the requester about status/assignee, a new assignee that it's theirs now.
  const alerts = [];
  const statusEv = events.find((e) => e[0] === "status");
  if (statusEv) alerts.push(notifyUser(cur.requester_id, id, "status", `${cur.ref} is now ${String(statusEv[2]).replace("_", " ")}`, cur.title, ts));
  const assignEv = events.find((e) => e[0] === "assignee");
  if (assignEv) {
    const newId = assignEv[2] === null ? null : Number(assignEv[2]);
    if (newId !== null && newId !== user.id) alerts.push(notifyUser(newId, id, "assigned", `${cur.ref} was assigned to you`, cur.title, ts));
    if (newId !== null) {
      const who = await db.prepare("SELECT name FROM users WHERE id = ?").bind(newId).first<{ name: string }>();
      alerts.push(notifyUser(cur.requester_id, id, "status", `${who?.name ?? "Someone from IT"} is now handling ${cur.ref}`, cur.title, ts));
    }
  }
  await db.batch([
    db.prepare(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id),
    ...alerts,
    ...events.map(([field, o, n]) =>
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, user.id, field, o, n, ts),
    ),
  ]);
  const label = (f: string, v: string | null) => (f === "status" || f === "priority" ? String(v).replace("_", " ") : v);
  for (const [field, o, n] of events) {
    if (field === "assignee") {
      const nm = n === null ? null : (await db.prepare("SELECT name FROM users WHERE id = ?").bind(Number(n)).first<{ name: string }>())?.name;
      await audit(c, "ticket.assignee", "ticket", nm ? `${cur.ref} assigned to ${nm}` : `${cur.ref} unassigned`, { ticketId: id });
    } else {
      await audit(c, `ticket.${field}`, "ticket", `${cur.ref} ${field}: ${label(field, o)} → ${label(field, n)}`, { ticketId: id });
    }
  }
  if (changed) await audit(c, "ticket.priority_lock", "ticket", sets.includes("priority_locked = 1") ? `${cur.ref} priority locked by an admin` : `${cur.ref} priority released to agents`, { ticketId: id });
  const toStatus = events.find((e) => e[0] === "status")?.[2];
  if (toStatus === "resolved" || toStatus === "closed") await resolveDuplicates({ addComment, ticketForComment }, c, user, id, cur.ref);
  liveChanged(id);
  return c.json({ ok: true, changed: true });
});

type TicketForComment = { ref: string; title: string; status: Status; priority: Priority; requester_id: number; assignee_id: number | null; first_response_at: number | null; created_at: number; paused_at: number | null; paused_secs: number };
export const ticketForComment = (id: number) =>
  db
    .prepare("SELECT ref, title, status, priority, requester_id, assignee_id, first_response_at, created_at, paused_at, paused_secs FROM tickets WHERE id = ?")
    .bind(id)
    .first<TicketForComment>();

/** Adds a message to a ticket, with everything that follows from it: reopening, restarting the clock, the bell, the email to the
    requester and the activity log. The chat calls it (below) and so does incoming email (with c = null and via = "email"). */
export async function addComment(c: Context<any> | null, user: Pick<User, "id" | "name" | "role">, id: number, t: TicketForComment, text: string, o: { internal?: boolean; draftIds?: number[]; via?: "email"; kind?: "text" | "gif" | "giphy"; ref?: string } = {}) {
  const staff = user.role !== "requester";
  const internal = staff && o.internal ? 1 : 0;
  const draftIds = o.draftIds ?? [];
  const ts = now();
  const stmts = [
    db.prepare("INSERT INTO comments (ticket_id, author_id, body, internal, created_at, kind, gif_ref) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, user.id, text, internal, ts, o.kind ?? "text", o.ref ?? null),
    // Must stay right after the INSERT: it links the files to the message that was just written.
    db.prepare(`UPDATE attachments SET scope = 'comment', comment_id = last_insert_rowid() WHERE ticket_id = ? AND id IN (${draftIds.length ? draftIds.map(() => "?").join(",") : "NULL"})`).bind(id, ...draftIds),
  ];
  // A reply from IT is also emailed to the requester (the notifier sends 'reply' events; new_value is the message id).
  if (staff && !internal && t.requester_id !== user.id) {
    stmts.push(db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, new_value, created_at) VALUES (?, ?, 'reply', CAST(last_insert_rowid() AS TEXT), ?)").bind(id, user.id, ts));
  }
  stmts.push(db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").bind(ts, id));
  const preview = text || (o.kind === "gif" || o.kind === "giphy" ? "Sent a GIF" : draftIds.length === 1 ? "Sent an attachment" : `Sent ${draftIds.length} attachments`);
  // First public staff reply counts as first response
  if (staff && !internal && !t.first_response_at && t.requester_id !== user.id) {
    stmts.push(db.prepare("UPDATE tickets SET first_response_at = ? WHERE id = ?").bind(ts, id));
  }
  // The requester wrote on a ticket marked resolved: it isn't fixed after all, so it goes back into the queue.
  if (!staff && t.status === "resolved") {
    stmts.push(
      db.prepare("UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = ?").bind(id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'status', 'resolved', 'open', 1, ?)").bind(id, user.id, ts),
    );
  }
  // The requester answered a ticket that was waiting on them: work resumes (and the response-target clock with it).
  if (!staff && t.status === "waiting") {
    const next = t.assignee_id ? "in_progress" : "open";
    const paused = t.paused_secs + (t.paused_at ? workBetween(t.paused_at, ts) : 0);
    stmts.push(
      db.prepare("UPDATE tickets SET status = ?, due_at = ?, paused_secs = ?, paused_at = NULL, sla_alert = 0 WHERE id = ?").bind(next, dueAt(await slaHours(), t.priority, t.created_at, paused), paused, id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'status', 'waiting', ?, 1, ?)").bind(id, user.id, next, ts),
    );
  }
  // Who needs to know: staff replies go to the requester; a requester's message goes to the assignee (or to all of IT if nobody has it yet);
  // an internal note goes to the assignee only.
  if (!staff) {
    if (t.assignee_id) stmts.push(notifyUser(t.assignee_id, id, "message", `${user.name} on ${t.ref}`, preview, ts));
    else stmts.push(notifyStaff(id, "message", `${user.name} on ${t.ref}`, preview, ts, user.id));
  } else if (internal) {
    if (t.assignee_id && t.assignee_id !== user.id) stmts.push(notifyUser(t.assignee_id, id, "note", `Internal note by ${user.name} on ${t.ref}`, preview, ts));
  } else if (t.requester_id !== user.id) {
    stmts.push(notifyUser(t.requester_id, id, "message", `${user.name} from IT replied on ${t.ref}`, preview, ts));
  }
  await db.batch(stmts);
  const who = { id: user.id, name: user.name, role: user.role };
  if (!staff && t.status === "resolved") await audit(c, "ticket.reopened", "ticket", `${t.ref} reopened by the requester replying`, { ticketId: id, who });
  await audit(
    c,
    "message.sent",
    "message",
    (internal ? `Internal note on ${t.ref}` : staff ? `Replied to ${t.ref}` : `Wrote on ${t.ref}`) + (o.via ? " by email" : ""),
    { ticketId: id, who },
  );
  liveChanged(id);
}

chatRoutes(tickets, { addComment, ticketForComment }); // edit, delete, reactions, typing, GIFs
dupRoutes(tickets, { addComment, ticketForComment }); // same problem as another ticket (staff)

// Add comment. Only staff may post internal notes.
tickets.post("/:id{[0-9]+}/comments", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const text = str(body.body, 10000);

  const t = await ticketForComment(id);
  if (!t || (!isStaff(user) && t.requester_id !== user.id)) return c.json({ error: "not found" }, 404);
  const draftIds = await usableDrafts(id, user.id, body.attachment_ids);
  if (!text && !draftIds.length) return c.json({ error: "body required" }, 400);

  // A closed ticket is finished: nobody can add to it (an admin can reopen it first).
  if (t.status === "closed") return c.json({ error: "This ticket is closed, so messages are turned off." }, 409);
  await addComment(c, user, id, t, text, { internal: body.internal === true, draftIds });
  // "Also send to the linked tickets": the same words to every still-open duplicate (staff, public replies only; files stay on this ticket).
  let also = 0;
  if (body.also_linked === true && isStaff(user) && body.internal !== true && text) {
    for (const d of await openDuplicates(id)) { const dt = await ticketForComment(d.id); if (dt) { await addComment(c, user, d.id, dt, text, {}); also++; } }
  }
  return c.json({ ok: true, also }, 201);
});

// The requester says whether it was really fixed. A thumbs-down on a resolved ticket sends it back to the queue.
tickets.post("/:id{[0-9]+}/rating", async (c) => {
  const user = c.get("user");
  if (isStaff(user)) return c.json({ error: "Only the person who raised the ticket can rate it." }, 403);
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const rating = body.rating === 1 ? 1 : body.rating === -1 ? -1 : 0;
  if (!rating) return c.json({ error: "rating must be 1 (fixed) or -1 (not fixed)" }, 400);
  const comment = str(body.comment, 500);

  const t = await db
    .prepare("SELECT ref, title, status, requester_id, assignee_id FROM tickets WHERE id = ?")
    .bind(id)
    .first<{ ref: string; title: string; status: Status; requester_id: number; assignee_id: number | null }>();
  if (!t || t.requester_id !== user.id) return c.json({ error: "not found" }, 404);
  if (t.status !== "resolved" && t.status !== "closed") return c.json({ error: "You can give feedback once IT marks the ticket resolved." }, 409);

  const ts = now();
  const reopen = rating === -1 && t.status === "resolved";
  const stmts = [db.prepare("UPDATE tickets SET rating = ?, rating_comment = ?, rated_at = ?, updated_at = ? WHERE id = ?").bind(rating, comment || null, ts, ts, id)];
  if (reopen) {
    stmts.push(
      db.prepare("UPDATE tickets SET status = 'open', resolved_at = NULL WHERE id = ?").bind(id),
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'status', 'resolved', 'open', 1, ?)").bind(id, user.id, ts),
    );
    if (comment) stmts.push(db.prepare("INSERT INTO comments (ticket_id, author_id, body, internal, created_at) VALUES (?, ?, ?, 0, ?)").bind(id, user.id, comment, ts));
  }
  if (rating === -1) {
    const title = reopen ? `${user.name} says ${t.ref} isn't fixed` : `${user.name} says ${t.ref} wasn't fixed (already closed)`;
    stmts.push(t.assignee_id ? notifyUser(t.assignee_id, id, "message", title, comment || t.title, ts) : notifyStaff(id, "message", title, comment || t.title, ts, user.id));
  } else if (t.assignee_id) {
    stmts.push(notifyUser(t.assignee_id, id, "status", `${user.name} confirmed ${t.ref} is fixed`, comment || t.title, ts));
  }
  await db.batch(stmts);
  if (rating === -1) teamsNotify("not_fixed", { ticketId: id, title: `${t.ref} was not fixed`, text: `${user.name} says it is still a problem${comment ? `: ${comment}` : "."}`.slice(0, 300) });
  await audit(c, "ticket.rated", "ticket", `Rated ${t.ref} ${rating === 1 ? "fixed" : "not fixed"}${reopen ? " (reopened)" : ""}`, { ticketId: id });
  liveChanged(id);
  return c.json({ ok: true, reopened: reopen });
});
