import { useEffect, useRef, useState } from "react";
import { initSystem, isStale, useSystem } from "./system";

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const reload = () => location.reload();

/** Banners for planned and finished updates, and a full-screen "being updated" while the server restarts. Shown to everybody. */
export function UpdateNotice() {
  const s = useSystem();
  const stale = isStale(s);
  const [now, setNow] = useState(Date.now());
  const kiosk = location.hash === "#tv" || location.hash === "#board";

  useEffect(() => { initSystem(); }, []);
  useEffect(() => {
    if (!s.maintenance && !s.announcement?.until) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [s.maintenance, s.announcement?.until]);
  // IT's banner (an outage, a warning, a notice) hides itself when its time is up, even if no message arrives to say so.
  const ann = s.announcement && (!s.announcement.until || now / 1000 < s.announcement.until) ? s.announcement : null;
  // When the banner is cleared (or runs out) it must stay in the page for a moment so it can fade: the SAME element has to survive the render in
  // which it was cleared (an effect that re-adds it a frame later would create a new element, which cannot animate away). So the last banner is
  // remembered while rendering, and forgotten by a timer once the fade is over.
  const last = useRef<typeof ann>(null);
  const [, bump] = useState(0);
  if (ann) last.current = ann;
  useEffect(() => {
    if (ann || !last.current) return;
    const t = window.setTimeout(() => { last.current = null; bump((n) => n + 1); window.dispatchEvent(new Event("resize")); }, 520);
    return () => window.clearTimeout(t);
  }, [ann]);
  const shown = ann ?? last.current;
  const leaving = !ann && !!shown;

  // The office display has nobody to press "Reload": it reloads itself shortly after an update.
  useEffect(() => {
    if (!stale || location.hash !== "#tv") return;
    const t = window.setTimeout(reload, 20_000);
    return () => window.clearTimeout(t);
  }, [stale]);

  // The banner sits above the page and pushes it down (it does not cover the header). Screens that size themselves to the window
  // (the ticket page) re-measure on "resize".
  const visible = s.restarting || stale || !!s.maintenance || !!shown;
  useEffect(() => { window.dispatchEvent(new Event("resize")); }, [visible]);

  if (s.restarting) return <Restarting />;

  const m = s.maintenance;
  if (!stale && !m && !shown) return null;
  const left = m ? Math.round((m.at - now) / 60_000) : 0;
  return (
    <>
    {shown && (
      <div key={shown.at} className={`ann-wrap relative z-[89] ${leaving ? "ann-leaving" : ""}`} aria-hidden={leaving || undefined}>
      <div className="ann-clip">
      <div role={shown.level === "outage" ? "alert" : "status"} className={`ann ann-${shown.level} flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 px-4 py-2 text-center text-sm font-semibold`}>
        {shown.level === "warn" ? <span className="ann-icon" aria-hidden><span>🟡</span></span> : <span className="ann-chip"><i aria-hidden />{shown.level === "outage" ? "Problem" : "Notice"}</span>}
        <span>{shown.text}</span>
        <span className="text-xs font-normal opacity-80">{shown.by} · {clock(shown.at * 1000)}</span>
      </div>
      </div>
      </div>
    )}
    {(stale || m) && <div role="status" className="relative z-[90] flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 py-2 text-center text-sm font-semibold"
      style={{ background: stale ? "#00a859" : "#ffb400", color: "#0b0b0b" }}>
      {stale ? (
        <>
          <span>A new version of the helpdesk is ready.{kiosk ? "" : " Reload to get it."}</span>
          <button className="rounded-md bg-[#0b0b0b] px-3 py-1 text-xs font-bold text-white hover:bg-black/80" onClick={reload}>Reload now</button>
        </>
      ) : (
        <span>
          {left > 0 ? `The helpdesk will be updated at ${clock(m!.at)} (in about ${left} min).` : "The helpdesk is about to be updated."}
          {" "}It will be unavailable for a minute: save what you are typing.{m!.message ? ` ${m!.message}` : ""}
        </span>
      )}
    </div>}
    </>
  );
}

/** The server said it is restarting. Wait for it to answer again, then load the new version without anyone pressing anything. */
function Restarting() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    let alive = true;
    const started = Date.now();
    const tick = window.setInterval(async () => {
      if (!alive) return;
      setSecs(Math.round((Date.now() - started) / 1000));
      // Give the old process time to go down first, otherwise it answers "ok" while it is still closing.
      if (Date.now() - started < 3000) return;
      try {
        const r = await fetch("/healthz", { cache: "no-store" });
        if (r.ok) { alive = false; reload(); }
      } catch { /* still down */ }
    }, 1500);
    return () => { alive = false; window.clearInterval(tick); };
  }, []);
  return (
    <div role="alert" aria-live="assertive" className="fixed inset-0 z-[100] grid place-items-center bg-page/95 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-fg/10 bg-surface p-7 text-center shadow-xl">
        <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-fg/15 border-t-brand-green" aria-hidden />
        <h2 className="text-lg font-bold text-fg">The helpdesk is being updated</h2>
        <p className="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
          {secs < 90 ? "This takes about a minute. This page will come back by itself." : "This is taking longer than usual. This page keeps trying and will come back by itself."}
        </p>
      </div>
    </div>
  );
}
