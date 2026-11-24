import { Hono } from "hono";
import { config, ssoEnforced, ssoReady } from "./config";
import { snapshot } from "./system";

/** Public, non-sensitive settings the sign-in screen needs (e.g. to show "you@company.com"), plus the running version. */
export const publicConfig = new Hono();
publicConfig.get("/config", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ companyDomain: config.companyDomain, maxUploadMb: config.maxUploadMb, system: snapshot(), sso: { available: ssoReady(), enforced: ssoEnforced() } });
});
