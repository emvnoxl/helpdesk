import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { Logo } from "./brand";
import { CountUp } from "./motion";
import { ThemeToggle } from "./ThemeToggle";
import { useLive } from "./live";
import { useTheme } from "./theme";
import { PRIO, STATUS, Panel, PriorityChip, ago, dateFmt, timeFmt } from "./viz";

/* The live board is deliberately simple: a few big numbers, the priority queue, and what IT is
   doing right now. Detailed analytics and personal queues live in the admin-only console. */

const COLS = "10rem 6.5rem minmax(0,1fr) 14rem 10rem";

/** "NOW" tag for the task IT is currently on. */
function NowChip() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider 2xl:text-xs" style={{ background: "var(--color-brand-green)", color: "#0b0b0b" }}>
      <span className="now-dot" style={{ background: "#0b0b0b", width: 6, height: 6 }} />Now
    </span>
  );
}

function Kpi({ label, value, sub, accent, alert }: { label: string; value: ReactNode; sub?: string; accent: string; alert?: boolean }) {
  return (
    <div
      className="rounded-2xl p-5 2xl:p-7"
      style={{ background: "var(--v-surface)", border: `1px solid ${alert ? accent : "var(--v-border)"}`, borderLeft: `8px solid ${accent}` }}
    >
      <div className="text-xs font-bold uppercase tracking-widest 2xl:text-base" style={{ color: "var(--v-ink2)" }}>{label}</div>
      <div className="mt-2 text-6xl font-extrabold leading-none 2xl:text-8xl" style={{ color: "var(--v-ink)" }}>{value}</div>
      <div className="mt-3 h-6 text-sm 2xl:text-lg" style={{ color: "var(--v-muted)" }}>{sub}</div>
    </div>
  );
}

export function Dashboard({ kiosk, canFullscreen, onBack, backLabel = "Back", onExpired }: { kiosk: boolean; canFullscreen: boolean; onBack: () => void; backLabel?: string; onExpired?: () => void }) {
  const [d, setD] = useState<any>(null);
  const [failed, setFailed] = useState(0);
  const [updated, setUpdated] = useState<number | null>(null);
  const [clock, setClock] = useState(new Date());
  const { mode: theme } = useTheme(); // the same light/dark switch as the rest of the app
  const fails = useRef(0);

  const load = useCallback(async () => {
    try {
      setD(await api("/admin/board"));
      setUpdated(Date.now());
      fails.current = 0;
      setFailed(0);
    } catch (e) {
      // The admin session ended (timed out or signed out elsewhere): hand back to the portal, which shows the login.
      if ((e as { status?: number }).status === 401 && onExpired) return onExpired();
      fails.current += 1;
      setFailed(fails.current);
      // Three misses in a row usually means the sign-in session expired: reloading sends the screen back through login.
      if (fails.current >= 3) location.reload();
    }
  }, [onExpired]);

  // Instant: the server pushes a nudge whenever a ticket, assignment or account changes. The 60 s poll below is only a safety net.
  useLive("/staff/stream", () => void load());

  useEffect(() => {
    void load();
    // Safety net (the push above does the real work); skipped while the tab is hidden.
    const poll = setInterval(() => !document.hidden && void load(), 60_000);
    const vis = () => !document.hidden && void load();
    document.addEventListener("visibilitychange", vis);
    const tick = setInterval(() => setClock(new Date()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [load]);

  const nowSec = Math.floor(clock.getTime() / 1000);
  const s = d?.summary ?? {};
  // The current task: the in-progress ticket touched most recently (the API returns them newest first).
  const currentId: number | undefined = d?.inProgress?.[0]?.id;
  const headBtn = "rounded-lg border px-3 py-1.5 text-sm font-semibold transition hover:opacity-80";

  return (
    <div className="flex min-h-screen flex-col xl:h-screen xl:overflow-hidden" style={{ background: "var(--v-page)", color: "var(--v-ink)" }}>
      <header style={{ background: "var(--v-head)", borderBottom: "1px solid var(--v-border)" }}>
        <div className="flex items-center justify-between gap-4 px-5 py-3 2xl:px-8 2xl:py-4">
          <Logo theme={theme} className="h-12 2xl:h-16" />
          <div className="hidden text-lg font-extrabold uppercase tracking-[0.25em] md:block 2xl:text-2xl" style={{ color: "var(--v-ink)" }}>Live Board</div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-2xl font-bold leading-none tabular-nums 2xl:text-4xl">{timeFmt.format(clock)}</div>
              <div className="mt-1 text-xs 2xl:text-sm" style={{ color: "var(--v-muted)" }}>{dateFmt.format(clock)}</div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle variant="board" label />
              {/* Fullscreen / monitor mode is only offered to managers and admins. */}
              {canFullscreen && (
                <button className={headBtn} style={{ borderColor: "var(--v-border)", color: "var(--v-ink)" }} onClick={() => void document.documentElement.requestFullscreen?.()}>Fullscreen</button>
              )}
              {!kiosk && (
                <button className={headBtn} style={{ borderColor: "var(--v-border)", color: "var(--v-ink)" }} onClick={onBack}>{backLabel}</button>
              )}
            </div>
          </div>
        </div>
        <div className="brand-stripe" />
      </header>

      {!d ? (
        <p className="p-10 text-center" style={{ color: "var(--v-ink2)" }}>{failed ? "Can't reach the helpdesk. Retrying…" : "Loading…"}</p>
      ) : (
        <main className="grid flex-1 content-start gap-4 p-4 xl:min-h-0 xl:grid-rows-[auto_minmax(0,1fr)] xl:content-stretch 2xl:gap-6 2xl:p-8">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4 2xl:gap-6">
            <Kpi label="Open tickets" value={<CountUp value={s.open ?? 0} />} sub={s.unassigned ? `${s.unassigned} not yet assigned` : "All assigned"} accent="var(--v-created)" />
            <Kpi label="Urgent" value={<CountUp value={s.urgent ?? 0} />} sub={s.urgent ? "Needs attention now" : "None right now"} accent={PRIO.urgent.color} alert={s.urgent > 0} />
            <Kpi label="Overdue" value={<CountUp value={s.overdue ?? 0} />} sub={s.overdue ? "Past target time" : "All on track"} accent={PRIO.high.color} alert={s.overdue > 0} />
            <Kpi label="Resolved today" value={<CountUp value={d.today.resolved_today ?? 0} />} sub={`${d.today.opened_today ?? 0} opened today`} accent="var(--v-resolved)" />
          </div>

          <div className="grid min-h-0 gap-4 xl:grid-cols-3 2xl:gap-6">
            <Panel title="Priority board" className="xl:col-span-2 xl:overflow-hidden" right={<span className="text-xs 2xl:text-sm" style={{ color: "var(--v-muted)" }}>Top {d.board.length} of {s.open ?? 0}</span>}>
              {d.board.length ? (
                <div className="overflow-x-auto">
                  <div role="table" aria-label="Priority board" className="min-w-[44rem] text-sm 2xl:text-lg">
                    <div role="row" className="grid items-center gap-x-3 px-3 pb-2 text-xs font-semibold uppercase tracking-wider 2xl:text-sm" style={{ gridTemplateColumns: COLS, color: "var(--v-muted)" }}>
                      <span role="columnheader">Priority</span><span role="columnheader">Ref</span><span role="columnheader">Issue</span>
                      <span role="columnheader">Assigned</span><span role="columnheader">Status</span>
                    </div>
                    <div className="space-y-1.5">
                      {d.board.map((t: any) => {
                        const now = t.id === currentId; // the task IT is on right now
                        const soft = !now && t.status === "in_progress"; // other work in progress
                        return (
                          <div
                            key={t.id}
                            role="row"
                            className={`grid items-center gap-x-3 rounded-xl px-3 py-2 2xl:py-3 ${now ? "glow-now" : soft ? "glow-soft" : ""}`}
                            style={{ gridTemplateColumns: COLS, ...(now || soft ? {} : { boxShadow: "inset 0 -1px 0 var(--v-grid)" }) }}
                          >
                            <span role="cell"><PriorityChip p={t.priority} locked={t.priority_locked} big /></span>
                            <span role="cell" className="font-bold tabular-nums">{t.ref}</span>
                            <span role="cell" className="flex min-w-0 items-center gap-2">
                              {now && <NowChip />}
                              <span className="truncate" title={t.title}>{t.title}</span>
                            </span>
                            <span role="cell" className="truncate" style={{ color: t.assignee ? "var(--v-ink)" : "var(--v-warn)", fontWeight: t.assignee ? 400 : 700 }}>{t.assignee ?? "Unassigned"}</span>
                            <span role="cell" className="flex items-center gap-1.5" style={{ color: now ? "var(--v-ink)" : "var(--v-ink2)", fontWeight: now ? 700 : 400 }}>
                              {STATUS[t.status] ?? t.status}
                              {now && <span className="working-dots" aria-hidden><i /><i /><i /></span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="py-10 text-center text-xl" style={{ color: "var(--v-ink2)" }}>No open tickets. All clear.</p>
              )}
            </Panel>

            <div className="grid min-h-0 gap-4 xl:grid-rows-[minmax(0,1fr)_auto] 2xl:gap-6">
              <Panel title="IT is working on" className="xl:overflow-hidden">
                {d.inProgress.length ? (
                  <ul className="space-y-3 2xl:space-y-4">
                    {d.inProgress.map((t: any, i: number) => (
                      <li key={t.id} className={`rounded-xl p-3 text-sm 2xl:text-lg ${i === 0 ? "glow-now" : "glow-soft"}`}>
                        <div className="flex items-center justify-between gap-2">
                          <b className="flex items-center gap-2">{i === 0 && <NowChip />}{t.assignee ?? "Unassigned"}</b>
                          <span className="shrink-0 text-xs 2xl:text-sm" style={{ color: "var(--v-muted)" }}>{ago(t.updated_at, nowSec)}</span>
                        </div>
                        <div className="truncate" style={{ color: "var(--v-ink2)" }} title={t.title}>
                          <span className="mr-2 tabular-nums" style={{ color: "var(--v-muted)" }}>{t.ref}</span>{t.title}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm 2xl:text-lg" style={{ color: "var(--v-muted)" }}>Nothing in progress right now.</p>}
              </Panel>
              <Panel title="Just resolved">
                {d.recentlyResolved.length ? (
                  <ul className="space-y-2">
                    {d.recentlyResolved.map((t: any) => (
                      <li key={t.id} className="flex items-baseline gap-2 text-sm 2xl:text-base">
                        <span className="shrink-0 tabular-nums" style={{ color: "var(--v-muted)" }}>{t.ref}</span>
                        <span className="truncate" title={t.title}>{t.title}</span>
                        <span className="ml-auto shrink-0 text-xs" style={{ color: "var(--v-muted)" }}>{ago(t.resolved_at, nowSec)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm" style={{ color: "var(--v-muted)" }}>Nothing resolved yet.</p>}
              </Panel>
            </div>
          </div>
        </main>
      )}

      <footer className="flex items-center justify-between px-5 py-2 text-xs 2xl:text-sm" style={{ color: "var(--v-muted)" }}>
        <span className="flex items-center gap-2">
          <span className="live-dot inline-block h-2.5 w-2.5 rounded-full" style={{ background: failed ? "var(--v-warn)" : "var(--v-resolved)" }} />
          {failed ? "Connection lost. Showing last known data, retrying…" : "Live · refreshes every minute"}
        </span>
        <span>{updated ? `Updated ${timeFmt.format(updated)}` : ""}</span>
      </footer>
    </div>
  );
}
