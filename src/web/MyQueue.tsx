import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ago, timeFmt } from "./viz";

const STEPS = ["Received", "In progress", "Resolved"];
const stepOf = (status: string) => (status === "open" ? 0 : status === "in_progress" || status === "waiting" ? 1 : 2);

/** Three-step tracker. Each state has a label, so it never relies on colour alone. */
export function Progress({ status }: { status: string }) {
  const at = stepOf(status);
  return (
    <ol className="flex items-center gap-1.5" aria-label={`Progress: ${STEPS[at]}`}>
      {STEPS.map((label, i) => (
        <li key={label} className="flex flex-1 flex-col gap-1">
          <span className="h-1.5 rounded-full" style={{ background: i <= at ? (i === at && at < 2 ? "var(--color-brand-amber)" : "var(--color-brand-green)") : "var(--color-stone-200)" }} />
          <span className={`text-[11px] font-semibold ${i === at ? "text-fg" : "text-neutral-400"}`}>
            {i === at && status === "waiting" ? "Waiting" : label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A normal user's own open tickets, with a progress tracker and their place in line. */
export function MyQueue({ open }: { open: (id: number) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [updated, setUpdated] = useState<number | null>(null);

  const load = useCallback(
    () => api("/queue").then((r) => { setD(r); setUpdated(Date.now()); setErr(""); }, (e) => setErr(e.message)),
    [],
  );

  useEffect(() => {
    void load();
    // Gentle refresh: every 2 minutes, and whenever the tab becomes visible again. Never while hidden.
    const poll = setInterval(() => !document.hidden && void load(), 120_000);
    const vis = () => !document.hidden && void load();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", vis); };
  }, [load]);

  if (err && !d) return <p className="text-red-700">Couldn't load your queue: {err}</p>;
  if (!d) return <p className="text-neutral-500">Loading…</p>;

  return (
    <div className="">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-500">
        <span>Your open tickets and where they sit in IT's line.</span>
        <span className="flex items-center gap-3">
          {updated && <span>Updated {timeFmt.format(updated)}</span>}
          <button className="font-semibold text-neutral-600 hover:text-fg" onClick={() => void load()}>Refresh</button>
        </span>
      </div>
      {err && <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}

      {d.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-10 text-center text-sm text-neutral-500">
          You have no open tickets. Anything you submit will show up here.
        </div>
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {d.items.map((t: any, i: number) => (
            <li key={t.id} className="rise-in" style={{ ["--i" as string]: i }}>
              <button
                onClick={() => open(t.id)}
                className={`w-full rounded-2xl border bg-surface p-5 text-left shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${t.status === "in_progress" ? "glow-now border-transparent" : "border-stone-200 hover:border-stone-400"}`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {t.status === "in_progress" && (
                    <span className="inline-flex items-center gap-2 self-center rounded-full bg-ink px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider text-white">
                      <span className="now-dot" />Being worked on <span className="working-dots"><i /><i /><i /></span>
                    </span>
                  )}
                  <span className="font-extrabold">{t.ref}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{t.title}</span>
                  {t.position && (
                    <span className="rounded-full bg-ink px-3 py-1 text-xs font-bold text-white" title="Your place among tickets waiting to start, most urgent first">
                      #{t.position} in line{d.capped ? "" : ` of ${d.waiting_total}`}
                    </span>
                  )}
                </div>
                <div className="mt-3"><Progress status={t.status} /></div>
                <div className="mt-3 text-sm text-neutral-500">
                  {t.assignee ? <><b className="text-fg">{t.assignee}</b> is on it</> : "Waiting to be picked up by IT"}
                  {" · "}updated {ago(t.updated_at, d.now)}
                  {t.status === "waiting" && <span className="ml-2 font-semibold text-fg">IT is waiting for a reply from you</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {d.recent.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-neutral-500">Recently resolved</h2>
          <ul className="divide-y divide-stone-200 overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm">
            {d.recent.map((t: any) => (
              <li key={t.id}>
                <button onClick={() => open(t.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-stone-50 focus:outline-none focus-visible:bg-stone-50">
                  <span className="w-20 shrink-0 font-bold">{t.ref}</span>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="shrink-0 text-xs text-neutral-500">{ago(t.resolved_at ?? t.updated_at, d.now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
