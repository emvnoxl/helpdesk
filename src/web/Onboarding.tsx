import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { Logo } from "./brand";
import { collectBrowserInfo, deviceKey } from "./device";
import { streamFor, useLive } from "./live";
import { ThemeToggle } from "./ThemeToggle";
import { btn } from "./ui";
import { TourSlides } from "./Tour";

/* First-time setup, shown once right after someone creates their account: a welcome, a one-minute tour of the app (Tour.tsx), the
   hardware report for this computer, and where to go next. A browser cannot run PowerShell, so the report is one click (the small file downloads by itself) plus opening that file;
   this screen then notices the report arriving and moves on without being told. Every step can be skipped. */

interface Mine { reported: boolean; hardware_at: number | null; name: string | null; model: string | null }
interface Link { cmd_url: string; command: string }
type Step = "welcome" | "tour" | "computer" | "done";

const FLAG = "fortress-helpdesk:onboarding";
/** Remembered per browser, so a refresh in the middle of the setup comes back to it. */
export const onboarding = {
  start(userId: number) { try { localStorage.setItem(FLAG, String(userId)); } catch { /* private mode: the setup simply won't survive a refresh */ } },
  pending(userId: number) { try { return localStorage.getItem(FLAG) === String(userId); } catch { return false; } },
  finish() { try { localStorage.removeItem(FLAG); } catch { /* nothing to clear */ } },
};

const Check = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
const big = "flex w-full items-center justify-center gap-3 rounded-2xl bg-brand-green px-6 py-4 text-lg font-extrabold text-ink shadow-md transition hover:brightness-110 active:scale-[0.99] focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-green/40 disabled:cursor-wait disabled:opacity-60";
const quiet = "text-sm font-semibold text-neutral-500 underline-offset-2 hover:text-fg hover:underline";

export function Onboarding({ name, onFinish }: { name: string; onFinish: (goTo: "home" | "new") => void }) {
  const first = name.split(" ")[0];
  const [step, setStep] = useState<Step>("welcome");
  const [info, setInfo] = useState<any>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const startedAt = useRef(0); // only a report that arrives after the button was pressed counts as "just received"

  const refresh = () => api<Mine>(`/devices/mine?key=${deviceKey()}`).then(setMine, () => {});
  useEffect(() => { void collectBrowserInfo().then(setInfo); void refresh(); }, []);
  // The report script tells the server, the server tells this page: no "I've done it" button needed. The poll is the safety net.
  useLive(streamFor(false), () => void refresh());
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [link]);

  // Only Windows PCs can send the full report; phones, Macs and the rest skip that step.
  const windows = info ? info.os === "Windows" && !info.mobile : true;
  const steps: Step[] = windows ? ["welcome", "tour", "computer", "done"] : ["welcome", "tour", "done"];
  const skipTour = () => setStep(steps[steps.indexOf("tour") + 1]!);
  const next = () => setStep(steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)]!);
  const received = !!mine?.reported && (!link || (mine.hardware_at ?? 0) >= startedAt.current);
  const waiting = !!link && !received;

  const download = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  async function send() {
    setBusy(true);
    setErr("");
    try {
      const l = await api<Link>("/devices/inventory-link", { method: "POST", json: { key: deviceKey() } });
      startedAt.current = Math.floor(Date.now() / 1000) - 5;
      setLink(l);
      download(l.cmd_url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(link!.command); setCopied(true); } catch { setErr("Couldn't copy. Use the downloaded file instead."); }
  };
  const finish = (goTo: "home" | "new") => { onboarding.finish(); onFinish(goTo); };

  const basics = info ? [[info.os, info.osVersion].filter(Boolean).join(" "), info.browser, info.cores ? `${info.cores} processor threads` : ""].filter(Boolean) : [];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-surface shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 sm:px-6">
          <Logo className="h-10 sm:h-14" />
          <ThemeToggle />
        </div>
        <div className="brand-stripe" />
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
        <div className="w-full max-w-xl">
          <ol className="mb-5 flex items-center justify-center gap-2" aria-label={`Step ${steps.indexOf(step) + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <li key={s} className={`h-1.5 rounded-full transition-all duration-300 ${i === steps.indexOf(step) ? "w-10 bg-brand-green" : i < steps.indexOf(step) ? "w-5 bg-brand-green/50" : "w-5 bg-stone-300"}`} />
            ))}
          </ol>

          <section key={step} className="page-in rounded-3xl border border-stone-200 bg-surface p-6 shadow-sm sm:p-9">
            {step === "welcome" && (
              <>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-ok">Your account is ready</p>
                <h1 className="mt-2 text-3xl font-extrabold leading-tight sm:text-4xl">Welcome, {first}.</h1>
                <p className="mt-2 text-lg text-neutral-600">This is where you ask IT for help, and see it being fixed.</p>
                <div className="mt-6 flex items-center gap-4 rounded-2xl bg-stone-100 p-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-green text-white">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                  </span>
                  <span className="min-w-0"><b className="block">A one-minute tour</b><span className="text-sm text-neutral-600">Five quick pictures: tickets, your place in line, chat and calls, the live board and quick fixes.</span></span>
                </div>
                <button className={big + " mt-6"} onClick={next}>Show me around</button>
                <p className="mt-3 flex justify-center gap-5">
                  <button className={quiet} onClick={skipTour}>Skip the tour</button>
                  <button className={quiet} onClick={() => finish("home")}>Skip everything</button>
                </p>
              </>
            )}

            {step === "tour" && <TourSlides onDone={next} doneLabel={windows ? "Next: this computer" : "Finish"} />}

            {step === "computer" && (
              <>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-ok">One-time setup</p>
                <h1 className="mt-2 text-3xl font-extrabold leading-tight">Tell IT about this computer</h1>
                <p className="mt-2 text-neutral-600">With the make, model and disk space on file, IT can fix most things without asking you to find a serial number.</p>
                {basics.length > 0 && !received && (
                  <p className="mt-3 flex flex-wrap gap-1.5 text-xs text-neutral-600">
                    {basics.map((b) => <span key={b} className="rounded-full bg-stone-100 px-2.5 py-1 font-semibold">{b}</span>)}
                    <span className="px-1 py-1 text-neutral-500">is all your browser can tell us.</span>
                  </p>
                )}

                {received ? (
                  <div className="rise-in mt-6 rounded-2xl bg-emerald-50 p-5 ring-1 ring-inset ring-emerald-300" role="status">
                    <div className="flex items-center gap-3 text-emerald-800">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-green text-white"><Check className="h-6 w-6" /></span>
                      <div className="min-w-0">
                        <div className="text-lg font-extrabold">Got it. Thank you!</div>
                        <div className="truncate text-sm">{[mine?.model, mine?.name].filter(Boolean).join(" · ") || "IT now has the details of this computer."}</div>
                      </div>
                    </div>
                    <button className={big + " mt-5"} onClick={next}>Continue</button>
                  </div>
                ) : !link ? (
                  <>
                    <button className={big + " mt-6"} disabled={busy} onClick={() => void send()}>
                      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
                      {busy ? "Preparing…" : "Send this computer's details"}
                    </button>
                    <p className="mt-3 text-xs text-neutral-500">Takes about ten seconds. It reads specifications only: make and model, serial number, processor, memory, disks, graphics, network addresses and Windows version. Never your files, passwords or browsing.</p>
                  </>
                ) : (
                  <div className="mt-6">
                    <ol className="space-y-3">
                      <Todo n={1} done>A small file, <b>fortress-hardware-report</b>, was downloaded.</Todo>
                      <Todo n={2}><b>Open it</b> from the downloads list at the top of your browser. If the browser asks, choose <b>Keep</b>.</Todo>
                      <Todo n={3}>If Windows says it "protected your PC": <b>More info</b>, then <b>Run anyway</b>.</Todo>
                    </ol>
                    <div className="mt-5 flex items-center gap-3 rounded-2xl bg-stone-100 px-4 py-3.5 text-sm font-semibold" role="status">
                      <span className="now-dot shrink-0" /> Waiting for this computer <span className="working-dots"><i /><i /><i /></span>
                      <span className="ml-auto text-xs font-normal text-neutral-500">this page continues by itself</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
                      <button className={quiet} onClick={() => download(link.cmd_url)}>Download it again</button>
                      <button className={quiet} onClick={() => void copy()}>{copied ? "Copied. Paste it into PowerShell" : "Copy a PowerShell command instead"}</button>
                    </div>
                  </div>
                )}
                {err && <p className="mt-3 text-sm text-red-700" role="alert">{err}</p>}
                {!received && (
                  <p className="mt-6 text-center"><button className={quiet} onClick={next}>{waiting ? "I'll do this later" : "Skip for now"}</button></p>
                )}
              </>
            )}

            {step === "done" && (
              <div className="text-center">
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-brand-green text-white"><Check className="h-9 w-9" /></span>
                <h1 className="mt-4 text-3xl font-extrabold">You're all set, {first}.</h1>
                <p className="mx-auto mt-2 max-w-sm text-neutral-600">
                  {windows && !mine?.reported
                    ? "You can send this computer's details any time from Your account, under This computer."
                    : "Whenever something isn't working, this is the place."}
                </p>
                <button className={big + " mt-7"} onClick={() => finish("new")}>Submit my first ticket</button>
                <button className={btn + " mt-3 w-full !bg-transparent !py-3 !text-fg !shadow-none ring-1 ring-inset ring-stone-300 hover:!bg-stone-100"} onClick={() => finish("home")}>Take me to the helpdesk</button>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Todo({ n, done, children }: { n: number; done?: boolean; children: ReactNode }) {
  return (
    <li className="rise-in flex items-start gap-3 text-sm" style={{ ["--i" as string]: n }}>
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold ${done ? "bg-brand-green text-white" : "bg-ink text-white dark:bg-stone-200 dark:text-fg"}`}>{done ? <Check className="h-4 w-4" /> : n}</span>
      <span className="pt-1">{children}</span>
    </li>
  );
}
