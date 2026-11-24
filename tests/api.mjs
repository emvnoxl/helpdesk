// API test suite: starts the built server (dist-server/index.js) on a random port with a throwaway database and
// exercises all three audiences (normal users, agents, admins), their boundaries, lockouts, password rules,
// staff-account management, the live board's privacy, notifications, and restart persistence.
//   npm test        (builds the server first, then runs this)
import { spawn } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), "fg-api-"));
const DOMAIN = "fortressghana.example";
const ADMIN = `admin@${DOMAIN}`;
const BOOT_PW = "Temp-Passw0rd-1234";
const MAIL_SECRET = "test-inbound-secret-0123456789";
let pass = 0, fail = 0, log = "";

const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(cond ? "ok   " : "FAIL ", name, extra); };

function start(extraEnv = {}) {
  const child = spawn(process.execPath, ["dist-server/index.js"], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, COMPANY_EMAIL_DOMAIN: DOMAIN, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: BOOT_PW, MAIL_LOG_ONLY: "1", NOTIFY_INTERVAL_SECONDS: "1", NODE_ENV: "test", SSO_AUTHORITY: IDP, SSO_GRAPH_URL: IDP + "/graph", STAFF_EMAIL_DELAY_SECONDS: "0", ALT_URLS: "http://helpdesk.fortress.test/", LOGIN_RATE_LIMIT: "1000", INBOUND_SECRET: MAIL_SECRET, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return child;
}
async function waitUp() {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return true; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  return false;
}

const PIN = "482915";
const jar = () => ({ cookie: "", name: "" });
async function req(method, p, body, session = jar(), headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json", ...(session.cookie ? { cookie: session.cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const sc of set) {
    const [pair] = sc.split(";");
    const [n, ...v] = pair.split("=");
    const gone = /max-age=0/i.test(sc) || v.join("") === "";
    const others = session.cookie.split("; ").filter((x) => x && !x.startsWith(n + "="));
    session.cookie = (gone ? others : [...others, pair]).join("; ");
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { code: res.status, json, setCookie: set, headers: res.headers };
}
const maxAge = (r) => Number((r.setCookie[0] ?? "").match(/Max-Age=(\d+)/i)?.[1] ?? 0);
const dbq = (sql, ...p) => { const d = new DatabaseSync(path.join(DATA, "helpdesk.db")); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const dbx = (sql, ...p) => { const d = new DatabaseSync(path.join(DATA, "helpdesk.db")); try { d.prepare(sql).run(...p); } finally { d.close(); } };

import http from "node:http";
import { createHash as sha256, randomBytes as rnd } from "node:crypto";
const TENANT = "0a1b2c3d-0000-4000-8000-0000000000aa", CLIENT = "0a1b2c3d-0000-4000-8000-0000000000bb", CSECRET = "pretend~client.secret";
/* next = who signs in at the pretend Microsoft; flags break one thing at a time. */
const idp = { next: null, codes: new Map(), exchange: null, graphDown: false, badAud: false, badNonce: false, authorizeSeen: null };
const idpServer = http.createServer(async (rq, rs) => {
  const u = new URL(rq.url, "http://idp");
  const send = (code, obj, headers = {}) => { rs.writeHead(code, { "content-type": "application/json", ...headers }); rs.end(JSON.stringify(obj)); };
  if (u.pathname.endsWith("/oauth2/v2.0/authorize")) {
    const p = u.searchParams, redir = p.get("redirect_uri");
    idp.authorizeSeen = Object.fromEntries(p);
    if (idp.next?.error) { rs.writeHead(302, { location: redir + "?error=" + idp.next.error + "&state=" + p.get("state") }); return rs.end(); }
    const code = rnd(12).toString("hex");
    idp.codes.set(code, { nonce: p.get("nonce"), challenge: p.get("code_challenge"), redir, who: idp.next, clientId: p.get("client_id") });
    rs.writeHead(302, { location: redir + "?code=" + code + "&state=" + p.get("state") });
    return rs.end();
  }
  if (u.pathname.endsWith("/oauth2/v2.0/token") && rq.method === "POST") {
    let body = ""; for await (const ch of rq) body += ch;
    const f = new URLSearchParams(body), c = idp.codes.get(f.get("code") ?? "");
    idp.codes.delete(f.get("code") ?? ""); // a code works once
    if (!c) return send(400, { error: "invalid_grant" });
    const pkceOk = sha256("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
    idp.exchange = { secretOk: f.get("client_secret") === CSECRET, pkceOk, redirOk: f.get("redirect_uri") === c.redir, clientOk: f.get("client_id") === c.clientId };
    if (!idp.exchange.secretOk || !pkceOk || !idp.exchange.redirOk) return send(400, { error: "invalid_grant" });
    const w = c.who, authority = "http://" + rq.headers.host;
    const claims = { aud: idp.badAud ? "someone-else" : CLIENT, iss: authority + "/" + TENANT + "/v2.0", tid: TENANT, oid: w.oid, nonce: idp.badNonce ? "nope" : c.nonce, exp: Math.floor(Date.now() / 1000) + 3600, name: w.name, preferred_username: w.email };
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    idp.tokenFor = w;
    return send(200, { token_type: "Bearer", id_token: b({ alg: "none" }) + "." + b(claims) + ".", access_token: "at-" + w.oid });
  }
  if (u.pathname.endsWith("/graph/me")) {
    if (idp.graphDown) return send(500, { error: "down" });
    const w = idp.tokenFor;
    return send(200, { displayName: w.name, mail: w.email, userPrincipalName: w.email, jobTitle: w.job ?? null, department: w.dept ?? null });
  }
  send(404, {});
});
await new Promise((r) => idpServer.listen(0, "127.0.0.1", r));
const IDP = "http://127.0.0.1:" + idpServer.address().port;
let server = start();
if (!(await waitUp())) { console.log("server did not start:\n" + log); process.exit(1); }

// ================= boot =================
ok("server is up and healthy", (await req("GET", "/healthz")).json.ok === true);
ok("first admin created from ADMIN_EMAIL", /Admin account created: admin@/.test(log));
ok("database file created in the data volume", dbq("select count(*) n from users")[0].n === 1);

// ================= normal users =================
const U = jar();
let r = await req("GET", "/api/me", undefined, U);
ok("unidentified visitor gets 401 identify", r.code === 401 && r.json.error === "identify");
r = await req("GET", "/api/tickets", undefined, U);
ok("…and can't list tickets", r.code === 401);
r = await req("POST", "/api/identify", { name: "Ama Boateng", email: "ama@gmail.com" }, U);
ok("email outside the company domain refused", r.code === 400 && /company email/i.test(r.json.error), `(${r.json.error})`);
r = await req("POST", "/api/identify", { name: "Ama", email: "nonsense" }, U);
ok("malformed email refused", r.code === 400);
r = await req("POST", "/api/identify", { name: "", email: `ama@${DOMAIN}` }, U);
ok("empty name refused", r.code === 400);
r = await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}` }, U);
ok("a new email is asked to create a PIN first (and no session is started)", r.code === 401 && r.json.error === "pin_setup" && r.json.new === true && !r.setCookie.length);
r = await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "123456" }, U);
ok("an easy-to-guess PIN is refused (123456)", r.code === 400 && /harder to guess/.test(r.json.error));
r = await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "000000" }, U);
ok("…so is 000000, 121212 and 654321", r.code === 400 && (await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "121212" }, U)).code === 400 && (await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "654321" }, U)).code === 400);
r = await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "12ab" }, U);
ok("a PIN must be exactly 6 digits (letters, 4 or 8 digits are refused)", r.code === 400 && /exactly 6 digits/.test(r.json.error) && (await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "4829" }, U)).code === 400 && (await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: "48291537" }, U)).code === 400);
r = await req("POST", "/api/identify", { name: "Ama Boateng", email: `Ama@${DOMAIN}`, new_pin: PIN }, U);
ok("name + company email + a new PIN creates the account and identifies (case-insensitive)", r.code === 200 && r.setCookie.some((c) => c.startsWith("fg_user=")));
ok("user cookie is HttpOnly", /HttpOnly/i.test(r.setCookie[0]) && /SameSite=Lax/i.test(r.setCookie[0]));
r = await req("GET", "/api/me", undefined, U);
ok("/api/me returns the account", r.json.email === `ama@${DOMAIN}` && r.json.name === "Ama Boateng");

r = await req("POST", "/api/tickets", { title: "Printer jam", description: "Floor 3 printer keeps jamming", category_id: 5, priority: "urgent" }, U);
const t1 = r.json.id;
ok("normal user raised a ticket (priority sent by the client is ignored)", r.code === 201 && /^FG-\d{4}$/.test(r.json.ref));
r = await req("GET", "/api/tickets/" + t1, undefined, U);
ok("ticket starts at medium priority", r.json.ticket.priority === "medium" && r.json.ticket.requester === "Ama Boateng");

const V = jar();
await req("POST", "/api/identify", { name: "Kofi Mensah", email: `kofi@${DOMAIN}`, new_pin: "739104" }, V);
r = await req("GET", "/api/tickets/" + t1, undefined, V);
ok("another user can't open Ama's ticket (404)", r.code === 404);
r = await req("GET", "/api/tickets", undefined, V);
ok("another user's list doesn't include it", r.json.length === 0);

// ================= staff boundaries =================
r = await req("GET", "/api/staff/overview", undefined, U);
ok("normal user session can't reach staff APIs (401)", r.code === 401 && r.json.error === "signed_out");
r = await req("GET", "/api/admin/users", undefined, U);
ok("…or admin APIs (401)", r.code === 401);
const SPOOF = jar();
await req("POST", "/api/identify", { name: "Not Admin", email: ADMIN, new_pin: "620583" }, SPOOF);
r = await req("GET", "/api/staff/overview", undefined, SPOOF);
ok("typing the admin's email as a normal user gives NO staff powers", r.code === 401);
r = await req("GET", "/api/tickets", undefined, SPOOF);
ok("…it is just a normal-user session (sees only its own tickets)", r.code === 200 && Array.isArray(r.json) && r.json.length === 0);

// ================= admin sign-in =================
const A = jar();
r = await req("POST", "/api/staff/login", { email: ADMIN, password: BOOT_PW, portal: "agent" }, A);
ok("an admin can't sign in at the agent portal", r.code === 401 && r.json.error === "incorrect");
r = await req("POST", "/api/staff/login", { email: ADMIN, password: "wrong-password", portal: "admin" }, A);
ok("wrong password -> 401 with attempts left", r.code === 401 && r.json.attempts_left === 4);
r = await req("POST", "/api/staff/login", { email: "nobody@" + DOMAIN, password: "whatever-whatever", portal: "admin" }, A);
ok("unknown email gets the same generic answer", r.code === 401 && r.json.error === "incorrect" && r.json.attempts_left === undefined);
r = await req("POST", "/api/staff/login", { email: ADMIN, password: BOOT_PW, portal: "admin", remember: true }, A);
ok("admin signs in with the bootstrap password", r.code === 200 && r.json.must_change_password === true);
ok("'keep signed in' gives a 12 h cookie, HttpOnly + SameSite=Strict", maxAge(r) === 43200 && /HttpOnly/i.test(r.setCookie[0]) && /SameSite=Strict/i.test(r.setCookie[0]), `(Max-Age ${maxAge(r)})`);
r = await req("GET", "/api/staff/overview", undefined, A);
ok("temporary password must be changed before anything else (403)", r.code === 403 && r.json.error === "password_change_required");
r = await req("GET", "/api/staff/me", undefined, A);
ok("…but /me still works so the screen can say so", r.code === 200 && r.json.must_change_password === true && r.json.role === "admin");
r = await req("POST", "/api/staff/password", { current: BOOT_PW, next: "short" }, A);
ok("new password must be 12+ characters", r.code === 400);
r = await req("POST", "/api/staff/password", { current: "not-the-current-one", next: "a much longer passphrase here" }, A);
ok("wrong current password refused (401)", r.code === 401);
const oldCookie = A.cookie;
const ADMIN_PW = "a much longer passphrase here";
r = await req("POST", "/api/staff/password", { current: BOOT_PW, next: ADMIN_PW }, A);
ok("admin chose a new password", r.code === 200);
r = await req("GET", "/api/staff/overview", undefined, { cookie: oldCookie });
ok("the older session ended when the password changed", r.code === 401);
r = await req("GET", "/api/staff/overview", undefined, A);
ok("this browser got a fresh session and can work", r.code === 200 && Array.isArray(r.json.mine));

// lockout (use a throwaway admin-portal attempt count on a second account later); here test lock on the agent below.

// ================= admin creates an agent =================
r = await req("POST", "/api/admin/users", { name: "Agent Kofi", email: `kofi.agent@${DOMAIN}`, role: "agent" }, A);
const agentId = r.json.id, AGENT_TEMP = r.json.temp_password;
ok("admin created an agent with a one-time temporary password", r.code === 201 && /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(AGENT_TEMP), `(${AGENT_TEMP})`);
r = await req("POST", "/api/admin/users", { name: "Dup", email: `kofi.agent@${DOMAIN}`, role: "agent" }, A);
ok("duplicate staff email refused (409)", r.code === 409);
r = await req("GET", "/api/admin/users", undefined, A);
ok("admin lists staff accounts", r.json.some((u) => u.id === agentId && u.role === "agent" && u.must_change_password === 1));
ok("no password hashes are ever returned", !JSON.stringify(r.json).includes("scrypt"));

const G = jar();
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: AGENT_TEMP, portal: "admin" }, G);
ok("the agent can't sign in at the admin portal", r.code === 401);
// lockout: 5 wrong attempts at the agent portal
for (let n = 1; n <= 4; n++) { r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: "nope-nope-nope" + n, portal: "agent" }, G); }
ok("4th wrong attempt: 1 try left", r.json.attempts_left === 1);
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: "nope-nope-nope5", portal: "agent" }, G);
ok("5th wrong attempt locks the account (429)", r.code === 429 && r.json.error === "locked");
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: AGENT_TEMP, portal: "agent" }, G);
ok("even the right password is refused while locked", r.code === 429);
dbx("UPDATE users SET locked_until = 0, failed_attempts = 0 WHERE id = ?", agentId);
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: AGENT_TEMP, portal: "agent" }, G);
ok("agent signs in at the agent portal after the lock window", r.code === 200 && maxAge(r) === 7200 && r.json.must_change_password === true, `(Max-Age ${maxAge(r)})`);
const AGENT_PW = "agent chooses a long passphrase";
r = await req("POST", "/api/staff/password", { current: AGENT_TEMP, next: AGENT_PW }, G);
ok("agent set their own password", r.code === 200);

// ================= agent powers and limits =================
r = await req("GET", "/api/staff/overview", undefined, G);
ok("agent sees the triage list with the normal user's ticket", r.code === 200 && r.json.triage.some((t) => t.id === t1) && r.json.topCategory === null);
r = await req("GET", "/api/staff/tickets?status=open", undefined, G);
ok("agent can list every open ticket", r.code === 200 && r.json.some((t) => t.id === t1));
r = await req("GET", "/api/admin/users", undefined, G);
ok("agent hits a plain 404 on admin APIs", r.code === 404);
r = await req("GET", "/api/admin/insights", undefined, G);
ok("…including insights", r.code === 404);
r = await req("GET", "/api/admin/board", undefined, G);
ok("…and the full live board", r.code === 404);
r = await req("GET", "/api/staff/tickets/agents", undefined, G);
ok("assignee list includes the admin and the agent", r.json.length === 2);
r = await req("PATCH", "/api/staff/tickets/" + t1, { assignee_id: agentId, status: "in_progress", priority: "high" }, G);
ok("agent takes the ticket and sets its priority", r.code === 200 && r.json.changed);
r = await req("GET", "/api/staff/tickets/" + t1, undefined, G);
ok("priority set by an agent is NOT locked", r.json.ticket.priority === "high" && r.json.ticket.priority_locked === 0 && r.json.ticket.requester_email === `ama@${DOMAIN}`);
r = await req("POST", `/api/staff/tickets/${t1}/comments`, { body: "Looking at it now", internal: false }, G);
r = await req("POST", `/api/staff/tickets/${t1}/comments`, { body: "Internal: needs a new roller", internal: true }, G);
r = await req("GET", "/api/tickets/" + t1, undefined, U);
ok("the requester sees the public reply but not the internal note", r.json.comments.length === 1 && r.json.comments[0].body === "Looking at it now" && r.json.comments[0].author === "Agent Kofi");
ok("chat: thread carries who is 'me', the author's role, and a bounded event log", typeof r.json.me === "number" && r.json.comments[0].author_role === "agent" && r.json.comments[0].author_id !== r.json.me && Array.isArray(r.json.events));
ok("chat: the requester's event log shows status/assignee only, never priority", r.json.events.length > 0 && r.json.events.every((e) => e.field === "status" || e.field === "assignee") && r.json.events.some((e) => e.field === "assignee" && e.new_name === "Agent Kofi"));
r = await req("GET", "/api/staff/tickets/" + t1, undefined, G);
ok("chat: staff see internal notes and priority changes in the thread", r.json.comments.some((c) => c.internal === 1) && r.json.events.some((e) => e.field === "priority"));
r = await req("POST", "/api/tickets/" + t1 + "/comments", { body: "Thanks, it's the roller", internal: true }, U);
r = await req("GET", "/api/staff/tickets/" + t1, undefined, G);
ok("chat: a requester can't post an internal note (it's stored as a normal message)", r.json.comments.find((c) => c.body === "Thanks, it's the roller")?.internal === 0);
r = await req("GET", "/api/notifications", undefined, U);
ok("notifications: the requester is told about IT's reply and the status/assignee changes", r.code === 200 && r.json.items.some((n) => n.kind === "message" && /replied/.test(n.title) && n.ref) && r.json.items.some((n) => n.kind === "status") && r.json.unread >= 2, JSON.stringify(r.json).slice(0, 200));
ok("notifications: internal notes never reach the requester", !r.json.items.some((n) => /Internal note|roller/i.test(n.title + n.body) && n.kind === "note"));
r = await req("GET", "/api/staff/notifications", undefined, G);
ok("notifications: the agent is told about the requester's new message on their ticket", r.code === 200 && r.json.items.some((n) => n.kind === "message" && /roller/.test(n.body)), JSON.stringify(r.json).slice(0, 200));
ok("notifications: the agent got the new-ticket alert too", r.json.items.some((n) => n.kind === "new_ticket" || n.kind === "assigned") || r.json.unread > 0);
r = await req("POST", "/api/notifications/read", { all: true }, U);
r = await req("GET", "/api/notifications", undefined, U);
ok("notifications: mark all read clears the count", r.json.unread === 0);
r = await req("POST", "/api/notifications/read", {}, U);
ok("notifications: marking nothing is a 400", r.code === 400);
r = await req("GET", "/api/staff/notifications", undefined, U);
ok("notifications: a normal user can't use the staff feed (401/403)", r.code === 401 || r.code === 403, String(r.code));

// ---- resolved board, end-of-day close, closed tickets lock the chat
const mk = async (title) => (await req("POST", "/api/tickets", { title, description: "details for " + title, category_id: 5 }, U)).json.id;
const rA = await mk("Resolve me A"), rB = await mk("Resolve me B"), rC = await mk("Resolve me C");
for (const id of [rA, rB, rC]) await req("PATCH", `/api/staff/tickets/${id}`, { assignee_id: (await req("GET", "/api/staff/me", undefined, G)).json.id, status: "resolved" }, G);
r = await req("GET", "/api/staff/overview", undefined, G);
ok("resolved board: agents see resolved tickets (read-only data)", [rA, rB, rC].every((id) => r.json.resolved.some((t) => t.id === id)) && r.json.resolved[0].requester && "resolved_at" in r.json.resolved[0], JSON.stringify(r.json.resolved).slice(0, 160));
r = await req("PATCH", `/api/staff/tickets/${rA}`, { status: "closed" }, G);
ok("only an admin can close: an agent gets 403", r.code === 403, String(r.code));
r = await req("POST", "/api/admin/tickets/close-resolved", {}, G);
ok("agents can't use the close-all endpoint (404)", r.code === 404, String(r.code));
r = await req("PATCH", `/api/staff/tickets/${rA}`, { status: "closed" }, A);
ok("an admin can close a resolved ticket", r.code === 200 && r.json.changed);
r = await req("POST", `/api/tickets/${rA}/comments`, { body: "hello?" }, U);
ok("messaging is off on a closed ticket (requester, 409)", r.code === 409, String(r.code));
r = await req("POST", `/api/staff/tickets/${rA}/comments`, { body: "late note", internal: true }, G);
ok("messaging is off on a closed ticket (staff too, 409)", r.code === 409, String(r.code));
r = await req("PATCH", `/api/staff/tickets/${rA}`, { status: "open" }, G);
ok("an agent can't reopen a closed ticket (403)", r.code === 403);
r = await req("PATCH", `/api/staff/tickets/${rA}`, { status: "open" }, A);
r = await req("POST", `/api/tickets/${rA}/comments`, { body: "back again" }, U);
ok("an admin reopening turns messaging back on", r.code === 201);
r = await req("POST", `/api/tickets/${rB}/comments`, { body: "it broke again" }, U);
r = await req("GET", "/api/tickets/" + rB, undefined, U);
ok("a requester replying on a resolved ticket reopens it", r.json.ticket.status === "open" && r.json.events.some((e) => e.field === "status" && e.new_value === "open"), r.json.ticket.status);
r = await req("POST", "/api/admin/tickets/close-resolved", {}, A);
ok("close-all closes what is still resolved (rC, not the reopened ones)", r.json.closed >= 1, JSON.stringify(r.json));
r = await req("GET", "/api/tickets/" + rC, undefined, U);
ok("close-all: that ticket is closed", r.json.ticket.status === "closed" && !!r.json.ticket.closed_at);
r = await req("GET", "/api/notifications", undefined, U);
ok("close-all: the requester is notified", r.json.items.some((n) => n.kind === "status" && /Resolve me C|closed/.test(n.title + n.body)));
r = await req("GET", "/api/staff/overview", undefined, G);
ok("resolved board is empty after the sweep", !r.json.resolved.some((t) => t.id === rC));
for (const id of [rA, rB]) await req("PATCH", `/api/staff/tickets/${id}`, { status: "closed" }, A); // keep the queue as later checks expect it
r = await req("PATCH", "/api/tickets/" + t1, { status: "closed" }, U);
ok("a normal user can't change a ticket (403)", r.code === 403);

// ================= admin priority lock =================
r = await req("PATCH", "/api/staff/tickets/" + t1, { priority: "urgent" }, A);
ok("admin sets priority -> locked", r.code === 200);
r = await req("PATCH", "/api/staff/tickets/" + t1, { priority: "low" }, G);
ok("agent can't override an admin's priority (403)", r.code === 403);
r = await req("PATCH", "/api/staff/tickets/" + t1, { status: "waiting" }, G);
ok("…but can still change the status", r.code === 200);
r = await req("PATCH", "/api/staff/tickets/" + t1, { priority_locked: false }, G);
r = await req("GET", "/api/staff/tickets/" + t1, undefined, A);
ok("an agent can't unlock it", r.json.ticket.priority_locked === 1);
await req("PATCH", "/api/staff/tickets/" + t1, { priority_locked: false, status: "in_progress" }, A);
r = await req("GET", "/api/staff/tickets/" + t1, undefined, A);
ok("an admin can release the lock", r.json.ticket.priority_locked === 0);

// ================= boards for normal users =================
const W = jar();
await req("POST", "/api/identify", { name: "Esi Owusu", email: `esi@${DOMAIN}`, new_pin: "915270" }, W);
const t2 = (await req("POST", "/api/tickets", { title: "Secret HR laptop issue", description: "private details", category_id: 2 }, W)).json.id;
const t3 = (await req("POST", "/api/tickets", { title: "Wi-Fi drops", description: "on floor 2", category_id: 1 }, U)).json.id;
r = await req("GET", "/api/board", undefined, U);
const b = r.json;
ok("live board: shows what IT is working on", b.working.length === 1 && b.working[0].assignee === "Agent Kofi" && b.working[0].mine === true && b.summary.working === 1);
ok("live board: shows who is next, with positions", b.next.length === 2 && b.next[0].position === 1 && b.next[1].position === 2);
ok("live board: my waiting ticket is flagged and placed", b.next.filter((n) => n.mine).length === 1 && b.mine.find((m) => m.id === t3).position !== null);
ok("live board never leaks other people's titles", !JSON.stringify(b.next).includes("Secret") && !JSON.stringify(b.working).includes("title") && !JSON.stringify(b).includes("Secret HR"));
r = await req("GET", "/api/queue", undefined, U);
const q3 = r.json.items.find((i) => i.id === t3);
ok("my queue agrees with the board on my place in line", q3 && q3.position === b.mine.find((m) => m.id === t3).position, `(#${q3?.position} of ${r.json.waiting_total})`);
ok("my queue shows the ticket IT is working on, with the assignee", r.json.items.find((i) => i.id === t1)?.assignee === "Agent Kofi");
r = await req("GET", "/api/board", undefined, W);
ok("someone else's board highlights only their own ticket", r.json.next.filter((n) => n.mine).length === 1 && r.json.mine.length === 1 && r.json.mine[0].title === "Secret HR laptop issue");

// ================= admin-only data =================
r = await req("GET", "/api/admin/board", undefined, A);
ok("admin reads the full live board", r.code === 200 && Array.isArray(r.json.board) && r.json.inProgress.length >= 1);
r = await req("GET", "/api/admin/insights?days=30", undefined, A);
ok("admin reads the insights", r.code === 200 && r.json.categories.length >= 1 && r.json.slaTargets);
r = await req("GET", "/api/admin/board", undefined, U);
ok("a normal user can't (401, no staff session)", r.code === 401);

// ================= user management guard rails =================
r = await req("PATCH", "/api/admin/users/1", { active: false }, A);
ok("an admin can't disable themselves", r.code === 400);
r = await req("PATCH", "/api/admin/users/1", { role: "agent" }, A);
ok("…or demote themselves (there must always be an admin)", r.code === 400);
r = await req("POST", `/api/admin/users/${agentId}/reset-password`, {}, A);
const RESET = r.json.temp_password;
ok("admin resets an agent's password", r.code === 200 && !!RESET);
r = await req("GET", "/api/staff/overview", undefined, G);
ok("the agent's open session ended immediately", r.code === 401);
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: AGENT_PW, portal: "agent" }, jar());
ok("their old password no longer works", r.code === 401);
const G2 = jar();
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: RESET, portal: "agent" }, G2);
ok("the temporary one does, and must be changed again", r.code === 200 && r.json.must_change_password === true);
r = await req("PATCH", "/api/admin/users/" + agentId, { active: false }, A);
ok("admin disables the agent", r.code === 200);
r = await req("GET", "/api/staff/overview", undefined, G2);
ok("their session is dead", r.code === 401);
r = await req("GET", "/api/staff/overview", undefined, A);
ok("their unfinished tickets went back to triage", r.json.triage.some((t) => t.id === t1 || t.id === t3));
r = await req("POST", "/api/staff/login", { email: `kofi.agent@${DOMAIN}`, password: RESET, portal: "agent" }, jar());
ok("a disabled agent can't sign in", r.code === 401);

// ================= deleting a staff account =================
r = await req("POST", "/api/admin/users", { name: "Agent Temp", email: `temp.agent@${DOMAIN}`, role: "agent" }, A);
const delId = r.json.id, delTemp = r.json.temp_password;
const D = jar();
await req("POST", "/api/staff/login", { email: `temp.agent@${DOMAIN}`, password: delTemp, portal: "agent" }, D);
await req("POST", "/api/staff/password", { current: delTemp, next: "temp agent long passphrase" }, D);
const tDel1 = (await req("POST", "/api/tickets", { title: "Delete test (open)", description: "x", category_id: 1 }, U)).json.id;
const tDel2 = (await req("POST", "/api/tickets", { title: "Delete test (done)", description: "x", category_id: 1 }, U)).json.id;
await req("PATCH", `/api/staff/tickets/${tDel1}`, { assignee_id: delId, status: "in_progress" }, D);
await req("PATCH", `/api/staff/tickets/${tDel2}`, { assignee_id: delId, status: "resolved" }, D);
await req("POST", `/api/staff/tickets/${tDel1}/comments`, { body: "I am on it now" }, D);
r = await req("DELETE", `/api/admin/users/${delId}`, undefined, D);
ok("an agent can't delete accounts (404)", r.code === 404);
r = await req("DELETE", "/api/admin/users/1", undefined, A);
ok("an admin can't delete themselves", r.code === 400);
r = await req("DELETE", "/api/admin/users/999999", undefined, A);
ok("deleting a person who doesn't exist -> 404", r.code === 404);
r = await req("DELETE", `/api/admin/users/${delId}`, undefined, A);
ok("admin deletes the agent", r.code === 200 && r.json.mode === "deleted");
r = await req("POST", "/api/staff/login", { email: `temp.agent@${DOMAIN}`, password: "temp agent long passphrase", portal: "agent" }, jar());
ok("the deleted agent can no longer sign in", r.code === 401);
r = await req("GET", "/api/staff/overview", undefined, D);
ok("their open session ended", r.code === 401);
ok("the account row is really gone", dbq("select count(*) n from users where id = ?", delId)[0].n === 0);
r = await req("GET", "/api/admin/users", undefined, A);
ok("they're gone from the staff list, and the placeholder never shows", !r.json.some((u) => u.id === delId) && !r.json.some((u) => /former/i.test(u.name)));
r = await req("GET", "/api/staff/tickets/" + tDel1, undefined, A);
ok("their in-progress ticket is back to open and unassigned", r.json.ticket.status === "open" && r.json.ticket.assignee_id === null);
r = await req("GET", "/api/staff/tickets/" + tDel2, undefined, A);
ok("their finished ticket stays resolved (just no assignee)", r.json.ticket.status === "resolved" && r.json.ticket.assignee_id === null);
r = await req("GET", "/api/tickets/" + tDel1, undefined, U);
ok("their reply stays on the ticket, shown as 'Former team member'", r.json.comments.some((c) => c.body === "I am on it now" && c.author === "Former team member"));
ok("the audit trail kept its entries", dbq("select count(*) n from ticket_events where ticket_id = ?", tDel1)[0].n >= 2);
// someone who also raised tickets as a normal user is removed from the team, not erased
r = await req("POST", "/api/admin/users", { name: "Ama Boateng", email: `ama@${DOMAIN}`, role: "agent" }, A);
const amaId = r.json.id;
ok("a normal user can be promoted to agent (same account, history kept)", r.code === 201 && amaId === dbq("select id from users where email = ?", `ama@${DOMAIN}`)[0].id);
r = await req("DELETE", `/api/admin/users/${amaId}`, undefined, A);
ok("deleting someone who raised tickets removes them from the team instead", r.code === 200 && r.json.mode === "removed_from_team");
r = await req("GET", "/api/tickets", undefined, U);
ok("…and their own tickets are untouched", r.code === 200 && r.json.length >= 2);
r = await req("POST", "/api/staff/login", { email: `ama@${DOMAIN}`, password: "anything-at-all-123", portal: "agent" }, jar());
ok("…but they can't sign in to the agent portal any more", r.code === 401);

// ================= notifications (log transport, 1 s tick) =================
await new Promise((rs) => setTimeout(rs, 2500));
ok("status/assignee changes were emailed to the requester", /\[mail\] to=ama@fortressghana\.example/.test(log), "");
ok("…naming the assignee", /Agent Kofi is now working on your ticket/.test(log));
ok("events are marked sent", dbq("select count(*) n from ticket_events where notified = 0 and field in ('status','assignee')")[0].n === 0);

// ================= web, headers, origin =================
r = await req("GET", "/");
ok("the web app is served at /", r.code === 200 && /<div id="root">/.test(r.json));
ok("security headers are set", !!r.headers.get("content-security-policy") && r.headers.get("x-content-type-options") === "nosniff");
r = await req("GET", "/agent");
ok("/agent and /admin are SPA routes", r.code === 200 && /<div id="root">/.test(r.json));
r = await req("GET", "/assets/not-here.js");
ok("a missing asset is a real 404, not HTML", r.code === 404 && !/<div id="root">/.test(String(r.json)));
r = await req("GET", "/..%2f..%2fpackage.json");
ok("path traversal is refused", r.code !== 200 || !/"name": "fortress-helpdesk"/.test(String(r.json)));
r = await req("POST", "/api/identify", { name: "X", email: `x@${DOMAIN}` }, jar(), { origin: "http://evil.example" });
ok("cross-site POST is refused (403)", r.code === 403);
r = await req("GET", "/api/nope");
ok("unknown API path is a JSON 404", r.code === 404 && r.json.error === "not found");

// ================= restart keeps data and sessions =================
const cookieBefore = A.cookie;
const ticketsBefore = dbq("select count(*) n from tickets")[0].n;
const exited = new Promise((rs) => server.once("exit", rs));
server.kill("SIGTERM");
await exited;
log = "";
server = start();
const back = await waitUp();
ok("server restarts", back, back ? "" : "\n" + log);
if (!back) process.exit(1);
r = await req("GET", "/api/staff/overview", undefined, { cookie: cookieBefore });
ok("sessions survive a restart (signing key is kept in the volume)", r.code === 200);
ok("data survives a restart", dbq("select count(*) n from tickets")[0].n === ticketsBefore);
ok("the admin isn't re-created on restart", !/Admin account created/.test(log));

// ================= instant updates (server-sent events) =================
const GE = jar();
{
  const made = await req("POST", "/api/admin/users", { name: "Agent Esi", email: `esi.agent@${DOMAIN}`, role: "agent" }, A);
  await req("POST", "/api/staff/login", { email: `esi.agent@${DOMAIN}`, password: made.json.temp_password, portal: "agent" }, GE);
  const pw = await req("POST", "/api/staff/password", { current: made.json.temp_password, next: "Esi-Strong-Passphrase-1" }, GE);
  ok("setup: a second agent signs in", pw.code === 200);
}
{
  const open = async (path, session) => {
    const ac = new AbortController();
    const res = await fetch(BASE + path, { headers: { cookie: session.cookie }, signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", pending = null;
    const waitFor = async (needle, ms = 3000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (buf.includes(needle)) return true;
        pending ??= reader.read().then((c) => { pending = null; if (c.value) buf += dec.decode(c.value); }, () => { pending = null; });
        await Promise.race([pending, new Promise((r) => setTimeout(r, 100))]);
      }
      return buf.includes(needle);
    };
    return { res, waitFor, close: () => ac.abort(), text: () => buf };
  };
  const anon = await fetch(BASE + "/api/stream");
  ok("streams need a session (401 without one)", anon.status === 401);
  const su = await open("/api/stream", U);
  ok("a requester can open the event stream", su.res.status === 200 && /text\/event-stream/.test(su.res.headers.get("content-type")) && (await su.waitFor("event: hello")));
  const sa = await open("/api/staff/stream", A);
  ok("an admin can open the staff event stream", sa.res.status === 200 && (await sa.waitFor("event: hello")));
  const sg = await open("/api/staff/stream", GE);
  await sg.waitFor("event: hello");
  const t0 = Date.now();
  const tNew = (await req("POST", "/api/tickets", { title: "Stream check", description: "x", category_id: 5 }, U)).json.id;
  const got = await su.waitFor("event: change") && await sa.waitFor("event: change") && await sg.waitFor("event: change");
  ok("a new ticket reaches every open screen at once (well under a second)", got && Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  ok("the change event names the ticket and carries nothing private", /"ticket":\d+/.test(sa.text()) && !/Stream check/.test(sa.text() + su.text()));
  ok("only admins receive activity-log events", (await sa.waitFor("event: audit")) && !sg.text().includes("event: audit") && !su.text().includes("event: audit"));
  su.close(); sa.close(); sg.close();
  await req("PATCH", `/api/staff/tickets/${tNew}`, { status: "closed" }, A); // keep the queue as later checks expect it
}

// ================= activity log =================
r = await req("GET", "/api/admin/activity", undefined, A);
ok("admin can read the activity log", r.code === 200 && r.json.rows.length > 10 && typeof r.json.last24h === "object");
const acts = new Set(r.json.rows.map((x) => x.action));
const all = (await req("GET", "/api/admin/activity?limit=100", undefined, A)).json.rows;
const allActs = new Set(all.map((x) => x.action));
ok("it records tickets, messages, sign-ins and account actions", ["ticket.created", "ticket.status", "ticket.assignee", "message.sent", "signin.staff", "account.created", "admin.close_resolved"].every((a) => allActs.has(a)), [...allActs].join(","));
ok("it records failures as security events (wrong password, locked account)", all.some((x) => x.category === "security" && x.action === "signin.failed") && all.some((x) => x.action === "signin.locked"));
ok("every row says who, what, and from where", all.every((x) => x.actor_name && x.summary && x.created_at) && all.filter((x) => x.category === "signin").every((x) => x.ip));
const dump = JSON.stringify(all);
ok("message bodies, passwords and temporary passwords never reach the log", !/roller|Looking at it now|Thanks, it's/.test(dump) && !/Passw0rd|temp_password/.test(dump) && !all.some((x) => /[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/.test(x.summary)));
r = await req("GET", "/api/admin/activity?cat=security", undefined, A);
ok("filtering by category works", r.json.rows.length > 0 && r.json.rows.every((x) => x.category === "security"));
r = await req("GET", "/api/admin/activity?q=" + encodeURIComponent("Printer jam"), undefined, A);
ok("searching the log works", r.json.rows.length > 0 && r.json.rows.every((x) => /printer jam/i.test(x.summary + x.actor_name)));
r = await req("GET", "/api/admin/activity?q=%25", undefined, A);
ok("search treats % literally (no wildcard surprises)", r.code === 200 && r.json.rows.length === 0);
r = await req("GET", "/api/admin/activity?limit=2", undefined, A);
const page2 = await req("GET", `/api/admin/activity?limit=2&before=${r.json.rows[1].id}`, undefined, A);
ok("paging walks back through older entries", r.json.more === true && page2.json.rows.length > 0 && page2.json.rows[0].id < r.json.rows[1].id);
r = await req("GET", "/api/admin/activity", undefined, GE);
ok("agents can't see the activity log (404)", r.code === 404);
r = await req("GET", "/api/admin/activity", undefined, U);
ok("normal users can't see it either (401/404)", r.code === 401 || r.code === 404);
r = await req("GET", "/api/admin/activity/export.csv?cat=ticket", undefined, A);
ok("the log exports as CSV (header, text/csv)", r.code === 200 && /text\/csv/.test(r.headers.get("content-type")) && r.json.startsWith("Time (UTC),Who,Role"), String(r.json).slice(0, 60));
all.length = 0;
const afterExport = (await req("GET", "/api/admin/activity?cat=admin", undefined, A)).json.rows;
ok("exporting is itself logged", afterExport.some((x) => x.action === "report.export"));

// ================= monthly reports =================
r = await req("GET", "/api/admin/reports", undefined, A);
const rep = r.json;
ok("admin gets this month's report", r.code === 200 && /^\d{4}-\d{2}$/.test(rep.month) && rep.partial === true && rep.kpis.created >= 3 && Array.isArray(rep.months), JSON.stringify(rep).slice(0, 120));
ok("report: totals are consistent (categories add up to tickets created)", rep.categories.reduce((a, c) => a + c.n, 0) === rep.kpis.created && rep.daily.reduce((a, d) => a + d.created, 0) === rep.kpis.created);
ok("report: response and resolution times are measured", rep.kpis.median_first_response_h !== null && rep.kpis.median_resolution_h !== null && rep.kpis.resolved >= 3);
ok("report: agents table includes the agent who resolved tickets", rep.agents.some((a) => a.name === "Agent Kofi" && a.resolved >= 1));
ok("report: smart analysis returns a plain-English summary and ranked findings", typeof rep.smart.summary === "string" && rep.smart.summary.includes("ticket") && Array.isArray(rep.smart.insights) && rep.smart.insights.every((x) => x.title && x.severity));
ok("report: no private message text in the report", !/Thanks, it's the roller|Looking at it now/.test(JSON.stringify(rep)));
r = await req("GET", "/api/admin/reports?month=2999-01", undefined, A);
ok("a future month is refused (400)", r.code === 400);
r = await req("GET", "/api/admin/reports?month=2026-13", undefined, A);
ok("a malformed month is refused (400)", r.code === 400);
r = await req("GET", "/api/admin/reports?month=2021-03", undefined, A);
ok("a month with no tickets still returns a clean, empty report", r.code === 200 && r.json.kpis.created === 0 && r.json.smart.insights.every((x) => x.severity !== "alert"));
r = await req("GET", `/api/admin/reports/tickets.csv?month=${rep.month}`, undefined, A);
const lines = r.json.split("\r\n").filter(Boolean);
ok("tickets export as CSV with one row per ticket", r.code === 200 && /text\/csv/.test(r.headers.get("content-type")) && lines[0].startsWith("Ref,Title,Category") && lines.length - 1 === rep.kpis.created, `${lines.length - 1} vs ${rep.kpis.created}`);
{
  const evil = (await req("POST", "/api/tickets", { title: "=HYPERLINK(\"http://x\")", description: "formula test", category_id: 5 }, U)).json.id;
  r = await req("GET", `/api/admin/reports/tickets.csv?month=${rep.month}`, undefined, A);
  ok("CSV cells starting with = are neutralised (no spreadsheet formula injection)", r.json.includes("'=HYPERLINK") && !/(^|,)=HYPERLINK/m.test(r.json));
  await req("PATCH", `/api/staff/tickets/${evil}`, { status: "closed" }, A);
}
r = await req("GET", "/api/admin/reports", undefined, GE);
ok("agents can't open reports (404)", r.code === 404);
r = await req("GET", `/api/admin/reports/tickets.csv?month=${rep.month}`, undefined, GE);
ok("…or download them (404)", r.code === 404);

// ================= sign-in on this computer: personal PIN =================
{
  const a = jar(), b = jar(), c2 = jar(), d = jar();
  const em = `esi.m@${DOMAIN}`, EP = "846213";
  let x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, new_pin: EP }, a);
  ok("first sign-in creates the PIN and is remembered on this computer (long-lived cookie)", x.code === 200 && maxAge(x) >= 100 * 86400, String(maxAge(x)));
  ok("the PIN is stored hashed, never as typed", !JSON.stringify(dbq("select pin_hash from users where email = ?", em)).includes(EP) && /^scrypt/.test(dbq("select pin_hash from users where email = ?", em)[0].pin_hash));
  x = await req("GET", "/api/me", undefined, a);
  ok("/api/me says a PIN is set", x.json.has_pin === true);

  // another computer, or an incognito window, typing the same email
  x = await req("POST", "/api/identify", { name: "Someone Else", email: em }, b);
  ok("a different computer typing that email is asked for the PIN (no session)", x.code === 401 && x.json.error === "pin_required" && !x.setCookie.length);
  x = await req("POST", "/api/identify", { name: "Someone Else", email: em, new_pin: "135790" }, b);
  ok("…and can't just set a new PIN over the owner's", x.code === 401 && x.json.error === "pin_required");
  x = await req("POST", "/api/identify", { name: "Someone Else", email: em, pin: "111222" }, b);
  ok("a wrong PIN is refused and counts the tries left", x.code === 401 && x.json.attempts_left === 4 && !x.setCookie.length);
  x = await req("GET", "/api/tickets", undefined, b);
  ok("…and that computer sees nothing", x.code === 401);
  x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, pin: EP, remember: false }, b);
  ok("the right PIN signs in; 'don't remember me' gives a browser-session cookie (no Max-Age)", x.code === 200 && x.setCookie.length === 1 && !/max-age/i.test(x.setCookie[0]));
  x = await req("GET", "/api/me", undefined, b);
  ok("…and the name typed with the right PIN is kept", x.code === 200 && x.json.name === "Esi Mensah");

  // lockout
  for (let n = 1; n <= 4; n++) x = await req("POST", "/api/identify", { name: "X Y", email: em, pin: "99999" + n }, c2);
  ok("4th wrong PIN: 1 try left", x.json.attempts_left === 1);
  x = await req("POST", "/api/identify", { name: "X Y", email: em, pin: "999995" }, c2);
  ok("5th wrong PIN locks the account (429)", x.code === 429 && x.json.locked_until > Date.now() / 1000);
  x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, pin: EP }, c2);
  ok("even the right PIN is refused while locked", x.code === 429);
  ok("…but computers already signed in keep working", (await req("GET", "/api/me", undefined, a)).code === 200);
  dbx("update users set locked_until = 0, failed_attempts = 0 where email = ?", em);

  // the owner manages the PIN
  x = await req("POST", "/api/security/pin", { current: "000000", next: "573920" }, a);
  ok("changing the PIN needs the current one", x.code === 401);
  x = await req("POST", "/api/security/pin", { current: EP, next: "654321" }, a);
  ok("…and the new one must not be guessable", x.code === 400);
  x = await req("POST", "/api/security/pin", { current: EP, next: "573920" }, a);
  ok("changing the PIN works and keeps this computer signed in", x.code === 200 && (await req("GET", "/api/me", undefined, a)).code === 200);
  ok("…while every other computer is signed out at once", (await req("GET", "/api/me", undefined, b)).code === 401);
  x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, pin: EP }, d);
  ok("the old PIN no longer works", x.code === 401 && x.json.error !== "pin_required");
  x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, pin: "573920" }, d);
  ok("the new PIN does", x.code === 200);
  x = await req("POST", "/api/security/signout-everywhere", {}, a);
  ok("'sign out everywhere' ends the other computers but not this one", x.code === 200 && (await req("GET", "/api/me", undefined, a)).code === 200 && (await req("GET", "/api/me", undefined, d)).code === 401);
  x = await req("POST", "/api/signout", {}, a);
  x = await req("GET", "/api/me", undefined, a);
  ok("signing out ends it on that computer", x.code === 401);

  // admin: find the person and clear a forgotten PIN
  x = await req("GET", "/api/admin/people?q=esi.m", undefined, A);
  const person = x.json.find((p) => p.email === em);
  ok("admin can find a normal user and see whether a PIN is set", x.code === 200 && person && person.has_pin === 1 && !JSON.stringify(x.json).includes("scrypt"));
  x = await req("GET", "/api/admin/people?q=%25", undefined, A);
  ok("people search treats % literally", x.code === 200 && x.json.length === 0);
  x = await req("GET", "/api/admin/people", undefined, GE);
  ok("agents can't list normal users (404)", x.code === 404);
  x = await req("POST", `/api/admin/people/${person.id}/reset-pin`, {}, GE);
  ok("agents can't reset PINs (404)", x.code === 404);
  const e2 = jar();
  await req("POST", "/api/identify", { name: "Esi Mensah", email: em, pin: "573920" }, e2);
  x = await req("POST", `/api/admin/people/${person.id}/reset-pin`, {}, A);
  ok("admin resets the PIN", x.code === 200);
  ok("…which signs that person out everywhere", (await req("GET", "/api/me", undefined, e2)).code === 401);
  x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, pin: "573920" }, jar());
  ok("…and the old PIN is gone: they are asked to create a new one", x.code === 401 && x.json.error === "pin_setup" && x.json.new === false);
  x = await req("POST", "/api/identify", { name: "Esi Mensah", email: em, new_pin: "264809" }, jar());
  ok("a new PIN signs them straight in, with their old tickets and account intact", x.code === 200);

  // an account from before PINs existed
  dbx("update users set pin_hash = null where email = ?", `kofi@${DOMAIN}`);
  x = await req("POST", "/api/identify", { name: "Kofi Mensah", email: `kofi@${DOMAIN}` }, jar());
  ok("an account from before PINs asks the next person to sign in to create one", x.code === 401 && x.json.error === "pin_setup" && x.json.new === false);
  ok("sessions issued before PINs existed still work until they sign out", (await req("GET", "/api/me", undefined, V)).code === 200);

  const log = (await req("GET", "/api/admin/activity?limit=100", undefined, A)).json.rows;
  const acts = new Set(log.map((l) => l.action));
  ok("PIN events are logged: created, failed, locked, changed, reset, sign out everywhere", ["account.registered", "signin.user", "signin.pin_failed", "signin.locked", "account.pin_changed", "account.pin_reset", "signout.everywhere", "signout.user"].every((k) => acts.has(k)), [...acts].join());
  ok("sign-ins are logged with the computer they came from", log.some((l) => l.action === "signin.user" && l.device));
  ok("no PIN ever appears in the log", !/482915|846213|573920|264809|111222/.test(JSON.stringify(log)));
}

// ================= computer details =================
{
  const DV = jar(), KEY = "0123456789abcdef0123456789abcdef", KEY2 = "fedcba9876543210fedcba9876543210";
  await req("POST", "/api/identify", { name: "Dev User", email: `dev.user@${DOMAIN}`, new_pin: "624831" }, DV);
  const info = { browser: "Edge", browserVersion: "126", os: "Windows", osVersion: "11", arch: "x86", bits: "64", cores: 8, memory: 8, screen: { w: 1920, h: 1080, dpr: 1.25, depth: 24 }, gpu: "ANGLE (NVIDIA GeForce RTX 3050)", tz: "Africa/Accra", lang: "en-GB", conn: { type: "4g", down: 10, rtt: 50 }, ua: "Mozilla/5.0 test", evil: "<script>alert(1)</script>", cores_extra: 99 };
  let x = await req("POST", "/api/devices/report", { key: KEY, info }, jar());
  ok("computer reports need a signed-in person (401)", x.code === 401);
  x = await req("POST", "/api/devices/report", { key: "not-a-key", info }, DV);
  ok("a malformed computer key is refused (400)", x.code === 400);
  x = await req("POST", "/api/devices/report", { key: KEY, info }, DV);
  ok("a browser can report what it knows about its computer", x.code === 200 && x.json.id > 0);
  await req("POST", "/api/devices/report", { key: KEY, info: { ...info, cores: 16 } }, DV);
  ok("reporting again updates the same computer instead of adding another", dbq("select count(*) n from devices where device_key = ?", KEY)[0].n === 1 && JSON.parse(dbq("select browser from devices where device_key = ?", KEY)[0].browser).cores === 16);
  const stored = dbq("select browser from devices where device_key = ?", KEY)[0].browser;
  ok("only known fields are stored (unexpected ones are dropped)", !/evil|script|cores_extra/.test(stored) && /Africa\/Accra/.test(stored));
  x = await req("POST", "/api/devices/report", { key: KEY2, info: { os: "x".repeat(5000), cores: -4, memory: "lots", screen: "wide", gpu: { a: 1 } } }, DV);
  const clipped = JSON.parse(dbq("select browser from devices where device_key = ?", KEY2)[0].browser);
  ok("oversized or wrongly typed values are cut down or dropped", x.code === 200 && clipped.os.length <= 40 && clipped.cores === undefined && clipped.memory === undefined && clipped.screen === undefined && clipped.gpu === undefined, JSON.stringify(clipped).slice(0, 120));

  // tickets remember the computer
  const tk = (await req("POST", "/api/tickets", { title: "Slow laptop", description: "very slow", category_id: 2, device_key: KEY }, DV)).json.id;
  x = await req("GET", "/api/staff/tickets/" + tk, undefined, GE);
  ok("staff see which computer a ticket was raised from", x.code === 200 && x.json.device && x.json.device.browser.cores === 16 && x.json.device.browser.os === "Windows");
  x = await req("GET", "/api/tickets/" + tk, undefined, DV);
  ok("the requester's own view of the ticket never includes computer details", x.code === 200 && !("device" in x.json && x.json.device));
  const noDev = (await req("POST", "/api/tickets", { title: "No device", description: "x", category_id: 2 }, DV)).json.id;
  x = await req("GET", "/api/staff/tickets/" + noDev, undefined, GE);
  ok("a ticket without a known computer simply has none", x.json.device === null);
  const other = (await req("POST", "/api/tickets", { title: "Spoof", description: "x", category_id: 2, device_key: "ffffffffffffffffffffffffffffffff" }, U)).json.id;
  ok("a device key that isn't theirs is ignored", (await req("GET", "/api/staff/tickets/" + other, undefined, GE)).json.device === null);
  await req("PATCH", `/api/staff/tickets/${tk}`, { status: "closed" }, A);
  await req("PATCH", `/api/staff/tickets/${noDev}`, { status: "closed" }, A);
  await req("PATCH", `/api/staff/tickets/${other}`, { status: "closed" }, A);

  // the full hardware report
  x = await req("POST", "/api/devices/inventory-link", { key: KEY }, jar());
  ok("asking for a hardware-report link needs a signed-in person", x.code === 401);
  x = await req("POST", "/api/devices/inventory-link", { key: KEY }, DV);
  const link = x.json;
  ok("a signed-in person gets a one-click file and a command for this computer", x.code === 200 && /^http.*\/api\/devices\/script\.cmd\?t=/.test(link.cmd_url) && /^powershell .*script\.ps1\?t=/.test(link.command));
  const tok = new URL(link.cmd_url).searchParams.get("t");
  x = await req("GET", "/api/devices/script.ps1?t=" + tok);
  ok("the PowerShell script is served as plain text, with that computer's token and this server's address", x.code === 200 && /text\/plain/.test(x.headers.get("content-type")) && x.json.includes(tok) && x.json.includes("/api/devices/inventory") && /Win32_ComputerSystem/.test(x.json));
  ok("the script is ASCII only (so it runs in any PowerShell)", !/[^\x00-\x7f]/.test(x.json));
  x = await req("GET", "/api/devices/script.cmd?t=" + tok);
  ok("the .cmd file downloads with Windows line endings and one marker", x.code === 200 && /attachment; filename="fortress-hardware-report\.cmd"/.test(x.headers.get("content-disposition")) && /\r\n/.test(x.json) && (x.json.match(/#PS1START/g) ?? []).length === 1 && x.json.startsWith("@echo off"));
  x = await req("GET", "/api/devices/script.ps1?t=" + tok.slice(0, -3) + "abc");
  ok("a tampered link is refused (410)", x.code === 410);
  x = await req("GET", "/api/devices/script.ps1");
  ok("no link at all is refused too", x.code === 410);

  const hw = { name: "FG-LAPTOP-07", manufacturer: "Dell Inc.", model: "Latitude 5440", serial: "7K4Q9Z3", biosVersion: "1.12.0", chassis: "Laptop", os: "Microsoft Windows 11 Pro", osVersion: "10.0.22631", osBuild: "22631", osArch: "64-bit", installDate: "2024-03-02", lastBoot: "2026-11-13 08:02", domain: "WORKGROUP", user: "ama", cpu: { name: "13th Gen Intel(R) Core(TM) i5-1335U", cores: 10, threads: 12, mhz: 1300 }, ramGb: 16, ramModules: [{ gb: 8, mhz: 5200 }, { gb: 8, mhz: 5200 }], disks: [{ model: "NVMe KIOXIA 512GB", gb: 476.9, type: "SSD" }], volumes: [{ drive: "C:", gb: 475.7, freeGb: 210.4 }], gpus: [{ name: "Intel(R) Iris(R) Xe Graphics", gb: 0.1, driver: "31.0.101.4502" }], nics: [{ name: "Intel Wi-Fi 6E AX211", mac: "AA:BB:CC:DD:EE:FF", ips: ["192.168.1.44"] }], battery: true, password: "hunter2", extra: { x: 1 } };
  x = await req("POST", "/api/devices/inventory", { token: "garbage", hw }, jar());
  ok("a hardware report with a bad token is refused (401)", x.code === 401);
  x = await req("POST", "/api/devices/inventory", { token: tok, hw }, jar());
  ok("the script's report is accepted without any cookie", x.code === 200);
  const hwRow = dbq("select hardware, hardware_at from devices where device_key = ?", KEY)[0];
  ok("it is stored against that computer, minus anything unexpected", hwRow.hardware_at > 0 && JSON.parse(hwRow.hardware).model === "Latitude 5440" && !/hunter2|password|extra/.test(hwRow.hardware));
  x = await req("POST", "/api/devices/inventory", { token: tok, hw: { model: "y".repeat(9000), disks: Array.from({ length: 100 }, () => ({ gb: 1 })), cpu: "no" } }, jar());
  const hw2 = JSON.parse(dbq("select hardware from devices where device_key = ?", KEY)[0].hardware);
  ok("oversized reports are cut down (model clipped, at most 8 disks, bad types dropped)", x.code === 200 && hw2.model.length <= 80 && hw2.disks.length <= 8 && hw2.cpu === undefined);
  await req("POST", "/api/devices/inventory", { token: tok, hw }, jar());

  // admin: People and the computers of each person
  x = await req("GET", "/api/admin/people?q=dev.user", undefined, A);
  const dev = x.json.find((p) => p.email === `dev.user@${DOMAIN}`);
  ok("People shows how many computers a person has and how many sent a full report", dev && dev.computers === 2 && dev.reported === 1, JSON.stringify(dev));
  x = await req("GET", `/api/admin/people/${dev.id}/devices`, undefined, A);
  ok("admin sees each computer: browser details and the full hardware report", x.code === 200 && x.json.length === 2 && x.json.some((d) => d.hardware?.serial === "7K4Q9Z3" && d.browser?.cores === 16));
  x = await req("GET", `/api/admin/people/${dev.id}/devices`, undefined, GE);
  ok("agents can't open a person's computers (404)", x.code === 404);
  x = await req("GET", "/api/me", undefined, DV);
  ok("a person's own session never exposes serial numbers or addresses", !/7K4Q9Z3|AA:BB/.test(JSON.stringify(x.json)));
  const lg = (await req("GET", "/api/admin/activity?limit=100", undefined, A)).json.rows;
  ok("hardware reports are logged, without the serial number or addresses", lg.some((l) => l.action === "hardware.reported" && /FG-LAPTOP-07/.test(l.summary)) && !/7K4Q9Z3|AA:BB|192\.168/.test(JSON.stringify(lg)));
}

// ================= attachments, help articles, saved replies, response targets, feedback =================
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 65)]);
async function upload(session, ticketId, name, bytes, query = "", base = "/api/tickets") {
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), name);
  const res = await fetch(BASE + base + "/" + ticketId + "/attachments" + query, { method: "POST", headers: { cookie: session.cookie }, body: fd }).catch((e) => ({ status: 0, text: async () => String(e.cause?.message ?? e) }));
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { code: res.status, json };
}
const raw = (session, path) => fetch(BASE + path, { headers: { cookie: session.cookie } });
const ST = "/api/staff/tickets";
{
  const RQ = jar(), RQ2 = jar();
  const made = await req("POST", "/api/identify", { name: "Kofi Files", email: "kofi.files@" + DOMAIN, new_pin: "718293" }, RQ);
  ok("a new account says it was just created (starts the first-time setup)", made.code === 200 && made.json.created === true, JSON.stringify(made.json));
  globalThis.__rq = RQ; // reused further down: sign-ins are rate-limited per address
  await req("POST", "/api/identify", { name: "Other Person", email: "other.person@" + DOMAIN, new_pin: "718294" }, RQ2);
  globalThis.__rq2 = RQ2;
  const tk = (await req("POST", "/api/tickets", { title: "Printer on floor 2 is offline", description: "It says offline since this morning, restarted twice.", category_id: 5 }, RQ)).json;
  await req("PATCH", ST + "/" + tk.id, { assignee_id: (dbq("select id from users where email = ?", "esi.agent@" + DOMAIN)[0]).id, status: "in_progress" }, GE);

  // ---- uploads: what is accepted and what is refused
  let x = await upload(RQ, tk.id, "error screen.png", PNG);
  ok("a requester can attach a screenshot (201)", x.code === 201 && x.json.id > 0 && x.json.name === "error screen.png" && x.json.mime === "image/png", JSON.stringify(x.json));
  const shot = x.json.id;
  x = await upload(RQ, tk.id, "tool.exe", Buffer.from("MZ" + "x".repeat(100)));
  ok("an .exe is refused (415)", x.code === 415);
  x = await upload(RQ, tk.id, "fake.png", Buffer.from("this is not an image at all"));
  ok("a file whose contents don't match its type is refused (415)", x.code === 415 && /doesn't look like/.test(x.json.error), JSON.stringify(x.json));
  x = await upload(RQ, tk.id, "big.zip", Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(10 * 1024 * 1024 + 4096)]));
  ok("a file over the size limit is refused (413) with a clear message", x.code === 413 && /too big/i.test(x.json.error), x.code + " " + JSON.stringify(x.json));
  x = await upload(RQ, tk.id, "huge.zip", Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(12 * 1024 * 1024)])).catch(() => ({ code: 0 }));
  ok("a far bigger one is cut off before it is read (413, or the connection is closed)", x.code === 413 || x.code === 0, String(x.code));
  ok("the public config tells the browser the limit", (await req("GET", "/api/config")).json.maxUploadMb === 10);
  x = await upload(RQ, tk.id, "empty.txt", Buffer.alloc(0));
  ok("an empty file is refused (400)", x.code === 400);
  x = await upload(RQ, tk.id, "../../etc/evil.png", PNG);
  ok("a path in the file name is stripped", x.code === 201 && x.json.name === "evil.png", JSON.stringify(x.json));
  const evil = x.json.id;
  x = await upload(RQ2, tk.id, "x.png", PNG);
  ok("another person can't attach to my ticket (404)", x.code === 404);
  x = await upload(jar(), tk.id, "x.png", PNG);
  ok("signed-out people can't upload (401)", x.code === 401);
  ok("the bytes never appear in the activity log, only the file name", (await req("GET", "/api/admin/activity?limit=50", undefined, A)).json.rows.some((l) => l.action === "attachment.added" && /error screen\.png/.test(l.summary)));

  // ---- a draft is private to whoever uploaded it
  let f = await raw(GE, ST + "/" + tk.id + "/attachments/" + shot);
  ok("an unsent draft is invisible to everyone but its uploader (404)", f.status === 404);
  f = await raw(RQ, "/api/tickets/" + tk.id + "/attachments/" + shot);
  ok("…the uploader can see it", f.status === 200);

  // ---- sending a message with files
  x = await req("POST", "/api/tickets/" + tk.id + "/comments", { body: "", attachment_ids: [] }, RQ);
  ok("an empty message with no files is still refused (400)", x.code === 400);
  x = await req("POST", "/api/tickets/" + tk.id + "/comments", { body: "", attachment_ids: [shot] }, RQ);
  ok("a message can be just a file (201)", x.code === 201);
  x = await req("GET", "/api/tickets/" + tk.id, undefined, RQ);
  const msg = x.json.comments.find((m) => m.files?.length);
  ok("the file shows on that message for the requester", msg && msg.files[0].id === shot && msg.files[0].name === "error screen.png" && msg.body === "");
  f = await raw(RQ, "/api/tickets/" + tk.id + "/attachments/" + shot);
  ok("an image is served inline with its real type, nosniff and a sandbox policy", f.status === 200 && f.headers.get("content-type") === "image/png" && /^inline/.test(f.headers.get("content-disposition")) && f.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(f.headers.get("content-security-policy")));
  ok("…and the bytes are intact", Buffer.from(await f.arrayBuffer()).equals(PNG));
  f = await raw(GE, ST + "/" + tk.id + "/attachments/" + shot);
  ok("the agent on the ticket can open it too", f.status === 200);
  f = await raw(RQ2, "/api/tickets/" + tk.id + "/attachments/" + shot);
  ok("a different requester can't (404)", f.status === 404);
  x = await req("GET", "/api/staff/notifications", undefined, GE);
  ok("the assignee is told, with 'Sent an attachment' instead of blank text", x.json.items.some((n) => n.kind === "message" && /attachment/i.test(n.body)), JSON.stringify(x.json.items[0]));

  // someone else's draft can't be borrowed
  const gdraft = (await upload(GE, tk.id, "agent-notes.log", Buffer.from("line one\nline two\n"), "", ST)).json.id;
  x = await req("POST", "/api/tickets/" + tk.id + "/comments", { body: "", attachment_ids: [gdraft] }, RQ);
  ok("a requester can't attach a file the agent uploaded (the message is refused)", x.code === 400);

  // ---- internal notes keep their files private
  x = await req("POST", ST + "/" + tk.id + "/comments", { body: "Looks like the print spooler. Log attached.", internal: true, attachment_ids: [gdraft] }, GE);
  ok("an agent can attach a file to an internal note", x.code === 201);
  x = await req("GET", "/api/tickets/" + tk.id, undefined, RQ);
  ok("the requester doesn't see the note or its file in the ticket", !JSON.stringify(x.json).includes("agent-notes.log"));
  f = await raw(RQ, "/api/tickets/" + tk.id + "/attachments/" + gdraft);
  ok("…and can't download it by id either (404)", f.status === 404);
  f = await raw(GE, ST + "/" + tk.id + "/attachments/" + gdraft);
  ok("staff can; non-images download as attachments", f.status === 200 && /^attachment/.test(f.headers.get("content-disposition")) && /^text\/plain/.test(f.headers.get("content-type")));

  // ---- description files, drafts taken back
  x = await upload(RQ, tk.id, "invoice.pdf", PDF, "?for=ticket");
  ok("the requester can add a file to the description right after raising the ticket", x.code === 201);
  x = await upload(GE, tk.id, "x.pdf", PDF, "?for=ticket", ST);
  ok("an agent can't add to someone's description (403)", x.code === 403);
  x = await req("GET", "/api/tickets/" + tk.id, undefined, RQ);
  ok("description files come back with the ticket", x.json.files.length === 1 && x.json.files[0].name === "invoice.pdf");
  f = await raw(RQ, "/api/tickets/" + tk.id + "/attachments/" + x.json.files[0].id);
  ok("a PDF downloads rather than rendering", /^attachment/.test(f.headers.get("content-disposition")) && f.headers.get("content-type") === "application/pdf");
  x = await req("DELETE", "/api/tickets/" + tk.id + "/attachments/" + evil, undefined, RQ);
  ok("a draft can be taken back before sending", x.code === 200);
  f = await raw(RQ, "/api/tickets/" + tk.id + "/attachments/" + evil);
  ok("…and then it is gone (404)", f.status === 404);
  x = await req("DELETE", "/api/tickets/" + tk.id + "/attachments/" + shot, undefined, RQ);
  ok("a file that was already sent can't be deleted (404)", x.code === 404);
  dbx("update tickets set created_at = created_at - 7200 where id = ?", tk.id);
  x = await upload(RQ, tk.id, "late.pdf", PDF, "?for=ticket");
  ok("later than 30 minutes after raising it, files go on messages instead (403)", x.code === 403);
  dbx("update tickets set created_at = created_at + 7200 where id = ?", tk.id);

  // ---- help articles
  x = await req("GET", "/api/kb", undefined, jar());
  ok("help articles need a signed-in person (401)", x.code === 401);
  x = await req("GET", "/api/kb", undefined, RQ);
  ok("a requester sees the starter library (25+ articles)", x.code === 200 && x.json.length >= 25 && x.json.every((a) => a.published), String(x.json.length));
  ok("…every one is published, titled, in a category and has a readable summary (no raw links or markup)", x.json.every((a) => a.title.length > 8 && a.category && a.excerpt.length > 20 && !/https?:|\*\*|\]\(/.test(a.excerpt)), JSON.stringify(x.json.filter((a) => !a.category || /https?:|\*\*/.test(a.excerpt)).map((a) => a.title)));
  ok("…and the library is the same on every start (nothing is added twice)", new Set(x.json.map((a) => a.title)).size === x.json.length);
  const withVideo = [];
  for (const a of x.json) { const full = (await req("GET", "/api/kb/" + a.id, undefined, RQ)).json; if (/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/m.test(full.body)) withVideo.push(full.title); }
  ok("some articles carry a YouTube video (each as a clean, well-formed link on its own line)", withVideo.length >= 3, JSON.stringify(withVideo));
  ok("the site's content policy lets pages embed only privacy-enhanced YouTube frames", /frame-src https:\/\/www\.youtube-nocookie\.com(;|$)/.test((await req("GET", "/")).headers.get("content-security-policy")), String((await req("GET", "/")).headers.get("content-security-policy")));
  x = await req("GET", "/api/kb/suggest?q=" + encodeURIComponent("printer is offline"), undefined, RQ);
  ok("typing 'printer is offline' suggests the printer article first", x.json.length >= 1 && /printer/i.test(x.json[0].title), JSON.stringify(x.json.map((a) => a.title)));
  x = await req("GET", "/api/kb/suggest?q=" + encodeURIComponent("wifi won't connect on my laptop"), undefined, RQ);
  ok("…and 'wifi won't connect' finds the Wi-Fi article", x.json.some((a) => /wi-fi/i.test(a.title)), JSON.stringify(x.json.map((a) => a.title)));
  x = await req("GET", "/api/kb/suggest?q=" + encodeURIComponent("prin"), undefined, RQ);
  ok("a half-typed word still matches (prefix)", x.json.some((a) => /printer/i.test(a.title)));
  x = await req("GET", "/api/kb/suggest?q=" + encodeURIComponent("quarterly budget forecast invoice"), undefined, RQ);
  ok("an unrelated summary suggests nothing (no noise)", x.json.length === 0, JSON.stringify(x.json.map((a) => a.title)));
  x = await req("GET", "/api/kb/suggest?q=ab", undefined, RQ);
  ok("two letters suggest nothing", x.json.length === 0);

  x = await req("POST", "/api/kb", { title: "Hack the helpdesk", body: "This should not be allowed to exist." }, RQ);
  ok("a requester can't write articles (404)", x.code === 404);
  x = await req("POST", "/api/staff/kb", { title: "Hack", body: "no" }, GE);
  ok("a too-short article is refused with a helpful message (400)", x.code === 400 && /steps|title/i.test(x.json.error), JSON.stringify(x.json));
  x = await req("POST", "/api/staff/kb", { title: "Draft: VPN not connecting", body: "## Steps\n1. Check you are online.\n2. Restart the VPN client.", published: false }, GE);
  ok("an agent writes a draft article (201)", x.code === 201);
  const draft = x.json.id;
  x = await req("GET", "/api/kb/" + draft, undefined, RQ);
  ok("a draft is invisible to requesters (404)", x.code === 404);
  x = await req("GET", "/api/kb?q=vpn", undefined, RQ);
  ok("…and absent from their search", !x.json.some((a) => a.id === draft));
  x = await req("GET", "/api/staff/kb?q=vpn", undefined, GE);
  ok("staff see drafts", x.json.some((a) => a.id === draft && a.published === false));
  x = await req("PATCH", "/api/staff/kb/" + draft, { title: "VPN will not connect", body: "## Steps\n1. Check you are online.\n2. Restart the VPN client.\n3. Raise a ticket.", published: true, category_id: 1 }, GE);
  ok("publishing it is an edit (200)", x.code === 200);
  x = await req("GET", "/api/kb/" + draft, undefined, RQ);
  ok("now requesters can read it and their read is counted", x.code === 200 && x.json.body.includes("Restart the VPN") && x.json.my_vote === null);
  x = await req("POST", "/api/kb/" + draft + "/vote", { helpful: true }, RQ);
  const art1 = (await req("GET", "/api/staff/kb", undefined, GE)).json.find((a) => a.id === draft);
  ok("a requester can say it solved the problem", x.code === 200 && art1.helpful === 1 && art1.views >= 1, JSON.stringify(art1));
  await req("POST", "/api/kb/" + draft + "/vote", { helpful: false }, RQ);
  const art2 = (await req("GET", "/api/staff/kb", undefined, GE)).json.find((a) => a.id === draft);
  ok("changing the vote doesn't count twice", art2.helpful === 0 && art2.not_helpful === 1);
  x = await req("POST", "/api/staff/kb/" + draft + "/vote", { helpful: true }, GE);
  ok("staff can't vote (403)", x.code === 403);
  x = await req("GET", "/api/staff/kb", undefined, RQ);
  ok("the staff article API is closed to requesters (401)", x.code === 401);
  x = await req("DELETE", "/api/staff/kb/" + draft, undefined, GE);
  ok("an article can be deleted", x.code === 200 && (await req("GET", "/api/staff/kb/" + draft, undefined, GE)).code === 404);

  // ---- saved replies
  x = await req("GET", "/api/staff/replies", undefined, RQ);
  ok("saved replies are staff only (401)", x.code === 401);
  x = await req("GET", "/api/staff/replies", undefined, GE);
  ok("an agent starts with the team's starter replies", x.json.length >= 5 && x.json.every((r) => r.shared), String(x.json.length));
  x = await req("POST", "/api/staff/replies", { title: "My greeting", body: "Hi {name}, thanks for reaching out about {ref}." }, GE);
  ok("an agent saves a personal reply", x.code === 201);
  const mine = x.json.id;
  x = await req("POST", "/api/staff/replies", { title: "For everyone", body: "Shared text for the whole team.", shared: true }, GE);
  ok("an agent can't create a team reply (403)", x.code === 403);
  x = await req("POST", "/api/staff/replies", { title: "Team sign-off", body: "Regards, Fortress IT.", shared: true }, A);
  ok("an admin can", x.code === 201);
  const team = x.json.id;
  x = await req("GET", "/api/staff/replies", undefined, A);
  ok("a personal reply is private to its owner", !x.json.some((r) => r.id === mine) && x.json.some((r) => r.id === team));
  x = await req("PATCH", "/api/staff/replies/" + team, { title: "Hijack", body: "changed by an agent" }, GE);
  ok("an agent can't change a team reply (403)", x.code === 403);
  x = await req("PATCH", "/api/staff/replies/" + mine, { title: "My greeting v2", body: "Hello {name}." }, GE);
  ok("…but can change their own", x.code === 200);
  x = await req("PATCH", "/api/staff/replies/" + mine, { title: "Taken over", body: "x x" }, A);
  ok("an admin can't edit someone's personal reply (403)", x.code === 403);
  await req("POST", "/api/staff/replies/" + mine + "/use", {}, GE);
  x = await req("GET", "/api/staff/replies", undefined, GE);
  ok("using a reply moves it up the list", x.json[0].id === mine && x.json[0].uses === 1, JSON.stringify(x.json[0]));
  x = await req("DELETE", "/api/staff/replies/" + mine, undefined, GE);
  ok("a reply can be deleted by its owner", x.code === 200);

  // ---- response targets
  x = await req("GET", "/api/admin/sla", undefined, GE);
  ok("response targets are admin only (404 for agents)", x.code === 404);
  x = await req("GET", "/api/admin/sla", undefined, A);
  ok("the targets start at 4 / 8 / 24 / 72 hours", x.json.hours.urgent === 4 && x.json.hours.high === 8 && x.json.hours.medium === 24 && x.json.hours.low === 72, JSON.stringify(x.json));
  x = await req("PUT", "/api/admin/sla", { urgent: 0, high: 8, medium: 24, low: 72 }, A);
  ok("a zero target is refused (400)", x.code === 400);
  x = await req("PUT", "/api/admin/sla", { urgent: "soon", high: 8, medium: 24, low: 72 }, A);
  ok("a non-number target is refused (400)", x.code === 400);
  const row0 = dbq("select created_at, due_at from tickets where id = ?", tk.id)[0];
  ok("a new ticket's due time is created + the medium target", row0.due_at - row0.created_at === 24 * 3600);
  x = await req("PUT", "/api/admin/sla", { urgent: 2, high: 6, medium: 12, low: 48 }, A);
  ok("an admin changes the targets", x.code === 200 && x.json.hours.medium === 12);
  const row1 = dbq("select created_at, due_at from tickets where id = ?", tk.id)[0];
  ok("open tickets follow the new targets straight away", row1.due_at - row1.created_at === 12 * 3600, String(row1.due_at - row1.created_at));
  x = await req("PATCH", ST + "/" + tk.id, { priority: "urgent" }, GE);
  const row2 = dbq("select created_at, due_at from tickets where id = ?", tk.id)[0];
  ok("a priority change recalculates from the new targets", row2.due_at - row2.created_at === 2 * 3600);
  await req("PATCH", ST + "/" + tk.id, { priority: "medium" }, GE);

  // the clock stops while waiting
  const before = dbq("select due_at from tickets where id = ?", tk.id)[0].due_at;
  x = await req("PATCH", ST + "/" + tk.id, { status: "waiting" }, GE);
  const wt = dbq("select paused_at, status from tickets where id = ?", tk.id)[0];
  ok("'waiting' pauses the clock", wt.status === "waiting" && wt.paused_at > 0);
  dbx("update tickets set due_at = unixepoch() - 600 where id = ?", tk.id);
  ok("a waiting ticket is not counted as overdue", (await req("GET", "/api/staff/overview", undefined, GE)).json.counts.overdue === 0);
  dbx("update tickets set paused_at = unixepoch() - 7200 where id = ?", tk.id);
  x = await req("POST", "/api/tickets/" + tk.id + "/comments", { body: "I tried it, still offline." }, RQ);
  const rs = dbq("select status, paused_at, paused_secs, due_at from tickets where id = ?", tk.id)[0];
  ok("when the requester replies, work resumes (the ticket is back in progress)", rs.status === "in_progress" && rs.paused_at === null);
  ok("…the paused time was added to the due time, not counted against IT", rs.paused_secs >= 7195 && rs.paused_secs <= 7210, String(rs.paused_secs));
  dbx("update tickets set due_at = unixepoch() - 60 where id = ?", tk.id);
  ok("…and once its clock is running and the time is up, it counts as overdue again", (await req("GET", "/api/staff/overview", undefined, GE)).json.counts.overdue === 1);
  x = await req("GET", "/api/tickets/" + tk.id, undefined, RQ);
  ok("the resume shows in the chat as a status change", x.json.events.some((e) => e.field === "status" && e.new_value === "in_progress"));
  dbx("update tickets set due_at = ? where id = ?", before, tk.id);

  // two tickets for the watcher to find after the next restart (see the end of this file)
  const w1 = (await req("POST", "/api/tickets", { title: "Almost late ticket one", description: "This one is close to its target time.", category_id: 1 }, RQ)).json;
  const w2 = (await req("POST", "/api/tickets", { title: "Already late ticket two", description: "This one is past its target time already.", category_id: 1 }, RQ)).json;
  const esiId = (dbq("select id from users where email = ?", "esi.agent@" + DOMAIN)[0]).id;
  dbx("update tickets set due_at = unixepoch() + 600, sla_alert = 0, assignee_id = ?, status = 'in_progress' where id = ?", esiId, w1.id);
  dbx("update tickets set due_at = unixepoch() - 600, sla_alert = 0, assignee_id = ?, status = 'in_progress' where id = ?", esiId, w2.id);
  globalThis.__sla = { w1: w1.id, w2: w2.id, esiId };

  // ---- feedback
  x = await req("POST", "/api/tickets/" + tk.id + "/rating", { rating: 1 }, RQ);
  ok("feedback before the ticket is resolved is refused (409)", x.code === 409);
  await req("PATCH", ST + "/" + tk.id, { status: "resolved" }, GE);
  x = await req("POST", ST + "/" + tk.id + "/rating", { rating: 1 }, GE);
  ok("staff can't rate their own work (403)", x.code === 403);
  x = await req("POST", "/api/tickets/" + tk.id + "/rating", { rating: 5 }, RQ);
  ok("a rating other than fixed / not fixed is refused (400)", x.code === 400);
  x = await req("POST", "/api/tickets/" + tk.id + "/rating", { rating: 1 }, RQ2);
  ok("someone else can't rate my ticket (404)", x.code === 404);
  x = await req("POST", "/api/tickets/" + tk.id + "/rating", { rating: -1, comment: "Still shows offline after the restart" }, RQ);
  const rt1 = dbq("select status, resolved_at, rating, rating_comment, rated_at from tickets where id = ?", tk.id)[0];
  ok("'not fixed' reopens a resolved ticket and keeps the comment", x.code === 200 && x.json.reopened === true && rt1.status === "open" && rt1.resolved_at === null && rt1.rating === -1 && /still shows offline/i.test(rt1.rating_comment));
  x = await req("GET", ST + "/" + tk.id, undefined, GE);
  ok("the comment also lands in the conversation, so the agent sees why", x.json.comments.some((m) => /Still shows offline/.test(m.body) && m.author_role === "requester") && x.json.ticket.rating === -1);
  x = await req("GET", "/api/staff/notifications", undefined, GE);
  ok("the agent is told it isn't fixed", x.json.items.some((n) => /isn't fixed/.test(n.title)));
  await req("PATCH", ST + "/" + tk.id, { status: "resolved" }, GE);
  x = await req("POST", "/api/tickets/" + tk.id + "/rating", { rating: 1, comment: "Thanks, that did it" }, RQ);
  const rt2 = dbq("select status, rating, rated_at, resolved_at from tickets where id = ?", tk.id)[0];
  ok("'fixed' keeps it resolved and replaces the earlier rating", x.code === 200 && x.json.reopened === false && rt2.status === "resolved" && rt2.rating === 1);
  x = await req("PATCH", ST + "/" + tk.id, { status: "closed" }, A);
  x = await req("POST", "/api/tickets/" + tk.id + "/rating", { rating: -1, comment: "Actually it came back" }, RQ);
  ok("'not fixed' on an already closed ticket records it but can't reopen it", x.code === 200 && x.json.reopened === false && dbq("select status from tickets where id = ?", tk.id)[0].status === "closed");
  x = await req("GET", "/api/admin/insights?days=30", undefined, A);
  ok("Insights count the feedback and list who said it wasn't fixed", x.json.totals.rated >= 1 && x.json.unhappy.some((u) => u.id === tk.id && /came back/.test(u.comment)), JSON.stringify(x.json.totals));
  x = await req("GET", "/api/admin/reports", undefined, A);
  ok("the monthly report has a satisfaction figure", x.json.kpis.rated >= 1 && typeof x.json.kpis.rated_good === "number", JSON.stringify(x.json.kpis.rated));
  x = await req("POST", "/api/tickets/" + tk.id + "/comments", { body: "hello?" }, RQ);
  ok("closed tickets still reject messages", x.code === 409);
  x = await upload(RQ, tk.id, "after.png", PNG);
  ok("…and files (409)", x.code === 409);
}

// ================= working hours, tickets by email, checklists, recurring tickets, asset register =================
{
  const RQ = globalThis.__rq; // Kofi Files, still signed in
  let x;
  const due = (id) => dbq("select created_at, due_at from tickets where id = ?", id)[0];

  // ---- working hours
  x = await req("PUT", "/api/admin/sla/calendar", { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" }, GE);
  ok("working hours are admin only (404 for agents)", x.code === 404);
  x = await req("GET", "/api/admin/sla", undefined, A);
  ok("working hours start switched off", x.json.calendar && x.json.calendar.enabled === false, JSON.stringify(x.json.calendar));
  const medium = x.json.hours.medium * 3600;
  x = await req("PUT", "/api/admin/sla/calendar", { enabled: true, days: [], start: "08:00", end: "17:00" }, A);
  ok("working hours with no working day are refused (400)", x.code === 400);
  let t0 = (await req("POST", "/api/tickets", { title: "Screen flickers", description: "It flickers when I open Teams." }, RQ)).json;
  ok("around the clock, the due time is created + target", due(t0.id).due_at - due(t0.id).created_at === medium);
  x = await req("PUT", "/api/admin/sla/calendar", { enabled: true, days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00", holidays: ["2026-12-25", "nonsense"] }, A);
  ok("an admin switches working hours on (bad holiday dates are dropped)", x.code === 200 && x.json.calendar.enabled && x.json.calendar.start === 480 && x.json.calendar.holidays.length === 1, JSON.stringify(x.json));
  const d1 = due(t0.id), at = new Date(d1.due_at * 1000), mins = at.getUTCHours() * 60 + at.getUTCMinutes();
  ok("open tickets are re-timed: the due time falls on a working day, inside office hours", at.getUTCDay() >= 1 && at.getUTCDay() <= 5 && mins >= 480 && mins <= 1020, at.toISOString());
  ok("…and later than the plain target, because nights don't count", d1.due_at - d1.created_at > medium, String(d1.due_at - d1.created_at));
  x = await req("PUT", "/api/admin/sla/calendar", { enabled: false }, A);
  ok("switching it off puts the tickets back on the clock", x.code === 200 && due(t0.id).due_at - due(t0.id).created_at === medium);

  // ---- tickets by email
  {
    // Re-timing every open ticket (working hours on/off, above) also re-timed the two tickets staged for the response-target watcher.
    const { w1, w2, esiId } = globalThis.__sla;
    dbx("update tickets set due_at = unixepoch() + 600, sla_alert = 0, assignee_id = ?, status = 'in_progress' where id = ?", esiId, w1);
    dbx("update tickets set due_at = unixepoch() - 600, sla_alert = 0, assignee_id = ?, status = 'in_progress' where id = ?", esiId, w2);
  }
  const mail = (body, auth = MAIL_SECRET) => req("POST", "/api/inbound/email", body, jar(), auth ? { authorization: "Bearer " + auth } : {});
  x = await mail({ from: `kofi.mensah@${DOMAIN}`, subject: "Hi" }, "");
  ok("the email door needs its secret (401)", x.code === 401);
  x = await mail({ from: `kofi.mensah@${DOMAIN}`, subject: "Hi" }, "wrong-secret-wrong-secret-0000");
  ok("…and the right one", x.code === 401);
  x = await mail({ from: "someone@gmail.com", subject: "Buy now", text: "spam", message_id: "<m0@x>" });
  ok("mail from outside the company is left out", x.code === 200 && x.json.outcome === "ignored", JSON.stringify(x.json));
  x = await mail({ from: `Kofi Mensah <kofi.mensah@${DOMAIN}>`, name: "Kofi Mensah", subject: "FW: Projector in the boardroom won't turn on", text: "Hello IT,\r\n\r\nThe projector is dead since this morning.\r\n\r\n-- \r\nKofi Mensah\r\nFinance", message_id: "<m1@x>" });
  const et = x.json.ticket;
  ok("an email from a colleague raises a ticket", x.json.outcome === "created" && /^FG-\d+$/.test(et?.ref ?? ""), JSON.stringify(x.json));
  const erow = dbq("select t.title, t.description, t.source, t.priority, u.email, u.name, u.role, u.pin_hash from tickets t join users u on u.id = t.requester_id where t.id = ?", et.id)[0];
  ok("…in their name, from the subject, without the signature, at medium priority", erow.title === "Projector in the boardroom won't turn on" && erow.description === "Hello IT,\n\nThe projector is dead since this morning." && erow.source === "email" && erow.priority === "medium" && erow.name === "Kofi Mensah", JSON.stringify(erow));
  ok("…and their new account is a normal user with no PIN yet", erow.role === "requester" && erow.pin_hash === null);
  x = await mail({ from: `kofi.mensah@${DOMAIN}`, subject: "FW: Projector in the boardroom won't turn on", text: "again", message_id: "<m1@x>" });
  ok("the same message twice is taken once", x.json.outcome === "ignored" && x.json.reason === "duplicate");
  x = await mail({ from: `kofi.mensah@${DOMAIN}`, subject: "Automatic reply: Projector", text: "I am on leave", message_id: "<m2@x>" });
  ok("an out-of-office reply is left out", x.json.outcome === "ignored" && x.json.reason === "automatic");
  x = await req("GET", "/api/staff/notifications", undefined, GE);
  ok("the team's bell says it came by email", x.json.items.some((n) => n.ticket_id === et.id && /by email/.test(n.body)));
  await req("PATCH", ST + "/" + et.id, { assignee_id: dbq("select id from users where role = 'agent' and active = 1")[0].id, status: "waiting" }, A);
  await req("POST", ST + "/" + et.id + "/comments", { body: "Is the power light on at the back?" }, GE);
  await req("POST", ST + "/" + et.id + "/comments", { body: "probably the lamp", internal: true }, GE);
  x = await mail({ from: `kofi.mensah@${DOMAIN}`, subject: `RE: [${et.ref}] Projector in the boardroom won't turn on`, text: `Yes, it is red.\n\nOn Mon, 16 Nov 2026 at 09:12, Fortress IT <it@${DOMAIN}> wrote:\n> Is the power light on at the back?\n`, message_id: "<m3@x>" });
  ok("a reply to our email lands on the ticket", x.json.outcome === "replied" && x.json.ticket.id === et.id, JSON.stringify(x.json));
  x = await req("GET", ST + "/" + et.id, undefined, GE);
  ok("…as the requester's message, without the quoted text", x.json.comments.some((m) => m.body === "Yes, it is red." && m.author_role === "requester"), JSON.stringify(x.json.comments.map((m) => m.body)));
  ok("…and a waiting ticket goes back to work", x.json.ticket.status === "in_progress");
  x = await mail({ from: `kofi.files@${DOMAIN}`, subject: `RE: [${et.ref}] Projector`, text: "Mine too", message_id: "<m4@x>" });
  ok("someone else quoting that reference gets their own ticket, not a place in the conversation", x.json.outcome === "created" && x.json.ticket.id !== et.id && !dbq("select body from comments where ticket_id = ?", et.id).some((m) => m.body === "Mine too"));
  x = await mail({ from: ADMIN, subject: `RE: [${et.ref}] Projector`, text: "Close it", message_id: "<m5@x>" });
  ok("email never acts as IT: a staff address quoting someone's ticket only raises its own", x.json.outcome === "created" && dbq("select status from tickets where id = ?", et.id)[0].status === "in_progress");
  await new Promise((r) => setTimeout(r, 2600));
  ok("a reply from IT is emailed to the requester", /\[mail\] to=kofi\.mensah@[^\n]*\n?[\s\S]{0,80}from IT replied:\s+> Is the power light on at the back\?/.test(log), log.split("\n").filter((l) => /kofi/.test(l)).slice(-3).join(" | "));
  ok("…and says they can answer by replying", /Reply to this email to answer/.test(log));
  ok("an internal note is never emailed", !/probably the lamp/.test(log));
  ok("the person who emailed gets a 'we have it' with the reference", new RegExp(`\\[mail\\] to=kofi\\.mensah@[^\\n]*subject="\\[${et.ref}\\][^\\n]*\\n?[\\s\\S]{0,80}raised a ticket`).test(log));
  ok("a ticket raised on the form does not get that email", !/to=kofi\.files@[^\n]*Screen flickers[^\n]*\n?[\s\S]{0,80}raised a ticket/.test(log));
  ok("emails are in the activity log, without their text", dbq("select summary from audit_log where ticket_id = ? and summary like '%by email%'", et.id).length >= 2 && !dbq("select summary from audit_log").some((a) => /it is red/i.test(a.summary)));

  // ---- checklists
  x = await req("GET", "/api/staff/checklists", undefined, GE);
  const starter = x.json.find((k) => k.name === "New starter");
  ok("starter checklists exist for the team", x.code === 200 && x.json.length >= 3 && starter?.items.length >= 5, JSON.stringify(x.json.map((k) => k.name)));
  x = await req("POST", "/api/staff/checklists", { name: "Printer install", items: ["Unbox", "Connect"] }, GE);
  ok("an agent can't create a checklist (403)", x.code === 403);
  x = await req("POST", "/api/staff/checklists", { name: "Printer install", items: "1. Unbox\n- Connect to the network\n\n" }, A);
  ok("an admin can (list markers and blank lines are cleaned)", x.code === 201);
  const pid = x.json.id;
  x = await req("GET", "/api/staff/checklists", undefined, A);
  ok("…with exactly the steps typed", JSON.stringify(x.json.find((k) => k.id === pid).items) === JSON.stringify(["Unbox", "Connect to the network"]));
  x = await req("POST", `/api/staff/checklists/${starter.id}/start`, { subject: "" }, GE);
  ok("starting one needs to say who it is for (400)", x.code === 400);
  x = await req("POST", `/api/staff/checklists/${starter.id}/start`, { subject: "Yaw Darko", note: "Starts Monday in Finance" }, GE);
  const ct = x.json;
  x = await req("GET", ST + "/" + ct.id, undefined, GE);
  ok("an agent starts a checklist: a ticket in their own queue with every step", ct.ref && x.json.ticket.title === "New starter: Yaw Darko" && x.json.ticket.assignee_id === x.json.me && x.json.ticket.source === "checklist" && x.json.tasks.length === starter.items.length && x.json.tasks.every((k) => !k.done), JSON.stringify(x.json.ticket.title));
  const step = x.json.tasks[0];
  x = await req("PATCH", `${ST}/${ct.id}/tasks/${step.id}`, { done: true }, GE);
  ok("ticking a step records who did it", x.code === 200 && x.json.tasks[0].done === 1 && !!x.json.tasks[0].done_by);
  x = await req("POST", `${ST}/${t0.id}/tasks`, { template_id: pid }, GE);
  ok("a checklist can be added to any ticket", x.code === 201 && x.json.tasks.length === 2);
  x = await req("POST", `${ST}/${t0.id}/tasks`, { text: "Test a page" }, GE);
  const extra = x.json.tasks[2];
  ok("…and single steps", x.code === 201 && extra?.text === "Test a page");
  x = await req("GET", "/api/tickets/" + t0.id, undefined, RQ);
  ok("the requester never sees IT's checklist", x.code === 200 && x.json.tasks === undefined);
  x = await req("PATCH", `/api/tickets/${t0.id}/tasks/${extra.id}`, { done: true }, RQ);
  ok("…and can't tick it (403)", x.code === 403);
  x = await req("DELETE", `${ST}/${t0.id}/tasks/${extra.id}`, undefined, GE);
  ok("a step can be removed", x.code === 200 && x.json.tasks.length === 2);

  // ---- recurring tickets
  x = await req("GET", "/api/admin/recurring", undefined, GE);
  ok("recurring tickets are admin only (404 for agents)", x.code === 404);
  x = await req("POST", "/api/admin/recurring", { title: "Check the backups", every: "sometimes", start: "2030-01-31" }, A);
  ok("an unknown repeat is refused (400)", x.code === 400);
  x = await req("POST", "/api/admin/recurring", { title: "Check the backups", description: "Restore one file.", every: "monthly", start: "2030-01-31", priority: "high", checklist_id: pid }, A);
  ok("an admin sets one up", x.code === 201);
  const rid = x.json.id;
  x = await req("GET", "/api/admin/recurring", undefined, A);
  const rr = x.json.find((r) => r.id === rid);
  ok("…for 08:00 on the chosen day", rr && new Date(rr.next_at * 1000).toISOString() === "2030-01-31T08:00:00.000Z" && rr.checklist === "Printer install", JSON.stringify(rr));
  x = await req("POST", `/api/admin/recurring/${rid}/run`, {}, A);
  const rt = x.json;
  x = await req("GET", ST + "/" + rt.id, undefined, GE);
  ok("'Raise now' makes the ticket, with its priority and checklist, without moving the schedule", x.json.ticket.source === "recurring" && x.json.ticket.priority === "high" && x.json.tasks.length === 2 && dbq("select next_at from recurring_tickets where id = ?", rid)[0].next_at === rr.next_at);
  x = await req("PATCH", `/api/admin/recurring/${rid}`, { active: false }, A);
  ok("it can be paused", x.code === 200 && dbq("select active from recurring_tickets where id = ?", rid)[0].active === 0);
  // One that was due 40 days ago (the server was "off"): after the restart below it must fire once and skip ahead.
  x = await req("POST", "/api/admin/recurring", { title: "Empty the print queue log", every: "daily", start: "2030-01-01" }, A);
  dbx("update recurring_tickets set next_at = unixepoch() - 40 * 86400 where id = ?", x.json.id);
  globalThis.__rec = { late: x.json.id, paused: rid };
  dbx("update recurring_tickets set next_at = unixepoch() - 86400 where id = ?", rid);

  // ---- asset register
  x = await req("GET", "/api/admin/assets", undefined, GE);
  ok("the asset register is admin only (404 for agents)", x.code === 404);
  x = await req("GET", "/api/admin/assets", undefined, A);
  ok("it lists every computer with its owner and ticket counts", x.code === 200 && x.json.length >= 1 && x.json.every((d) => d.owner && d.owner_email && typeof d.tickets === "number") && x.json.some((d) => d.hardware?.serial), JSON.stringify(x.json[0] ?? {}).slice(0, 200));

  // ---- calls and screen sharing (the server only introduces the two browsers; the sound itself never passes through it)
  {
    const open = async (p, session) => {
      const ac = new AbortController();
      const res = await fetch(BASE + p, { headers: { cookie: session.cookie }, signal: ac.signal });
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = "", pending = null;
      const waitFor = async (needle, ms = 3000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (buf.includes(needle)) return true;
          pending ??= reader.read().then((c) => { pending = null; if (c.value) buf += dec.decode(c.value); }, () => { pending = null; });
          await Promise.race([pending, new Promise((r) => setTimeout(r, 100))]);
        }
        return buf.includes(needle);
      };
      return { waitFor, close: () => ac.abort(), text: () => buf };
    };
    const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n", ANSWER = SDP + "a=answer\r\n";
    const CT = "/api/tickets", RQ2 = globalThis.__rq2; // Other Person, still signed in
    const mine = async (session, base, id) => (await req("GET", base + "/calls", undefined, session)).json.calls.find((k) => k.id === id);
    const ot = (await req("POST", CT, { title: "Laptop will not charge", description: "Tried two chargers." }, RQ2)).json;
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: SDP, tab: "admintab0001" }, A);
    ok("calling someone who doesn't have the helpdesk open is refused at once and leaves a missed call",
      x.code === 409 && x.json.missed === true && dbq("select count(*) n from notifications where ticket_id = ? and kind = 'call'", ot.id)[0].n === 1 && dbq("select old_value v from ticket_events where ticket_id = ? and field = 'call'", ot.id)[0]?.v === "missed", JSON.stringify(x.json));
    const s2 = await open("/api/stream", RQ2); await s2.waitFor("event: hello");
    const sK = await open("/api/stream", RQ); await sK.waitFor("event: hello");
    x = await req("POST", CT + "/" + ot.id + "/call", { sdp: SDP, tab: "kofitab00001" }, RQ);
    ok("nobody can call on someone else's ticket (404)", x.code === 404);
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: "hello", tab: "admintab0001" }, A);
    ok("a call needs a real session description (400)", x.code === 400);
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: SDP, tab: "admintab0001" }, A);
    const cid = x.json.call?.id;
    ok("staff can call the requester of a ticket", x.code === 201 && x.json.call.state === "ringing" && x.json.call.role === "caller" && x.json.call.offer === undefined, JSON.stringify(x.json));
    ok("the requester's screen is told at once, and nobody else's", (await s2.waitFor("event: call")) && !sK.text().includes("event: call"));
    let k = await mine(RQ2, CT, cid);
    ok("the person being called sees who is ringing, with the offer", k?.role === "invited" && k.offer === SDP && typeof k.with === "string" && k.with.length > 0);
    ok("other people see nothing of the call", (await req("GET", CT + "/calls", undefined, RQ)).json.calls.length === 0);
    x = await req("POST", CT + "/calls/" + cid + "/accept", { sdp: ANSWER, tab: "kofitab00001" }, RQ);
    ok("and can't answer it (404)", x.code === 404);
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: SDP, tab: "esitab000001" }, GE);
    ok("one call per ticket at a time (409)", x.code === 409);
    x = await req("POST", CT + "/calls/" + cid + "/accept", { sdp: ANSWER, tab: "othertab0001" }, RQ2);
    ok("answering connects the two", x.code === 200 && x.json.call.state === "active" && x.json.call.role === "callee", JSON.stringify(x.json));
    x = await req("POST", CT + "/calls/" + cid + "/accept", { sdp: ANSWER, tab: "othertab0002" }, RQ2);
    ok("a second tab can't answer the same call (409)", x.code === 409);
    k = await mine(A, ST, cid);
    ok("the caller receives the answer", k?.answer === ANSWER && k.state === "active");
    x = await req("POST", CT + "/calls/" + cid + "/share", { on: true }, RQ2);
    ok("showing a screen is flagged to the other side only", x.code === 200 && (await mine(A, ST, cid)).remote_sharing === true && (await mine(RQ2, CT, cid)).remote_sharing === false);
    await new Promise((r) => setTimeout(r, 1100));
    x = await req("POST", ST + "/calls/" + cid + "/hangup", {}, A);
    const ev = dbq("select old_value o, new_value n, notified from ticket_events where ticket_id = ? and field = 'call' order by id desc limit 1", ot.id)[0];
    ok("hanging up ends it for both and writes the call onto the ticket", x.code === 200 && (await mine(RQ2, CT, cid))?.state === "ended" && ev.o === "ended" && Number(ev.n) >= 1 && ev.notified === 1, JSON.stringify(ev));
    x = await req("GET", CT + "/" + ot.id, undefined, RQ2);
    ok("calls show in the ticket's conversation", x.json.events.filter((e) => e.field === "call").length === 2);

    // requesters don't start calls: they ask, and IT is told (IT decides when to ring)
    const adminId = dbq("select id from users where email = ?", ADMIN)[0].id;
    await req("PATCH", ST + "/" + ot.id, { assignee_id: adminId }, A);
    const sa = await open("/api/staff/stream", A); await sa.waitFor("event: hello");
    x = await req("POST", CT + "/" + ot.id + "/call", { sdp: SDP, tab: "othertab0001" }, RQ2);
    ok("a requester can't start a call themselves (403)", x.code === 403 && /Request a call/.test(x.json.error ?? ""), JSON.stringify(x.json));
    x = await req("POST", ST + "/" + ot.id + "/call-request", {}, A);
    ok("IT can't send call requests (403)", x.code === 403);
    x = await req("POST", CT + "/" + ot.id + "/call-request", { note: "Easier to show you on screen" }, RQ);
    ok("nobody can ask for a call on someone else's ticket (404)", x.code === 404);
    x = await req("POST", CT + "/" + ot.id + "/call-request", { note: "  Easier   to show you on screen  " }, RQ2);
    ok("a requester can ask IT for a call", x.code === 201 && x.json.call_request?.note === "Easier to show you on screen", JSON.stringify(x.json));
    const nCall = () => dbq("select count(*) n from notifications where ticket_id = ? and kind = 'call_request' and user_id = ?", ot.id, adminId)[0].n;
    ok("the person handling the ticket is told at once", (await sa.waitFor("event: change")) && nCall() === 1);
    ok("and nobody else on the team is bothered", dbq("select count(*) n from notifications where ticket_id = ? and kind = 'call_request'", ot.id)[0].n === 1);
    x = await req("POST", CT + "/" + ot.id + "/call-request", {}, RQ2);
    ok("asking twice is refused while the first is open (409)", x.code === 409);
    let dr = (await req("GET", CT + "/" + ot.id, undefined, RQ2)).json, ds = (await req("GET", ST + "/" + ot.id, undefined, A)).json;
    ok("both sides see the open request", dr.call_request?.note === "Easier to show you on screen" && ds.call_request?.by === "Other Person");
    ok("and a line in the conversation, with the note", [dr, ds].every((d) => d.events.some((e) => e.field === "call_request" && e.new_value === "asked" && e.old_value === "Easier to show you on screen")));
    ok("the request is never emailed", dbq("select count(*) n from ticket_events where ticket_id = ? and field = 'call_request' and notified = 0", ot.id)[0].n === 0);
    x = await req("DELETE", CT + "/" + ot.id + "/call-request", undefined, RQ2);
    dr = (await req("GET", CT + "/" + ot.id, undefined, RQ2)).json;
    ok("the requester can take the request back", x.code === 200 && dr.call_request === null && dr.events.some((e) => e.field === "call_request" && e.old_value === "cancelled"));
    await req("POST", CT + "/" + ot.id + "/call-request", {}, RQ2);
    x = await req("DELETE", ST + "/" + ot.id + "/call-request", undefined, A);
    ok("IT can close a request without calling", x.code === 200 && (await req("GET", CT + "/" + ot.id, undefined, RQ2)).json.call_request === null);
    // a request ends when IT rings and the requester picks up
    await req("POST", CT + "/" + ot.id + "/call-request", { note: "Printer again" }, RQ2);
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: SDP, tab: "admintab0002" }, A);
    const cid3 = x.json.call?.id;
    ok("IT rings the requester from the request", x.code === 201 && (await mine(RQ2, CT, cid3))?.role === "invited", JSON.stringify(x.json));
    ok("the request stays open until they answer", (await req("GET", CT + "/" + ot.id, undefined, RQ2)).json.call_request !== null);
    await req("POST", CT + "/calls/" + cid3 + "/accept", { sdp: ANSWER, tab: "othertab0003" }, RQ2);
    ok("answering closes the request", (await req("GET", CT + "/" + ot.id, undefined, RQ2)).json.call_request === null && dbq("select old_value o from ticket_events where ticket_id = ? and field = 'call_request' order by id desc limit 1", ot.id)[0].o === "answered");
    await req("POST", ST + "/calls/" + cid3 + "/hangup", {}, A);
    // a requester who is not at the helpdesk misses the call but the request stays
    await req("POST", CT + "/" + ot.id + "/call-request", {}, RQ2);
    s2.close();
    await new Promise((r) => setTimeout(r, 16000)); // the "recently online" grace period
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: SDP, tab: "admintab0004" }, A);
    ok("ringing someone who isn't at the helpdesk leaves a missed call and keeps the request open", x.code === 409 && x.json.missed === true && (await req("GET", CT + "/" + ot.id, undefined, RQ2)).json.call_request !== null, JSON.stringify(x.json));
    // asking over and over is slowed down
    let slowed = false;
    for (let i = 0; i < 7 && !slowed; i++) {
      await req("DELETE", CT + "/" + ot.id + "/call-request", undefined, RQ2);
      slowed = (await req("POST", CT + "/" + ot.id + "/call-request", {}, RQ2)).code === 429;
    }
    ok("asking again and again is slowed down (429)", slowed);
    sa.close();
    await req("PATCH", ST + "/" + ot.id, { status: "closed" }, A);
    x = await req("POST", ST + "/" + ot.id + "/call", { sdp: SDP, tab: "admintab0001" }, A);
    ok("no calls on a closed ticket (409)", x.code === 409 && !x.json.missed);
    x = await req("POST", CT + "/" + ot.id + "/call-request", {}, RQ2);
    ok("and no call requests on a closed ticket (409)", x.code === 409);
    const acts = new Set(dbq("select distinct action from audit_log").map((r) => r.action));
    ok("calls and call requests are in the activity log", ["call.start", "call.answer", "call.end", "call.missed", "call.screen_on", "call.request", "call.request_cancelled", "call.request_dismissed"].every((a) => acts.has(a)), [...acts].filter((a) => a.startsWith("call")).join(","));
    sK.close();
  }
}

// ================= ticket emails (printed to the log in tests: MAIL_LOG_ONLY) =================
{
  const RQ = globalThis.__rq;
  const meR = (await req("GET", "/api/me", undefined, RQ)).json;
  const waitLog = async (re, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(log)) return true; await new Promise((r) => setTimeout(r, 200)); } return re.test(log); };
  const quiet = (ms = 3500) => new Promise((r) => setTimeout(r, ms));
  const adminRow = dbq("select id, name from users where email = ?", ADMIN)[0];
  const BS = String.fromCharCode(92);
  const esc = (t) => [...t].map((ch) => (".*+?^$(){}|[]" + BS).includes(ch) ? BS + ch : ch).join("");

  // the requester gets a confirmation for a ticket raised on the web
  const tk = (await req("POST", "/api/tickets", { title: "Mailtest monitor flicker", description: "The screen flickers", category_id: 5 }, RQ)).json;
  ok("a requester is emailed that their web ticket was received", await waitLog(new RegExp("\\[mail\\] to=" + esc(meR.email) + " subject=\"\\[" + tk.ref + "\\] Mailtest monitor flicker\" :: [^\\n]*Hi Kofi,\\s+We have your ticket")), tk.ref);
  ok("the admin is emailed about the new ticket (it was unread: nobody is at the helpdesk in a test)", await waitLog(new RegExp("\\[mail\\] to=" + esc(ADMIN) + " subject=\"[^\"]*\" :: (?:(?!\\[mail\\])[^])*New ticket " + tk.ref + "[:\\n]"), 8000), (log.match(/\[mail\] to=admin@[^\n]*/g) ?? []).slice(-3).join(" | "));
  ok("every email is branded plain text too (name and footer)", /Fortress Oil & Gas Helpdesk\nYou get these emails because of a ticket you raised/.test(log));

  // a reply from IT is emailed with the words, and the status change too
  await req("POST", ST + "/" + tk.id + "/comments", { body: "Please try a different cable, then tell me.", internal: false }, A);
  ok("IT's reply reaches the requester by email with the text", await waitLog(new RegExp("\\[mail\\] to=" + esc(meR.email) + " subject=\"\\[" + tk.ref + "\\][^\\n]*:: [^]*?replied:\\s+> Please try a different cable")));
  await req("PATCH", ST + "/" + tk.id, { status: "resolved" }, A);
  ok("a status change reaches the requester, and 'resolved' says what to do if it is not fixed", await waitLog(/is now Resolved[^]*?If it is not fixed, open the ticket/));

  // a person who switched emails off gets none, and everything still works
  let x = await req("PATCH", "/api/me/preferences", { email_notify: false }, RQ);
  ok("a requester can switch ticket emails off", x.code === 200 && x.json.email_notify === false && (await req("GET", "/api/me", undefined, RQ)).json.email_notify === false);
  ok("…and a nonsense value is refused (400)", (await req("PATCH", "/api/me/preferences", { email_notify: "no" }, RQ)).code === 400);
  const before = log.length;
  await req("POST", ST + "/" + tk.id + "/comments", { body: "SECRET-WORDS-NOT-MAILED", internal: false }, A);
  await req("PATCH", ST + "/" + tk.id, { status: "in_progress" }, A);
  await quiet();
  ok("…so a reply and a status change are not emailed to them", !/SECRET-WORDS-NOT-MAILED/.test(log.slice(before)) && !new RegExp("to=" + esc(meR.email)).test(log.slice(before)));
  ok("…and the events are marked done, not left to pile up", dbq("select count(*) n from ticket_events where ticket_id = ? and notified = 0 and field in ('status','reply')", tk.id)[0].n === 0);
  await req("PATCH", "/api/me/preferences", { email_notify: true }, RQ);

  // staff: one email for several things, nothing for what they have read, nothing when switched off
  const esi = dbq("select id from users where email = ?", "esi.agent@" + DOMAIN)[0].id;
  dbx("insert into notifications (user_id, ticket_id, kind, title, body) values (?, null, 'new_ticket', 'DIGEST-ONE', 'first thing'), (?, null, 'assigned', 'DIGEST-TWO', 'second thing'), (?, null, 'message', 'DIGEST-THREE', 'third thing')", esi, esi, esi);
  dbx("insert into notifications (user_id, ticket_id, kind, title, body, read_at) values (?, null, 'new_ticket', 'ALREADY-READ-ONE', 'seen', unixepoch())", esi);
  ok("several waiting things become ONE email", await waitLog(/to=esi\.agent@[^ ]+ subject="3 updates waiting on the helpdesk" :: [^]*?DIGEST-ONE[^]*?DIGEST-TWO[^]*?DIGEST-THREE/));
  ok("…and the same email is not sent twice", (log.match(/to=esi\.agent@[^ ]+ subject="3 updates waiting on the helpdesk"/g) ?? []).length === 1);
  await quiet(2500);
  ok("a notification they already read is never emailed", !/ALREADY-READ-ONE/.test(log));
  ok("…and the rows are marked emailed", dbq("select count(*) n from notifications where user_id = ? and emailed = 0", esi)[0].n === 0);
  x = await req("PATCH", "/api/staff/profile", { email_notify: false }, GE);
  ok("an agent can switch their emails off (their name is untouched)", x.code === 200 && x.json.email_notify === false && (await req("GET", "/api/staff/me", undefined, GE)).json.email_notify === false);
  dbx("insert into notifications (user_id, ticket_id, kind, title, body) values (?, null, 'new_ticket', 'SWITCHED-OFF-ONE', 'nope')", esi);
  await quiet();
  ok("…and then they are not emailed", !/SWITCHED-OFF-ONE/.test(log));
  await req("PATCH", "/api/staff/profile", { email_notify: true }, GE);
  ok("a bell-only kind (like a status tick) is never emailed to staff", (() => { dbx("insert into notifications (user_id, ticket_id, kind, title, body) values (?, null, 'status', 'BELL-ONLY-ONE', 'x')", esi); return true; })() && !(await waitLog(/BELL-ONLY-ONE/, 3000)));

  // the admin's test email and mail status
  x = await req("GET", "/api/admin/system", undefined, A);
  ok("the system page reports the mail transport and the last success", x.json.mail_status.transport === "log" && x.json.mail_status.last_ok_at > 0 && x.json.mail_status.last_error === null && x.json.admin_email === ADMIN, JSON.stringify(x.json.mail_status));
  x = await req("POST", "/api/admin/system/test-email", {}, A);
  ok("an admin can send a test email to themselves", x.code === 200 && x.json.to === ADMIN && x.json.via === "log" && await waitLog(new RegExp("to=" + esc(ADMIN) + " subject=\"Test email from the Fortress Oil & Gas Helpdesk\"")));
  ok("a bad address is refused (400)", (await req("POST", "/api/admin/system/test-email", { to: "not an address" }, A)).code === 400);
  ok("an agent can't use it (404)", (await req("POST", "/api/admin/system/test-email", {}, GE)).code === 404);
  ok("the test is in the activity log", dbq("select count(*) n from audit_log where action = 'system.test_email'")[0].n === 1);
  ok("switching emails off is in the activity log", dbq("select count(*) n from audit_log where action = 'account.email_notify'")[0].n >= 3);
}

// ================= updates, system page, backups, hardware-script addresses =================
{
  const openS = async (p, session) => {
    const ac = new AbortController();
    const res = await fetch(BASE + p, { headers: { cookie: session.cookie }, signal: ac.signal });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", pending = null;
    const waitFor = async (needle, ms = 3000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (buf.includes(needle)) return true;
        pending ??= reader.read().then((c) => { pending = null; if (c.value) buf += dec.decode(c.value); }, () => { pending = null; });
        await Promise.race([pending, new Promise((r) => setTimeout(r, 100))]);
      }
      return buf.includes(needle);
    };
    return { res, waitFor, close: () => ac.abort(), text: () => buf };
  };
  const adminId = dbq("select id from users where email = ?", ADMIN)[0].id;

  // the version, to everybody
  let x = await req("GET", "/api/config");
  const ver = x.json.system?.version;
  ok("the public config says which version runs (and that no update is announced)", x.code === 200 && typeof ver === "string" && ver.length > 0 && x.json.system.maintenance === null && x.json.system.restarting === false);
  x = await req("GET", "/healthz");
  ok("the health check carries the version too", x.json.ok === true && x.json.version === ver);
  x = await req("GET", "/api/admin/system", undefined, A);
  ok("the admin system page reports version, uptime, sizes and mail mode", x.code === 200 && x.json.version === ver && x.json.started_at > 0 && x.json.db_bytes > 0 && x.json.mail === "log", JSON.stringify(x.json).slice(0, 160));
  ok("an agent gets a plain 404 for it", (await req("GET", "/api/admin/system", undefined, GE)).code === 404);
  ok("signed out is 401", (await req("GET", "/api/admin/system")).code === 401);

  // every stream starts with the version, and hears about an announced update
  const sa = await openS("/api/staff/stream", A);
  ok("a stream's first message carries the version", (await sa.waitFor("event: hello")) && sa.text().includes('"version":"' + ver + '"'));
  const RS = globalThis.__rq; // a normal user who is still signed in
  const sr = await openS("/api/stream", RS);
  await sr.waitFor("event: hello");
  x = await req("POST", "/api/admin/system/maintenance", { minutes: 0 }, A);
  ok("an announcement needs 1 to 240 minutes (400)", x.code === 400);
  ok("an agent can't announce (404)", (await req("POST", "/api/admin/system/maintenance", { minutes: 5 }, GE)).code === 404);
  x = await req("POST", "/api/admin/system/maintenance", { minutes: 5, message: "New ticket form" }, A);
  ok("an admin announces an update in 5 minutes", x.code === 200 && x.json.maintenance?.message === "New ticket form" && Math.abs(x.json.maintenance.at - (Date.now() + 300000)) < 15000);
  ok("a signed-in requester's open screen hears about it at once", await sr.waitFor('"message":"New ticket form"'));
  ok("…and so does a page that loads later (public config)", (await req("GET", "/api/config")).json.system.maintenance?.message === "New ticket form");
  ok("…and the system page shows it", (await req("GET", "/api/admin/system", undefined, A)).json.maintenance?.message === "New ticket form");
  ok("the announcement is in the activity log", dbq("select count(*) n from audit_log where action = 'system.announce'")[0].n === 1);
  x = await req("DELETE", "/api/admin/system/maintenance", undefined, A);
  ok("cancelling clears it everywhere", x.code === 200 && (await req("GET", "/api/config")).json.system.maintenance === null);
  sr.close();

  // backups
  x = await req("GET", "/api/admin/backups", undefined, A);
  ok("backups: nothing yet, and automatic backups are on", x.code === 200 && x.json.enabled === true && x.json.files.length === 0 && x.json.healthy === false && x.json.inside_data === true, JSON.stringify(x.json).slice(0, 200));
  ok("an agent can't see backups (404)", (await req("GET", "/api/admin/backups", undefined, GE)).code === 404);
  ok("an agent can't start one (404)", (await req("POST", "/api/admin/backups/run", undefined, GE)).code === 404);
  x = await req("POST", "/api/admin/backups/run", undefined, A);
  const file = x.json.file;
  ok("an admin can back up now", x.code === 200 && x.json.ok === true && /^helpdesk-\d{8}-\d{4}\.db\.gz$/.test(file) && x.json.bytes > 1000, JSON.stringify(x.json));
  x = await req("GET", "/api/admin/backups", undefined, A);
  ok("it is listed and the status is healthy", x.json.files.length === 1 && x.json.files[0].name === file && x.json.healthy === true && x.json.last_ok?.file === file);
  const dl = await fetch(BASE + "/api/admin/backups/" + file, { headers: { cookie: A.cookie } });
  const gz = Buffer.from(await dl.arrayBuffer());
  const raw = (await import("node:zlib")).gunzipSync(gz);
  ok("the download is gzip and unpacks to a SQLite database", dl.status === 200 && /gzip/.test(dl.headers.get("content-type")) && raw.subarray(0, 15).toString() === "SQLite format 3");
  const restored = path.join(DATA, "restore-check.db");
  fs.writeFileSync(restored, raw);
  const rdb = new DatabaseSync(restored);
  const hasAdmin = rdb.prepare("select count(*) n from users where email = ?").get(ADMIN).n === 1;
  rdb.close(); fs.rmSync(restored, { force: true });
  ok("and the copy contains the data (the admin account is in it)", hasAdmin);
  ok("a file name that isn't a backup is refused (404)", (await req("GET", "/api/admin/backups/..%2f..%2fhelpdesk.db", undefined, A)).code === 404 && (await req("GET", "/api/admin/backups/helpdesk.db", undefined, A)).code === 404);
  ok("an agent can't download one (404)", (await req("GET", "/api/admin/backups/" + file, undefined, GE)).code === 404);
  ok("backups and downloads are in the activity log", ["backup.ok", "backup.download"].every((a) => dbq("select count(*) n from audit_log where action = ?", a)[0].n >= 1));

  // the hardware script knows more than one address
  const DVK = globalThis.__rq;
  x = await req("POST", "/api/devices/inventory-link", { key: "aaaabbbbccccddddeeeeffff00001111" }, DVK);
  const tk = x.code === 200 ? new URL(x.json.cmd_url).searchParams.get("t") : "";
  x = await req("GET", "/api/devices/script.ps1?t=" + tk);
  const urls = (x.json.match(/\$urls = @\((.*)\)/) ?? [])[1] ?? "";
  ok("the report script tries the address the browser used first, then the configured ones", x.code === 200 && urls.startsWith("'" + BASE + "'") && urls.includes("'http://helpdesk.fortress.test'"), urls);
  ok("…each is tried in turn and the failure lists them all", x.json.includes("foreach ($u in $urls)") && x.json.includes("Could not send the report. Tried:") && !x.json.includes("__URL"));

  // an update while the server was off: set up for the restart below
  dbx("update settings set value = 'previous-build' where key = 'app_version'");
  globalThis.__restartStream = await openS("/api/staff/stream", A);
  await globalThis.__restartStream.waitFor("event: hello");
  globalThis.__ver = ver;
  sa.close();
}

// ================= address and email setup from the admin page (overrides .env, secrets never come back) =================
{
  const S = "/api/admin/system/settings";
  const RQ = globalThis.__rq;
  const waitLog = async (re, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(log)) return true; await new Promise((r) => setTimeout(r, 200)); } return re.test(log); };
  let x = await req("GET", S, undefined, A);
  ok("the setup page reads what .env gave: trial mail, no saved address", x.code === 200 && x.json.mail.mode === "log" && x.json.mail.source === "env" && x.json.address.source === "env" && x.json.address.app_url === "" && x.json.address.alt_urls.includes("http://helpdesk.fortress.test"), JSON.stringify(x.json));
  ok("an agent gets a plain 404, signed out gets 401", (await req("GET", S, undefined, GE)).code === 404 && (await req("PUT", S, { address: { app_url: "http://x.test" } }, GE)).code === 404 && (await req("GET", S)).code === 401);

  // validation
  ok("nothing to save is refused (400)", (await req("PUT", S, {}, A)).code === 400);
  ok("a badly written address is refused (400)", (await req("PUT", S, { address: { app_url: "helpdesk.test" } }, A)).code === 400 && (await req("PUT", S, { address: { app_url: "http://a.test/path?x=1" } }, A)).code === 400 && (await req("PUT", S, { address: { app_url: "http://a b.test" } }, A)).code === 400);
  ok("an address with a quote in it (it ends up inside a script) is refused", (await req("PUT", S, { address: { app_url: "http://a.test", alt_urls: ["http://x.test'; calc; '"] } }, A)).code === 400);
  x = await req("PUT", S, { address: { app_url: "https://helpdesk.test" } }, A);
  ok("an https address can't be saved while you are on plain http (you would be signed out)", x.code === 400 && /plain http/.test(x.json.error));
  ok("a made-up mode is refused", (await req("PUT", S, { mail: { mode: "carrier-pigeon" } }, A)).code === 400);
  ok("SMTP needs a server, a sane port and a password for its username", (await req("PUT", S, { mail: { mode: "smtp", from: "h@x.test", smtp: { host: "", port: 587 } } }, A)).code === 400 && (await req("PUT", S, { mail: { mode: "smtp", from: "h@x.test", smtp: { host: "mail.x.test", port: 99999 } } }, A)).code === 400 && (await req("PUT", S, { mail: { mode: "smtp", from: "h@x.test", smtp: { host: "mail.x.test", port: 587, user: "h@x.test" } } }, A)).code === 400);
  ok("Microsoft 365 needs real-looking IDs, a secret and a mailbox", (await req("PUT", S, { mail: { mode: "graph", graph: { tenant_id: "nope", client_id: "nope", sender: "h@x.test" } } }, A)).code === 400 && (await req("PUT", S, { mail: { mode: "graph", graph: { tenant_id: "0a1b2c3d-0000-4000-8000-000000000001", client_id: "0a1b2c3d-0000-4000-8000-000000000002", sender: "h@x.test" } } }, A)).code === 400);
  ok("the From address must be an address", (await req("PUT", S, { mail: { mode: "log", from: "not an address" } }, A)).code === 400);

  // the address: saved, in force at once, in the report script and in email links
  x = await req("PUT", S, { address: { app_url: "http://helpdesk.fortress.test:8080/", alt_urls: "http://10.0.0.5:3000, http://nas.fortress.test", trust_proxy: false } }, A);
  ok("an admin saves the address (trailing slash dropped)", x.code === 200 && x.json.address.app_url === "http://helpdesk.fortress.test:8080" && x.json.address.alt_urls.length === 2 && x.json.address.source === "saved", JSON.stringify(x.json.address));
  ok("the system page shows the saved address", (await req("GET", "/api/admin/system", undefined, A)).json.app_url === "http://helpdesk.fortress.test:8080");
  const lk = await req("POST", "/api/devices/inventory-link", { key: "99998888777766665555444433332222" }, RQ);
  const tk0 = lk.code === 200 ? new URL(lk.json.cmd_url).searchParams.get("t") : "";
  const sc = (await req("GET", "/api/devices/script.ps1?t=" + tk0)).json;
  ok("the hardware script now tries the saved address and the other addresses too", typeof sc === "string" && sc.includes("'http://helpdesk.fortress.test:8080'") && sc.includes("'http://10.0.0.5:3000'") && sc.includes("'http://nas.fortress.test'"));
  const tkn = (await req("POST", "/api/tickets", { title: "Setup page link test", description: "x", category_id: 5 }, RQ)).json;
  ok("emails now carry a button straight to the ticket", await waitLog(new RegExp("Open my ticket: http://helpdesk\\.fortress\\.test:8080/\\?t=" + tkn.id + "\\b")));

  // email: SMTP with a password, which is stored encrypted and never returned
  const PASS = "s3cret-Smtp-passw0rd";
  x = await req("PUT", S, { mail: { mode: "smtp", from: "helpdesk@fortress.test", smtp: { host: "127.0.0.1", port: 1, secure: false, user: "helpdesk@fortress.test", pass: PASS } } }, A);
  ok("an admin saves SMTP settings", x.code === 200 && x.json.mail.mode === "smtp" && x.json.mail.smtp.host === "127.0.0.1" && x.json.mail.smtp.has_pass === true && x.json.mail.source === "saved", JSON.stringify(x.json.mail));
  ok("the password is never in any response", !JSON.stringify(x.json).includes(PASS) && !JSON.stringify((await req("GET", S, undefined, A)).json).includes(PASS) && !JSON.stringify((await req("GET", "/api/admin/system", undefined, A)).json).includes(PASS));
  const raw = dbq("select value from settings where key = 'app_settings'")[0].value;
  ok("…and it is encrypted in the database", !raw.includes(PASS) && raw.includes("enc1:"));
  x = await req("PUT", S, { mail: { mode: "smtp", from: "helpdesk@fortress.test", smtp: { host: "127.0.0.1", port: 1, secure: false, user: "helpdesk@fortress.test", pass: "" } } }, A);
  ok("saving again with the password box empty keeps the saved password", x.code === 200 && x.json.mail.smtp.has_pass === true);
  ok("the system page now says SMTP", (await req("GET", "/api/admin/system", undefined, A)).json.mail === "smtp");
  x = await req("POST", "/api/admin/system/test-email", {}, A);
  ok("a test email to an unreachable server fails with the real reason, not silence (502)", x.code === 502 && /ECONNREFUSED|connect/i.test(x.json.error), JSON.stringify(x.json));
  const info = (await req("GET", "/api/admin/system", undefined, A)).json.mail_status;
  ok("…and the failure is shown on the system page", /smtp/.test(info.last_error ?? "") && info.last_error_at > 0, JSON.stringify(info));
  ok("settings changes are in the activity log, without any secret", dbq("select count(*) n from audit_log where action = 'system.settings'")[0].n >= 3 && !dbq("select group_concat(summary) s from audit_log")[0].s.includes(PASS));

  // Microsoft 365 values are kept too, secret hidden
  x = await req("PUT", S, { mail: { mode: "graph", from: "", graph: { tenant_id: "0a1b2c3d-0000-4000-8000-000000000001", client_id: "0a1b2c3d-0000-4000-8000-000000000002", client_secret: "graph~Secret.value", sender: "helpdesk@fortress.test" } } }, A);
  ok("an admin saves Microsoft 365 settings (and SMTP is switched off)", x.code === 200 && x.json.mail.mode === "graph" && x.json.mail.graph.has_secret === true && x.json.mail.smtp.host === "" && !JSON.stringify(x.json).includes("graph~Secret"), JSON.stringify(x.json.mail));

  // back to trial mode for the rest of the suite; it must survive a restart (checked after the restart below)
  x = await req("PUT", S, { mail: { mode: "log", from: "helpdesk@fortress.test" } }, A);
  ok("back to trial mode", x.code === 200 && x.json.mail.mode === "log" && x.json.mail.smtp.host === "" && x.json.mail.graph.client_id === "");
}

// ================= sign in with Microsoft 365 (against the pretend Microsoft above) =================
{
  const S = "/api/admin/system/settings";
  const RQ = globalThis.__rq;
  /** GET without following redirects, keeping cookies like a browser would. */
  const getRaw = async (url, session) => {
    const res = await fetch(url, { redirect: "manual", headers: session.cookie ? { cookie: session.cookie } : {} });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";"); const [n, ...v] = pair.split("=");
      const gone = /max-age=0/i.test(sc) || v.join("") === "";
      session.cookie = [...session.cookie.split("; ").filter((x) => x && !x.startsWith(n + "=")), ...(gone ? [] : [pair])].join("; ");
    }
    return { code: res.status, loc: res.headers.get("location"), text: await res.text() };
  };
  /** The whole dance: our /start, the pretend Microsoft, our /callback. Returns where the page then moves on to. */
  const login = async (portal, who, session = jar(), extra = "") => {
    idp.next = who;
    const a = await getRaw(BASE + "/api/auth/microsoft/start?portal=" + portal + extra, session);
    if (a.code !== 302) return { session, target: (a.text.match(/url=([^"]+)"/) ?? [])[1]?.replace(/&#38;/g, "&") ?? "", first: a };
    const b = await getRaw(a.loc, session);
    const c = await getRaw(b.loc, session);
    return { session, target: (c.text.match(/url=([^"]+)"/) ?? [])[1]?.replace(/&#38;/g, "&") ?? "", first: a, cb: c };
  };
  const user = (email) => dbq("select * from users where email = ?", email)[0];
  const AMA = { oid: "oid-ama-0001", email: "ama.mensah@" + DOMAIN, name: "Ama Mensah", job: "Accountant", dept: "Finance" };

  // not set up yet
  let r = await login("user", AMA);
  ok("with no Microsoft app set up, signing in says so instead of failing oddly", r.first.code === 200 && r.target === "/?login_error=sso_off", r.target);
  ok("the public config says it is not available", (await req("GET", "/api/config")).json.sso.available === false);

  // the admin sets it up
  let x = await req("PUT", S, { sso: { use_mail_app: false, tenant_id: "nope", client_id: CLIENT, client_secret: CSECRET } }, A);
  ok("ids must look like ids (400)", x.code === 400);
  ok("reusing the email app is refused while email isn't on Microsoft 365 (400)", (await req("PUT", S, { sso: { use_mail_app: true } }, A)).code === 400);
  ok("an agent can't change it (404)", (await req("PUT", S, { sso: { tenant_id: TENANT } }, GE)).code === 404);
  x = await req("PUT", S, { sso: { use_mail_app: false, tenant_id: TENANT, client_id: CLIENT, client_secret: CSECRET, enforced: false } }, A);
  ok("an admin saves the Microsoft app (tenant, client, secret)", x.code === 200 && x.json.sso.configured === true && x.json.sso.has_secret === true && x.json.sso.enforced === false && x.json.sso.verified_at === null, JSON.stringify(x.json.sso));
  ok("the secret is never returned and is encrypted at rest", !JSON.stringify(x.json).includes(CSECRET) && !dbq("select value from settings where key = 'app_settings'")[0].value.includes(CSECRET));
  x = await req("PUT", S, { sso: { use_mail_app: false, tenant_id: TENANT, client_id: CLIENT, client_secret: "", enforced: true } }, A);
  ok("it can't be switched on for everyone before an admin has signed in with it (400)", x.code === 400 && /Test sign-in/.test(x.json.error), JSON.stringify(x.json));
  ok("the public config says it is available, not enforced", (await req("GET", "/api/config")).json.sso.available === true && (await req("GET", "/api/config")).json.sso.enforced === false);
  {
    // the way back is the SAVED address (what gets registered in Entra), not whatever the browser happens to be on
    idp.next = { oid: "oid-probe", email: "probe@" + DOMAIN, name: "Probe" };
    const j = jar();
    const a = await getRaw(BASE + "/api/auth/microsoft/start?portal=user", j);
    await getRaw(a.loc, j);
    ok("the way back uses the saved address, which is what gets registered in Entra", idp.authorizeSeen.redirect_uri === "http://helpdesk.fortress.test:8080/api/auth/microsoft/callback", idp.authorizeSeen.redirect_uri);
    await req("PUT", S, { address: { app_url: "", alt_urls: [], trust_proxy: false } }, A); // for the rest of this block, use the address the test is on
  }

  // a normal user: the account is created from their Microsoft profile
  r = await login("user", AMA, jar(), "&t=42");
  ok("a new person signs in: the account is made and they go to their ticket with the welcome flag", r.target === "/?t=42&welcome=1", r.target);
  const q = idp.authorizeSeen;
  ok("the browser is sent to Microsoft with PKCE, a state, a nonce and the registered address", q.client_id === CLIENT && q.code_challenge_method === "S256" && q.code_challenge.length >= 43 && q.state.length >= 20 && q.nonce.length >= 20 && q.response_type === "code" && /openid/.test(q.scope) && q.redirect_uri === BASE + "/api/auth/microsoft/callback", JSON.stringify(q));
  ok("the code was exchanged with the secret, the verifier and the same redirect address", idp.exchange.secretOk && idp.exchange.pkceOk && idp.exchange.redirOk && idp.exchange.clientOk);
  const me = (await req("GET", "/api/me", undefined, r.session)).json;
  ok("they are signed in as a requester with their Microsoft details", me.email === AMA.email && me.name === "Ama Mensah" && me.ms_linked === true && me.job_title === "Accountant" && me.department === "Finance" && me.has_pin === false, JSON.stringify(me));
  ok("the account is linked and has no PIN or password", user(AMA.email).role === "requester" && user(AMA.email).ms_oid === AMA.oid && user(AMA.email).pin_hash === null);
  const r2 = await login("user", AMA);
  ok("signing in again goes home and doesn't duplicate the account", r2.target === "/" && dbq("select count(*) n from users where email = ?", AMA.email)[0].n === 1);
  ok("both sign-ins are in the activity log", dbq("select count(*) n from audit_log where action = 'signin.microsoft'")[0].n >= 2 && dbq("select count(*) n from audit_log where action = 'account.registered' and summary like '%Microsoft%'")[0].n === 1);

  // an account that already exists (made with a PIN) is linked by its email
  const kofi = user("kofi.files@" + DOMAIN);
  const KOFI = { oid: "oid-kofi-0002", email: "kofi.files@" + DOMAIN, name: "Kofi Files", job: "Surveyor" };
  r = await login("user", KOFI);
  ok("someone who already had an account is linked to it, not duplicated", r.target === "/" && user(KOFI.email).id === kofi.id && user(KOFI.email).ms_oid === KOFI.oid && dbq("select count(*) n from audit_log where action = 'account.ms_linked'")[0].n === 1);
  ok("…and sees their old tickets", (await req("GET", "/api/tickets", undefined, r.session)).json.length >= 1);
  r = await login("user", { oid: "oid-someone-else", email: KOFI.email, name: "Not Kofi" });
  ok("a different Microsoft account claiming that email is refused (mismatch), no session", r.target === "/?login_error=mismatch" && !r.session.cookie.includes("fg_user"));
  r = await login("user", { oid: KOFI.oid, email: AMA.email, name: "Kofi Files" });
  ok("a Microsoft account whose email now belongs to a different helpdesk account is refused too", r.target === "/?login_error=mismatch" && user(KOFI.email).id === kofi.id);
  r = await login("user", { oid: "oid-outsider", email: "outsider@gmail.com", name: "Outsider" });
  ok("an address outside the company domain is refused", r.target === "/?login_error=wrong_domain" && !user("outsider@gmail.com"));
  dbx("update users set active = 0 where email = ?", AMA.email);
  r = await login("user", AMA);
  ok("a disabled account can't sign in", r.target === "/?login_error=disabled");
  dbx("update users set active = 1 where email = ?", AMA.email);
  r = await login("user", { error: "access_denied" });
  ok("pressing Cancel at Microsoft comes back with a clear message", r.target === "/?login_error=cancelled");
  idp.badAud = true; r = await login("user", AMA); idp.badAud = false;
  ok("an identity token for another app is refused", r.target === "/?login_error=failed");
  idp.badNonce = true; r = await login("user", AMA); idp.badNonce = false;
  ok("a token with the wrong nonce is refused", r.target === "/?login_error=failed");
  idp.graphDown = true; r = await login("user", { oid: "oid-nograph", email: "no.graph@" + DOMAIN, name: "No Graph" }); idp.graphDown = false;
  ok("if Microsoft's profile service is down the identity token is enough", r.target === "/?welcome=1" && user("no.graph@" + DOMAIN).job_title === null);
  const ng = user("no.graph@" + DOMAIN);
  r = await login("user", { oid: "oid-nograph", email: "renamed.person@" + DOMAIN, name: "No Graph" });
  ok("when someone's address changes in Microsoft 365 they still get in, and the account follows", r.target === "/" && user("renamed.person@" + DOMAIN)?.id === ng.id && !user("no.graph@" + DOMAIN) && dbq("select count(*) n from audit_log where action = 'account.email_changed'")[0].n === 1);
  const bare = jar();
  const cb = await getRaw(BASE + "/api/auth/microsoft/callback?code=abc&state=def", bare);
  ok("a callback that never started here (no cookie) is refused", /login_error=expired/.test(cb.text));
  const j3 = jar();
  const st = await getRaw(BASE + "/api/auth/microsoft/start?portal=user", j3);
  const cb2 = await getRaw(BASE + "/api/auth/microsoft/callback?code=abc&state=tampered", j3);
  ok("…and so is one with the wrong state", /login_error=expired/.test(cb2.text) && st.code === 302);
  const j4 = jar();
  idp.next = AMA;
  const s4 = await getRaw(BASE + "/api/auth/microsoft/start?portal=user", j4);
  const cbUrl = (await getRaw(s4.loc, j4)).loc;
  const copy = () => Object.assign(jar(), { cookie: j4.cookie });
  const first = await getRaw(cbUrl, copy());
  const replay = await getRaw(cbUrl, copy());
  ok("a sign-in code works once: the same code used again is refused", /url=\/"/.test(first.text) && /login_error=failed/.test(replay.text), replay.text.slice(0, 160));

  // staff: only existing accounts, in their own portal
  const esiRow = user("esi.agent@" + DOMAIN);
  r = await login("agent", { oid: "oid-esi-0003", email: esiRow.email, name: "Esi Agent" });
  ok("an agent signs in at /agent with Microsoft", r.target === "/agent", r.target);
  let sm = (await req("GET", "/api/staff/me", undefined, r.session)).json;
  ok("…as an agent, and their chosen name is kept", sm.role === "agent" && sm.email === esiRow.email && sm.name === esiRow.name && sm.must_change_password === false, JSON.stringify(sm));
  r = await login("agent", { oid: "oid-nobody-0004", email: "not.staff@" + DOMAIN, name: "Not Staff" });
  ok("a Microsoft account nobody added as staff can't get into /agent, and no account is made", r.target === "/agent?login_error=not_staff" && !user("not.staff@" + DOMAIN));
  r = await login("admin", { oid: "oid-esi-0003", email: esiRow.email, name: "Esi Agent" });
  ok("an agent can't get into /admin", r.target === "/admin?login_error=not_staff");
  r = await login("agent", { oid: "oid-ama-0001", email: AMA.email, name: "Ama Mensah" });
  ok("a normal user can't get into /agent", r.target === "/agent?login_error=not_staff");

  // a staff account with a temporary password still pending: Microsoft sign-in retires that password
  const made = await req("POST", "/api/admin/users", { name: "Yaw Temp", email: "yaw.temp@" + DOMAIN, role: "agent" }, A);
  r = await login("agent", { oid: "oid-yaw-0005", email: "yaw.temp@" + DOMAIN, name: "Yaw Temp" });
  sm = (await req("GET", "/api/staff/me", undefined, r.session)).json;
  ok("a new agent signs in with Microsoft without being asked to choose a password", made.code === 201 && r.target === "/agent" && sm.must_change_password === false);
  ok("…and the temporary password no longer works", (await req("POST", "/api/staff/login", { email: "yaw.temp@" + DOMAIN, password: made.json.temp_password, portal: "agent" }, jar())).code === 401);

  // an admin signs in: this proves it works, which unlocks "switch off the old sign-ins"
  r = await login("admin", { oid: "oid-admin-0006", email: ADMIN, name: "Admin" });
  const SA = r.session;
  ok("an admin signs in at /admin with Microsoft", r.target === "/admin" && (await req("GET", "/api/staff/me", undefined, SA)).json.role === "admin", r.target);
  x = await req("GET", S, undefined, A);
  ok("…which records that Microsoft sign-in has been seen working", x.json.sso.verified_at > 0, JSON.stringify(x.json.sso));

  // switch the old sign-ins off
  x = await req("PUT", S, { sso: { use_mail_app: false, tenant_id: TENANT, client_id: CLIENT, client_secret: "", enforced: true } }, A);
  ok("now the admin can make Microsoft the only way in", x.code === 200 && x.json.sso.enforced === true && x.json.sso.verified_at > 0, JSON.stringify(x.json.sso));
  ok("the public config says so", (await req("GET", "/api/config")).json.sso.enforced === true);
  x = await req("POST", "/api/identify", { name: "Pin Person", email: "pin.person@" + DOMAIN, new_pin: "573918" }, jar());
  ok("names and PINs no longer open an account (403 sso_required)", x.code === 403 && x.json.error === "sso_required" && !user("pin.person@" + DOMAIN));
  x = await req("POST", "/api/staff/login", { email: esiRow.email, password: "whatever-whatever", portal: "agent" }, jar());
  ok("agents can no longer use a password", x.code === 401 && x.json.error === "incorrect");
  x = await req("POST", "/api/staff/login", { email: ADMIN, password: ADMIN_PW, portal: "admin" }, jar());
  ok("an admin still can (the way back in if Microsoft is down)", x.code === 200, JSON.stringify(x.json));
  r = await login("user", { oid: "oid-late-0007", email: "late.joiner@" + DOMAIN, name: "Late Joiner" });
  ok("Microsoft sign-in keeps working for new people", r.target === "/?welcome=1" && !!user("late.joiner@" + DOMAIN));
  ok("an existing session keeps working", (await req("GET", "/api/me", undefined, RQ)).code === 200);

  // changing the credentials makes admins test again before enforcing
  x = await req("PUT", S, { sso: { use_mail_app: false, tenant_id: TENANT, client_id: CLIENT, client_secret: "a-new-secret", enforced: true } }, A);
  ok("changing the secret needs a fresh test before it can stay enforced (400)", x.code === 400 && /Test sign-in/.test(x.json.error), JSON.stringify(x.json));
  x = await req("PUT", S, { sso: { use_mail_app: false, tenant_id: TENANT, client_id: CLIENT, client_secret: CSECRET, enforced: false } }, A);
  ok("…and with the right secret back, un-enforcing works", x.code === 200 && x.json.sso.enforced === false && x.json.sso.configured === true, JSON.stringify(x.json.sso));
  ok("the old sign-ins are back (the rest of the suite uses them)", (await req("GET", "/api/config")).json.sso.enforced === false && (await req("GET", S, undefined, A)).json.sso.enforced === false && (await req("POST", "/api/staff/login", { email: "nobody@" + DOMAIN, password: "x-x-x-x-x-x-x-x", portal: "agent" }, jar())).code === 401);
  await req("PUT", S, { address: { app_url: "http://helpdesk.fortress.test:8080/", alt_urls: "http://10.0.0.5:3000, http://nas.fortress.test", trust_proxy: false } }, A); // as the earlier block left it
  ok("the activity log shows the Microsoft settings changes, without secrets",dbq("select count(*) n from audit_log where action = 'system.settings' and summary like '%Microsoft%'")[0].n >= 2 && !dbq("select group_concat(summary) s from audit_log")[0].s.includes(CSECRET));
}

// ================= brute-force limiter (real default: 15 sign-in attempts per 10 minutes per address) =================
{
  const gone = new Promise((rs) => server.once("exit", rs));
  server.kill("SIGTERM");
  if (process.platform === "win32") console.log("skip  open screens are told the server is restarting (Windows ends a child process without running its shutdown handler; checked on Linux/Docker)");
  else ok("when the server is stopped, open screens are told it is restarting (before it goes)", await globalThis.__restartStream.waitFor('"restarting":true', 3000));
  await gone;
  globalThis.__restartStream.close();
  server = start({ LOGIN_RATE_LIMIT: "15" });
  ok("server restarts with the default limiter", await waitUp());
  {
    const sv = await req("GET", "/api/admin/system/settings", undefined, A);
    ok("saved address and mail settings survive a restart and still override .env", sv.code === 200 && sv.json.address.app_url === "http://helpdesk.fortress.test:8080" && sv.json.address.source === "saved" && sv.json.mail.mode === "log" && sv.json.mail.source === "saved" && sv.json.mail.from === "helpdesk@fortress.test", JSON.stringify(sv.json));
  }
  {
    const adminId = dbq("select id from users where email = ?", ADMIN)[0].id;
    const upd = dbq("select title, body from notifications where user_id = ? and kind = 'update'", adminId);
    ok("a new version after a restart tells the admin (bell)", upd.length === 1 && upd[0].title === "Helpdesk updated" && upd[0].body.includes(globalThis.__ver), JSON.stringify(upd));
    ok("…and writes it in the activity log and remembers it", dbq("select count(*) n from audit_log where action = 'system.update' and actor_role = 'system'")[0].n === 1 && JSON.parse(dbq("select value from settings where key = 'last_update'")[0].value).from === "previous-build");
  }
  // The response-target watcher runs a few seconds after start-up: it alerts once for a ticket close to its target and once for a late one.
  await new Promise((r) => setTimeout(r, 7500));
  {
    const { w1, w2, esiId } = globalThis.__sla;
    const n = (tid, kind, uid) => dbq("select count(*) n from notifications where ticket_id = ? and kind = ? and user_id = ?", tid, kind, uid)[0].n;
    const adminId = dbq("select id from users where email = ?", ADMIN)[0].id;
    ok("a ticket close to its target warns the person on it, once", n(w1, "sla_warn", esiId) === 1 && dbq("select sla_alert a from tickets where id = ?", w1)[0].a === 1);
    ok("…and doesn't bother the admin yet", n(w1, "sla_warn", adminId) === 0);
    ok("a late ticket tells the person on it and the admin, once each", n(w2, "sla_breach", esiId) === 1 && n(w2, "sla_breach", adminId) === 1 && dbq("select sla_alert a from tickets where id = ?", w2)[0].a === 2);
    ok("the breach is in the activity log, written by the system", dbq("select count(*) n from audit_log where action = 'ticket.sla_breach' and ticket_id = ? and actor_role = 'system'", w2)[0].n === 1);
    ok("a ticket that was already late before the upgrade didn't trigger anything", dbq("select count(*) n from notifications where kind = 'sla_breach'").length === 1);
  }
  {
    const { late, paused } = globalThis.__rec;
    const n = dbq("select count(*) n from tickets where source = 'recurring' and title = 'Empty the print queue log'")[0].n;
    const row = dbq("select next_at, last_ticket_id from recurring_tickets where id = ?", late)[0];
    ok("a recurring ticket that was due while the server was off is raised once, not forty times", n === 1 && !!row.last_ticket_id, `(${n})`);
    ok("…and its next date is in the future", row.next_at > Date.now() / 1000 && row.next_at < Date.now() / 1000 + 86400 + 60);
    ok("…written to the activity log by the system", dbq("select count(*) n from audit_log where action = 'ticket.created' and actor_role = 'system' and ticket_id = ?", row.last_ticket_id)[0].n === 1);
    ok("a paused one stays quiet even when its date has passed", dbq("select count(*) n from tickets where source = 'recurring' and title = 'Check the backups'")[0].n === 1);
  }
  const codes = [];
  for (let n = 0; n < 17; n++) codes.push((await req("POST", "/api/staff/login", { email: `nobody${n}@${DOMAIN}`, password: "guess-guess-guess", portal: "admin" }, jar())).code);
  ok("the first 15 guesses get a normal answer (401)", codes.slice(0, 15).every((c) => c === 401), `(${[...new Set(codes.slice(0, 15))].join(",")})`);
  ok("the 16th and later are refused (429)", codes[15] === 429 && codes[16] === 429, `(${codes.slice(15).join(",")})`);
}

server.kill("SIGTERM");
idpServer.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
