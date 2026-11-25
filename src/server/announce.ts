import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit } from "./audit";
import { getSetting, putSetting } from "./sla";

/* The outage banner: IT posts one line ("Wi-Fi is down on floor 2, we are on it") and every open screen shows it at once, on the sign-in
   page too. One at a time, optionally ending by itself. It rides on the same live "system" message as update notices (see system.ts), so
   nothing new is needed in the browser's connection. Agents and admins can post and clear it. */

export type Level = "info" | "warn" | "outage";
interface Ann { text: string; level: Level; at: number; by: string; until: number | null }

let current: Ann | null = null;
let onChange: () => void = () => {};
let timer: ReturnType<typeof setTimeout> | undefined;
const now = () => Math.floor(Date.now() / 1000);

/** What every screen is told (null when there is none, or it has run out). */
export const currentAnnouncement = (): Ann | null => (current && (!current.until || now() < current.until) ? current : null);
/** system.ts registers how to tell everyone. */
export const onAnnouncementChange = (fn: () => void) => { onChange = fn; };

function arm() {
  clearTimeout(timer);
  if (current?.until) {
    const ms = Math.min(2 ** 31 - 1, Math.max(0, (current.until - now()) * 1000) + 500);
    timer = setTimeout(() => onChange(), ms); // everyone's banner goes away when it ends
    timer.unref?.();
  }
}

export async function loadAnnouncement() {
  try { current = JSON.parse((await getSetting("announcement")) ?? "null"); } catch { current = null; }
  arm();
}

const LEVELS: Level[] = ["info", "warn", "outage"];

/** Mounted at /api/staff/announcement (agents and admins). */
export const announce = new Hono<AppEnv>();

announce.get("/", (c) => c.json({ announcement: currentAnnouncement() }));

// { text (1..200), level, minutes? (1..4320; leave out for "until I clear it") }
announce.put("/", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!text) return c.json({ error: "Write what people should know." }, 400);
  const level = LEVELS.includes(b.level as Level) ? (b.level as Level) : "info";
  const m = Number(b.minutes);
  const until = Number.isFinite(m) && m >= 1 ? now() + Math.min(4320, Math.round(m)) * 60 : null;
  current = { text, level, at: now(), by: c.get("user").name, until };
  await putSetting("announcement", JSON.stringify(current));
  arm();
  await audit(c, "announcement.posted", "admin", `Posted a ${level === "outage" ? "problem" : level === "warn" ? "warning" : "notice"} banner: ${text}${until ? "" : " (until cleared)"}`);
  onChange();
  return c.json({ announcement: currentAnnouncement() });
});

announce.delete("/", async (c) => {
  if (current) await audit(c, "announcement.cleared", "admin", `Cleared the banner: ${current.text}`);
  current = null;
  await putSetting("announcement", "null");
  arm();
  onChange();
  return c.json({ announcement: null });
});

