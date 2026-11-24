import { useSyncExternalStore } from "react";

/* What the server says about itself: its version, an announced update, "restarting now". It arrives with /api/config (once, when the
   page loads) and on the live stream (the first message of every connection, and a "system" event when something changes).
   `loaded` is the version this page was built with: the server's version at the moment the page loaded. When the server's version
   differs, this tab is stale. */

export interface SystemState {
  loaded: string | null;
  version: string | null;
  restarting: boolean;
  maintenance: { at: number; message: string } | null;
}

let state: SystemState = { loaded: null, version: null, restarting: false, maintenance: null };
const listeners = new Set<() => void>();
const set = (next: Partial<SystemState>) => { state = { ...state, ...next }; listeners.forEach((l) => l()); };

/** From the stream or /api/config. */
export function applySystem(s: { version?: string; restarting?: boolean; maintenance?: SystemState["maintenance"] } | undefined) {
  if (!s || typeof s.version !== "string") return;
  set({
    version: s.version,
    loaded: state.loaded ?? s.version,
    restarting: !!s.restarting,
    maintenance: s.maintenance ?? null,
  });
}

let started = false;
/** Ask once, when the page starts, which version this is. */
export function initSystem() {
  if (started) return;
  started = true;
  fetch("/api/config", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j && applySystem(j.system))
    .catch(() => { /* the live stream will tell us */ });
}

export const useSystem = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
export const isStale = (s: SystemState) => !!s.loaded && !!s.version && s.loaded !== s.version;
