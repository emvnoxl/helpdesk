import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* The one-minute tour: five small pictures of what the helpdesk does. Shown at the start of the first-time setup (Onboarding.tsx)
   and again whenever someone asks for it on Home. The pictures are drawn with plain boxes, so they follow the light/dark theme. */

const Ico = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const bar = (w: string, tone = "bg-stone-300") => <span className={`block h-2 rounded-full ${tone}`} style={{ width: w }} />;
const mock = "rounded-xl border border-stone-200 bg-surface shadow-sm";

function ArtSubmit() {
  return (
    <div className={`${mock} w-full max-w-sm p-3`}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">What's wrong?</div>
      <div className="mt-1.5 flex items-center rounded-lg border border-brand-green bg-surface px-2.5 py-2 text-sm font-semibold ring-2 ring-brand-green/20">
        Printer on floor 2 won't print<span className="tour-caret ml-0.5 inline-block h-4 w-0.5 bg-brand-green" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-neutral-600"><Ico size={12} d="M21 12.5 12.5 21a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" /> screenshot.png</span>
        <span className="ml-auto rounded-lg bg-brand-green px-3 py-1.5 text-xs font-extrabold text-ink">Send to IT</span>
      </div>
    </div>
  );
}

function ArtQueue() {
  return (
    <div className={`${mock} w-full max-w-sm p-3.5`}>
      <div className="flex items-center gap-2 text-sm">
        <b>FG-0042</b><span className="min-w-0 flex-1 truncate font-semibold">Printer on floor 2</span>
        <span className="rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-bold text-white dark:bg-stone-200 dark:text-fg">#2 in line</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-1.5 text-[10px] font-semibold">
        {[["Received", "bg-brand-green", "text-neutral-400"], ["In progress", "bg-brand-amber", "text-fg"], ["Resolved", "bg-stone-200", "text-neutral-400"]].map(([l, c, t]) => (
          <span key={l}><span className={`block h-1.5 rounded-full ${c}`} /><span className={`mt-1 block ${t}`}>{l}</span></span>
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-xs text-neutral-500"><span className="now-dot" /> <b className="text-fg">Esi</b> from IT is on it</div>
    </div>
  );
}

function ArtChat() {
  return (
    <div className={`${mock} w-full max-w-sm overflow-hidden`}>
      <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2">
        <b className="flex-1 text-sm">Conversation</b>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-green px-2.5 py-1 text-[11px] font-extrabold text-ink"><Ico size={12} d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /> Request a call</span>
      </div>
      <div className="space-y-1.5 bg-stone-50 p-3 text-xs">
        <div className="w-fit max-w-[80%] rounded-2xl rounded-bl-md border border-stone-200 bg-surface px-3 py-1.5">Is the green light on at the back?</div>
        <div className="ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-brand-green px-3 py-1.5 font-medium text-ink">Yes, but it says offline</div>
        <div className="flex w-fit items-center gap-1.5 rounded-2xl rounded-bl-md border border-stone-200 bg-surface px-3 py-1.5"><Ico size={12} d="M3 5h18v11H3zM8 20h8M12 16v4" /> Can you show me your screen?</div>
      </div>
    </div>
  );
}

function ArtBoard() {
  return (
    <div className="w-full max-w-sm">
      <div className="grid grid-cols-3 gap-2">
        {[["3", "Being worked on", "var(--color-brand-green)"], ["5", "Waiting in line", "var(--color-brand-amber)"], ["8", "Fixed today", "var(--color-brand-red)"]].map(([n, l, c]) => (
          <div key={l} className={`${mock} p-2.5`} style={{ borderTop: `3px solid ${c}` }}>
            <div className="text-2xl font-extrabold leading-none">{n}</div>
            <div className="mt-1 text-[10px] font-semibold text-neutral-500">{l}</div>
          </div>
        ))}
      </div>
      <div className={`${mock} mt-2 flex items-center gap-2 px-3 py-2 text-xs`}>
        <b>#2</b><span className="text-neutral-500">Printing</span>
        <span className="ml-auto rounded-full bg-brand-green px-2 py-0.5 text-[10px] font-extrabold text-ink">YOU</span>
      </div>
    </div>
  );
}

function ArtHelp() {
  return (
    <div className={`${mock} w-full max-w-sm p-3`}>
      <div className="flex items-center gap-2 rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs text-neutral-500"><Ico size={13} d="M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3" /> wifi keeps dropping</div>
      {[["Wi-Fi keeps disconnecting", false], ["Connect to the office printer", true]].map(([t, video]) => (
        <div key={String(t)} className="mt-2 flex items-center gap-2.5 rounded-lg bg-stone-100 px-2.5 py-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-fg"><Ico size={14} d={video ? "M8 5v14l11-7z" : "M6 3h9l4 4v14H6zM9 12h7M9 16h7"} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold">{t}</span><span className="mt-1 block">{bar("70%")}</span></span>
        </div>
      ))}
    </div>
  );
}

const SLIDES: { tag: string; title: string; text: string; art: ReactNode }[] = [
  { tag: "Submit a ticket", title: "Tell IT what's wrong", text: "One or two sentences is enough. Paste a screenshot if it helps. Your ticket goes straight to IT.", art: <ArtSubmit /> },
  { tag: "My queue", title: "Watch it move", text: "See your place in line, who picked it up, and each step until it is fixed. No need to ask for an update.", art: <ArtQueue /> },
  { tag: "Inside a ticket", title: "Chat, or ask for a call", text: "Talk to IT right on the ticket. If it's easier to show than to explain, press Request a call: IT rings you here and you can share your screen.", art: <ArtChat /> },
  { tag: "Live board", title: "See what IT is busy with", text: "How many tickets are being worked on, how many are waiting, and where yours sits among them.", art: <ArtBoard /> },
  { tag: "Help", title: "Try a quick fix first", text: "Short guides and videos for the usual problems: Wi-Fi, printers, Outlook, passwords. Often faster than waiting.", art: <ArtHelp /> },
];

/** The slides themselves. `onDone` fires on the last "next" and on Skip. */
export function TourSlides({ onDone, doneLabel = "Got it" }: { onDone: () => void; doneLabel?: string }) {
  const [i, setI] = useState(0);
  const s = SLIDES[i]!;
  const last = i === SLIDES.length - 1;
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, SLIDES.length - 1));
      if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div>
      <div key={i} className="page-in">
        <div className="grid h-48 place-items-center rounded-2xl bg-stone-100 p-4 sm:h-52" aria-hidden>{s.art}</div>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.2em] text-ok">{i + 1} of {SLIDES.length} · {s.tag}</p>
        <h2 className="mt-1.5 text-2xl font-extrabold leading-tight sm:text-3xl">{s.title}</h2>
        <p className="mt-2 min-h-[4.5rem] text-neutral-600">{s.text}</p>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <div className="flex flex-1 items-center gap-1.5" role="tablist" aria-label="Tour steps">
          {SLIDES.map((x, n) => (
            <button key={x.tag} type="button" role="tab" aria-selected={n === i} aria-label={x.tag} onClick={() => setI(n)}
              className={`h-2 rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${n === i ? "w-7 bg-brand-green" : "w-2 bg-stone-300 hover:bg-stone-400"}`} />
          ))}
        </div>
        {!last && <button type="button" onClick={onDone} className="rounded-lg px-3 py-2 text-sm font-semibold text-neutral-500 hover:text-fg">Skip</button>}
        {i > 0 && <button type="button" onClick={() => setI(i - 1)} className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm font-semibold text-neutral-700 hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">Back</button>}
        <button ref={nextRef} type="button" onClick={() => (last ? onDone() : setI(i + 1))}
          className="rounded-lg bg-brand-green px-5 py-2.5 text-sm font-extrabold text-ink shadow-sm transition hover:brightness-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-green/40">
          {last ? doneLabel : "Next"}
        </button>
      </div>
    </div>
  );
}

/** The same tour in a dialog, for "Take the tour" on Home. */
export function TourDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="A quick tour of the helpdesk" className="dialog-in w-full max-w-xl overflow-hidden rounded-3xl bg-surface text-fg shadow-2xl ring-1 ring-black/5">
        <div className="brand-stripe" />
        <div className="p-6 sm:p-8"><TourSlides onDone={onClose} doneLabel="Done" /></div>
      </div>
    </div>,
    document.body,
  );
}
