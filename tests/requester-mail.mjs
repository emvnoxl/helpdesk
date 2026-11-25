// Client emails are sent only for things the client has not looked at (REQUESTER_EMAIL_DELAY_SECONDS): its own server, a 3 s delay.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name} ${cond ? "" : extra}`); };
const DATA = mkdtempSync(path.join(tmpdir(), "fg-rmail-"));
const PORT = 19000 + Math.floor(Math.random() * 900), BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "admin@rmail.test", BOOT = "Boot-Password-For-Mail-1", NEWPW = "A-Much-Better-Passphrase-22";
let log = "";
const server = spawn(process.execPath, ["dist-server/index.js"], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: BOOT, COMPANY_EMAIL_DOMAIN: "", MAIL_LOG_ONLY: "1", NOTIFY_INTERVAL_SECONDS: "1", REQUESTER_EMAIL_DELAY_SECONDS: "3", SEED_FORMS: "0", STAFF_EMAIL_DELAY_SECONDS: "0", BACKUP_ENABLED: "0", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = () => ({ cookie: "" });
async function req(method, p, body, j = jar()) {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", origin: BASE, ...(j.cookie ? { cookie: j.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const sc of res.headers.getSetCookie?.() ?? []) { const [pair] = sc.split(";"); const n = pair.split("=")[0]; j.cookie = [...j.cookie.split("; ").filter((x) => x && !x.startsWith(n + "=")), pair].join("; "); }
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { code: res.status, json };
}
const mails = (to) => log.split("[mail] to=").slice(1).filter((m) => m.startsWith(to + " "));
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(250); } return fn(); };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {} await sleep(250); }
  const A = jar();
  await req("POST", "/api/staff/login", { email: ADMIN, password: BOOT, portal: "admin" }, A);
  await req("POST", "/api/staff/password", { current: BOOT, next: NEWPW }, A);
  const R = jar(), EMAIL = "client@rmail.test";
  await req("POST", "/api/identify", { name: "Client Person", email: EMAIL, new_pin: "639258" }, R);
  const tk = (await req("POST", "/api/tickets", { title: "Laptop will not start", description: "Black screen", category_id: 5 }, R)).json;
  const reply = (body) => req("POST", `/api/staff/tickets/${tk.id}/comments`, { body, internal: false }, A);

  ok("'we have your ticket' still goes at once", await waitFor(() => mails(EMAIL).some((m) => /We have your ticket/.test(m)), 2500));

  // A: the client never looks: nothing for a while, then ONE email with the latest messages
  await reply("ALPHA first message");
  await reply("BETA second message");
  await sleep(1500);
  ok("a reply is NOT emailed straight away", !mails(EMAIL).some((m) => /ALPHA/.test(m)));
  ok("…after the delay ONE email carries both unseen messages", await waitFor(() => mails(EMAIL).filter((m) => /ALPHA/.test(m)).length === 1 && mails(EMAIL).some((m) => /ALPHA/.test(m) && /BETA/.test(m)), 9000));
  ok("…and says they have not seen them yet", mails(EMAIL).some((m) => /BETA/.test(m) && /not seen yet/.test(m)));
  await sleep(2500);
  ok("…and is not sent twice", mails(EMAIL).filter((m) => /ALPHA/.test(m)).length === 1);

  // B: the client opens the ticket (the bell is read) before the delay is over: no email at all
  await reply("GAMMA message that gets read");
  await req("POST", "/api/notifications/read", { ticket_id: tk.id }, R);
  await sleep(6500);
  ok("a message the client looked at in time is never emailed", !mails(EMAIL).some((m) => /GAMMA/.test(m)));

  // C: a single unseen reply keeps the familiar layout (name, 'from IT replied', the text)
  await reply("DELTA lone message");
  ok("a single unseen reply is emailed after the delay in the usual layout", await waitFor(() => mails(EMAIL).some((m) => /from IT replied:\s+> DELTA lone message/.test(m)), 9000));

  // D: more than three unseen messages: only the latest three are quoted
  for (const n of ["ONE", "TWO", "THREE", "FOUR", "FIVE"]) await reply(`SEQ-${n}`);
  ok("five unseen messages become one email with the last three", await waitFor(() => mails(EMAIL).some((m) => /SEQ-FIVE/.test(m)), 9000));
  const big = mails(EMAIL).find((m) => /SEQ-FIVE/.test(m)) ?? "";
  ok("…the earlier ones are only counted, not quoted", /SEQ-THREE/.test(big) && /SEQ-FOUR/.test(big) && !/SEQ-ONE/.test(big) && /2 earlier messages/.test(big), big.slice(0, 400));

  // E: switched off = nothing
  await req("PATCH", "/api/me/preferences", { email_notify: false }, R);
  const before = mails(EMAIL).length;
  await reply("OMEGA while switched off");
  await sleep(6000);
  ok("a client who switched emails off gets none", mails(EMAIL).length === before && !mails(EMAIL).some((m) => /OMEGA/.test(m)));
} catch (e) { console.log("ERR", e); fail++; }
server.kill();
await sleep(300);
try { rmSync(DATA, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
