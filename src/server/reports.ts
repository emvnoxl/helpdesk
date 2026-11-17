import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { isoTime, toCsv } from "./csv";
import { buildInsights, buildSummary, clusterTickets, forecastNext, findSpikes, iqrUpperFence, mean, median, percentile, type Doc } from "./analytics";

/* Admin > Reports: a month of tickets in numbers, a CSV of the tickets, and a smart analysis (see analytics.ts).
   Months run from the 1st 00:00 to the next 1st 00:00 in UTC (Ghana is on UTC all year, so this matches the wall clock). */

export const reports = new Hono<AppEnv>();

interface Row {
  id: number; ref: string; title: string; description: string; status: string; priority: string; category: string | null;
  requester_id: number; requester: string; requester_email: string; assignee_id: number | null; assignee: string | null;
  created_at: number; first_response_at: number | null; resolved_at: number | null; closed_at: number | null; due_at: number | null; asset_tag: string | null;
  rating: number | null; rating_comment: string | null;
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
function range(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { from: Math.floor(Date.UTC(y, m - 1, 1) / 1000), to: Math.floor(Date.UTC(y, m, 1) / 1000) };
}
function parseMonth(raw: string | undefined): string | null {
  const cur = monthKey(new Date());
  const m = raw ?? cur;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m) || m < "2020-01" || m > cur) return null;
  return m;
}
const label = (month: string) => new Date(range(month).from * 1000).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const done = (r: Row) => r.resolved_at ?? r.closed_at;
const hours = (a: number, b: number) => Math.max(0, (b - a) / 3600);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

async function ticketsIn(from: number, to: number): Promise<Row[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.ref, t.title, t.description, t.status, t.priority, c.name AS category,
              t.requester_id, u.name AS requester, u.email AS requester_email, t.assignee_id, a.name AS assignee,
              t.created_at, t.first_response_at, t.resolved_at, t.closed_at, t.due_at, t.asset_tag, t.rating, t.rating_comment
       FROM tickets t JOIN users u ON u.id = t.requester_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.created_at >= ? AND t.created_at < ? ORDER BY t.created_at LIMIT 20000`,
    )
    .bind(from, to)
    .all<Row>();
  return results;
}

async function kpis(rows: Row[], from: number, to: number) {
  const nowS = Math.floor(Date.now() / 1000);
  const [resolved, closed, reopened, msgs, openEnd, oldOpen, feedback] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE resolved_at >= ? AND resolved_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE closed_at >= ? AND closed_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n FROM ticket_events WHERE field = 'status' AND old_value IN ('resolved','closed') AND new_value NOT IN ('resolved','closed') AND created_at >= ? AND created_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(internal),0) AS notes FROM comments WHERE created_at >= ? AND created_at < ?").bind(from, to),
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE created_at < ? AND (COALESCE(resolved_at, closed_at) IS NULL OR COALESCE(resolved_at, closed_at) >= ?)").bind(to, to),
    db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE created_at < ? - 7*86400 AND (COALESCE(resolved_at, closed_at) IS NULL OR COALESCE(resolved_at, closed_at) >= ?)").bind(Math.min(to, nowS), to),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(rating = 1),0) AS good FROM tickets WHERE rated_at >= ? AND rated_at < ?").bind(from, to),
  ]);
  const fr = rows.filter((r) => r.first_response_at).map((r) => hours(r.created_at, r.first_response_at!));
  const fixed = rows.filter((r) => done(r));
  const rt = fixed.map((r) => hours(r.created_at, done(r)!));
  const measured = fixed.filter((r) => r.due_at);
  const met = measured.filter((r) => done(r)! <= r.due_at!).length;
  return {
    created: rows.length,
    resolved: resolved.results[0].n as number,
    closed: closed.results[0].n as number,
    urgent: rows.filter((r) => r.priority === "urgent").length,
    open_end: openEnd.results[0].n as number,
    old_open_end: oldOpen.results[0].n as number,
    reopened: reopened.results[0].n as number,
    messages: msgs.results[0].n as number,
    internal_notes: msgs.results[0].notes as number,
    avg_first_response_h: fr.length ? r1(mean(fr)) : null,
    median_first_response_h: fr.length ? r1(median(fr)) : null,
    avg_resolution_h: rt.length ? r1(mean(rt)) : null,
    median_resolution_h: rt.length ? r1(median(rt)) : null,
    p90_resolution_h: rt.length ? r1(percentile(rt, 0.9)) : null,
    rated: feedback.results[0].n as number,
    rated_good: feedback.results[0].good as number,
    csat_pct: feedback.results[0].n ? Math.round(((feedback.results[0].good as number) / (feedback.results[0].n as number)) * 1000) / 10 : null,
    sla_measured: measured.length,
    sla_pct: measured.length ? Math.round((met / measured.length) * 1000) / 10 : null,
  };
}

function group(rows: Row[], key: (r: Row) => string) {
  const m = new Map<string, Row[]>();
  rows.forEach((r) => m.set(key(r), [...(m.get(key(r)) ?? []), r]));
  return m;
}
const slaOf = (rs: Row[]) => {
  const meas = rs.filter((r) => done(r) && r.due_at);
  return { measured: meas.length, sla_pct: meas.length ? Math.round((meas.filter((r) => done(r)! <= r.due_at!).length / meas.length) * 1000) / 10 : null };
};
const avgRes = (rs: Row[]) => {
  const x = rs.filter((r) => done(r)).map((r) => hours(r.created_at, done(r)!));
  return x.length ? r1(mean(x)) : null;
};

reports.get("/", async (c) => {
  const month = parseMonth(c.req.query("month"));
  if (!month) return c.json({ error: "Pick a month in the form 2026-10 (not in the future)." }, 400);
  const { from, to } = range(month);
  const cur = new Date();
  const partial = month === monthKey(cur);
  const prevDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 2, 1));
  const prevMonth = monthKey(prevDate);
  const pr = range(prevMonth);

  const rows = await ticketsIn(from, to);
  const prevRows = await ticketsIn(pr.from, pr.to);
  const k = await kpis(rows, from, to);
  const pk = prevRows.length || partial ? await kpis(prevRows, pr.from, pr.to) : null;

  // by day
  const days = new Map<string, { created: number; resolved: number; cats: Map<string, number> }>();
  for (let t = from; t < to; t += 86400) days.set(new Date(t * 1000).toISOString().slice(0, 10), { created: 0, resolved: 0, cats: new Map() });
  rows.forEach((r) => {
    const d = days.get(new Date(r.created_at * 1000).toISOString().slice(0, 10));
    if (d) (d.created++, d.cats.set(r.category ?? "Other", (d.cats.get(r.category ?? "Other") ?? 0) + 1));
  });
  const resolvedRows = (await db.prepare("SELECT resolved_at FROM tickets WHERE resolved_at >= ? AND resolved_at < ?").bind(from, to).all<{ resolved_at: number }>()).results;
  resolvedRows.forEach((r) => {
    const d = days.get(new Date(r.resolved_at * 1000).toISOString().slice(0, 10));
    if (d) d.resolved++;
  });
  const daily = [...days.entries()].map(([date, v]) => ({ date, created: v.created, resolved: v.resolved }));
  const elapsedDays = partial ? Math.max(1, Math.ceil((Date.now() / 1000 - from) / 86400)) : daily.length;
  const spikes = findSpikes(daily.slice(0, elapsedDays).map((d) => ({ date: d.date, n: d.created }))).map((s) => {
    const cats = days.get(s.date)!.cats;
    return { ...s, topCategory: [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
  });

  // categories, priorities
  const prevCat = group(prevRows, (r) => r.category ?? "Other");
  const categories = [...group(rows, (r) => r.category ?? "Other").entries()]
    .map(([name, rs]) => ({ name, n: rs.length, share: rows.length ? Math.round((rs.length / rows.length) * 1000) / 10 : 0, prev: prevCat.get(name)?.length ?? 0, avg_resolution_h: avgRes(rs), ...slaOf(rs) }))
    .sort((a, b) => b.n - a.n);
  const priorities = ["urgent", "high", "medium", "low"].map((name) => {
    const rs = rows.filter((r) => r.priority === name);
    return { name, n: rs.length, avg_resolution_h: avgRes(rs), ...slaOf(rs) };
  });

  // agents (by who holds the ticket now), requesters, assets
  const doneBy = (await db
    .prepare("SELECT t.assignee_id AS id, COUNT(*) AS resolved, AVG(t.resolved_at - t.created_at) / 3600.0 AS avg_h FROM tickets t WHERE t.resolved_at >= ? AND t.resolved_at < ? AND t.assignee_id IS NOT NULL GROUP BY t.assignee_id")
    .bind(from, to)
    .all<{ id: number; resolved: number; avg_h: number }>()).results;
  const staff = (await db.prepare("SELECT id, name, role, active FROM users WHERE role IN ('agent','admin') AND email != 'former.team.member@helpdesk.invalid'").all<{ id: number; name: string; role: string }>()).results;
  const openNow = new Map((await db.prepare("SELECT assignee_id AS id, COUNT(*) AS n FROM tickets WHERE assignee_id IS NOT NULL AND status NOT IN ('resolved','closed') GROUP BY assignee_id").all<{ id: number; n: number }>()).results.map((r) => [r.id, r.n]));
  const agents = staff
    .map((s) => ({ id: s.id, name: s.name, role: s.role, assigned: rows.filter((r) => r.assignee_id === s.id).length, resolved: doneBy.find((d) => d.id === s.id)?.resolved ?? 0, avg_resolution_h: r1(doneBy.find((d) => d.id === s.id)?.avg_h ?? null), open_now: openNow.get(s.id) ?? 0 }))
    .filter((a) => a.assigned || a.resolved || a.open_now)
    .sort((a, b) => b.resolved - a.resolved);
  const requesters = [...group(rows, (r) => String(r.requester_id)).values()].map((rs) => ({ name: rs[0]!.requester, n: rs.length })).sort((a, b) => b.n - a.n).slice(0, 10);
  const assetMap = group(rows.filter((r) => r.asset_tag), (r) => r.asset_tag!);
  const assets = [...assetMap.entries()].map(([tag, rs]) => ({ tag, n: rs.length })).sort((a, b) => b.n - a.n).filter((a) => a.n >= 2).slice(0, 10);

  // when tickets arrive (UTC = local time in Ghana)
  const heat = new Map<string, number>();
  rows.forEach((r) => {
    const d = new Date(r.created_at * 1000);
    const key = `${d.getUTCDay()}:${d.getUTCHours()}`;
    heat.set(key, (heat.get(key) ?? 0) + 1);
  });
  const heatmap = [...heat.entries()].map(([k, n]) => ({ dow: Number(k.split(":")[0]), hr: Number(k.split(":")[1]), n }));

  // history for the forecast: the six months up to and including this one
  const histRaw = (await db
    .prepare("SELECT strftime('%Y-%m', created_at, 'unixepoch') AS m, COUNT(*) AS n FROM tickets WHERE created_at >= ? AND created_at < ? GROUP BY m")
    .bind(Math.floor(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 6, 1) / 1000), to)
    .all<{ m: string; n: number }>()).results;
  const history: { month: string; created: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const m = monthKey(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 - i, 1)));
    history.push({ month: m, created: histRaw.find((h) => h.m === m)?.n ?? 0 });
  }
  const firstTicket = (await db.prepare("SELECT MIN(created_at) AS t FROM tickets").first<{ t: number | null }>())?.t;
  const firstMonth = firstTicket ? monthKey(new Date(firstTicket * 1000)) : monthKey(cur);
  const histForForecast = history.filter((h) => h.month >= firstMonth).map((h) => h.created);

  // smart analysis
  const docs: Doc[] = rows.map((r) => ({ id: r.id, ref: r.ref, title: r.title, description: r.description, requester_id: r.requester_id, category: r.category }));
  const clusters = clusterTickets(docs);
  const resTimes = rows.filter((r) => done(r)).map((r) => ({ ref: r.ref, title: r.title, hours: hours(r.created_at, done(r)!) }));
  const fence = iqrUpperFence(resTimes.map((x) => x.hours));
  const slowest = resTimes.filter((x) => x.hours > fence && x.hours > 4).sort((a, b) => b.hours - a.hours).slice(0, 5).map((x) => ({ ...x, hours: r1(x.hours)! }));
  const forecast = forecastNext(histForForecast);
  const input = {
    label: label(month), partial, cur: k, prev: pk ? { created: pk.created } : null, categories, priorities, agents, clusters, spikes, slowest, repeatAssets: assets.filter((a) => a.n >= 3), heat: heatmap, forecast,
  };
  const insights = buildInsights(input);
  const summary = buildSummary(input);

  const months: string[] = [];
  for (let d = new Date(Date.UTC(Number(firstMonth.slice(0, 4)), Number(firstMonth.slice(5)) - 1, 1)); monthKey(d) <= monthKey(cur) && months.length < 60; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(monthKey(d));
  if (!months.includes(month)) months.push(month);

  return c.json({
    month, label: label(month), previous_label: label(prevMonth), partial, generated_at: Math.floor(Date.now() / 1000), months: months.reverse(),
    kpis: k, previous: pk, daily, categories, priorities, agents, requesters, assets, heatmap, history,
    smart: { summary, insights, clusters, spikes, slowest, forecast },
  });
});

reports.get("/tickets.csv", async (c) => {
  const month = parseMonth(c.req.query("month"));
  if (!month) return c.json({ error: "Pick a month in the form 2026-10." }, 400);
  const { from, to } = range(month);
  const rows = await ticketsIn(from, to);
  await audit(c, "report.export", "admin", `Exported the ticket report for ${label(month)} (${rows.length} tickets)`);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="fortress-helpdesk-tickets-${month}.csv"`);
  c.header("Cache-Control", "no-store");
  return c.body(
    toCsv(
      ["Ref", "Title", "Category", "Priority", "Status", "Requester", "Requester email", "Assigned to", "Created (UTC)", "First response (UTC)", "Resolved (UTC)", "Closed (UTC)", "Due (UTC)", "Hours to first response", "Hours to resolve", "Met target time", "Asset tag", "Feedback", "Feedback comment"],
      rows.map((r) => [
        r.ref, r.title, r.category ?? "", r.priority, r.status.replace("_", " "), r.requester, r.requester_email, r.assignee ?? "",
        isoTime(r.created_at), isoTime(r.first_response_at), isoTime(r.resolved_at), isoTime(r.closed_at), isoTime(r.due_at),
        r.first_response_at ? r1(hours(r.created_at, r.first_response_at)) : "", done(r) ? r1(hours(r.created_at, done(r)!)) : "",
        done(r) && r.due_at ? (done(r)! <= r.due_at ? "Yes" : "No") : done(r) ? "" : "Still open", r.asset_tag ?? "",
        r.rating === 1 ? "Fixed" : r.rating === -1 ? "Not fixed" : "", r.rating_comment ?? "",
      ]),
    ),
  );
});
