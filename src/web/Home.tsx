import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { BrandMark } from "./brand";
import { HardwareNudge } from "./HardwareNudge";
import { streamFor, useLive } from "./live";
import { CountUp } from "./motion";
import { Progress } from "./MyQueue";
import { TourDialog } from "./Tour";
import { ago } from "./viz";

/* Home for normal users. One question at the top ("what do you need help with?") that starts a ticket, what IT is doing right now
   beside it, then the person's own tickets and a few shortcuts. Everything on it is live. */

type Go = "new" | "queue" | "board" | "help" | "account";
const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const ARROW = "M5 12h14M13 6l6 6-6 6";
const IDEAS = ["Wi-Fi is not working", "I can't print", "I forgot my password", "Outlook won't open"];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function Home({ name, go, open, onNew }: { name: string; go: (page: Go) => void; open: (id: number) => void; onNew: (title?: string) => void }) {
  const first = name.split(" ")[0];
  const [q, setQ] = useState<any>(null);
  const [b, setB] = useState<any>(null);
  const [text, setText] = useState("");
  const [tour, setTour] = useState(false);

  const load = useCallback(() => {
    void api("/queue").then(setQ, () => setQ((p: any) => p ?? { items: [], recent: [], now: Date.now() / 1000 }));
    void api("/board").then(setB, () => {});
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 60_000); // safety net; pushes below are instant
    return () => clearInterval(t);
  }, [load]);
  useLive(streamFor(false), load);

  const submit = (e: FormEvent) => { e.preventDefault(); onNew(text.trim() || undefined); };
  const s = b?.summary;
  const items: any[] = q?.items ?? [];
  const waitingOnMe = items.filter((t) => t.status === "waiting").length;

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
      <HardwareNudge />

      {/* ---- the question, and what IT is doing ---- */}
      <section className="rise-in relative min-w-0 overflow-hidden rounded-3xl bg-ink text-white dark:ring-1 dark:ring-white/10 xl:col-span-3">
        <BrandMark onDark className="pointer-events-none absolute -right-16 top-1/2 hidden h-[140%] -translate-y-1/2 opacity-20 lg:block" />
        <div className="relative grid gap-8 px-6 py-9 sm:px-10 sm:py-12 lg:grid-cols-5 lg:items-center">
          <div className="min-w-0 lg:col-span-3">
            <p className="text-xs font-bold uppercase tracking-[0.25em] text-brand-amber">Fortress Oil &amp; Gas Helpdesk</p>
            <h1 className="mt-3 text-3xl font-extrabold leading-tight sm:text-5xl">{greeting()}, {first}.</h1>
            <p className="mt-2 text-lg text-white/70">What do you need help with?</p>
            <form onSubmit={submit} className="mt-6 flex max-w-xl items-center gap-1 rounded-2xl bg-surface p-1.5 shadow-lg ring-1 ring-black/5 focus-within:ring-2 focus-within:ring-brand-green dark:ring-white/20">
              <span className="pl-2.5 text-neutral-500"><Ico d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3" size={18} /></span>
              <input
                value={text} onChange={(e) => setText(e.target.value)} maxLength={150} aria-label="Describe your problem in a few words"
                placeholder="What's wrong?"
                className="min-w-0 flex-1 bg-transparent px-2.5 py-2.5 text-base text-fg placeholder:text-neutral-500 focus:outline-none"
              />
              <button className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-brand-green px-4 py-2.5 text-sm font-extrabold text-ink transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-fg">
                <span className="hidden sm:inline">Submit a ticket</span><span className="sm:hidden">Submit</span><Ico d={ARROW} size={16} />
              </button>
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-white/45">Common:</span>
              {IDEAS.map((t) => (
                <button key={t} type="button" onClick={() => onNew(t)} className="rounded-full border border-white/20 px-3 py-1 font-semibold text-white/80 transition hover:border-white/50 hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white">{t}</button>
              ))}
            </div>
          </div>

          <aside className="min-w-0 rounded-2xl bg-white/[0.06] p-5 ring-1 ring-white/10 backdrop-blur-sm lg:col-span-2" aria-label="IT right now">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-white/60">IT right now</h2>
              {b && (
                <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-bold ${b.it_online ? "bg-brand-green/20 text-white" : "bg-white/10 text-white/60"}`}>
                  {b.it_online ? <span className="now-dot" /> : <span className="h-2 w-2 rounded-full bg-white/40" />}
                  {b.it_online ? "Online" : "Away"}
                </span>
              )}
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-3">
              {([["Being worked on", s?.working, "var(--color-brand-green)"], ["Waiting in line", s?.waiting, "var(--color-brand-amber)"], ["Fixed today", s?.resolved_today, "var(--color-brand-red)"]] as const).map(([label, n, c]) => (
                <div key={label} className="min-w-0">
                  <dd className="text-3xl font-extrabold leading-none tabular-nums sm:text-4xl">{s ? <CountUp value={Number(n) || 0} /> : "–"}</dd>
                  <dt className="mt-2 border-t-2 pt-1.5 text-[11px] font-semibold leading-tight text-white/60" style={{ borderColor: c }}>{label}</dt>
                </div>
              ))}
            </dl>
            <button type="button" onClick={() => go("board")} className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-white/80 hover:text-white focus:outline-none focus-visible:underline">
              Open the live board <Ico d={ARROW} size={15} />
            </button>
          </aside>
        </div>
        <div className="brand-stripe" />
      </section>

      {/* ---- your tickets ---- */}
      <section className="min-w-0 xl:col-span-2" aria-label="Your tickets">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-extrabold">
            Your open tickets
            {items.length > 0 && <span className="ml-2 rounded-full bg-stone-200 px-2 py-0.5 align-middle text-xs font-bold text-neutral-600">{items.length}</span>}
          </h2>
          <button className="text-sm font-semibold text-neutral-500 hover:text-fg" onClick={() => go("queue")}>My queue →</button>
        </div>
        {waitingOnMe > 0 && (
          <p className="mb-3 rounded-xl bg-brand-amber/20 px-4 py-2.5 text-sm font-semibold ring-1 ring-inset ring-amber-300" role="status">
            IT is waiting for a reply from you on {waitingOnMe === 1 ? "one ticket" : `${waitingOnMe} tickets`}.
          </p>
        )}
        {q === null ? (
          <div className="h-32 animate-pulse rounded-2xl bg-stone-100" />
        ) : items.length ? (
          <ul className="space-y-3">
            {items.slice(0, 4).map((t, i) => (
              <li key={t.id} className="rise-in" style={{ ["--i" as string]: i + 1 }}>
                <button onClick={() => open(t.id)}
                  className={`group w-full rounded-2xl border bg-surface p-4 text-left shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green sm:p-5 ${t.status === "in_progress" ? "glow-soft border-transparent" : "border-stone-200 hover:border-stone-400"}`}>
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 text-sm font-extrabold">{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate font-semibold">{t.title}</span>
                    {t.position ? (
                      <span className="shrink-0 rounded-full bg-ink px-2.5 py-1 text-xs font-bold text-white dark:bg-stone-200 dark:text-fg">#{t.position} in line</span>
                    ) : t.status === "in_progress" ? (
                      <span className="inline-flex shrink-0 items-center gap-2 text-xs font-bold text-ok"><span className="now-dot" /> Being worked on</span>
                    ) : null}
                    <span className="shrink-0 text-neutral-400 transition group-hover:translate-x-0.5 group-hover:text-fg"><Ico d={ARROW} size={16} /></span>
                  </div>
                  <div className="mt-3"><Progress status={t.status} /></div>
                  <div className="mt-2 text-xs text-neutral-500">
                    {t.status === "waiting" ? <b className="text-fg">Waiting for your reply</b> : t.assignee ? <><b className="text-fg">{t.assignee}</b> is on it</> : "Waiting to be picked up by IT"}
                    {" · "}updated {ago(t.updated_at, q.now)}
                  </div>
                </button>
              </li>
            ))}
            {items.length > 4 && <li><button className="text-sm font-semibold text-neutral-500 hover:text-fg" onClick={() => go("queue")}>and {items.length - 4} more in My queue →</button></li>}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-surface px-6 py-10 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-brand-green/15 text-ok"><Ico d="M5 12.5l4.5 4.5L19 7.5" size={24} /></span>
            <p className="mt-3 font-bold">Nothing open. You're all clear.</p>
            <p className="mt-1 text-sm text-neutral-500">When something stops working, describe it above and IT takes it from there.</p>
          </div>
        )}

        {q?.recent?.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-500">Recently fixed</h3>
            <ul className="divide-y divide-stone-200 overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm">
              {q.recent.slice(0, 3).map((t: any) => (
                <li key={t.id}>
                  <button onClick={() => open(t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-stone-50 focus:outline-none focus-visible:bg-stone-50">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-green/15 text-ok"><Ico d="M5 12.5l4.5 4.5L19 7.5" size={13} /></span>
                    <span className="w-20 shrink-0 font-bold">{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="shrink-0 text-xs text-neutral-500">{ago(t.resolved_at ?? t.updated_at, q.now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ---- shortcuts ---- */}
      <section className="min-w-0" aria-label="Shortcuts">
        <h2 className="mb-3 text-lg font-extrabold">Shortcuts</h2>
        <ul className="space-y-2.5">
          <Shortcut i={1} onClick={() => go("help")} title="Help articles" sub="Quick fixes and videos for the usual problems" tint="var(--color-brand-green)"
            d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" />
          <Shortcut i={2} onClick={() => go("board")} title="Live board" sub="What IT is working on and who is next" tint="var(--color-brand-amber)" d="M3 12h4l3-8 4 16 3-8h4" />
          <Shortcut i={3} onClick={() => go("account")} title="Your account" sub="Your PIN and this computer's details" tint="var(--color-brand-red)"
            d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0" />
          <Shortcut i={4} onClick={() => setTour(true)} title="Take the tour" sub="One minute: how the helpdesk works" tint="var(--color-stone-400)" d="M8 5v14l11-7z" />
        </ul>
      </section>

      {tour && <TourDialog onClose={() => setTour(false)} />}
    </div>
  );
}

function Shortcut({ i, title, sub, d, tint, onClick }: { i: number; title: string; sub: ReactNode; d: string; tint: string; onClick: () => void }) {
  return (
    <li className="rise-in" style={{ ["--i" as string]: i }}>
      <button onClick={onClick} className="group flex w-full items-center gap-3.5 rounded-2xl border border-stone-200 bg-surface p-3.5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-stone-400 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-fg" style={{ background: `color-mix(in srgb, ${tint} 18%, transparent)` }}><Ico d={d} size={20} /></span>
        <span className="min-w-0 flex-1">
          <b className="block">{title}</b>
          <span className="block truncate text-sm text-neutral-500">{sub}</span>
        </span>
        <span className="shrink-0 text-neutral-400 transition group-hover:translate-x-0.5 group-hover:text-fg"><Ico d={ARROW} size={16} /></span>
      </button>
    </li>
  );
}
