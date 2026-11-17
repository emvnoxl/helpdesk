import { Hono, type Context } from "hono";
import { type AppEnv, type User, isStaff } from "./auth";
import { audit } from "./audit";
import { changed, online, signal } from "./bus";
import { config } from "./config";
import { db } from "./db";
import { notifyStaff, notifyUser } from "./notifications";

/* Voice calls and screen sharing on a ticket (WebRTC). The sound and the picture travel directly between the two browsers over the
   office network; this server only introduces them: who is ringing whom, the two session descriptions (offer and answer, each with
   its network candidates already inside, so there is nothing to trickle), and whether a screen is being shown. Nothing is recorded.
   Calls live in memory (one process): a restart ends them. Mounted inside the tickets router, so the same code serves normal users
   (/api/tickets/...) and staff (/api/staff/tickets/...).

   Only IT starts calls. A requester asks for one ("call request": a line in the ticket's conversation, the bell for whoever is handling the
   ticket, a banner with "Call now" on the ticket) and IT rings them when ready, so IT decides when a call happens.

   A person can have several tabs open, so the state is a snapshot every tab reads (GET /calls) after a "call" push, not a queue:
   all tabs ring, the first to answer takes the call (its `tab` id is remembered) and the others see that and go quiet. */

const RING_SECONDS = 30;
const MAX_CALL_SECONDS = 4 * 3600;
const KEEP_ENDED_MS = 15_000; // long enough for every tab to see how it ended
const MAX_SDP = 30_000;

type Reason = "ended" | "missed" | "declined" | "cancelled";
interface Party { key: string; id: number; name: string; tab: string; role?: string }
interface Call {
  id: string;
  ticketId: number;
  ref: string;
  title: string;
  caller: Party;
  /** Everyone whose screens ring (the requester, or the assignee, or the whole IT team), until one of them answers. */
  invited: Map<string, { id: number; name: string }>;
  callee: Party | null;
  state: "ringing" | "active" | "ended";
  reason: Reason | null;
  offer: string;
  answer: string | null;
  share: { caller: boolean; callee: boolean };
  startedAt: number;
  answeredAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const calls = new Map<string, Call>();
const now = () => Math.floor(Date.now() / 1000);
/** A staff session and a normal-user session of the same person are different parties. */
const keyOf = (u: Pick<User, "id" | "role">) => (u.role === "requester" ? "r" : "s") + u.id;
const newId = () => crypto.randomUUID().replace(/-/g, "");
const tabOf = (v: unknown) => (typeof v === "string" && /^[a-z0-9]{8,40}$/i.test(v) ? v : "");
const sdpOf = (v: unknown) => (typeof v === "string" && v.startsWith("v=0") && v.length <= MAX_SDP ? v : "");
const everyone = (call: Call) => [call.caller.key, ...call.invited.keys(), ...(call.callee ? [call.callee.key] : [])];
const busy = (key: string) => [...calls.values()].some((k) => k.state !== "ended" && (k.caller.key === key || k.callee?.key === key));

function view(call: Call, key: string) {
  const role = call.caller.key === key ? "caller" : call.callee?.key === key ? "callee" : "invited";
  const other = role === "caller" ? (call.callee?.name ?? [...call.invited.values()][0]?.name ?? "IT") : call.caller.name;
  return {
    id: call.id,
    ticket_id: call.ticketId,
    ref: call.ref,
    title: call.title,
    state: call.state,
    reason: call.reason,
    role,
    with: role === "caller" && !call.callee && call.invited.size > 1 ? "IT" : other,
    my_tab: role === "caller" ? call.caller.tab : role === "callee" ? call.callee!.tab : null,
    offer: role !== "caller" && call.state !== "ended" ? call.offer : undefined,
    answer: role === "caller" ? (call.answer ?? undefined) : undefined,
    remote_sharing: role === "caller" ? call.share.callee : call.share.caller,
    answered_at: call.answeredAt,
  };
}

/** Ends a call, writes what happened onto the ticket (a line in the chat, the bell for a missed call, the activity log). */
async function finish(call: Call, reason: Reason, c: Parameters<typeof audit>[0] = null) {
  if (call.state === "ended") return;
  const wasActive = call.state === "active";
  const everyoneBefore = everyone(call);
  call.state = "ended";
  call.reason = reason;
  if (call.timer) clearTimeout(call.timer);
  setTimeout(() => calls.delete(call.id), KEEP_ENDED_MS).unref();
  const ts = now();
  const secs = wasActive && call.answeredAt ? Math.max(0, ts - call.answeredAt) : 0;
  const outcome = wasActive ? "ended" : reason === "declined" ? "declined" : "missed";
  try {
    const stmts = [
      // notified = 1: these lines are for the chat, the notifier must not email them
      db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'call', ?, ?, 1, ?)").bind(call.ticketId, call.caller.id, outcome, String(secs), ts),
    ];
    if (!wasActive) for (const p of call.invited.values()) stmts.push(notifyUser(p.id, call.ticketId, "call", `Missed call from ${call.caller.name}`, `${call.ref} · ${call.title}`, ts));
    await db.batch(stmts);
    const who = { id: call.caller.id, name: call.caller.name, role: call.caller.role ?? "requester" };
    await audit(c, wasActive ? "call.end" : "call.missed", "ticket", wasActive ? `${call.ref}: call with ${call.callee?.name ?? "?"} ended after ${Math.round(secs / 60) || 1} min` : `${call.ref}: call from ${call.caller.name} was not answered${reason === "declined" ? " (declined)" : ""}`, { ticketId: call.ticketId, who: c ? undefined : who });
  } catch (e) {
    console.error("[calls] could not record the call:", (e as Error).message); // the ticket was deleted meanwhile, for example
  }
  signal(everyoneBefore);
  changed(call.ticketId);
}

const REQUEST_VALID_SECONDS = 24 * 3600; // an unanswered request stops showing after a day
const MAX_REQUESTS_PER_HOUR = 5;

/** The open request for a call on this ticket, if there is one: the latest 'call_request' event is "asked" and not too old. */
export async function pendingRequest(ticketId: number): Promise<{ note: string; at: number; by: string } | null> {
  const e = await db
    .prepare(
      `SELECT e.old_value AS note, e.new_value AS state, e.created_at AS at, u.name AS by FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.ticket_id = ? AND e.field = 'call_request' ORDER BY e.id DESC LIMIT 1`,
    )
    .bind(ticketId)
    .first<{ note: string | null; state: string; at: number; by: string | null }>();
  return e && e.state === "asked" && now() - e.at < REQUEST_VALID_SECONDS ? { note: e.note ?? "", at: e.at, by: e.by ?? "" } : null;
}
// notified = 1: these lines are for the conversation, never emailed
const clearRequest = (ticketId: number, reason: "cancelled" | "dismissed" | "answered", actorId: number) =>
  db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'call_request', ?, 'cleared', 1, ?)").bind(ticketId, actorId, reason, now()).run();

/** Network helpers for offices where computers can't reach each other directly (separate VLANs): an optional TURN relay. */
const iceServers = () => (config.turn.url ? [{ urls: config.turn.url.split(",").map((s) => s.trim()).filter(Boolean), username: config.turn.username, credential: config.turn.password }] : []);

export const callRoutes = new Hono<AppEnv>();

// What concerns me right now: a call I am in, or one that is ringing for me.
callRoutes.get("/calls", (c) => {
  const key = keyOf(c.get("user"));
  const mine = [...calls.values()].filter((k) => k.caller.key === key || k.callee?.key === key || (k.state === "ringing" && k.invited.has(key)));
  return c.json({ calls: mine.map((k) => view(k, key)), ice: iceServers() });
});

// Start a call on a ticket: { sdp (the offer), tab }
callRoutes.post("/:id{[0-9]+}/call", async (c) => {
  const user = c.get("user");
  const staff = isStaff(user);
  const id = Number(c.req.param("id"));
  const t = await db
    .prepare(
      `SELECT t.ref, t.title, t.status, t.requester_id, t.assignee_id, u.name AS requester, u.active AS requester_active
       FROM tickets t JOIN users u ON u.id = t.requester_id WHERE t.id = ?`,
    )
    .bind(id)
    .first<{ ref: string; title: string; status: string; requester_id: number; assignee_id: number | null; requester: string; requester_active: number }>();
  if (!t || (!staff && t.requester_id !== user.id)) return c.json({ error: "not found" }, 404);
  if (!staff) return c.json({ error: "IT starts calls. Use “Request a call” and IT will ring you here." }, 403);
  if (t.status === "closed") return c.json({ error: "This ticket is closed." }, 409);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const sdp = sdpOf(body.sdp), tab = tabOf(body.tab);
  if (!sdp || !tab) return c.json({ error: "invalid call" }, 400);
  const me = keyOf(user);
  if (busy(me)) return c.json({ error: "You are already in a call." }, 409);
  if ([...calls.values()].some((k) => k.ticketId === id && k.state !== "ended")) return c.json({ error: "There is already a call on this ticket." }, 409);

  if (t.requester_id === user.id) return c.json({ error: "This is your own ticket." }, 400);
  const invited = new Map<string, { id: number; name: string }>([["r" + t.requester_id, { id: t.requester_id, name: t.requester }]]);
  const call: Call = {
    id: newId(), ticketId: id, ref: t.ref, title: t.title, caller: { key: me, id: user.id, name: user.name, tab, role: user.role }, invited, callee: null,
    state: "ringing", reason: null, offer: sdp, answer: null, share: { caller: false, callee: false }, startedAt: now(), answeredAt: null, timer: null,
  };
  // Nobody to ring (no helpdesk tab open): say so at once and leave a missed call, rather than letting it ring into nothing.
  const reachable = [...invited.keys()].filter((k) => online(k) && !busy(k));
  if (!reachable.length) {
    const inCall = [...invited.keys()].some((k) => busy(k));
    calls.set(call.id, call);
    await finish(call, "missed", c);
    calls.delete(call.id);
    return c.json({ error: inCall ? `${t.requester} is on another call. They will see that you called.` : `${t.requester} doesn't have the helpdesk open right now. They will see that you called. Their request stays open.`, missed: true }, 409);
  }
  for (const k of [...invited.keys()]) if (!reachable.includes(k) && invited.size > 1) invited.delete(k);
  calls.set(call.id, call);
  call.timer = setTimeout(() => void finish(call, "missed"), RING_SECONDS * 1000);
  call.timer.unref();
  await audit(c, "call.start", "ticket", `${t.ref}: called ${t.requester}`, { ticketId: id });
  signal(everyone(call));
  return c.json({ call: view(call, me), ice: iceServers() }, 201);
});

const find = (c: Context<AppEnv>) => {
  const call = calls.get(c.req.param("call") ?? "");
  const key = keyOf(c.get("user"));
  return call && (call.caller.key === key || call.callee?.key === key || call.invited.has(key)) ? { call, key } : null;
};

// Answer: { sdp (the answer), tab }. The first tab to answer takes the call.
callRoutes.post("/calls/:call/accept", async (c) => {
  const f = find(c);
  if (!f) return c.json({ error: "not found" }, 404);
  const { call, key } = f;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const sdp = sdpOf(body.sdp), tab = tabOf(body.tab);
  if (!sdp || !tab) return c.json({ error: "invalid call" }, 400);
  if (call.state !== "ringing" || !call.invited.has(key)) return c.json({ error: call.state === "active" ? "Someone else answered this call." : "This call has ended." }, 409);
  if (busy(key)) return c.json({ error: "You are already in a call." }, 409);
  const before = everyone(call);
  const p = call.invited.get(key)!;
  call.callee = { key, id: p.id, name: p.name, tab };
  call.invited.clear();
  call.state = "active";
  call.answer = sdp;
  call.answeredAt = now();
  if (call.timer) clearTimeout(call.timer);
  call.timer = setTimeout(() => void finish(call, "ended"), MAX_CALL_SECONDS * 1000);
  call.timer.unref();
  await audit(c, "call.answer", "ticket", `${call.ref}: answered the call from ${call.caller.name}`, { ticketId: call.ticketId });
  if (await pendingRequest(call.ticketId)) { await clearRequest(call.ticketId, "answered", p.id); changed(call.ticketId); } // the banner on the open ticket goes away at once
  signal(before);
  return c.json({ call: view(call, key) });
});

// "Not now". When the whole team was ringing, the others keep ringing.
callRoutes.post("/calls/:call/decline", async (c) => {
  const f = find(c);
  if (!f) return c.json({ ok: true });
  const { call, key } = f;
  if (call.state !== "ringing" || !call.invited.has(key)) return c.json({ ok: true });
  if (call.invited.size > 1) {
    call.invited.delete(key);
    signal([key]);
  } else await finish(call, "declined", c);
  return c.json({ ok: true });
});

// Hang up, or stop ringing (the caller gave up). Also sent by the browser when the tab closes.
callRoutes.post("/calls/:call/hangup", async (c) => {
  const f = find(c);
  if (!f) return c.json({ ok: true });
  const { call, key } = f;
  if (call.caller.key === key || call.callee?.key === key) await finish(call, call.state === "active" ? "ended" : "cancelled", c);
  return c.json({ ok: true });
});

// "I am showing my screen now" / "I stopped": { on }
callRoutes.post("/calls/:call/share", async (c) => {
  const f = find(c);
  if (!f || f.call.state !== "active") return c.json({ error: "not found" }, 404);
  const { call, key } = f;
  const side = call.caller.key === key ? "caller" : call.callee?.key === key ? "callee" : null;
  if (!side) return c.json({ error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const on = body.on === true;
  if (call.share[side] !== on) {
    call.share[side] = on;
    await audit(c, on ? "call.screen_on" : "call.screen_off", "ticket", `${call.ref}: ${on ? "started" : "stopped"} showing their screen`, { ticketId: call.ticketId });
    signal(everyone(call));
  }
  return c.json({ ok: true });
});

// A requester asks for a call: { note? }. IT is told; nothing rings until IT decides to call.
callRoutes.post("/:id{[0-9]+}/call-request", async (c) => {
  const user = c.get("user");
  if (isStaff(user)) return c.json({ error: "IT starts calls with the Call button." }, 403);
  const id = Number(c.req.param("id"));
  const t = await db
    .prepare("SELECT ref, title, status, requester_id, assignee_id FROM tickets WHERE id = ?")
    .bind(id)
    .first<{ ref: string; title: string; status: string; requester_id: number; assignee_id: number | null }>();
  if (!t || t.requester_id !== user.id) return c.json({ error: "not found" }, 404);
  if (t.status === "closed") return c.json({ error: "This ticket is closed." }, 409);
  if (await pendingRequest(id)) return c.json({ error: "You have already asked for a call. IT has been told." }, 409);
  const recent = await db
    .prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE actor_id = ? AND field = 'call_request' AND new_value = 'asked' AND created_at > ?")
    .bind(user.id, now() - 3600)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_REQUESTS_PER_HOUR) return c.json({ error: "You have asked for several calls in the last hour. Please wait a little, or write a message on the ticket." }, 429);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const ts = now();
  // The person handling it, or the whole team when nobody is (or they have left).
  const owner = t.assignee_id ? await db.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND role IN ('agent','admin')").bind(t.assignee_id).first<{ id: number }>() : null;
  const title = `${user.name} asked for a call`, text = `${t.ref} · ${note || t.title}`;
  await db.batch([
    db.prepare("INSERT INTO ticket_events (ticket_id, actor_id, field, old_value, new_value, notified, created_at) VALUES (?, ?, 'call_request', ?, 'asked', 1, ?)").bind(id, user.id, note || null, ts),
    owner ? notifyUser(owner.id, id, "call_request", title, text, ts) : notifyStaff(id, "call_request", title, text, ts, user.id),
  ]);
  await audit(c, "call.request", "ticket", `${t.ref}: asked for a call`, { ticketId: id });
  changed(id);
  return c.json({ ok: true, call_request: await pendingRequest(id) }, 201);
});

// The requester takes the request back, or IT closes it without calling ("not now").
callRoutes.delete("/:id{[0-9]+}/call-request", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const t = await db.prepare("SELECT ref, requester_id FROM tickets WHERE id = ?").bind(id).first<{ ref: string; requester_id: number }>();
  if (!t || (!isStaff(user) && t.requester_id !== user.id)) return c.json({ error: "not found" }, 404);
  if (await pendingRequest(id)) {
    await clearRequest(id, isStaff(user) ? "dismissed" : "cancelled", user.id);
    await audit(c, isStaff(user) ? "call.request_dismissed" : "call.request_cancelled", "ticket", `${t.ref}: call request ${isStaff(user) ? "closed by IT" : "cancelled"}`, { ticketId: id });
    changed(id);
  }
  return c.json({ ok: true, call_request: null });
});
