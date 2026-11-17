import { Hono } from "hono";
import { config } from "./config";

/** Public, non-sensitive settings the sign-in screen needs (e.g. to show "you@company.com"). */
export const publicConfig = new Hono();
publicConfig.get("/config", (c) => c.json({ companyDomain: config.companyDomain, maxUploadMb: config.maxUploadMb }));
