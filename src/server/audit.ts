import type { Context } from "hono";
import { clientIp } from "./auth";
import { audited } from "./bus";
import { db } from "./db";

/* The activity log: one row per thing that happens (tickets, messages, sign-ins, accounts, admin actions, security events).
   Shown to admins under Dashboard > Activity. It records WHO and WHAT, never message bodies, passwords or temporary passwords. */

export type Category = "ticket" | "message" | "signin" | "account" | "admin" | "security";
export interface Actor { id: number | null; name: string; role: string }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** "Edge on Windows" from a User-Agent string; enough to tell computers apart without storing the whole header. */
export function deviceOf(ua: string | undefined): string {
  if (!ua) return "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const SYSTEM: Actor = { id: null, name: "System", role: "system" };

/** Writes a row. `who` defaults to the signed-in user of this request. Never throws: logging must not break the action it describes. */
export async function audit(
  c: Context<any> | null,
  action: string,
  category: Category,
  summary: string,
  opts: { ticketId?: number; who?: Actor } = {},
) {
  try {
    const u = c ? (c.get("user") as { id: number; name: string; role: string } | undefined) : undefined;
    const who = opts.who ?? (u ? { id: u.id, name: u.name, role: u.role } : SYSTEM);
    await db
      .prepare("INSERT INTO audit_log (actor_id, actor_name, actor_role, action, category, ticket_id, summary, ip, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(who.id, clip(who.name, 100), who.role, action, category, opts.ticketId ?? null, clip(summary, 300), c ? clientIp(c) : null, c ? deviceOf(c.req.header("user-agent")) : null)
      .run();
    audited();
  } catch (e) {
    console.error("[audit] could not write:", (e as Error).message);
  }
}

export const pruneAudit = (days: number) => db.prepare("DELETE FROM audit_log WHERE created_at < unixepoch() - ?").bind(days * 86400).run();
