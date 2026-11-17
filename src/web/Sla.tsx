import { useEffect, useState } from "react";
import { span } from "./viz";

/* Response targets as staff see them: a chip that counts down on the lists and a bar on the ticket page.
   The clock stops while a ticket is "waiting" (on the requester), so it shows as paused instead of running late. */

export function useNow(everyMs = 30000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export type SlaKind = "none" | "paused" | "ok" | "soon" | "late" | "met" | "missed";
export interface SlaInfo { kind: SlaKind; text: string; used: number }
interface T { status: string; due_at: number | null; created_at: number; resolved_at?: number | null; closed_at?: number | null }

export function slaInfo(t: T, now: number): SlaInfo {
  if (!t.due_at) return { kind: "none", text: "No target", used: 0 };
  const total = Math.max(1, t.due_at - t.created_at);
  const used = Math.min(1, Math.max(0, (now - t.created_at) / total));
  if (t.status === "resolved" || t.status === "closed") {
    const done = t.resolved_at ?? t.closed_at;
    if (!done) return { kind: "none", text: "Finished", used: 1 };
    return done <= t.due_at ? { kind: "met", text: "Met its target", used: Math.min(1, (done - t.created_at) / total) } : { kind: "missed", text: `Missed by ${span(done - t.due_at)}`, used: 1 };
  }
  if (t.status === "waiting") return { kind: "paused", text: "Paused, waiting for the requester", used };
  const left = t.due_at - now;
  if (left < 0) return { kind: "late", text: `Overdue by ${span(left)}`, used: 1 };
  return { kind: left <= Math.max(1800, total * 0.2) ? "soon" : "ok", text: `Due in ${span(left)}`, used };
}

const STYLE: Record<SlaKind, string> = {
  none: "bg-stone-100 text-neutral-500 ring-stone-300",
  paused: "bg-purple-50 text-purple-800 ring-purple-300",
  ok: "bg-green-50 text-green-800 ring-green-300",
  soon: "bg-amber-50 text-amber-900 ring-amber-400",
  late: "bg-red-50 text-red-800 ring-red-300",
  met: "bg-green-50 text-green-800 ring-green-300",
  missed: "bg-red-50 text-red-800 ring-red-300",
};
const BAR: Record<SlaKind, string> = { none: "#a8a29e", paused: "#9b6bd1", ok: "#00a859", soon: "#ffb400", late: "#ee3239", met: "#00a859", missed: "#ee3239" };
const ICON: Record<SlaKind, string> = {
  none: "M5 12h14",
  paused: "M9 6v12M15 6v12",
  ok: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  soon: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  late: "M12 8v5M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  met: "M5 13l4 4L19 7",
  missed: "M6 6l12 12M18 6 6 18",
};

/** Small pill for lists. Icon + words, never colour alone. */
export function SlaChip({ t, short = false }: { t: T; short?: boolean }) {
  const now = useNow();
  const s = slaInfo(t, now);
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${STYLE[s.kind]}`} title={s.text}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ICON[s.kind]} /></svg>
      {short && s.kind === "paused" ? "Paused" : s.text}
    </span>
  );
}

/** Ticket page: how much of the time allowed has been used. */
export function SlaBar({ t, due }: { t: T; due: string }) {
  const now = useNow(15000);
  const s = slaInfo(t, now);
  return (
    <section className="rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm" aria-label="Response target">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-neutral-500">Response target</h3>
        <SlaChip t={t} />
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.used * 100)} aria-label="Share of the target time used">
        <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.max(3, s.used * 100)}%`, background: BAR[s.kind] }} />
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        {s.kind === "paused" ? "The clock is stopped while this ticket waits for the requester and carries on when they reply." : `Target time: ${due}`}
      </p>
    </section>
  );
}
