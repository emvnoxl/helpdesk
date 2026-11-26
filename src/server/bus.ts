import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "./auth";

/* Instant updates. Anything that changes data calls `changed()`; every open screen is listening on a Server-Sent Events stream and
   re-fetches straight away (the screens keep a slow poll as a safety net). The events carry no data, only "something changed" and,
   for tickets, which one, so nothing private travels over the stream: each screen still fetches through its own authorised API.
   One process, one SQLite file, so an in-memory hub is all that is needed. */

type Send = (event: string, data: string) => void;
interface Sub { send: Send; admin: boolean; key: string }
const subs = new Set<Sub>();

/** A ticket, comment, assignment, account or anything else on a board changed. */
export function changed(ticketId?: number) {
  const data = JSON.stringify(ticketId ? { ticket: ticketId } : {});
  for (const s of subs) s.send("change", data);
}
/** Everyone with a stream open (system notices: an update was announced, the server is restarting). */
export function broadcast(event: string, data: string) {
  for (const s of subs) s.send(event, data);
}
let helloData: () => string = () => "{}";
/** What the first message of every stream carries (the server version and any announced update: see system.ts). */
export const setHello = (fn: () => string) => { helloData = fn; };
/** A new line in the activity log (admins only). */
export function audited() {
  for (const s of subs) if (s.admin) s.send("audit", "{}");
}

/* Calls (calls.ts): only the people concerned are nudged. A key is "r<id>" for a normal-user session and "s<id>" for a staff one. */
const lastSeen = new Map<string, number>();
export function signal(keys: string[]) {
  for (const s of subs) if (keys.includes(s.key)) s.send("call", "{}");
}
/** "Someone is typing": to the other side of one ticket only. A staff typist reaches that ticket's requester; a requester reaches all staff. Nothing is stored. */
export function typing(fromStaff: boolean, requesterId: number, data: string) {
  for (const s of subs) if (fromStaff ? s.key === "r" + requesterId : s.key.startsWith("s")) s.send("typing", data);
}
/** Does this person have the helpdesk open? The stream reconnects every 10 minutes, so a few seconds of absence still counts. */
export const online = (key: string) => [...subs].some((s) => s.key === key) || Date.now() - (lastSeen.get(key) ?? 0) < 15_000;
/** Is anyone from IT at the helpdesk right now? (Shown to normal users on Home.) */
export const staffOnline = () => [...subs].some((s) => s.key.startsWith("s")) || [...lastSeen].some(([k, at]) => k.startsWith("s") && Date.now() - at < 15_000);
/** Normal users who have the helpdesk open right now (a stream is open, or one closed a moment ago). Admin > People shows them. */
export function onlineRequesters(): number[] {
  const ids = new Set<number>();
  for (const s of subs) if (s.key[0] === "r") ids.add(Number(s.key.slice(1)));
  for (const [k, at] of lastSeen) if (k[0] === "r" && Date.now() - at < 15_000) ids.add(Number(k.slice(1)));
  return [...ids];
}
/** Someone arrived or left: only admins' screens are nudged, and they re-ask /admin/people/online. */
function presence() { for (const s of subs) if (s.admin) s.send("presence", "{}"); }
const gone = (sub: Sub) => {
  if (!subs.delete(sub)) return;
  lastSeen.set(sub.key, Date.now());
  if (sub.key[0] === "r") setTimeout(presence, 16_000).unref(); // after the 15 s grace, if they did not come back, they are offline
};

const MAX_SUBS = 1000;
const MAX_LIFE_MS = 10 * 60_000; // then the browser reconnects, which re-checks the session

/** GET /  => an event stream. Mounted behind requesterAuth (/api/stream) and staffAuth (/api/staff/stream). */
export const stream = new Hono<AppEnv>();
stream.get("/", (c) => {
  if (subs.size >= MAX_SUBS) return c.json({ error: "busy" }, 503);
  const user = c.get("user");
  const admin = user.role === "admin";
  const key = (user.role === "requester" ? "r" : "s") + user.id;
  c.header("Cache-Control", "no-cache, no-transform"); // no-transform keeps the compressor from buffering the stream
  c.header("X-Accel-Buffering", "no"); // nginx: don't hold events back
  return streamSSE(c, async (s) => {
    const sub: Sub = { admin, key, send: (event, data) => void s.writeSSE({ event, data }).catch(() => {}) };
    const arrived = key[0] === "r" && !online(key); // a reconnect every 10 minutes is not an arrival
    subs.add(sub);
    if (arrived) presence();
    s.onAbort(() => gone(sub));
    await s.writeSSE({ event: "hello", data: helloData(), retry: 3000 });
    const until = Date.now() + MAX_LIFE_MS;
    while (!s.aborted && Date.now() < until) {
      await s.sleep(20_000);
      if (!s.aborted) await s.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }
    gone(sub);
  });
});
