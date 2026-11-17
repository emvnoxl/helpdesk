/* Smart analysis for the monthly report. Everything here is classic statistics and text mining that runs on this server over your own
   tickets: nothing is sent anywhere, and the same data always gives the same answer (no language model is involved).
     - robust spike detection (median / MAD "modified z-score")
     - trend and next-month forecast (least-squares line with a residual band)
     - recurring-problem detection (TF-IDF vectors + cosine similarity, greedy clustering)
     - slow-ticket outliers (IQR fences)
     - workload concentration (Gini coefficient)
     - rule-based findings and a plain-English summary built from all of the above.
   Pure functions, no database access, so they can be tested on their own. */

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export function percentile(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
export const median = (xs: number[]) => percentile(xs, 0.5);
export const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Least-squares line through (0,y0), (1,y1), ... */
export function linearTrend(ys: number[]) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, resid: 0 };
  const xm = (n - 1) / 2, ym = mean(ys);
  let sxy = 0, sxx = 0, sst = 0;
  ys.forEach((y, x) => { sxy += (x - xm) * (y - ym); sxx += (x - xm) ** 2; sst += (y - ym) ** 2; });
  const slope = sxy / sxx, intercept = ym - slope * xm;
  const sse = ys.reduce((a, y, x) => a + (y - (intercept + slope * x)) ** 2, 0);
  return { slope, intercept, r2: sst === 0 ? 0 : 1 - sse / sst, resid: n > 2 ? Math.sqrt(sse / (n - 2)) : 0 };
}

/** Next value of a series with an uncertainty band; null when there is too little history to say anything honest. */
export function forecastNext(history: number[]) {
  const ys = history.slice(-6);
  if (ys.length < 3) return null;
  const t = linearTrend(ys);
  const value = Math.max(0, t.intercept + t.slope * ys.length);
  const band = Math.max(t.resid, value * 0.1);
  return { value: Math.round(value), low: Math.max(0, Math.round(value - band)), high: Math.round(value + band), slope: t.slope, r2: t.r2 };
}

/** Days that are far above a normal day. Uses the median and MAD so one huge day can't hide itself by inflating the average. */
export function findSpikes(daily: { date: string; n: number }[]) {
  const ns = daily.map((d) => d.n);
  const med = median(ns);
  const mad = median(ns.map((n) => Math.abs(n - med)));
  const out: { date: string; n: number; normal: number; z: number }[] = [];
  for (const d of daily) {
    if (d.n < 3) continue;
    const z = mad > 0 ? (0.6745 * (d.n - med)) / mad : d.n >= med + 4 && d.n >= 2 * Math.max(med, 1) ? 99 : 0;
    if (z > 3.5) out.push({ date: d.date, n: d.n, normal: Math.round(med * 10) / 10, z: Math.round(Math.min(z, 99) * 10) / 10 });
  }
  return out.sort((a, b) => b.z - a.z);
}

/** Tukey fences: values above Q3 + 1.5 x IQR are unusually slow. */
export function iqrUpperFence(xs: number[]) {
  if (xs.length < 5) return Infinity;
  const q1 = percentile(xs, 0.25), q3 = percentile(xs, 0.75);
  return q3 + 1.5 * (q3 - q1);
}

/** 0 = work spread evenly, towards 1 = one person does nearly everything. */
export function gini(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), n = s.length, total = s.reduce((a, b) => a + b, 0);
  if (n < 2 || total === 0) return 0;
  return s.reduce((a, x, i) => a + (2 * (i + 1) - n - 1) * x, 0) / (n * total);
}

/* ---------- recurring problems: TF-IDF + cosine similarity ---------- */

const STOP = new Set(
  ("a an the and or but if of to in on at for with from by as is are was were be been it its this that these those i we you they he she me my our your " +
    "not no can cant cannot could would should will wont do does did done have has had get got getting gets please pls help need needs needed want " +
    "issue issues problem problems since after before when then now still again also very just some any all more has been being into out up down " +
    "hi hello dear thanks thank regards urgent urgently kindly asap today yesterday morning working work works").split(" "),
);
const undouble = (w: string) => (/([b-df-hj-np-tv-z])$/.test(w) && !/(ll|ss|zz)$/.test(w) ? w.slice(0, -1) : w); // jamm -> jam, dropp -> drop
const stem = (w: string) =>
  undouble(w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("es") ? w.slice(0, -2) : w.length > 4 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

export interface Doc { id: number; ref: string; title: string; description: string; requester_id: number; category: string | null }
export interface Cluster { size: number; requesters: number; label: string; category: string | null; refs: string[]; examples: string[] }

export function clusterTickets(docs: Doc[], opts: { threshold?: number; minSize?: number } = {}): Cluster[] {
  const threshold = opts.threshold ?? 0.3, minSize = opts.minSize ?? 3;
  const N = docs.length;
  if (N < minSize) return [];
  const toks = docs.map((d) => [...tokenize(d.title), ...tokenize(d.title), ...tokenize(d.description).slice(0, 60)]); // the title counts double
  const df = new Map<string, number>();
  toks.forEach((t) => new Set(t).forEach((w) => df.set(w, (df.get(w) ?? 0) + 1)));
  const idf = (w: string) => Math.log((N + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const unit = (m: Map<string, number>) => {
    const norm = Math.sqrt([...m.values()].reduce((a, b) => a + b * b, 0)) || 1;
    for (const [k, v] of m) m.set(k, v / norm);
    return m;
  };
  const vecs = toks.map((t) => {
    const tf = new Map<string, number>();
    t.forEach((w) => tf.set(w, (tf.get(w) ?? 0) + 1));
    for (const [w, c] of tf) tf.set(w, (1 + Math.log(c)) * idf(w));
    return unit(tf);
  });
  const dot = (a: Map<string, number>, b: Map<string, number>) => {
    const [s, l] = a.size < b.size ? [a, b] : [b, a];
    let r = 0;
    for (const [k, v] of s) r += v * (l.get(k) ?? 0);
    return r;
  };

  const groups: { members: number[]; sum: Map<string, number>; centroid: Map<string, number> }[] = [];
  vecs.forEach((v, i) => {
    let best = -1, bestSim = threshold;
    groups.forEach((g, gi) => {
      const sim = dot(v, g.centroid);
      if (sim >= bestSim) (best = gi, bestSim = sim);
    });
    if (best < 0) {
      groups.push({ members: [i], sum: new Map(v), centroid: new Map(v) });
    } else {
      const g = groups[best]!;
      g.members.push(i);
      for (const [k, x] of v) g.sum.set(k, (g.sum.get(k) ?? 0) + x);
      g.centroid = unit(new Map(g.sum));
    }
  });

  return groups
    .filter((g) => g.members.length >= minSize)
    .map((g) => {
      const label = [...g.centroid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w).join(" · ");
      const cats = new Map<string, number>();
      g.members.forEach((i) => docs[i]!.category && cats.set(docs[i]!.category!, (cats.get(docs[i]!.category!) ?? 0) + 1));
      const cat = [...cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return {
        size: g.members.length,
        requesters: new Set(g.members.map((i) => docs[i]!.requester_id)).size,
        label,
        category: cat,
        refs: g.members.map((i) => docs[i]!.ref),
        examples: g.members.slice(0, 3).map((i) => docs[i]!.title),
      };
    })
    .sort((a, b) => b.size - a.size || b.requesters - a.requesters);
}

/* ---------- findings and summary ---------- */

export interface Insight { severity: "alert" | "watch" | "info" | "good"; title: string; detail: string; action?: string }

export interface InsightInput {
  label: string;
  partial: boolean;
  cur: { created: number; resolved: number; closed: number; median_first_response_h: number | null; median_resolution_h: number | null; sla_pct: number | null; sla_measured: number; reopened: number; open_end: number; old_open_end: number };
  prev: { created: number } | null;
  categories: { name: string; n: number; prev: number; share: number }[];
  priorities: { name: string; n: number; sla_pct: number | null; measured: number }[];
  agents: { name: string; resolved: number }[];
  clusters: Cluster[];
  spikes: { date: string; n: number; normal: number; topCategory: string | null }[];
  slowest: { ref: string; title: string; hours: number }[];
  repeatAssets: { tag: string; n: number }[];
  heat: { dow: number; hr: number; n: number }[];
  forecast: ReturnType<typeof forecastNext>;
}

const DOW = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const pct = (x: number) => `${Math.round(x)}%`;
const hrs = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${(Math.round(h * 10) / 10).toString()} h` : `${(Math.round(h / 2.4) / 10).toString()} days`);

export function buildInsights(i: InsightInput): Insight[] {
  const out: Insight[] = [];
  const { cur, prev } = i;
  const add = (x: Insight) => out.push(x);

  if (prev && prev.created >= 5) {
    const change = ((cur.created - prev.created) / prev.created) * 100;
    if (Math.abs(change) >= 20 && !i.partial)
      add(change > 0
        ? { severity: "watch", title: `Ticket volume rose ${pct(change)}`, detail: `${cur.created} tickets against ${prev.created} the month before.`, action: "Look at which categories grew (below) to see whether one cause is behind it." }
        : { severity: "good", title: `Ticket volume fell ${pct(-change)}`, detail: `${cur.created} tickets against ${prev.created} the month before.` });
  }

  const grown = i.categories.filter((c) => c.n - c.prev >= 3 && c.n >= c.prev * 1.5).sort((a, b) => b.n - b.prev - (a.n - a.prev))[0];
  if (grown)
    add({ severity: "watch", title: `${grown.name} tickets jumped`, detail: `${grown.prev} last month, ${grown.n} this month.`, action: "Check for a shared cause (a failing device, a recent change) or publish a short how-to for this kind of request." });
  const top = i.categories[0];
  if (top && top.share >= 35 && cur.created >= 10) add({ severity: "info", title: `${top.name} is the biggest category`, detail: `${top.n} tickets, ${pct(top.share)} of the month.` });

  i.clusters.slice(0, 3).forEach((c) =>
    add({
      severity: c.size >= 5 ? "alert" : "watch",
      title: `Recurring problem: ${c.label}`,
      detail: `${c.size} similar tickets from ${c.requesters} ${c.requesters === 1 ? "person" : "people"}${c.category ? ` (mostly ${c.category})` : ""}. For example: "${c.examples[0]}".`,
      action: c.requesters > 1 ? "Several people hit the same thing: fixing the root cause would remove these tickets from next month." : "The same person keeps reporting it: the earlier fix may not have held.",
    }),
  );

  i.spikes.slice(0, 2).forEach((s) =>
    add({ severity: "watch", title: `Unusual spike on ${s.date}`, detail: `${s.n} tickets in one day, against about ${s.normal} on a normal day${s.topCategory ? `, mostly ${s.topCategory}` : ""}.`, action: "A spike usually means an outage or a change that affected many people. Worth a note in the incident log." }),
  );

  if (cur.sla_pct !== null && cur.sla_measured >= 5) {
    if (cur.sla_pct < 80) add({ severity: "alert", title: `Only ${pct(cur.sla_pct)} of tickets met their target time`, detail: `${cur.sla_measured} finished tickets were measured.`, action: "Review the targets or the load: either they are unrealistic or the team is stretched." });
    else if (cur.sla_pct < 90) add({ severity: "watch", title: `${pct(cur.sla_pct)} of tickets met their target time`, detail: `Slightly under the 90% mark across ${cur.sla_measured} tickets.` });
    else add({ severity: "good", title: `${pct(cur.sla_pct)} of tickets met their target time`, detail: `Measured on ${cur.sla_measured} finished tickets.` });
  }
  const worst = i.priorities.filter((p) => p.measured >= 3 && p.sla_pct !== null && p.sla_pct < 70).sort((a, b) => a.sla_pct! - b.sla_pct!)[0];
  if (worst) add({ severity: "alert", title: `${worst.name} tickets are missing their targets`, detail: `Only ${pct(worst.sla_pct!)} of ${worst.measured} were finished in time.`, action: "These are the ones people notice most." });

  if (cur.median_first_response_h !== null) {
    if (cur.median_first_response_h > 4) add({ severity: "watch", title: `Slow first replies: ${hrs(cur.median_first_response_h)} (median)`, detail: "Half of all requesters waited at least this long to hear anything.", action: "A quick acknowledgement, even before the fix, makes the wait feel shorter." });
    else if (cur.median_first_response_h <= 1 && cur.created >= 5) add({ severity: "good", title: `Fast first replies: ${hrs(cur.median_first_response_h)} (median)`, detail: "Most people heard back within the hour." });
  }

  if (cur.resolved >= 5 && cur.reopened / cur.resolved >= 0.1)
    add({ severity: "watch", title: `${cur.reopened} tickets came back after being resolved`, detail: `That is ${pct((cur.reopened / cur.resolved) * 100)} of tickets resolved this month.`, action: "Fixes may not be holding. Check the reopened tickets for a pattern." });

  if (i.slowest.length)
    add({ severity: "info", title: `${i.slowest.length} ticket${i.slowest.length === 1 ? "" : "s"} took far longer than usual`, detail: `Slowest: ${i.slowest[0]!.ref} "${i.slowest[0]!.title}" at ${hrs(i.slowest[0]!.hours)}.`, action: "Statistically unusual (outside the normal spread). Often waiting on a supplier or a person." });

  const staffed = i.agents.filter((a) => a.resolved > 0);
  const total = staffed.reduce((a, b) => a + b.resolved, 0);
  if (i.agents.length >= 2 && total >= 10) {
    const share = Math.max(...staffed.map((a) => a.resolved)) / total;
    if (share >= 0.7) add({ severity: "watch", title: "Most fixes come from one person", detail: `${pct(share * 100)} of resolved tickets were handled by ${staffed.sort((a, b) => b.resolved - a.resolved)[0]!.name}.`, action: "Knowledge that sits with one person is a risk when they are away." });
  }

  if (cur.old_open_end > 0) add({ severity: "watch", title: `${cur.old_open_end} ticket${cur.old_open_end === 1 ? "" : "s"} still open after more than 7 days`, detail: `${cur.open_end} tickets were open at the end of the month in total.`, action: "Chase or close these so the backlog doesn't hide real work." });

  const totalHeat = i.heat.reduce((a, b) => a + b.n, 0);
  if (totalHeat >= 20) {
    const byDow = new Map<number, number>();
    i.heat.forEach((h) => byDow.set(h.dow, (byDow.get(h.dow) ?? 0) + h.n));
    const [d, dn] = [...byDow.entries()].sort((a, b) => b[1] - a[1])[0]!;
    const bin = (h: number) => Math.floor(h / 2) * 2;
    const byHour = new Map<number, number>();
    i.heat.forEach((h) => byHour.set(bin(h.hr), (byHour.get(bin(h.hr)) ?? 0) + h.n));
    const [hr] = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0]!;
    add({ severity: "info", title: `Busiest time: ${DOW[d]} and ${String(hr).padStart(2, "0")}:00 to ${String(hr + 2).padStart(2, "0")}:00`, detail: `${pct((dn / totalHeat) * 100)} of tickets arrive on ${DOW[d]!.toLowerCase()}.`, action: "Plan cover and quick checks around this window." });
  }

  i.repeatAssets.slice(0, 2).forEach((a) =>
    add({ severity: "watch", title: `Device ${a.tag} was reported ${a.n} times`, detail: "Repeat tickets on one device usually mean it should be repaired or replaced rather than patched again.", action: "Inspect or swap it." }),
  );

  if (i.forecast && !i.partial) {
    add({ severity: "info", title: `Next month: about ${i.forecast.value} tickets`, detail: `Likely range ${i.forecast.low} to ${i.forecast.high}, from the trend of recent months${i.forecast.r2 < 0.3 ? " (the trend is weak, so treat this loosely)" : ""}.` });
  }

  const rank = { alert: 0, watch: 1, info: 2, good: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function buildSummary(i: InsightInput, topPriorityNote?: string): string {
  const { cur, prev } = i;
  const parts: string[] = [];
  const delta = prev && prev.created > 0 ? ` (${cur.created >= prev.created ? "up" : "down"} ${pct(Math.abs(((cur.created - prev.created) / prev.created) * 100))} on the month before)` : "";
  parts.push(`${i.partial ? "So far in" : "In"} ${i.label} the helpdesk received ${cur.created} ticket${cur.created === 1 ? "" : "s"}${delta}, resolved ${cur.resolved} and closed ${cur.closed}.`);
  if (cur.median_first_response_h !== null || cur.median_resolution_h !== null) {
    const bits: string[] = [];
    if (cur.median_first_response_h !== null) bits.push(`the median first reply took ${hrs(cur.median_first_response_h)}`);
    if (cur.median_resolution_h !== null) bits.push(`the median time to resolve was ${hrs(cur.median_resolution_h)}`);
    parts.push(`${bits.join(" and ").replace(/^./, (c) => c.toUpperCase())}${cur.sla_pct !== null && cur.sla_measured >= 3 ? `, and ${pct(cur.sla_pct)} of finished tickets met their target time` : ""}.`);
  }
  const top = i.categories[0];
  if (top) parts.push(`${top.name} was the busiest category with ${top.n} ticket${top.n === 1 ? "" : "s"} (${pct(top.share)}).`);
  if (i.clusters[0]) parts.push(`The most repeated problem was "${i.clusters[0].label}", reported ${i.clusters[0].size} times.`);
  if (cur.open_end > 0) parts.push(`${cur.open_end} ticket${cur.open_end === 1 ? " was" : "s were"} still open at the end of the period.`);
  if (topPriorityNote) parts.push(topPriorityNote);
  return parts.join(" ");
}

/* ---- help-article search ----
   Used while someone types a ticket title ("these might help") and by the Help page search. Plain information retrieval, runs here:
   each query word is weighted by how rare it is across the articles (IDF) and by how often it appears (a title hit counts triple).
   A word also matches the start of a longer word, so "print" finds "printer" while the person is still typing. The score is the share
   of the query's total weight that the article covers (0..1), so short and long questions are judged alike. */
export interface Article { id: number; title: string; body: string; category_id?: number | null }
// "Wi-Fi", "e-mail" and "log in" are one word to a person but several (or no) words to the tokenizer.
const joinWords = (s: string) => s.replace(/wi[s-]?fi/gi, "wifi").replace(/e[s-]mail/gi, "email").replace(/log[s-]?in/gi, "login").replace(/sign[s-]in/gi, "signin");
export function rankArticles<T extends Article>(articles: T[], query: string, opts: { categoryId?: number | null; min?: number; limit?: number } = {}): (T & { score: number })[] {
  const q = [...new Set(tokenize(joinWords(query)))];
  if (!q.length || !articles.length) return [];
  const docs = articles.map((a) => ({ a, title: tokenize(joinWords(a.title)), body: tokenize(joinWords(a.body)) }));
  const hit = (words: string[], t: string) => words.reduce((n, w) => n + (w === t || (t.length >= 4 && w.startsWith(t)) ? 1 : 0), 0);
  // Words no article uses can't be judged either way, so they count for half a typical word (otherwise one odd word sinks a good match).
  const dfs = q.map((t) => docs.filter((d) => hit(d.title, t) + hit(d.body, t) > 0).length);
  if (dfs.every((n) => n === 0)) return [];
  const known = q.map((_, i) => (dfs[i]! > 0 ? Math.log(1 + (docs.length - dfs[i]! + 0.5) / (dfs[i]! + 0.5)) : 0));
  const knownCount = dfs.filter((n) => n > 0).length;
  const typical = known.reduce((a, b) => a + b, 0) / knownCount;
  const idf = known.map((w, i) => (dfs[i]! > 0 ? w : typical * 0.5));
  const total = idf.reduce((a, b) => a + b, 0) || 1;
  const min = opts.min ?? 0.34;
  return docs
    .map((d) => {
      const covered = q.reduce((s, t, i) => {
        const tf = hit(d.title, t) * 3 + hit(d.body, t);
        return s + idf[i]! * (tf / (tf + 1.2)) * 1.2;
      }, 0);
      const bonus = opts.categoryId && d.a.category_id === opts.categoryId ? 0.08 : 0;
      // Evidence, so one common word in the body ("new") can't pull in an unrelated article: a hit in the title,
      // or at least two different query words in the text, or a one-word query.
      const inTitle = q.some((t) => hit(d.title, t) > 0);
      const bodyWords = q.filter((t) => hit(d.body, t) > 0).length;
      const evidence = inTitle || bodyWords >= 2 || q.length === 1;
      return { ...d.a, score: evidence ? Math.min(1, covered / total) + bonus : 0 };
    })
    .filter((r) => r.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, opts.limit ?? 4);
}
