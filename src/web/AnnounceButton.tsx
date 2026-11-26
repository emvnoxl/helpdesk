import { useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { useSystem } from "./system";
import { Portal } from "./Portal";
import { btn, field } from "./ui";

const LEVELS = [
  { v: "info", label: "Notice", hint: "For your information", dot: "bg-[#0b0b0b] dark:bg-white" },
  { v: "warn", label: "Warning", hint: "Something may be slow or limited", dot: "bg-[#ffb400]" },
  { v: "outage", label: "Problem", hint: "Something is down", dot: "bg-[#d92b33]" },
] as const;
const HOURS = [
  { label: "Until I clear it", minutes: 0 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Until the end of today", minutes: -1 },
  { label: "24 hours", minutes: 1440 },
];

/** For IT: post or clear the banner every open screen shows ("Wi-Fi is down on floor 2, we are on it"). */
export function AnnounceButton() {
  const sys = useSystem();
  const { toast } = useNotify();
  const cur = sys.announcement;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [level, setLevel] = useState<"info" | "warn" | "outage">("outage");
  const [dur, setDur] = useState(0);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false); // "clear it for everyone?", asked inside this dialog instead of in another one on top of it

  const show = () => {
    setSure(false);
    setText(cur?.text ?? "");
    setLevel(cur?.level ?? "outage");
    setDur(0);
    setOpen(true);
  };
  const minutes = () => {
    if (dur >= 0) return dur || undefined;
    const end = new Date(); end.setHours(23, 59, 0, 0);
    return Math.max(1, Math.round((end.getTime() - Date.now()) / 60_000));
  };
  const post = async () => {
    setBusy(true);
    try {
      await api("/staff/announcement", { method: "PUT", json: { text, level, minutes: minutes() } });
      toast("Everyone with the helpdesk open sees it now.", "success", "Banner posted");
      setOpen(false);
    } catch (e) { toast((e as Error).message, "error", "Couldn't post the banner"); }
    setBusy(false);
  };
  const clear = async () => {
    setBusy(true);
    try { await api("/staff/announcement", { method: "DELETE" }); toast("The banner is gone.", "success"); setOpen(false); } catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };

  return (
    <>
      <button type="button" onClick={show} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors hover:bg-fg/10 ${cur ? "border-[#d92b33]/60 text-red-700" : "border-stone-300 text-neutral-700"}`} title="Tell everyone about a problem">
        <span aria-hidden>📣</span> {cur ? "Banner is live" : "Announce"}
      </button>
      {open && (
        <Portal>
        <div className="fixed inset-0 z-[95] grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Announcement" onKeyDown={(e) => { if (e.key === "Escape") { if (sure) setSure(false); else setOpen(false); } }}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl" style={{ borderTop: "5px solid #ffb400" }}>
            <div className="space-y-4 p-5">
              <div>
                <h3 className="text-lg font-extrabold">{cur ? "Change the banner" : "Tell everyone"}</h3>
                <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">One line shown at the top of every screen, including the sign-in page. It saves people raising the same ticket.</p>
              </div>
              <label className="block text-sm font-semibold">What should people know?
                <textarea autoFocus className={`${field} mt-1 min-h-[4.5rem] resize-none text-fg`} maxLength={200} placeholder="Wi-Fi is down on floor 2. IT is working on it." value={text} onChange={(e) => setText(e.target.value)} />
                <span className="mt-0.5 block text-right text-xs font-normal text-neutral-500">{text.length}/200</span>
              </label>
              <div role="radiogroup" aria-label="Kind" className="grid grid-cols-3 gap-2">
                {LEVELS.map((l) => (
                  <button key={l.v} type="button" role="radio" aria-checked={level === l.v} onClick={() => setLevel(l.v)} title={l.hint}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-2 py-2 text-sm font-semibold ${level === l.v ? "border-brand-green bg-brand-green/15" : "border-stone-300 hover:bg-fg/5"}`}>
                    <span className={`h-2.5 w-2.5 rounded-full ${l.dot}`} />{l.label}
                  </button>
                ))}
              </div>
              <label className="block text-sm font-semibold">Show it
                <select className={`${field} mt-1 text-fg`} value={dur} onChange={(e) => setDur(Number(e.target.value))}>
                  {HOURS.map((h) => <option key={h.label} value={h.minutes}>{h.label}</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-fg/5 px-5 py-3">
              {sure ? (
                <>
                  <span className="mr-auto text-sm font-semibold text-fg">Clear it for everyone?</span>
                  <button type="button" autoFocus className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-fg/10" onClick={() => setSure(false)}>Keep it</button>
                  <button type="button" className="rounded-lg bg-[#d92b33] px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => void clear()}>Yes, clear it</button>
                </>
              ) : (
                <>
                  {cur && <button type="button" className="mr-auto rounded-lg border border-[#d92b33]/50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-700/10" disabled={busy} onClick={() => setSure(true)}>Clear the banner</button>}
                  <button type="button" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-fg/10" onClick={() => setOpen(false)}>Cancel</button>
                  <button type="button" className={btn} disabled={busy || !text.trim()} onClick={() => void post()}>{cur ? "Update banner" : "Post banner"}</button>
                </>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}
    </>
  );
}
