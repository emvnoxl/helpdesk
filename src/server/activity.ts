import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { isoTime, toCsv } from "./csv";

/* Admin > Activity: the log of what happens in the app. Mounted under /api/admin (admins only). */

export const activity = new Hono<AppEnv>();

const CATS = ["ticket", "message", "signin", "account", "admin", "security"];

function filters(c: { req: { query: (k: string) => string | undefined } }) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const cat = c.req.query("cat");
  if (cat && CATS.includes(cat)) (where.push("category = ?"), binds.push(cat));
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    where.push("(summary LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\')");
    binds.push(like, like, like);
  }
  const since = Number(c.req.query("since")) || 0;
  if (since > 0) (where.push("created_at >= ?"), binds.push(since));
  const before = Number(c.req.query("before")) || 0;
  if (before > 0) (where.push("id < ?"), binds.push(before));
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", binds };
}

activity.get("/", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
  const f = filters(c);
  const { results } = await db
    .prepare(`SELECT id, created_at, actor_id, actor_name, actor_role, action, category, ticket_id, summary, ip, device FROM audit_log ${f.sql} ORDER BY id DESC LIMIT ?`)
    .bind(...f.binds, limit + 1)
    .all();
  const counts = await db
    .prepare("SELECT category, COUNT(*) AS n FROM audit_log WHERE created_at >= unixepoch() - 86400 GROUP BY category")
    .all<{ category: string; n: number }>();
  return c.json({ rows: results.slice(0, limit), more: results.length > limit, last24h: Object.fromEntries(counts.results.map((r) => [r.category, r.n])) });
});

activity.get("/export.csv", async (c) => {
  const f = filters(c);
  const { results } = await db
    .prepare(`SELECT created_at, actor_name, actor_role, category, action, ticket_id, summary, ip, device FROM audit_log ${f.sql} ORDER BY id DESC LIMIT 20000`)
    .bind(...f.binds)
    .all<any>();
  await audit(c, "report.export", "admin", `Exported the activity log (${results.length} rows)`);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="fortress-helpdesk-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
  c.header("Cache-Control", "no-store");
  return c.body(
    toCsv(
      ["Time (UTC)", "Who", "Role", "Category", "Action", "Ticket id", "What happened", "IP", "Device"],
      results.map((r) => [isoTime(r.created_at), r.actor_name, r.actor_role, r.category, r.action, r.ticket_id, r.summary, r.ip, r.device]),
    ),
  );
});
