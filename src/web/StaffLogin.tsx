import { useState, type FormEvent } from "react";
import { ApiError, api } from "./api";
import { BrandMark, Logo } from "./brand";
import { usePageTone } from "./tone";
import { ThemeToggle } from "./ThemeToggle";
import { btn, field } from "./ui";
import { clock } from "./useStaff";

export type Portal = "agent" | "admin";

const COPY: Record<Portal, { badge: string; title: string; text: string }> = {
  agent: { badge: "Agent", title: "Agent sign-in", text: "Sign in with the email and password IT gave you. This is separate from the helpdesk." },
  admin: { badge: "Admin", title: "Admin sign-in", text: "Sign in with your admin email and password. This is separate from the helpdesk." },
};

/** Full-screen sign-in for the agent and admin portals. Accounts are created by an admin; there is no self sign-up. */
export function StaffLogin({ portal, display, onDone }: { portal: Portal; display?: boolean; onDone: () => void }) {
  usePageTone("dark");
  const copy = COPY[portal];
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [remember, setRemember] = useState(!!display); // the office display defaults to staying signed in
  const [err, setErr] = useState("");
  const [left, setLeft] = useState<number | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const lockedNow = lockedUntil > Date.now() / 1000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await api("/staff/login", { method: "POST", json: { email, password: pw, portal, remember } });
      onDone();
    } catch (x) {
      const a = x as ApiError;
      if (a.message === "incorrect") { setLeft(a.data.attempts_left ?? null); setErr("Incorrect email or password."); }
      else if (a.message === "locked") { setLockedUntil(a.data.locked_until); setErr(""); }
      else setErr(a.message);
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-ink">
      <div className="brand-stripe" />
      <BrandMark onDark className="pointer-events-none absolute -bottom-16 -right-16 hidden h-[75vh] opacity-40 md:block" />
      <div className="absolute right-4 top-4 z-10"><ThemeToggle variant="onDark" /></div>
      <div className="relative flex flex-1 items-center justify-center p-4">
        <form onSubmit={submit} className="page-in w-full max-w-md space-y-5 rounded-3xl bg-surface p-8 shadow-2xl">
          <div className="flex items-center justify-between">
            <Logo className="h-16" />
            <span className={`rounded-full px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.2em] ${portal === "admin" ? "bg-ink text-brand-amber" : "bg-ink text-brand-green"}`}>{copy.badge}</span>
          </div>
          <div>
            <h1 className="text-2xl font-extrabold">{display ? "Sign in to the live board" : copy.title}</h1>
            <p className="mt-1 text-sm text-neutral-500">{copy.text}</p>
          </div>

          <label className="block text-sm font-semibold">
            Email
            <input autoFocus className={field + " mt-1 font-normal"} type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="block text-sm font-semibold">
            Password
            <input className={field + " mt-1 font-normal"} type="password" name="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={lockedNow} required />
          </label>

          {portal === "admin" && (
            <label className="flex items-start gap-2 text-sm text-neutral-600">
              <input type="checkbox" className="mt-1" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span><b className="text-fg">Keep this screen signed in for 12 hours</b><br /><span className="text-xs">For the office display. Leave it off on a shared or personal computer (it then signs out after 2 hours).</span></span>
            </label>
          )}

          {lockedNow && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">Locked after too many wrong attempts. Try again after {clock(lockedUntil)}.</p>}
          {err && !lockedNow && <p role="alert" className="text-sm text-red-700">{err}{left !== null && left > 0 ? ` ${left} ${left === 1 ? "try" : "tries"} left.` : ""}</p>}

          <button className={btn + " w-full py-2.5"} disabled={busy || lockedNow || !pw || !email}>{busy ? "Checking…" : "Sign in"}</button>
          <p className="text-center text-xs text-neutral-500">Forgot your password? Ask an admin to reset it. <a className="font-semibold underline" href="/">Back to the helpdesk</a></p>
        </form>
      </div>
    </div>
  );
}

/** Shown right after signing in with a temporary password (a new account, or one an admin reset). */
export function PasswordChangeScreen({ name, onDone }: { name: string; onDone: () => void }) {
  usePageTone("dark");
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const MIN = 12;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < MIN) return setErr(`Use at least ${MIN} characters.`);
    if (pw !== pw2) return setErr("The new passwords don't match.");
    setBusy(true);
    setErr("");
    try {
      await api("/staff/password", { method: "POST", json: { current: cur, next: pw } });
      onDone();
    } catch (x) {
      setErr((x as Error).message === "locked" ? "Too many wrong attempts. Try again later." : (x as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-ink">
      <div className="brand-stripe" />
      <BrandMark onDark className="pointer-events-none absolute -bottom-16 -right-16 hidden h-[75vh] opacity-40 md:block" />
      <div className="absolute right-4 top-4 z-10"><ThemeToggle variant="onDark" /></div>
      <div className="relative flex flex-1 items-center justify-center p-4">
        <form onSubmit={submit} className="page-in w-full max-w-md space-y-5 rounded-3xl bg-surface p-8 shadow-2xl">
          <Logo className="h-16" />
          <div>
            <h1 className="text-2xl font-extrabold">Choose your own password</h1>
            <p className="mt-1 text-sm text-neutral-500">Hi {name.split(" ")[0]}, you signed in with a temporary password. Pick a new one that only you know: at least {MIN} characters, for example a few unrelated words.</p>
          </div>
          <input className={field} type="password" autoComplete="current-password" placeholder="Temporary password" value={cur} onChange={(e) => setCur(e.target.value)} required autoFocus />
          <input className={field} type="password" autoComplete="new-password" placeholder={`New password (${MIN}+ characters)`} value={pw} onChange={(e) => setPw(e.target.value)} required />
          <div>
            <input className={field} type="password" autoComplete="new-password" placeholder="Repeat new password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
            <p className="mt-1 text-xs text-neutral-500" aria-live="polite">{pw.length < MIN ? `${MIN - pw.length} more character${MIN - pw.length === 1 ? "" : "s"} needed` : "Long enough"}</p>
          </div>
          {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
          <button className={btn + " w-full py-2.5"} disabled={busy || !cur || !pw}>{busy ? "Saving…" : "Save password and continue"}</button>
        </form>
      </div>
    </div>
  );
}
