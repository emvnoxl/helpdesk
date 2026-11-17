import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { collectBrowserInfo, deviceKey } from "./device";
import { streamFor, useLive } from "./live";

/* Home: a reminder for people who skipped "Tell IT about this computer" in the first-time setup. One button does the same thing as
   the setup step (the report file downloads, this card notices the report arriving). "Not now" hides it on this computer for two
   weeks; it disappears for good once the report is in. Windows computers only. */

interface Mine { reported: boolean; hardware_at: number | null; name: string | null; model: string | null }
interface Link { cmd_url: string; command: string }

const SNOOZE = "fortress-helpdesk:hardware-nudge";
const SNOOZE_DAYS = 14;
const snoozed = () => { try { return Date.now() < Number(localStorage.getItem(SNOOZE) ?? 0); } catch { return false; } };

export function HardwareNudge() {
  const [show, setShow] = useState(false);
  const [mine, setMine] = useState<Mine | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const asked = useRef(false);

  const refresh = () => api<Mine>(`/devices/mine?key=${deviceKey()}`).then(setMine, () => {});
  useEffect(() => {
    if (snoozed()) return;
    void collectBrowserInfo().then((info) => {
      if (info.os !== "Windows" || info.mobile) return;
      setShow(true);
      void refresh();
    });
  }, []);
  useLive(streamFor(false), () => { if (show) void refresh(); });
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [link]);

  if (!show || !mine) return null;
  // Already on file before they were asked: nothing to show. Arrived after they pressed the button: say thanks.
  if (mine.reported && !asked.current) return null;

  const download = (url: string) => { const a = document.createElement("a"); a.href = url; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); };
  const send = async () => {
    setBusy(true);
    setErr("");
    try {
      const l = await api<Link>("/devices/inventory-link", { method: "POST", json: { key: deviceKey() } });
      asked.current = true;
      setLink(l);
      download(l.cmd_url);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const later = () => { try { localStorage.setItem(SNOOZE, String(Date.now() + SNOOZE_DAYS * 86400_000)); } catch { /* it will simply ask again next visit */ } setShow(false); };

  return (
    <section className="rise-in min-w-0 rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm xl:col-span-3" style={{ borderLeft: "6px solid var(--color-brand-amber)" }} aria-label="Finish setting up this computer">
      {mine.reported ? (
        <div className="flex flex-wrap items-center gap-3" role="status">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-green text-white">
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          </span>
          <div className="min-w-0 flex-1"><b>Got it, thank you.</b> <span className="text-sm text-neutral-600">{[mine.model, mine.name].filter(Boolean).join(" · ")}</span></div>
          <button className="text-sm font-semibold text-neutral-500 hover:text-fg" onClick={() => setShow(false)}>Close</button>
        </div>
      ) : !link ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-72">
            <b>One thing left: tell IT about this computer</b>
            <p className="text-sm text-neutral-600">About ten seconds, once. With the make, model and disk space on file, IT can fix most things without asking you for a serial number.</p>
            {err && <p className="mt-1 text-sm text-red-700" role="alert">{err}</p>}
          </div>
          <button className="rounded-lg bg-brand-green px-5 py-2.5 text-sm font-bold text-ink shadow-sm transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green focus-visible:ring-offset-2 disabled:opacity-60" disabled={busy} onClick={() => void send()}>
            {busy ? "Preparing…" : "Send this computer's details"}
          </button>
          <button className="text-sm font-semibold text-neutral-500 hover:text-fg" onClick={later}>Not now</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-72 text-sm">
            <b className="text-base">Open the file that was just downloaded</b>
            <p className="text-neutral-600"><b>fortress-hardware-report</b> is in your browser's downloads. If the browser asks, choose <b>Keep</b>; if Windows says it "protected your PC", choose <b>More info</b> then <b>Run anyway</b>.</p>
          </div>
          <span className="inline-flex items-center gap-2.5 rounded-full bg-stone-100 px-3.5 py-2 text-sm font-semibold" role="status"><span className="now-dot" /> Waiting for this computer <span className="working-dots"><i /><i /><i /></span></span>
          <button className="text-sm font-semibold text-neutral-500 hover:text-fg" onClick={() => download(link.cmd_url)}>Download again</button>
        </div>
      )}
    </section>
  );
}
