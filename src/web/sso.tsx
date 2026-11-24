import { useEffect, useState } from "react";
import { deepLinkTicket } from "./deeplink";

/* Sign in with Microsoft 365: what the screens need to know, and the button. */

export interface SsoState { available: boolean; enforced: boolean }
let cache: SsoState | null = null;

/** null while loading. `available` = the Microsoft app is set up; `enforced` = PINs and agent passwords are switched off. */
export function useSso(): SsoState | null {
  const [s, setS] = useState<SsoState | null>(cache);
  useEffect(() => {
    if (cache) return;
    fetch("/api/config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { cache = j?.sso ?? { available: false, enforced: false }; setS(cache); })
      .catch(() => setS({ available: false, enforced: false }));
  }, []);
  return s;
}

export const SSO_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled. Press the button to try again.",
  expired: "That sign-in took too long, or was opened twice. Please try again.",
  failed: "Microsoft sign-in could not be completed. Please try again, and tell IT if it keeps happening.",
  wrong_domain: "Please sign in with your company Microsoft 365 account.",
  disabled: "This account has been disabled. Please contact IT.",
  not_staff: "This Microsoft account has not been given access here. Ask an admin to add you under Staff.",
  mismatch: "This Microsoft account does not match the helpdesk account for that email. Please contact IT.",
  no_email: "Microsoft did not share an email address for this account. Please contact IT.",
  sso_off: "Microsoft sign-in is not set up yet.",
  throttled: "Too many attempts. Please wait a few minutes and try again.",
};
export const ssoErrorText = (code: string | null) => (code ? SSO_ERRORS[code] ?? "Sign-in did not work. Please try again." : "");

/** The four-square Microsoft mark. */
const Mark = () => (
  <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden>
    <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
  </svg>
);

export function SsoButton({ portal, label = "Sign in with Microsoft" }: { portal: "user" | "agent" | "admin"; label?: string }) {
  const href = `/api/auth/microsoft/start?portal=${portal}${deepLinkTicket ? `&t=${deepLinkTicket}` : ""}`;
  return (
    <a href={href} className="flex w-full items-center justify-center gap-3 rounded-xl border border-stone-300 bg-surface px-4 py-3 text-sm font-semibold text-fg shadow-sm transition hover:border-brand-green hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
      <Mark />
      {label}
    </a>
  );
}

export const OrDivider = ({ text = "or" }: { text?: string }) => (
  <div className="flex items-center gap-3 text-xs text-neutral-500"><span className="h-px flex-1 bg-stone-200" />{text}<span className="h-px flex-1 bg-stone-200" /></div>
);
