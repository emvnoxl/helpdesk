/* Which build is this? `__BUILD__` is stamped in by scripts/build-server.mjs (git commit or build time). Under `tsx` (dev) it does not exist. */
declare const __BUILD__: { id: string; builtAt: string; note: string } | undefined;

export const BUILD: { id: string; builtAt: string; note: string } =
  typeof __BUILD__ !== "undefined" ? __BUILD__ : { id: "dev", builtAt: new Date().toISOString(), note: "development build" };
export const STARTED_AT = Date.now();
