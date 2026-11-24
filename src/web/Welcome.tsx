import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "./api";
import { BrandMark, Logo } from "./brand";
import { clearSaved, loadSaved, saveDetails } from "./name";
import { PIN_LENGTH, PinInput } from "./PinInput";
import { usePageTone } from "./tone";
import { ThemeToggle } from "./ThemeToggle";
import { btn, field } from "./ui";
import { loginError } from "./deeplink";
import { OrDivider, SsoButton, ssoErrorText, useSso } from "./sso";

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

type Step = "details" | "pin" | "create";

/** Sign in for normal users: name, company email and a personal 6-digit PIN.
    A new email creates its PIN here; a known email must enter it on any computer that hasn't signed in before.
    After signing out, a computer that has been used offers "Continue as <name>" (it still asks for the PIN). */
export function Welcome({ onDone }: { onDone: (created: boolean) => void }) {
  usePageTone("dark");
  const sso = useSso();
  const legacy = sso !== null && !sso.enforced; // names and PINs: until Microsoft sign-in is switched on for everyone
  const saved = loadSaved();
  const known = !!(saved.name && saved.email);
  const [other, setOther] = useState(false); // "Not you?" opens the form for someone else
  const [step, setStep] = useState<Step>("details");
  const [isNew, setIsNew] = useState(true);
  const [name, setName] = useState(known ? "" : saved.name);
  const [email, setEmail] = useState(known ? "" : saved.email);
  const [remember, setRemember] = useState(true);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [domain, setDomain] = useState("");
  const [err, setErr] = useState("");
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ companyDomain: string }>("/config").then((c) => setDomain(c.companyDomain), () => {});
  }, []);

  /** One try at signing in; the server's answer decides which step comes next. */
  async function attempt(n: string, e: string, extra: { pin?: string; new_pin?: string } = {}) {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ created?: boolean }>("/identify", { method: "POST", json: { name: n.trim(), email: e.trim(), remember, ...extra } });
      if (remember) saveDetails(n.trim(), e.trim().toLowerCase());
      else clearSaved(); // "don't remember" also forgets the prefill on this computer
      onDone(!!r?.created);
    } catch (x) {
      const m = (x as Error).message;
      const data = (x as ApiError).data ?? {};
      if (m === "pin_required") { setStep("pin"); setPin(""); }
      else if (m === "pin_setup") { setStep("create"); setIsNew(data.new !== false); setPin(""); setPin2(""); }
      else {
        setErr(data.attempts_left !== undefined ? `${m} ${data.attempts_left} ${data.attempts_left === 1 ? "try" : "tries"} left.` : m);
        if (step === "pin") { setPin(""); setShake((k) => k + 1); }
      }
      setBusy(false);
    }
  }

  const mismatch = pin2.length === PIN_LENGTH && pin !== pin2;
  const matches = pin.length === PIN_LENGTH && pin2.length === PIN_LENGTH && pin === pin2;
  const submitDetails = (ev: FormEvent) => { ev.preventDefault(); void attempt(name, email); };
  const submitCreate = (ev: FormEvent) => { ev.preventDefault(); if (matches) void attempt(name, email, { new_pin: pin }); };
  const back = () => { setStep("details"); setErr(""); setPin(""); setPin2(""); setOther(true); };

  const who = (
    <div className="flex items-center gap-3 rounded-2xl bg-stone-100 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-amber font-extrabold text-ink" aria-hidden>{initials(name)}</span>
      <span className="min-w-0 text-sm"><b className="block truncate">{name}</b><span className="block truncate text-neutral-600">{email.trim().toLowerCase()}</span></span>
    </div>
  );
  const lock = (
    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink text-brand-amber" aria-hidden>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
    </span>
  );

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-ink">
      <div className="brand-stripe" />
      <BrandMark onDark className="pointer-events-none absolute -bottom-10 -right-16 hidden h-[70vh] opacity-40 md:block" />
      <div className="absolute right-4 top-4 z-10"><ThemeToggle variant="onDark" /></div>
      <div className="relative flex flex-1 items-center justify-center p-4">
        <div className="page-in w-full max-w-md space-y-6 rounded-3xl bg-surface p-6 shadow-2xl sm:p-8" key={step + String(other)}>
          <Logo className="h-16" />

          {loginError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{ssoErrorText(loginError)}</p>}

          {sso?.enforced && (
            <div className="space-y-5">
              <div>
                <h1 className="text-2xl font-extrabold">Sign in</h1>
                <p className="mt-1 text-sm text-neutral-500">Use your company Microsoft 365 account, the same one you use for email.</p>
              </div>
              <SsoButton portal="user" />
              <p className="text-xs text-neutral-500">First time here? Signing in creates your helpdesk account from your Microsoft profile. There is no PIN and nothing else to remember.</p>
            </div>
          )}

          {legacy && step === "pin" && (
            <div className="space-y-5">
              <div className="flex items-start gap-4">
                {lock}
                <div>
                  <h1 className="text-2xl font-extrabold leading-tight">Enter your PIN</h1>
                  <p className="mt-1 text-sm text-neutral-500">This computer hasn't signed in with this email before, so we need the PIN that belongs to it.</p>
                </div>
              </div>
              {who}
              <PinInput name="pin" label="Your 6-digit PIN" autoFocus autoComplete="current-password" value={pin} onChange={setPin} disabled={busy} invalid={!!err} shakeKey={shake} hint={err || "It signs in as soon as you type the sixth digit."} onComplete={(v) => void attempt(name, email, { pin: v })} />
              <p className="text-xs text-neutral-500">Forgotten it? Ask IT to reset it.</p>
              <button type="button" className="w-full text-center text-sm font-semibold text-neutral-600 hover:underline" onClick={back}>← Not you? Use a different email</button>
            </div>
          )}

          {legacy && step === "create" && (
            <form className="space-y-5" onSubmit={submitCreate} noValidate>
              <div className="flex items-start gap-4">
                {lock}
                <div>
                  <h1 className="text-2xl font-extrabold leading-tight">{isNew ? `Welcome, ${name.split(" ")[0] || "there"}` : "Create your PIN"}</h1>
                  <p className="mt-1 text-sm text-neutral-500">
                    {isNew ? "Choose a 6-digit PIN. " : "Your account now has a PIN. Choose 6 digits. "}You'll use it on any other computer, so nobody else can open your tickets.
                  </p>
                </div>
              </div>
              {who}
              <PinInput name="new-pin" label="Choose a PIN" autoFocus autoComplete="new-password" value={pin} onChange={setPin} disabled={busy} />
              <PinInput name="new-pin2" label="Type it again" autoComplete="new-password" value={pin2} onChange={setPin2} disabled={busy} invalid={mismatch} ok={matches} hint={mismatch ? "These don't match yet." : matches ? "✓ They match." : undefined} />
              <p className="text-xs text-neutral-500">Avoid 123456, 000000 or your birth year. Don't use your bank PIN.</p>
              {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
              <button className={btn + " w-full py-2.5"} disabled={busy || !matches}>{busy ? "One moment…" : "Create PIN and sign in"}</button>
              <button type="button" className="w-full text-center text-sm font-semibold text-neutral-600 hover:underline" onClick={back}>← Back</button>
            </form>
          )}

          {legacy && step === "details" && known && !other && (
            <div className="space-y-5">
              <div>
                <h1 className="text-2xl font-extrabold">Welcome back</h1>
                <p className="mt-1 text-sm text-neutral-500">This computer remembers you. Your PIN keeps your tickets private.</p>
              </div>
              <button
                className="flex w-full items-center gap-4 rounded-2xl border border-stone-200 p-4 text-left transition hover:border-brand-green hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green disabled:opacity-60"
                disabled={busy}
                autoFocus
                onClick={() => { setName(saved.name); setEmail(saved.email); void attempt(saved.name, saved.email); }}
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-amber text-lg font-extrabold text-ink" aria-hidden>{initials(saved.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{busy ? "One moment…" : `Continue as ${saved.name}`}</span>
                  <span className="block truncate text-sm text-neutral-500">{saved.email}</span>
                </span>
                <span aria-hidden className="text-xl text-neutral-400">→</span>
              </button>
              {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
              <div className="flex items-center justify-between text-sm">
                <button className="font-semibold text-neutral-600 underline-offset-2 hover:underline" onClick={() => { setOther(true); setErr(""); }}>Not you? Sign in as someone else</button>
                <button className="text-neutral-500 underline-offset-2 hover:underline" title="Stop this computer from remembering you" onClick={() => { clearSaved(); setOther(true); }}>Forget me here</button>
              </div>
            </div>
          )}

          {legacy && step === "details" && !(known && !other) && (
            <form className="space-y-5" onSubmit={submitDetails} noValidate>
              {sso?.available && (
                <div className="space-y-4">
                  <SsoButton portal="user" />
                  <OrDivider text="or use your name and a PIN" />
                </div>
              )}
              <div>
                <h1 className="text-2xl font-extrabold">Sign in</h1>
                <p className="mt-1 text-sm text-neutral-500">Tell us who you are so IT knows who we're helping and where to send updates. First time here? You'll create a PIN next.</p>
              </div>
              <label className="block text-sm font-semibold">
                Your full name
                <input autoFocus className={field + " mt-1 font-normal"} name="name" autoComplete="name" placeholder="e.g. Ama Boateng" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="block text-sm font-semibold">
                Your company email
                <input className={field + " mt-1 font-normal"} type="email" name="email" autoComplete="email" placeholder={`you@${domain || "company.com"}`} maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} />
                <span className="mt-1 block text-xs font-normal text-neutral-500">We email you when your ticket's status changes.</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="checkbox" name="remember" className="mt-0.5 h-4 w-4 accent-[#00a859]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span><b>Remember me on this computer</b><span className="block text-xs text-neutral-500">Untick on a shared computer: you'll be signed out when the browser closes.</span></span>
              </label>
              {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
              <button className={btn + " w-full py-2.5"} disabled={busy || !name.trim() || !email.trim()}>{busy ? "One moment…" : "Continue"}</button>
              {known && other && <button type="button" className="w-full text-center text-sm font-semibold text-neutral-600 hover:underline" onClick={() => { setOther(false); setErr(""); }}>← Back to {saved.name}</button>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
