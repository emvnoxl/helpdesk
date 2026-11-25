import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit } from "./audit";
import { config } from "./config";
import { seal, unseal } from "./settings";
import { webhookOk } from "./teamshosts";
import { getSetting, putSetting } from "./sla";

/* Alerts in a Microsoft Teams channel. IT adds a "Workflows" webhook to a channel (Teams > the channel > ... > Workflows > "Post to a channel
   when a webhook request is received") and pastes its address under Admin > System > Alerts. The helpdesk then posts a short card for the
   things worth interrupting someone for. Only the ticket's reference, title and who raised it are sent. The address is a secret (anyone who
   has it can post to the channel): it is stored sealed, never shown again, and only Microsoft's own addresses are accepted. */

export type TeamsEvent = "new_ticket" | "sla_breach" | "call_request" | "not_fixed";
export const TEAMS_EVENTS: { id: TeamsEvent; label: string; hint: string }[] = [
  { id: "new_ticket", label: "A new ticket is raised", hint: "From the web form or by email" },
  { id: "sla_breach", label: "A ticket goes past its response target", hint: "One alert per ticket" },
  { id: "call_request", label: "Someone asks for a call", hint: "They are waiting for IT to ring" },
  { id: "not_fixed", label: "Someone says it was not fixed", hint: "A thumbs-down on a resolved ticket" },
];

interface Stored { url: string; events: Record<TeamsEvent, boolean>; last: { at: number; ok: boolean; error?: string } | null }
const DEFAULT_EVENTS: Record<TeamsEvent, boolean> = { new_ticket: true, sla_breach: true, call_request: true, not_fixed: false };
let cfg: Stored = { url: "", events: { ...DEFAULT_EVENTS }, last: null };

export async function loadTeams() {
  try {
    const s = JSON.parse((await getSetting("teams")) ?? "null") as Partial<Stored> | null;
    cfg = { url: s?.url ?? "", events: { ...DEFAULT_EVENTS, ...(s?.events ?? {}) }, last: s?.last ?? null };
  } catch { cfg = { url: "", events: { ...DEFAULT_EVENTS }, last: null }; }
}
const save = () => putSetting("teams", JSON.stringify(cfg));

let sent: number[] = [];
const card = (title: string, text: string, link: string) => ({
  type: "message",
  attachments: [{
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body: [
        { type: "TextBlock", text: "Fortress Oil & Gas Helpdesk", size: "Small", isSubtle: true, weight: "Bolder" },
        { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
        ...(text ? [{ type: "TextBlock", text, wrap: true }] : []),
      ],
      ...(link ? { actions: [{ type: "Action.OpenUrl", title: "Open the ticket", url: link }] } : {}),
    },
  }],
});

async function post(title: string, text: string, link: string): Promise<void> {
  const res = await fetch(unseal(cfg.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card(title, text, link)), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Teams answered ${res.status}${res.status === 401 || res.status === 403 ? ": the webhook may have been deleted or switched off" : res.status === 404 ? ": the webhook address is not valid any more" : ""}`);
}

/** Fire and forget: a problem here must never get in the way of the ticket. At most 30 a minute. */
export function teamsNotify(event: TeamsEvent, o: { ticketId?: number; title: string; text?: string }) {
  if (!cfg.url || !cfg.events[event]) return;
  const t = Date.now();
  sent = sent.filter((x) => t - x < 60_000);
  if (sent.length >= 30) return;
  sent.push(t);
  const link = config.appUrl && o.ticketId ? `${config.appUrl}/admin?t=${o.ticketId}` : "";
  post(o.title, o.text ?? "", link)
    .then(() => { cfg.last = { at: Math.floor(t / 1000), ok: true }; return save(); })
    .catch((e) => { cfg.last = { at: Math.floor(t / 1000), ok: false, error: String((e as Error).message).slice(0, 160) }; return save().catch(() => {}); })
    .catch(() => {});
}

/** Admin only (mounted at /api/admin/teams). */
export const teams = new Hono<AppEnv>();

teams.get("/", (c) => c.json({ configured: !!cfg.url, events: cfg.events, available: TEAMS_EVENTS, last: cfg.last }));

// { url?, events? }: a blank url keeps the saved one, "-" removes it.
teams.put("/", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const u = typeof b.url === "string" ? b.url.trim() : "";
  if (u && u !== "-" && !webhookOk(u)) return c.json({ error: "That is not a Teams webhook address. It should start with https:// and come from Microsoft (logic.azure.com, webhook.office.com or powerplatform.com): copy it from the Workflows step in Teams." }, 400);
  if (u) cfg.url = u === "-" ? "" : seal(u);
  if (b.events && typeof b.events === "object") for (const e of TEAMS_EVENTS) if (typeof (b.events as Record<string, unknown>)[e.id] === "boolean") cfg.events[e.id] = (b.events as Record<string, boolean>)[e.id]!;
  await save();
  await audit(c, "system.settings", "admin", `Teams alerts: ${cfg.url ? "on" : "off"}${u ? (u === "-" ? ", address removed" : ", address changed") : ""} (${TEAMS_EVENTS.filter((e) => cfg.events[e.id]).map((e) => e.id).join(", ") || "nothing selected"})`);
  return c.json({ ok: true });
});

teams.post("/test", async (c) => {
  if (!cfg.url) return c.json({ error: "Add the webhook address first." }, 409);
  try {
    await post("Test message", "If you can read this, the helpdesk can post in this channel.", config.appUrl ? config.appUrl + "/admin" : "");
    cfg.last = { at: Math.floor(Date.now() / 1000), ok: true };
    await save();
    return c.json({ ok: true });
  } catch (e) {
    cfg.last = { at: Math.floor(Date.now() / 1000), ok: false, error: (e as Error).message.slice(0, 160) };
    await save();
    return c.json({ error: (e as Error).message }, 502);
  }
});
