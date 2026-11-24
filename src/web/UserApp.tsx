import { useEffect, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import { TicketView } from "./TicketView";
import { Logo } from "./brand";
import { LiveBoard } from "./LiveBoard";
import { MyQueue } from "./MyQueue";
import { NewTicket } from "./NewTicket";
import { Account } from "./Account";
import { deepLinkTicket, welcomeFlag } from "./deeplink";
import { useSso } from "./sso";
import { Help } from "./Help";
import { reportDevice } from "./device";
import { SlidingTabs } from "./Tabs";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { Welcome } from "./Welcome";
import { Onboarding, onboarding } from "./Onboarding";
import { Home } from "./Home";
import { streamFor, useConnected } from "./live";
import { CallDock } from "./Calls";

/* The normal-user app: just four things. Home, submit a ticket, my queue, and a simple live board. */

type Me = { id: number; name: string; email: string; has_pin: boolean; email_notify: boolean; ms_linked: boolean; job_title: string | null; department: string | null };
type Page = "home" | "new" | "queue" | "board" | "help" | "account";
type Route = { page: Page } | { page: "ticket"; id: number };

// `short` is what a phone shows, so all five tabs fit without sideways scrolling.
const NAV: { id: Page; label: string; short: string; d: string }[] = [
  { id: "home", label: "Home", short: "Home", d: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" },
  { id: "new", label: "Submit a ticket", short: "Submit", d: "M12 5v14M5 12h14" },
  { id: "queue", label: "My queue", short: "Queue", d: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" },
  { id: "board", label: "Live board", short: "Board", d: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "help", label: "Help", short: "Help", d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" },
];
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

function PageBox({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-5">
        <h1 className="text-2xl font-extrabold">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-neutral-500">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export function UserApp() {
  const sso = useSso();
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still checking, null = not identified yet
  const [err, setErr] = useState("");
  const [route, setRoute] = useState<Route>(deepLinkTicket ? { page: "ticket", id: deepLinkTicket } : { page: "home" });
  const [fresh, setFresh] = useState(welcomeFlag); // the account was created a moment ago in this browser (or just now at Microsoft sign-in)
  const [draftTitle, setDraftTitle] = useState(""); // what was typed into "what do you need help with?" on Home
  const online = useConnected(streamFor(false)); // this tab's connection to the helpdesk

  const load = () =>
    api<Me>("/me").then(
      (m) => { setMe(m); setErr(""); },
      (e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setErr(e.message)),
    );
  useEffect(() => void load(), []);
  useEffect(() => { if (me) void reportDevice(); }, [me?.id]); // tell IT which computer this is (browser details only)

  if (err) return <p className="p-8 text-red-700">Can't reach the helpdesk: {err}</p>;
  if (me === undefined) return <div className="min-h-screen" />;
  if (me === null) return <Welcome onDone={(created) => { setRoute((r) => (r.page === "ticket" ? r : { page: "home" })); setFresh(created); void load(); }} />;
  // A brand-new account gets the first-time setup (once; a refresh in the middle comes back to it).
  if (fresh || onboarding.pending(me.id)) {
    if (fresh) onboarding.start(me.id);
    return <Onboarding name={me.name} onFinish={(page) => { setFresh(false); setRoute({ page }); }} />;
  }

  const go = (r: Route, title = "") => { setDraftTitle(title); setRoute(r); };
  const status = online === false ? "Offline" : online ? "Online" : "Connecting";
  const openTicket = (id: number) => go({ page: "ticket", id });
  const here: Page = route.page === "ticket" ? "queue" : route.page;
  const signOut = async () => {
    await api("/signout", { method: "POST", json: {} }).catch(() => {});
    setMe(null);
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-surface shadow-sm">
        <div className="flex w-full items-center justify-between gap-3 px-4 pt-3 sm:px-6 xl:px-10">
          <button onClick={() => go({ page: "home" })} aria-label="Home" className="shrink-0"><Logo className="h-10 sm:h-14" /></button>
          <div className="flex min-w-0 items-center gap-2 text-sm sm:gap-3">
            {/* who is signed in: opens their account (PIN, this computer) */}
            <button
              onClick={() => go({ page: "account" })}
              aria-current={route.page === "account" ? "page" : undefined}
              title={`${me.name} · ${me.email} · ${online === false ? "Offline: trying to reconnect" : status}. Your account`}
              className={`group flex min-w-0 items-center gap-3 rounded-xl py-1 pl-1 pr-1 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green md:pr-3 ${route.page === "account" ? "bg-stone-200/70" : "hover:bg-stone-200/60"}`}
            >
              {/* the avatar, with the connection status as the badge on its corner: tick = online, cross = offline, pulsing dot = connecting */}
              <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-xs font-extrabold tracking-wide text-white dark:bg-stone-200 dark:text-fg">
                <span aria-hidden>{initials(me.name)}</span>
                <span
                  role="status" aria-label={status} title={status}
                  className={`absolute -bottom-1 -right-1 grid h-4 w-4 place-items-center rounded-full text-white ring-2 ring-surface transition-colors ${online === false ? "bg-[#d92b33]" : online ? "bg-brand-green" : "bg-stone-400"}`}
                >
                  {online === false ? (
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
                  ) : online ? (
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  ) : (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  )}
                </span>
              </span>
              <span className="hidden min-w-0 text-left leading-tight md:block">
                <span className="block max-w-[14rem] truncate font-semibold text-fg">{me.name}</span>
                <span className="hidden max-w-[16rem] truncate text-xs text-neutral-600 xl:block">{me.email}</span>
                <span className="block text-xs text-neutral-600 xl:hidden">Your account</span>
              </span>
              <span className="sr-only">{me.name}, {status}, your account</span>
            </button>
            <span className="hidden h-7 w-px bg-stone-300 sm:block" aria-hidden />
            <div className="flex items-center gap-1.5">
              <NotificationBell base="/notifications" onOpen={openTicket} viewing={route.page === "ticket" ? route.id : null} />
              <ThemeToggle />
            </div>
            <span className="hidden h-7 w-px bg-stone-300 sm:block" aria-hidden />
            <button
              onClick={() => void signOut()}
              title="Sign out on this computer"
              aria-label="Sign out"
              className="flex items-center gap-2 rounded-lg border border-stone-300 px-2.5 py-2 font-semibold text-neutral-700 transition hover:border-stone-500 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green sm:px-3.5"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="sm:hidden"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
        <div className="w-full px-3 pt-1 sm:px-5 xl:px-9">
          <SlidingTabs<Page>
            mode="nav" label="Main" value={route.page === "account" ? undefined : here} onChange={(id) => go({ page: id })}
            tabs={NAV.map(({ id, label, short, d }) => ({
              id,
              label: (
                <span className="flex items-center gap-2">
                  <svg className="hidden sm:block" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
                  <span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span>
                </span>
              ),
            }))}
          />
        </div>
        <div className="brand-stripe" />
      </header>

      {sso !== null && !sso.enforced && !me.ms_linked && !me.has_pin && route.page !== "account" && (
        <div className="border-b border-amber-300 bg-brand-amber/20 px-4 py-2.5 text-sm sm:px-6 xl:px-10" role="status">
          <b>Create a PIN</b> so nobody can open your tickets by typing your email on another computer.{" "}
          <button className="font-bold underline" onClick={() => go({ page: "account" })}>Set my PIN</button>
        </div>
      )}
      {/* Keyed by page, so every navigation replays the entrance and feels like a transition. */}
      <main key={route.page === "ticket" ? `ticket-${route.id}` : route.page} className="page-in w-full flex-1 px-4 pb-12 pt-6 sm:px-6 xl:px-10">
        {route.page === "home" && <Home name={me.name} go={(page) => go({ page })} open={openTicket} onNew={(title) => go({ page: "new" }, title)} />}
        {route.page === "new" && (
          <PageBox title="Submit a ticket">
            <NewTicket name={me.name} email={me.email} initialTitle={draftTitle} onView={openTicket} onList={() => go({ page: "queue" })} />
          </PageBox>
        )}
        {route.page === "queue" && (
          <PageBox title="My queue" sub="Where your tickets are right now.">
            <MyQueue open={openTicket} />
          </PageBox>
        )}
        {route.page === "board" && (
          <PageBox title="Live board" sub="What IT is working on, and where you sit.">
            <LiveBoard open={openTicket} />
          </PageBox>
        )}
        {route.page === "help" && (
          <PageBox title="Help" sub="Quick fixes for the usual problems. If none of them works, raise a ticket.">
            <Help onNewTicket={() => go({ page: "new" })} />
          </PageBox>
        )}
        {route.page === "account" && (
          <PageBox title="Your account" sub={sso?.enforced ? "You sign in with your Microsoft 365 account." : "Your PIN keeps your tickets private."}>
            <Account name={me.name} email={me.email} hasPin={me.has_pin} emailNotify={me.email_notify} msLinked={me.ms_linked} jobTitle={me.job_title} department={me.department} onChanged={() => void load()} />
          </PageBox>
        )}
        {route.page === "ticket" && (
          <PageBox title="Ticket">
            <TicketView id={route.id} role="requester" base="/tickets" />
          </PageBox>
        )}
      </main>
      <footer className="border-t border-stone-200 bg-surface py-4 text-center text-xs text-neutral-400">Fortress Oil &amp; Gas Helpdesk</footer>
      <CallDock staff={false} onOpen={openTicket} />
    </div>
  );
}
