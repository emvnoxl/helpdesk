import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { Logo } from "./brand";
import { EmailSwitch } from "./EmailSwitch";
import { useSso } from "./sso";
import { btn, card, field } from "./ui";
import { useNotify } from "./notify";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { CallDock } from "./Calls";
import { clock, type StaffUser } from "./useStaff";

/** The header, account panel and full-width page area shared by the agent and admin portals. */
export function PortalFrame({
  portal, user, onChanged, onSignOut, headerExtra, onOpenTicket, viewing, children,
}: {
  portal: "agent" | "admin"; user: StaffUser; onChanged: () => void; onSignOut: () => void; headerExtra?: ReactNode;
  /** Opens a ticket from a notification, and which ticket is open now (its notifications are read automatically). */
  onOpenTicket: (id: number) => void; viewing: number | null; children: ReactNode;
}) {
  const [panel, setPanel] = useState(false);
  const sso = useSso();
  const noPassword = !!sso?.enforced && portal === "agent"; // agents sign in with Microsoft only
  const [name, setName] = useState(user.name);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const { toast } = useNotify();
  const MIN = 12;
  const pad = "px-4 sm:px-6 xl:px-10"; // the portals use the whole screen width

  async function saveName(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/staff/profile", { method: "PATCH", json: { name } });
      toast("This is the name people see as \"assigned to\".", "success", "Name saved");
      onChanged();
    } catch (x) {
      toast((x as Error).message, "error");
    }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return toast("The new passwords don't match.", "error");
    try {
      await api("/staff/password", { method: "POST", json: { current: cur, next: pw } });
      setCur(""); setPw(""); setPw2("");
      toast("Every other session of yours has been signed out.", "success", "Password changed");
      onChanged();
    } catch (x) {
      toast((x as Error).message === "locked" ? "Too many wrong attempts. Try again later." : (x as Error).message, "error");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-ink text-white">
        <div className={`flex w-full flex-wrap items-center justify-between gap-3 py-3 ${pad}`}>
          <div className="flex items-center gap-3">
            <Logo theme="dark" className="h-12" />
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-[0.2em] text-ink ${portal === "admin" ? "bg-brand-amber" : "bg-brand-green"}`}>{portal}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            {/* who is signed in, and for how long */}
            <div className="flex items-center gap-3" title={`${user.name} · ${user.email}`}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-extrabold tracking-wide text-white ring-1 ring-white/15" aria-hidden>
                {user.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?"}
              </span>
              <div className="hidden min-w-0 leading-tight xl:block">
                <div className="truncate font-semibold text-white">{user.name}</div>
                <div className="truncate text-xs text-white/55">
                  {user.email}
                  {user.expires_at ? <span className="text-white/45"> · signed in until <b className="font-semibold text-white/70">{clock(user.expires_at)}</b></span> : null}
                </div>
              </div>
            </div>
            {headerExtra && <span className="hidden h-7 w-px bg-white/15 xl:block" aria-hidden />}
            {headerExtra}
            <span className="hidden h-7 w-px bg-white/15 sm:block" aria-hidden />
            <div className="flex items-center gap-2">
              <NotificationBell base="/staff/notifications" onOpen={onOpenTicket} viewing={viewing} tone="dark" />
              <ThemeToggle variant="onDark" />
            </div>
            <span className="hidden h-7 w-px bg-white/15 sm:block" aria-hidden />
            <div className="flex items-center gap-1">
              <button className="rounded-lg px-3 py-2 font-medium text-white/80 hover:bg-white/10 aria-expanded:bg-white/10" onClick={() => setPanel((v) => !v)} aria-expanded={panel}>Account</button>
              <a className="rounded-lg px-3 py-2 font-medium text-white/80 hover:bg-white/10" href="/">Helpdesk</a>
              <button className="ml-1 rounded-lg border border-white/25 px-3.5 py-2 font-semibold hover:bg-white/10" onClick={onSignOut}>Sign out</button>
            </div>
          </div>
        </div>
        <div className="brand-stripe" />
      </header>

      <main className={`w-full flex-1 pb-12 pt-6 ${pad}`}>
        {panel && (
          <div className="page-in mb-6 grid gap-4 lg:grid-cols-2">
            <form onSubmit={saveName} className={card + " space-y-3"}>
              <h2 className="font-bold">Your name</h2>
              <p className="text-xs text-neutral-500">This is what people see when a ticket is assigned to you.</p>
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
              <button className={btn}>Save name</button>
            </form>
            {!noPassword && <form onSubmit={changePassword} className={card + " space-y-3"}>
              <h2 className="font-bold">Change password</h2>
              <input className={field} type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} required />
              <input className={field} type="password" autoComplete="new-password" placeholder={`New password (${MIN}+ characters)`} value={pw} onChange={(e) => setPw(e.target.value)} minLength={MIN} required />
              <input className={field} type="password" autoComplete="new-password" placeholder="Repeat new password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
              <button className={btn}>Save new password</button>
            </form>}
            <EmailSwitch initial={user.email_notify} title="Emails for me" text="Get an email when a ticket needs you: a new ticket, one assigned to you, a reply from a requester, or a late ticket. Only things you have not already seen in the helpdesk, and several at once come as one email."
              save={(on) => api("/staff/profile", { method: "PATCH", json: { email_notify: on } })} />
          </div>
        )}
        {children}
      </main>
      <CallDock staff onOpen={onOpenTicket} />
    </div>
  );
}
