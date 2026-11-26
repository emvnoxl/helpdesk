import { useEffect, useRef, useSyncExternalStore } from "react";
import { applySystem } from "./system";

/* Instant updates. The server pushes a tiny "something changed" over a Server-Sent Events stream (see src/server/bus.ts) and each
   screen re-fetches through its own authorised API. Browsers allow only ~6 connections per site over plain HTTP, so every tab shares
   ONE stream per path no matter how many components listen. A slow poll stays in each screen as a safety net (a proxy that buffers
   streams, a laptop waking from sleep): the screens still work, just not instantly. */

export type LiveEvent = "change" | "audit" | "open" | "call" | "typing" | "presence";
type LiveData = { ticket?: number; name?: string; staff?: boolean };
type Handler = (event: LiveEvent, data: LiveData) => void;
interface Hub { es: EventSource | null; handlers: Set<Handler>; timer: number; opened: boolean }
const hubs = new Map<string, Hub>();

/* Is this tab connected to the helpdesk? true once the stream is open; false when it has been down for a few seconds (the planned
   reconnect every ten minutes is shorter than that, so it never shows as "offline"). */
const conn = new Map<string, boolean>();
const connTimers = new Map<string, number>();
const connListeners = new Set<() => void>();
function setConn(path: string, up: boolean) {
  window.clearTimeout(connTimers.get(path));
  const apply = () => { if (conn.get(path) !== up) { conn.set(path, up); connListeners.forEach((l) => l()); } };
  if (up) apply();
  else connTimers.set(path, window.setTimeout(apply, 6000));
}

function connect(path: string, hub: Hub) {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource("/api" + path);
  hub.es = es;
  es.onopen = () => setConn(path, true);
  const fire = (event: LiveEvent) => (e: Event) => {
    let data = {};
    try { data = JSON.parse((e as MessageEvent).data || "{}"); } catch { /* ping or malformed: ignore */ }
    hub.handlers.forEach((h) => h(event, data));
  };
  es.addEventListener("change", fire("change"));
  es.addEventListener("audit", fire("audit"));
  es.addEventListener("presence", fire("presence")); // someone arrived or left (admin People / Computers)
  es.addEventListener("typing", fire("typing")); // someone is typing on a ticket (TicketView)
  es.addEventListener("call", fire("call")); // someone is ringing, answered or hung up (Calls.tsx)
  es.addEventListener("system", (e) => { try { applySystem(JSON.parse((e as MessageEvent).data || "{}")); } catch { /* ignore */ } }); // update announced / server restarting
  es.addEventListener("hello", (e) => {
    try { applySystem(JSON.parse((e as MessageEvent).data || "{}")); } catch { /* an old server sends {} */ }
    // After a reconnect, catch up on whatever was missed while the stream was down.
    if (hub.opened) hub.handlers.forEach((h) => h("open", {}));
    hub.opened = true;
  });
  es.onerror = () => {
    setConn(path, false);
    // The browser retries by itself while the stream is merely interrupted. If it gave up (for example a 401 after the session
    // ended), try again in a while; the screens' own polling covers the gap.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      hub.es = null;
      hub.timer = window.setTimeout(() => hub.handlers.size && connect(path, hub), 15_000);
    }
  };
}

export function subscribe(path: string, handler: Handler): () => void {
  let hub = hubs.get(path);
  if (!hub) {
    hub = { es: null, handlers: new Set(), timer: 0, opened: false };
    hubs.set(path, hub);
  }
  hub.handlers.add(handler);
  if (!hub.es && !hub.timer) connect(path, hub);
  return () => {
    const h = hubs.get(path);
    if (!h) return;
    h.handlers.delete(handler);
    if (!h.handlers.size) {
      h.es?.close();
      window.clearTimeout(h.timer);
      hubs.delete(path);
    }
  };
}

/** Calls `onEvent` for every push on `path` ("/stream" for normal users, "/staff/stream" for agents and admins), with a short
    debounce so a burst of changes becomes one refresh. `events` limits which kinds wake you (default: change and reconnect). */
export function useLive(path: string, onEvent: (event: LiveEvent, data: LiveData) => void, events: LiveEvent[] = ["change", "open"]) {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const want = useRef(events);
  want.current = events;
  useEffect(() => {
    let timer = 0;
    let last: { event: LiveEvent; data: LiveData } | null = null;
    const off = subscribe(path, (event, data) => {
      if (!want.current.includes(event)) return;
      // A ticket-specific event must not be swallowed by a later generic one inside the debounce window.
      last = last && last.data.ticket && !data.ticket ? last : { event, data };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { const l = last!; last = null; cb.current(l.event, l.data); }, 120);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [path]);
}

export const streamFor = (staff: boolean) => (staff ? "/staff/stream" : "/stream");

/** true = connected, false = offline (server unreachable or no network), null = still connecting. */
export function useConnected(path: string): boolean | null {
  const up = useSyncExternalStore((l) => (connListeners.add(l), () => connListeners.delete(l)), () => conn.get(path) ?? null);
  const net = useSyncExternalStore(
    (l) => { window.addEventListener("online", l); window.addEventListener("offline", l); return () => { window.removeEventListener("online", l); window.removeEventListener("offline", l); }; },
    () => navigator.onLine,
  );
  return net ? up : false;
}
