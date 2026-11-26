import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit, SYSTEM } from "./audit";
import { config } from "./config";
import { db } from "./db";
import { composeReport, type Mail, type ReportMailData } from "./mailrender";
import { mailCtx, previewImages } from "./mailtemplates";
import { mailInfo, sendOne } from "./notifier";
import { buildReport, monthKey, parseMonth } from "./reports";
import { getSetting, putSetting } from "./sla";
import { firstOfNextMonth, nextAfter, parseLocal, reportMonthFor, toLocal } from "./reportschedule";

/* The monthly report by email (Admin > System > Report email). At the date and time an admin picks (Ghana time = UTC), and then on the same day and
   time every month if "repeat" is on, the numbers for the month before the send date go to: all active admins (optional), chosen agents/admins,
   and any extra addresses typed in. The email holds totals only (no ticket titles, no names), so it is safe to send outside the helpdesk.
   Each report month goes out once: `last_month` remembers which one did. */

interface Cfg {
  enabled: boolean;
  day: number;                 // 1..31: the day of the month the schedule keeps (a short month uses its last day)
  next_at: number | null;      // the next send, seconds since 1970 (UTC)
  repeat: boolean;             // every month, or just once
  admins: boolean;             // every active admin
  staff_ids: number[];         // chosen agents / admins
  custom: string[];            // extra addresses
  last_month: string | null;   // the report month that was sent ("2026-10")
  last: { at: number; month: string; sent: number; failed: number; error: string | null; by: string } | null;
  attempt: { month: string; at: number } | null; // so a broken mail setup is retried every few hours, not every ten minutes
}
const DEFAULT: Cfg = { enabled: false, day: 1, next_at: null, repeat: true, admins: true, staff_ids: [], custom: [], last_month: null, last: null, attempt: null };
let cfg: Cfg = { ...DEFAULT };
const now = () => Math.floor(Date.now() / 1000);

export const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export async function loadReportMail() {
  try {
    const s = JSON.parse((await getSetting("report_email")) ?? "null") as Partial<Cfg> | null;
    cfg = {
      enabled: !!s?.enabled,
      day: Number.isInteger(s?.day) && s!.day! >= 1 && s!.day! <= 31 ? s!.day! : 1,
      next_at: Number.isFinite(s?.next_at) ? s!.next_at! : null,
      repeat: s?.repeat !== false,
      admins: s?.admins !== false,
      staff_ids: Array.isArray(s?.staff_ids) ? s!.staff_ids!.filter((n) => Number.isInteger(n)).slice(0, 50) : [],
      custom: Array.isArray(s?.custom) ? s!.custom!.filter((e) => typeof e === "string" && EMAIL.test(e)).slice(0, 20) : [],
      last_month: typeof s?.last_month === "string" ? s.last_month : null,
      last: s?.last ?? null,
      attempt: s?.attempt ?? null,
    };
    // From before the date picker existed: "on day N at 08:00" becomes the next such moment.
    if (cfg.enabled && cfg.next_at === null) {
      const d = new Date();
      let t = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), cfg.day, 8) / 1000);
      if (t <= now() && cfg.last_month === reportMonthFor(t)) t = nextAfter(t, cfg.day, now());
      cfg.next_at = t;
    }
  } catch { cfg = { ...DEFAULT }; }
}
const save = () => putSetting("report_email", JSON.stringify(cfg));

interface Person { name: string; email: string }
/** Everyone who gets it right now: chosen people who are still active staff, plus the admins if ticked, plus the typed addresses. One email per address. */
export async function recipients(): Promise<Person[]> {
  const { results } = await db
    .prepare("SELECT id, name, email, role FROM users WHERE active = 1 AND role IN ('agent','admin') AND email NOT LIKE '%@helpdesk.invalid' ORDER BY name")
    .all<{ id: number; name: string; email: string; role: string }>();
  const out = new Map<string, Person>();
  for (const u of results) if ((cfg.admins && u.role === "admin") || cfg.staff_ids.includes(u.id)) out.set(u.email.toLowerCase(), { name: u.name, email: u.email });
  for (const e of cfg.custom) if (!out.has(e.toLowerCase())) out.set(e.toLowerCase(), { name: "", email: e });
  return [...out.values()];
}

const prevMonthOf = (d = new Date()) => monthKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));

/** The report data the email needs (totals only). */
async function dataFor(month: string): Promise<ReportMailData> {
  const r = await buildReport(month);
  const k = r.kpis;
  return {
    label: r.label, partial: r.partial,
    kpis: { created: k.created, resolved: k.resolved, closed: k.closed, open_end: k.open_end, old_open_end: k.old_open_end, median_first_response_h: k.median_first_response_h, median_resolution_h: k.median_resolution_h, sla_pct: k.sla_pct, sla_measured: k.sla_measured, csat_pct: k.csat_pct, rated: k.rated },
    prev_created: r.previous ? r.previous.created : null,
    categories: r.categories.map((c) => ({ name: c.name, n: c.n, share: c.share, avg_resolution_h: c.avg_resolution_h })),
    priorities: r.priorities.map((p) => ({ name: p.name, n: p.n, avg_resolution_h: p.avg_resolution_h, sla_pct: p.sla_pct })),
    summary: r.smart.summary,
  };
}

export interface SendResult { sent: number; failed: { email: string; error: string }[]; month: string }

/** Builds the report for `month` once and mails it to each person. One failure does not stop the others. */
export async function sendReport(month: string, to: Person[]): Promise<SendResult> {
  const data = await dataFor(month);
  const ctx = mailCtx();
  const failed: SendResult["failed"] = [];
  let sent = 0;
  for (const p of to) {
    try { await sendOne(composeReport(p, data, ctx)); sent++; }
    catch (e) { failed.push({ email: p.email, error: (e as Error).message.slice(0, 160) }); }
  }
  return { sent, failed, month };
}

/** Moves the schedule on after a send (or after finding this month's report already went out): the next monthly slot, or off for a one-off. */
async function advance() {
  if (cfg.repeat && cfg.next_at) cfg.next_at = nextAfter(cfg.next_at, cfg.day, now());
  else { cfg.enabled = false; cfg.next_at = null; }
  await save();
}

/** When the chosen moment has come, send the report for the month before it, once. A mail setup that is not ready is retried every few hours. */
export async function runDue(): Promise<SendResult | null> {
  if (!cfg.enabled || cfg.next_at === null || now() < cfg.next_at) return null;
  const month = reportMonthFor(cfg.next_at);
  if (cfg.last_month === month) { await advance(); return null; } // already sent (perhaps by hand): skip it, keep the schedule
  if (cfg.attempt?.month === month && now() - cfg.attempt.at < 6 * 3600) return null;
  const to = await recipients();
  if (!to.length) return null;
  if ((await mailInfo()).transport === "off") return null; // nothing to send with yet: try again later
  cfg.attempt = { month, at: now() };
  const r = await sendReport(month, to);
  cfg.last = { at: now(), month, sent: r.sent, failed: r.failed.length, error: r.failed[0]?.error ?? null, by: "automatic" };
  if (r.sent > 0) { cfg.last_month = month; await advance(); } else await save();
  await audit(null, "report.emailed", "admin", `Monthly report for ${month} emailed to ${r.sent} ${r.sent === 1 ? "person" : "people"}${r.failed.length ? `, ${r.failed.length} failed` : ""}`, { who: SYSTEM });
  return r;
}

export function startReportMail() {
  const run = () => void runDue().catch((e) => console.error("[report-email]", (e as Error).message));
  const first = setTimeout(run, 150_000);
  const t = setInterval(run, 10 * 60_000);
  first.unref?.();
  t.unref?.();
  return () => { clearTimeout(first); clearInterval(t); };
}

/** Admin only (mounted at /api/admin/report-email). */
export const reportEmail = new Hono<AppEnv>();

reportEmail.get("/", async (c) => {
  const [people, staff, mail] = await Promise.all([
    recipients(),
    db.prepare("SELECT id, name, email, role FROM users WHERE active = 1 AND role IN ('agent','admin') AND email NOT LIKE '%@helpdesk.invalid' ORDER BY role, name").all<{ id: number; name: string; email: string; role: string }>(),
    mailInfo(),
  ]);
  const at = cfg.next_at ?? firstOfNextMonth(now());
  return c.json({
    enabled: cfg.enabled, repeat: cfg.repeat, day: cfg.day, send_at: toLocal(at), next_at: cfg.enabled ? cfg.next_at : null, covers: reportMonthFor(at),
    now_local: toLocal(now()), suggestion: toLocal(firstOfNextMonth(now())),
    admins: cfg.admins, staff_ids: cfg.staff_ids, custom: cfg.custom,
    last: cfg.last, recipient_count: people.length,
    staff: staff.results, transport: mail.transport, app_url_set: !!config.appUrl, report_month: prevMonthOf(),
  });
});

// { enabled, send_at: "2026-12-05T08:30" (Ghana time), repeat, admins, staff_ids, custom }
reportEmail.put("/", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const at = parseLocal(b.send_at);
  if (at === null) return c.json({ error: "Pick a date and a time for the report." }, 400);
  const enabled = !!b.enabled;
  if (enabled && at <= now() && at !== cfg.next_at) return c.json({ error: "Pick a date and time in the future." }, 400);
  const custom: string[] = [...new Set(((Array.isArray(b.custom) ? b.custom : []) as unknown[]).map((e) => String(e).trim()).filter(Boolean))];
  if (custom.length > 20) return c.json({ error: "At most 20 extra addresses." }, 400);
  const bad = custom.find((e) => !EMAIL.test(e));
  if (bad) return c.json({ error: `“${bad.slice(0, 60)}” doesn't look like an email address.` }, 400);
  const ids: number[] = [...new Set(((Array.isArray(b.staff_ids) ? b.staff_ids : []) as unknown[]).map(Number).filter(Number.isInteger))].slice(0, 50);
  const valid = ids.length ? (await db.prepare(`SELECT id FROM users WHERE active = 1 AND role IN ('agent','admin') AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number }>()).results.map((r) => r.id) : [];
  const was = { ...cfg };
  cfg = { ...cfg, enabled, repeat: b.repeat !== false, day: new Date(at * 1000).getUTCDate(), next_at: at, admins: !!b.admins, staff_ids: valid, custom };
  if (cfg.enabled && !(await recipients()).length) { cfg = was; return c.json({ error: "Choose at least one person to send it to." }, 400); }
  await save();
  const n = (await recipients()).length;
  await audit(c, "report.settings", "admin", cfg.enabled ? `Monthly report email on: ${toLocal(at).replace("T", " ")} Ghana time${cfg.repeat ? ", then every month" : ", once"}, ${n} recipient${n === 1 ? "" : "s"}` : "Monthly report email off");
  return c.json({ ok: true, next_at: cfg.enabled ? cfg.next_at : null });
});

// { month?, to: "me" | "saved" }: a test to the admin's own address, or the real thing to everyone chosen, right now.
reportEmail.post("/send", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const month = parseMonth(typeof b.month === "string" ? b.month : prevMonthOf());
  if (!month) return c.json({ error: "Pick a month in the form 2026-10 (not in the future)." }, 400);
  const me = c.get("user");
  const everyone = b.to === "saved";
  const to = everyone ? await recipients() : [{ name: me.name, email: me.email }];
  if (!to.length) return c.json({ error: "Choose at least one person to send it to." }, 400);
  if ((await mailInfo()).transport === "off") return c.json({ error: "Email is switched off. Set it up under System > Email first." }, 409);
  const r = await sendReport(month, to);
  if (everyone) {
    cfg.last = { at: now(), month, sent: r.sent, failed: r.failed.length, error: r.failed[0]?.error ?? null, by: me.name };
    if (r.sent > 0 && month === prevMonthOf()) cfg.last_month = month; // sending last month's by hand means the automatic one is done for this month
    await save();
  }
  await audit(c, "report.emailed", "admin", `Report for ${month} emailed ${everyone ? `to ${r.sent} ${r.sent === 1 ? "person" : "people"}` : "to themselves as a test"}${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
  if (!r.sent) return c.json({ error: r.failed[0]?.error ?? "Nothing was sent.", failed: r.failed }, 502);
  return c.json({ ok: true, sent: r.sent, failed: r.failed, month });
});

// { month? }: the email as it would look with that month's real numbers (for the preview frame; the logo is inlined).
reportEmail.post("/preview", async (c) => {
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const month = parseMonth(typeof b.month === "string" ? b.month : prevMonthOf());
  if (!month) return c.json({ error: "Pick a month in the form 2026-10." }, 400);
  const m: Mail = composeReport({ name: c.get("user").name, email: c.get("user").email }, await dataFor(month), { ...mailCtx(), preview: true, ...previewImages() });
  return c.json({ subject: m.subject, html: m.html });
});
