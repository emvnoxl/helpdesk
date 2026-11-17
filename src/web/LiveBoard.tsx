import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { CountUp } from "./motion";
import { useLive } from "./live";
import { STATUS, ago, timeFmt } from "./viz";

/* The simple live board for normal users: what IT is working on right now, who is next, and where *you* sit.
   Other people's tickets appear only as a reference and category, never a title or a name. */

function Stat({ label, value, accent, sub, i }: { label: string; value: number; accent: string; sub: string; i: number }) {
  return (
    <div className="rise-in rounded-2xl border border-stone-200 bg-surface p-5 shadow-sm" style={{ borderLeft: `6px solid ${accent}`, ["--i" as string]: i }}>
      <div className="text-xs font-bold uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 text-5xl font-extrabold leading-none"><CountUp value={value} /></div>
      <div className="mt-2 text-sm text-neutral-500">{sub}</div>
    </div>
  );
}

const YouChip = ({ pulse = false }: { pulse?: boolean }) => (
  <span className={`rounded-full bg-ink px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-white ${pulse ? "you-pulse" : ""}`}>You</span>
);

export function LiveBoard({ open }: { open: (id: number) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState("");
  const [updated, setUpdated] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api("/board"));
      setUpdated(Date.now());
      setErr("");
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useLive("/stream", () => void load()); // instant: the server pushes whenever anything changes

  useEffect(() => {
    void load();
    // Safety net, every minute while the tab is visible, and again when it comes back into view. Never while hidden.
    const poll = setInterval(() => !document.hidden && void load(), 60_000);
    const vis = () => !document.hidden && void load();
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", vis); };
  }, [load]);

  if (err && !d) return <p className="text-red-700">Couldn't load the board: {err}</p>;
  if (!d) return <p className="text-neutral-500">Loading…</p>;

  const s = d.summary;
  const working: any[] = d.working;
  const next: any[] = d.next;
  const mine: any[] = d.mine;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-500">
        <span className="flex items-center gap-2"><span className="live-dot inline-block h-2.5 w-2.5 rounded-full bg-brand-green" /> Live · updates the moment anything changes</span>
        <span className="flex items-center gap-3">
          {updated && <span>Updated {timeFmt.format(updated)}</span>}
          <button className="font-semibold text-neutral-600 hover:text-fg" onClick={() => void load()}>Refresh</button>
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat i={0} label="Waiting in line" value={s.waiting ?? 0} accent="var(--v-created)" sub="Not started yet" />
        <Stat i={1} label="Being worked on" value={s.working ?? 0} accent="var(--color-brand-green)" sub="IT is on these now" />
        <Stat i={2} label="Resolved today" value={s.resolved_today ?? 0} accent="var(--color-brand-amber)" sub="Fixed so far today" />
      </div>

      {/* where I sit */}
      <section className="rise-in" style={{ ["--i" as string]: 3 }}>
        <h2 className="mb-2 text-lg font-extrabold">Where you sit</h2>
        {mine.length ? (
          <ul className="space-y-2.5">
            {mine.map((t) => {
              const active = t.status === "in_progress";
              return (
                <li key={t.id}>
                  <button onClick={() => open(t.id)} className={`flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl border bg-surface p-4 text-left shadow-sm transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${active ? "glow-now border-transparent" : "border-stone-200"}`}>
                    <span className="text-lg font-extrabold">{t.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {t.position ? (
                      <span className="rounded-full bg-ink px-3 py-1 text-sm font-bold text-white">#{t.position} in line{d.capped ? "" : ` of ${s.waiting}`}</span>
                    ) : active ? (
                      <span className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-xs font-extrabold uppercase tracking-wider text-white">
                        <span className="now-dot" />Being worked on{t.assignee ? ` by ${t.assignee}` : ""} <span className="working-dots"><i /><i /><i /></span>
                      </span>
                    ) : (
                      <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-neutral-700">{t.status === "waiting" ? "Waiting for your reply" : STATUS[t.status] ?? t.status}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-6 text-center text-sm text-neutral-500">You have no open tickets right now.</div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rise-in" style={{ ["--i" as string]: 4 }}>
          <h2 className="mb-2 text-lg font-extrabold">Being worked on now</h2>
          {working.length ? (
            <ul className="space-y-2.5">
              {working.map((t, i) => (
                <li key={t.ref} className={`rounded-2xl bg-surface p-4 shadow-sm ${i === 0 ? "glow-now" : "glow-soft"}`}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {i === 0 && <span className="inline-flex items-center gap-2 rounded-full bg-ink px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-white"><span className="now-dot" />Now</span>}
                    <b>{t.ref}</b>
                    {t.category && <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-700">{t.category}</span>}
                    {t.mine && <YouChip />}
                    <span className="ml-auto text-xs text-neutral-500">{ago(t.updated_at, d.now)}</span>
                  </div>
                  <div className="mt-1 text-sm text-neutral-600">{t.assignee ? <><b className="text-fg">{t.assignee}</b> is on it</> : "IT is on it"}</div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-6 text-center text-sm text-neutral-500">IT isn't working on a ticket right now. New tickets are picked up in priority order.</div>
          )}
        </section>

        <section className="rise-in" style={{ ["--i" as string]: 5 }}>
          <h2 className="mb-2 text-lg font-extrabold">Up next</h2>
          {next.length ? (
            <ol className="divide-y divide-stone-200 overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm [&>li]:isolate">
              {next.map((t) => (
                <li key={t.position} className={`relative flex items-center gap-3 px-4 py-3 ${t.mine ? "glow-row" : ""}`}>
                  {t.mine && <span className="row-sheen" aria-hidden />}
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-sm font-extrabold">{t.position}</span>
                  <b className="w-20 shrink-0 text-sm">{t.ref}</b>
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-600">{t.category ?? "General"}</span>
                  {t.mine && <YouChip pulse />}
                </li>
              ))}
            </ol>
          ) : (
            <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-6 text-center text-sm text-neutral-500">Nobody is waiting. Anything new goes straight to the front.</div>
          )}
          {s.waiting > next.length && <p className="mt-2 text-xs text-neutral-500">…and {s.waiting - next.length} more waiting after these.</p>}
        </section>
      </div>
    </div>
  );
}
