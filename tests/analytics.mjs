// Unit tests for the report's smart analysis (src/server/analytics.ts) on made-up data with known answers.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const out = path.join(mkdtempSync(path.join(os.tmpdir(), "fg-an-")), "analytics.mjs");
await build({ entryPoints: ["src/server/analytics.ts"], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
const A = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { console.log(`${c ? "ok  " : "FAIL"}  ${n} ${c ? "" : x}`); c ? pass++ : fail++; };
const day = (i) => `2026-10-${String(i + 1).padStart(2, "0")}`;

// ---- spikes
const flat = Array.from({ length: 30 }, (_, i) => ({ date: day(i), n: [2, 3, 2, 4, 3, 2][i % 6] }));
ok("spikes: an ordinary month has none", A.findSpikes(flat).length === 0);
const spiky = flat.map((d, i) => (i === 11 ? { ...d, n: 19 } : d));
const sp = A.findSpikes(spiky);
ok("spikes: one 19-ticket day among 2-4 is found, and only that day", sp.length === 1 && sp[0].date === day(11) && sp[0].n === 19, JSON.stringify(sp));
const quiet = Array.from({ length: 30 }, (_, i) => ({ date: day(i), n: i === 5 ? 9 : 0 }));
ok("spikes: a spike in an otherwise empty month is found (MAD = 0 case)", A.findSpikes(quiet).length === 1);
ok("spikes: tiny days (under 3 tickets) are never called spikes", A.findSpikes(Array.from({ length: 30 }, (_, i) => ({ date: day(i), n: i === 3 ? 2 : 0 }))).length === 0);

// ---- trend and forecast
const t = A.linearTrend([10, 12, 14, 16, 18]);
ok("trend: a perfect line has slope 2 and R² 1", Math.abs(t.slope - 2) < 1e-9 && Math.abs(t.r2 - 1) < 1e-9);
const f = A.forecastNext([10, 12, 14, 16, 18]);
ok("forecast: continues the line (20) with a sensible band", f && f.value === 20 && f.low <= 20 && f.high >= 20 && f.high - f.low <= 6, JSON.stringify(f));
ok("forecast: refuses to guess from fewer than 3 months", A.forecastNext([10, 12]) === null);
ok("forecast: never goes negative", A.forecastNext([9, 5, 2, 1]).value >= 0);

// ---- statistics helpers
ok("median/percentile are right", A.median([1, 3, 2]) === 2 && A.percentile([1, 2, 3, 4, 5], 0.9) === 4.6);
const fence = A.iqrUpperFence([1, 2, 2, 3, 3, 3, 4, 4, 5, 40]);
ok("outliers: 40 hours is beyond the fence, 5 is not", fence < 40 && fence > 5, String(fence));
ok("gini: even work is ~0, one person doing everything is high", A.gini([5, 5, 5, 5]) < 0.01 && A.gini([0, 0, 0, 20]) > 0.7);

// ---- recurring problems
const mk = (id, title, description, who, category) => ({ id, ref: `FG-${id}`, title, description, requester_id: who, category });
const docs = [
  mk(1, "Printer on floor 3 keeps jamming", "paper jam again on the HP printer", 1, "Printing"),
  mk(2, "Floor 3 printer jammed", "the printer jams every second page", 2, "Printing"),
  mk(3, "Printer jam level 3", "HP printer paper stuck", 3, "Printing"),
  mk(4, "Printer jamming again", "third floor printer paper jam", 1, "Printing"),
  mk(5, "Cannot connect to office wifi", "laptop wifi drops in the boardroom", 4, "Network"),
  mk(6, "Wifi disconnects in boardroom", "wifi keeps dropping", 5, "Network"),
  mk(7, "Wifi keeps dropping", "boardroom wifi connection lost", 6, "Network"),
  mk(8, "New starter needs laptop", "please set up a laptop for the new accountant", 7, "Hardware"),
  mk(9, "Reset my password", "forgot my outlook password", 8, "Accounts & Access"),
];
const cl = A.clusterTickets(docs);
ok("recurring: finds the printer problem (4 tickets, 3 people)", cl[0] && cl[0].size === 4 && cl[0].requesters === 3 && /printer|jam/.test(cl[0].label), JSON.stringify(cl[0]));
ok("recurring: finds the wifi problem as a separate group", cl.length === 2 && cl[1].size === 3 && /wifi|boardroom/.test(cl[1].label), JSON.stringify(cl.map((c) => [c.size, c.label])));
ok("recurring: one-off tickets are not grouped", !cl.some((c) => c.refs.includes("FG-8") || c.refs.includes("FG-9")));
ok("recurring: too few tickets gives no clusters (and no crash)", A.clusterTickets(docs.slice(0, 2)).length === 0 && A.clusterTickets([]).length === 0);
const big = Array.from({ length: 3000 }, (_, i) => mk(i, `Ticket about thing${i % 97} item${i % 13}`, `details ${i % 31} widget${i}`, i % 50, "Other"));
const t0 = Date.now();
A.clusterTickets(big);
ok("recurring: 3,000 tickets cluster in a few seconds", Date.now() - t0 < 8000, `${Date.now() - t0}ms`);

// ---- findings and summary
const base = {
  label: "October 2026", partial: false,
  cur: { created: 60, resolved: 55, closed: 50, median_first_response_h: 0.4, median_resolution_h: 3, sla_pct: 96, sla_measured: 50, reopened: 1, open_end: 5, old_open_end: 0 },
  prev: { created: 40 },
  categories: [{ name: "Network", n: 24, prev: 8, share: 40 }, { name: "Printing", n: 12, prev: 10, share: 20 }],
  priorities: [{ name: "urgent", n: 5, sla_pct: 100, measured: 5 }],
  agents: [{ name: "Kofi", resolved: 40 }, { name: "Esi", resolved: 10 }],
  clusters: cl, spikes: [{ date: "2026-10-12", n: 19, normal: 3, topCategory: "Network" }], slowest: [], repeatAssets: [{ tag: "PRN-07", n: 4 }],
  heat: [{ dow: 1, hr: 8, n: 30 }, { dow: 2, hr: 9, n: 10 }], forecast: { value: 66, low: 58, high: 74, slope: 5, r2: 0.8 },
};
const ins = A.buildInsights(base);
const titles = ins.map((i) => i.title).join(" | ");
ok("findings: volume rise, category jump, recurring problem, spike, repeat device, busy time and forecast are all reported", /rose 50%/.test(titles) && /Network tickets jumped/.test(titles) && /Recurring problem/.test(titles) && /spike on 2026-10-12/.test(titles) && /PRN-07/.test(titles) && /Mondays/.test(titles) && /Next month: about 66/.test(titles), titles);
ok("findings: ordered most serious first, and the good news is last", ["alert", "watch", "info", "good"].indexOf(ins[0].severity) <= ["alert", "watch", "info", "good"].indexOf(ins.at(-1).severity) && ins.at(-1).severity === "good", ins.map((i) => i.severity).join());
ok("findings: a healthy target-time rate is praised", ins.some((i) => i.severity === "good" && /96%/.test(i.title)));
ok("findings: workload concentration is flagged (80% by one person)", ins.some((i) => /one person/.test(i.title)));
const bad = A.buildInsights({ ...base, cur: { ...base.cur, sla_pct: 60 }, spikes: [], clusters: [], repeatAssets: [] });
ok("findings: poor target-time rate is an alert", bad.some((i) => i.severity === "alert" && /60%/.test(i.title)));
const empty = A.buildInsights({ ...base, cur: { created: 0, resolved: 0, closed: 0, median_first_response_h: null, median_resolution_h: null, sla_pct: null, sla_measured: 0, reopened: 0, open_end: 0, old_open_end: 0 }, prev: null, categories: [], priorities: [], agents: [], clusters: [], spikes: [], repeatAssets: [], heat: [], forecast: null });
ok("findings: an empty month produces no noise", empty.length === 0, JSON.stringify(empty));
const sum = A.buildSummary(base);
ok("summary: reads as plain English with the key numbers", /received 60 tickets \(up 50%/.test(sum) && /median first reply took 24 min/.test(sum) && /Network was the busiest category/.test(sum), sum);
ok("summary: a month in progress says 'so far'", /^So far in/.test(A.buildSummary({ ...base, partial: true })));

// ---- help-article search
const kb = [
  { id: 1, title: "The printer is offline or won't print", body: "Check the printer is switched on, with paper. Open Settings, Printers and scanners and cancel stuck jobs.", category_id: 5 },
  { id: 2, title: "I can't connect to the office Wi-Fi", body: "Turn Wi-Fi off and on, forget the network and connect again. Restart the computer.", category_id: 1 },
  { id: 3, title: "I forgot my password or my account is locked", body: "Use forgot my password on the sign-in page. Accounts lock after several wrong attempts.", category_id: 4 },
  { id: 4, title: "My computer is slow or keeps freezing", body: "Restart, close programs, check free space on the C: drive.", category_id: 2 },
];
const top = (q, o) => A.rankArticles(kb, q, o).map((r) => r.id);
ok("articles: 'printer offline' finds the printer article first", top("printer offline")[0] === 1, String(top("printer offline")));
ok("articles: a half-typed word matches (prin -> printer)", top("prin")[0] === 1);
ok("articles: 'wifi' (one word) finds 'Wi-Fi'", top("wifi keeps dropping")[0] === 2, String(top("wifi keeps dropping")));
ok("articles: plurals and endings are handled (passwords, locked)", top("passwords locked out")[0] === 3);
ok("articles: unrelated words find nothing", top("quarterly budget forecast spreadsheet").length === 0);
ok("articles: a category match breaks ties in favour of that category", A.rankArticles(kb, "computer restart", { categoryId: 2 })[0]?.id === 4);
ok("articles: one common word in the body is not enough (no 'new' -> 'new phone' mix-ups)", A.rankArticles([...kb, { id: 9, title: "Set up your phone", body: "You will need a new phone number for the app and a new code.", category_id: 1 }], "need a new chair").length === 0);
ok("articles: an empty or stop-word-only query finds nothing", top("").length === 0 && top("please help me").length === 0);
ok("articles: scores stay in range and are sorted best first", (() => { const r = A.rankArticles(kb, "computer connect restart", { min: 0.05, limit: 10 }); return r.every((x, i) => x.score <= 1.1 && (i === 0 || r[i - 1].score >= x.score)); })());

// ---- working hours, recurrence and email text (src/server/worktime.ts)
{
  const out2 = path.join(path.dirname(out), "worktime.mjs");
  await build({ entryPoints: ["src/server/worktime.ts"], bundle: true, platform: "node", format: "esm", outfile: out2, logLevel: "silent" });
  const W = await import(pathToFileURL(out2).href);
  const at = (s) => Math.floor(Date.parse(s + "Z") / 1000);
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16);
  const cal = { enabled: true, days: [1, 2, 3, 4, 5], start: 480, end: 1020, holidays: [] };
  const off = { ...cal, enabled: false };
  const H = 3600;
  // 2026-11-13 is a Friday, 2026-11-16 a Monday
  ok("hours: switched off, it is plain addition", W.addWorkSeconds(off, at("2026-11-13T16:00"), 4 * H) === at("2026-11-13T20:00"));
  ok("hours: inside the day it is plain addition too", iso(W.addWorkSeconds(cal, at("2026-11-13T09:00"), 4 * H)) === "2026-11-13T13:00");
  ok("hours: Friday 16:00 + 4 h ends Monday 11:00", iso(W.addWorkSeconds(cal, at("2026-11-13T16:00"), 4 * H)) === "2026-11-16T11:00", iso(W.addWorkSeconds(cal, at("2026-11-13T16:00"), 4 * H)));
  ok("hours: raised on Saturday night, the clock starts Monday 08:00", iso(W.addWorkSeconds(cal, at("2026-11-14T22:30"), 1 * H)) === "2026-11-16T09:00");
  ok("hours: a 24 h target on 9 h days takes 2 days and 6 hours", iso(W.addWorkSeconds(cal, at("2026-11-16T08:00"), 24 * H)) === "2026-11-18T14:00");
  ok("hours: a target that ends exactly at closing time is due at closing time, not next morning", iso(W.addWorkSeconds(cal, at("2026-11-16T13:00"), 4 * H)) === "2026-11-16T17:00");
  ok("hours: holidays are skipped", iso(W.addWorkSeconds({ ...cal, holidays: ["2026-11-16"] }, at("2026-11-13T16:00"), 4 * H)) === "2026-11-17T11:00");
  ok("hours: working time between Friday 16:00 and Monday 11:00 is 4 h", W.workSecondsBetween(cal, at("2026-11-13T16:00"), at("2026-11-16T11:00")) === 4 * H);
  ok("hours: a weekend holds no working time", W.workSecondsBetween(cal, at("2026-11-14T00:00"), at("2026-11-15T23:59")) === 0);
  ok("hours: between is 0 when the end is not after the start", W.workSecondsBetween(cal, 500, 500) === 0 && W.workSecondsBetween(cal, 900, 100) === 0);
  ok("hours: add and between agree", (() => { const s = at("2026-11-12T15:20"); return [1, 5, 9, 13, 40, 100].every((h) => W.workSecondsBetween(cal, s, W.addWorkSeconds(cal, s, h * H)) === h * H); })());
  ok("hours: a calendar with no working days falls back to plain time instead of hanging", W.addWorkSeconds({ ...cal, days: [] }, 1000, 60) === 1060);
  ok("hours: every day a holiday does not hang either", W.addWorkSeconds({ ...cal, days: [1], holidays: [] , end: 480 }, 1000, 60) === 1060);
  const cc = W.cleanCalendar({ enabled: true, days: [5, 1, 1, 9, "x"], start: "07:30", end: "16:00", holidays: ["2026-12-25", "25/12/2026", 7] });
  ok("hours: what an admin types is cleaned", cc.enabled && String(cc.days) === "1,5" && cc.start === 450 && cc.end === 960 && String(cc.holidays) === "2026-12-25", JSON.stringify(cc));

  ok("repeat: monthly on the 31st lands on the last day of short months and comes back to the 31st", (() => {
    let t = at("2026-01-31T08:00"); const seen = [];
    for (let i = 0; i < 3; i++) { t = W.nextRun("monthly", t, 31); seen.push(iso(t).slice(0, 10)); }
    return String(seen) === "2026-02-28,2026-03-31,2026-04-30";
  })());
  ok("repeat: weekdays skip the weekend", iso(W.nextRun("weekdays", at("2026-11-13T08:00"), 13)) === "2026-11-16T08:00");
  ok("repeat: quarterly and yearly", iso(W.nextRun("quarterly", at("2026-11-30T08:00"), 30)) === "2027-02-28T08:00" && iso(W.nextRun("yearly", at("2026-11-16T08:00"), 16)) === "2027-11-16T08:00");
  ok("repeat: after a long gap the next run is the first one in the future", (() => { const now = at("2026-11-16T12:00"); const n = W.nextRunAfter("daily", at("2026-10-01T08:00"), 1, now); return iso(n) === "2026-11-17T08:00"; })());

  const gmail = "Yes it is.\n\nOn Mon, 16 Nov 2026 at 09:12, Fortress IT <it@x.com>\nwrote:\n> Is it on?\n> Thanks\n";
  ok("email: a Gmail reply keeps only the new text (the 'wrote:' line may wrap)", W.cleanEmailBody(gmail) === "Yes it is.", JSON.stringify(W.cleanEmailBody(gmail)));
  const outlook = "Still broken.\r\n\r\nFrom: Fortress IT <it@x.com>\r\nSent: Monday, November 16, 2026 9:12 AM\r\nTo: Kofi\r\nSubject: [FG-0042] Printer\r\n\r\nHi Kofi";
  ok("email: an Outlook reply too", W.cleanEmailBody(outlook) === "Still broken.", JSON.stringify(W.cleanEmailBody(outlook)));
  ok("email: Outlook-on-the-web separator and signature", W.cleanEmailBody("Thanks!\n________________________________\nFrom: IT") === "Thanks!" && W.cleanEmailBody("Done\n-- \nKofi\nFinance") === "Done");
  ok("email: a line that merely starts with 'From' in normal text is kept", W.cleanEmailBody("From Monday I am away.\nPlease fix before then.") === "From Monday I am away.\nPlease fix before then.");
  ok("email: html is turned into text", W.cleanEmailBody(W.htmlToText("<html><head><style>p{}</style></head><body><p>Hello &amp; welcome</p><div>Line&nbsp;two<br>three</div></body></html>")) === "Hello & welcome\nLine two\nthree");
  ok("email: subject prefixes and our reference are removed", W.cleanSubject("RE: FW: [FG-0042] Printer offline") === "Printer offline" && W.cleanSubject("Re: re: hello") === "hello");
  ok("email: the reference is found only when it is one", W.refIn("RE: [FG-0042] Printer") === "FG-0042" && W.refIn("fwd: fg-12345 thing") === "FG-12345" && W.refIn("config-0042 broken") === null);
  ok("email: a name is made from the address", W.nameFromEmail("ama.boateng2@x.com") === "Ama Boateng" && W.nameFromEmail("123@x.com") === "Unknown sender");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
