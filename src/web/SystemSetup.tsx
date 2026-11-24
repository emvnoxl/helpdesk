import { useState, type ReactNode } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { btn, field } from "./ui";

/* Admin > System > Address and Email: what used to be .env edits plus a restart. Saved settings override .env at once.
   Secrets (SMTP password, Graph client secret) are never sent back: the page only knows whether one is set, and a blank box on save means "keep it". */

export interface Settings {
  address: { app_url: string; alt_urls: string[]; trust_proxy: boolean; source: "saved" | "env"; cookies_secure: boolean };
  sso: { configured: boolean; enforced: boolean; use_mail_app: boolean; tenant_id: string; client_id: string; has_secret: boolean; verified_at: number | null; source: "saved" | "env" };
  mail: {
    mode: "off" | "log" | "smtp" | "graph";
    from: string;
    smtp: { host: string; port: number; secure: boolean; user: string; has_pass: boolean };
    graph: { tenant_id: string; client_id: string; has_secret: boolean; sender: string };
    source: "saved" | "env";
  };
}

const label = "block text-sm font-semibold text-fg";
const hint = "mt-1 text-xs text-neutral-600 dark:text-neutral-400";
const code = "rounded bg-fg/10 px-1";

function Row({ title, hintText, children }: { title: string; hintText?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className={label}>{title}</span>
      <div className="mt-1">{children}</div>
      {hintText && <span className={hint + " block"}>{hintText}</span>}
    </label>
  );
}

export const secondaryBtn = "rounded-lg border border-fg/25 bg-transparent px-3.5 py-2 text-sm font-semibold text-fg hover:bg-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green disabled:opacity-50";

/** The helpdesk's own address (APP_URL, ALT_URLS, TRUST_PROXY). */
export function AddressSetup({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const { toast } = useNotify();
  const [url, setUrl] = useState(s.address.app_url);
  const [alts, setAlts] = useState(s.address.alt_urls.join("\n"));
  const [proxy, setProxy] = useState(s.address.trust_proxy);
  const [busy, setBusy] = useState(false);
  const here = location.origin;
  const dirty = url.trim() !== s.address.app_url || alts.split(/[,\s]+/).filter(Boolean).join(",") !== s.address.alt_urls.join(",") || proxy !== s.address.trust_proxy;

  async function save() {
    setBusy(true);
    try {
      await api("/admin/system/settings", { method: "PUT", json: { address: { app_url: url, alt_urls: alts, trust_proxy: proxy } } });
      toast("Links in emails now use this address.", "success", "Address saved");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error", "Not saved");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-fg/10 bg-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Address</h2>
        <span className="rounded-full bg-fg/10 px-2.5 py-0.5 text-xs font-bold text-fg">{s.address.app_url ? (s.address.source === "saved" ? "Saved here" : "From .env") : "Not set"}</span>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        The web address people type to reach the helpdesk. Links in emails use it, and an <code className={code}>https://</code> address switches on secure cookies. You are on <b className="text-fg">{here}</b> right now.
      </p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Row title="Address" hintText="For example https://helpdesk.fortressghana.com. No path. Only save an https address once it works in your browser.">
          <div className="flex gap-2">
            <input className={field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://helpdesk.yourcompany.com" spellCheck={false} autoCapitalize="none" />
            <button type="button" className={secondaryBtn + " shrink-0"} onClick={() => setUrl(here)}>Use this one</button>
          </div>
        </Row>
        <Row title="Other addresses (optional)" hintText="The same helpdesk under another name or IP, one per line. The hardware report tries them all, so it survives an IP change.">
          <textarea className={field + " min-h-[2.75rem]"} rows={2} value={alts} onChange={(e) => setAlts(e.target.value)} placeholder="http://192.168.1.20:3000" spellCheck={false} autoCapitalize="none" />
        </Row>
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-fg">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={proxy} onChange={(e) => setProxy(e.target.checked)} />
        <span>
          <b>A reverse proxy provides the https</b> (Caddy, nginx, your NAS's proxy)
          <span className={hint + " block"}>Tick this only if one really sits in front of the helpdesk: it makes the helpdesk believe the proxy about who is connecting.</span>
        </span>
      </label>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className={btn} disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save address"}</button>
        {s.address.source === "saved" && <span className={hint}>What you save here overrides <code className={code}>APP_URL</code> in .env.</span>}
      </div>
    </section>
  );
}

const MODES: { id: Settings["mail"]["mode"]; title: string; text: string }[] = [
  { id: "smtp", title: "SMTP", text: "Any mail server: Microsoft 365, Gmail, your own." },
  { id: "graph", title: "Microsoft 365 (Graph)", text: "Sends as a mailbox through an Entra app. Can also read the mailbox for tickets by email." },
  { id: "log", title: "Trial", text: "Print emails in the server log instead of sending." },
  { id: "off", title: "Off", text: "Nobody is emailed." },
];

/** How emails are sent: SMTP or Microsoft Graph credentials. */
export function MailSetup({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const { toast } = useNotify();
  const m = s.mail;
  const [mode, setMode] = useState(m.mode);
  const [from, setFrom] = useState(m.from);
  const [host, setHost] = useState(m.smtp.host);
  const [port, setPort] = useState(String(m.smtp.port || 587));
  const [tls, setTls] = useState(m.smtp.secure);
  const [user, setUser] = useState(m.smtp.user);
  const [pass, setPass] = useState("");
  const [tenant, setTenant] = useState(m.graph.tenant_id);
  const [client, setClient] = useState(m.graph.client_id);
  const [secret, setSecret] = useState("");
  const [sender, setSender] = useState(m.graph.sender);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("/admin/system/settings", {
        method: "PUT",
        json: { mail: { mode, from, smtp: { host, port: Number(port), secure: tls, user, pass }, graph: { tenant_id: tenant, client_id: client, client_secret: secret, sender } } },
      });
      setPass(""); setSecret("");
      toast(mode === "off" || mode === "log" ? "Saved." : "Now press “Send a test email” to check it reaches you.", "success", "Email settings saved");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error", "Not saved");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="How email is sent" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {MODES.map((x) => (
          <button key={x.id} type="button" role="radio" aria-checked={mode === x.id} onClick={() => setMode(x.id)}
            className={`rounded-xl border p-3 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${mode === x.id ? "border-brand-green bg-brand-green/15 ring-1 ring-brand-green" : "border-fg/20 hover:bg-fg/5"}`}>
            <span className="flex items-center gap-2 text-sm font-bold text-fg">
              <span className={`grid h-4 w-4 place-items-center rounded-full border ${mode === x.id ? "border-brand-green bg-brand-green" : "border-fg/40"}`}>{mode === x.id && <span className="h-1.5 w-1.5 rounded-full bg-ink" />}</span>
              {x.title}
            </span>
            <span className="mt-1 block text-xs text-neutral-600 dark:text-neutral-400">{x.text}</span>
          </button>
        ))}
      </div>

      {(mode === "smtp" || mode === "graph" || mode === "log") && (
        <Row title="Send emails from" hintText={mode === "graph" ? "Optional: the mailbox below is used." : "The address people see, for example helpdesk@yourcompany.com."}>
          <input className={field} type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="helpdesk@yourcompany.com" autoCapitalize="none" spellCheck={false} />
        </Row>
      )}

      {mode === "smtp" && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem_12rem]">
            <Row title="Mail server"><input className={field} value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.office365.com" autoCapitalize="none" spellCheck={false} /></Row>
            <Row title="Port"><input className={field} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="587" /></Row>
            <Row title="Security">
              <select className={field} value={tls ? "tls" : "starttls"} onChange={(e) => { setTls(e.target.value === "tls"); setPort(e.target.value === "tls" ? "465" : "587"); }}>
                <option value="starttls">STARTTLS (587)</option>
                <option value="tls">TLS (465)</option>
              </select>
            </Row>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Row title="Username"><input className={field} value={user} onChange={(e) => setUser(e.target.value)} placeholder="helpdesk@yourcompany.com" autoComplete="off" autoCapitalize="none" spellCheck={false} /></Row>
            <Row title="Password" hintText={m.smtp.has_pass ? "A password is saved. Leave blank to keep it." : "Stored encrypted. Never shown again."}>
              <input className={field} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={m.smtp.has_pass ? "•••••••• (saved)" : ""} autoComplete="new-password" />
            </Row>
          </div>
          <button type="button" className={secondaryBtn} onClick={() => { setHost("smtp.office365.com"); setPort("587"); setTls(false); }}>Fill in Microsoft 365 values</button>
          <p className={hint}>Microsoft 365 needs “SMTP AUTH” switched on for that mailbox, and often an app password if the account uses multi-factor sign-in.</p>
        </div>
      )}

      {mode === "graph" && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Row title="Tenant ID" hintText="Directory (tenant) ID from the app registration."><input className={field} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoCapitalize="none" /></Row>
            <Row title="Client ID" hintText="Application (client) ID."><input className={field} value={client} onChange={(e) => setClient(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoCapitalize="none" /></Row>
            <Row title="Client secret" hintText={m.graph.has_secret ? "A secret is saved. Leave blank to keep it." : "Stored encrypted. Never shown again."}>
              <input className={field} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={m.graph.has_secret ? "•••••••• (saved)" : ""} autoComplete="new-password" />
            </Row>
            <Row title="Send as (mailbox)" hintText="Needs the Mail.Send application permission with admin consent."><input className={field} type="email" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="helpdesk@yourcompany.com" autoCapitalize="none" spellCheck={false} /></Row>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className={btn} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save email settings"}</button>
        <span className={hint}>{m.source === "saved" ? <>Saved here: overrides the <code className={code}>SMTP_*</code> and <code className={code}>GRAPH_*</code> lines in .env.</> : "Currently coming from .env. Saving here overrides it."}</span>
      </div>
    </div>
  );
}

/** Sign in with Microsoft 365: the Entra app registration, a test, and the switch that retires PINs and agent passwords. */
export function SsoSetup({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const { toast, confirm } = useNotify();
  const x = s.sso;
  const [same, setSame] = useState(x.use_mail_app);
  const [tenant, setTenant] = useState(x.tenant_id);
  const [client, setClient] = useState(x.client_id);
  const [secret, setSecret] = useState("");
  const [enforce, setEnforce] = useState(x.enforced);
  const [busy, setBusy] = useState(false);
  const redirect = (s.address.app_url || location.origin) + "/api/auth/microsoft/callback";
  const mailIsGraph = s.mail.mode === "graph";
  const verified = !!x.verified_at;
  const state = x.enforced ? { text: "Required for everyone", tone: "bg-brand-green text-ink" } : verified ? { text: "Working, optional", tone: "bg-brand-green text-ink" } : x.configured ? { text: "Saved, not tested yet", tone: "bg-brand-amber text-ink" } : { text: "Not set up", tone: "bg-fg/10 text-fg" };

  async function save() {
    if (enforce && !x.enforced) {
      const yes = await confirm({
        title: "Make Microsoft 365 the only way to sign in?",
        body: "Names and PINs stop working for normal users, and agents can no longer use passwords. Everyone signs in with their company Microsoft account. Admins keep a local password at /admin as the way back in, and you can switch this off again here.",
        confirmLabel: "Switch the old sign-ins off",
        tone: "danger",
      });
      if (!yes) return;
    }
    setBusy(true);
    try {
      await api("/admin/system/settings", { method: "PUT", json: { sso: { use_mail_app: same, tenant_id: tenant, client_id: client, client_secret: secret, enforced: enforce } } });
      setSecret("");
      toast(enforce ? "Everyone now signs in with Microsoft 365." : "Now press Test sign-in and sign in with your own account.", "success", "Microsoft sign-in saved");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "error", "Not saved");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-fg/10 bg-surface p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-fg">Sign in with Microsoft 365</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${state.tone}`}>{state.text}</span>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        People sign in with their company account instead of a PIN: the account is created from their Microsoft profile (name, job title, department) and linked to any existing one by email. Agents and admins must already be added under Staff.
      </p>

      <details className="mt-3 rounded-xl border border-fg/15" open={!x.configured}>
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-fg">How to set it up in Microsoft Entra</summary>
        <ol className="list-decimal space-y-2 border-t border-fg/10 px-8 py-4 text-sm text-neutral-700 dark:text-neutral-300">
          <li>Open <b>entra.microsoft.com</b> &gt; Identity &gt; Applications &gt; <b>App registrations</b> &gt; New registration. Name it "Fortress Helpdesk" and choose <b>Accounts in this organizational directory only</b>.</li>
          <li>Under <b>Redirect URI</b> choose <b>Web</b> and paste this address (copy it exactly):
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-fg/10 px-2 py-1 text-xs text-fg">{redirect}</code>
              <button type="button" className={secondaryBtn + " !px-2.5 !py-1 text-xs"} onClick={() => { void navigator.clipboard?.writeText(redirect); toast("Redirect address copied.", "success"); }}>Copy</button>
            </span>
            {!s.address.app_url && <span className={hint + " block"}>Set and save the Address above first, so this address is the final one. If the helpdesk's name changes later, change it here and in Entra.</span>}
          </li>
          <li>On the app's <b>Overview</b> page copy the <b>Directory (tenant) ID</b> and the <b>Application (client) ID</b> into the boxes below.</li>
          <li><b>Certificates &amp; secrets</b> &gt; New client secret: copy the <b>Value</b> (shown once) into the secret box below.</li>
          <li><b>API permissions</b> already has Microsoft Graph &gt; <b>User.Read</b> (delegated), which is all that is needed to sign in.</li>
        </ol>
      </details>

      <div className="mt-4 space-y-4">
        <label className={`flex items-start gap-3 text-sm text-fg ${mailIsGraph ? "cursor-pointer" : "opacity-60"}`}>
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={same} disabled={!mailIsGraph} onChange={(e) => setSame(e.target.checked)} />
          <span><b>Use the same app registration as email</b><span className={hint + " block"}>{mailIsGraph ? "Email is already sent through Microsoft 365, so the IDs and secret can be reused. Add the redirect address above to that app." : "Only available when email is set to Microsoft 365 (Graph) above."}</span></span>
        </label>
        {!same && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Row title="Tenant ID"><input className={field} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoCapitalize="none" /></Row>
            <Row title="Client ID"><input className={field} value={client} onChange={(e) => setClient(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoCapitalize="none" /></Row>
            <Row title="Client secret" hintText={x.has_secret ? "A secret is saved. Leave blank to keep it." : "Stored encrypted. Never shown again."}>
              <input className={field} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={x.has_secret ? "•••••••• (saved)" : ""} autoComplete="new-password" />
            </Row>
          </div>
        )}

        <label className={`flex items-start gap-3 text-sm text-fg ${verified ? "cursor-pointer" : "opacity-60"}`}>
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={enforce} disabled={!verified && !x.enforced} onChange={(e) => setEnforce(e.target.checked)} />
          <span>
            <b>Make Microsoft 365 the only way to sign in</b>
            <span className={hint + " block"}>
              {verified
                ? "Switches off PINs for normal users and passwords for agents. Admins keep a local password at /admin as the way back in."
                : "Locked until you have seen it work: save the settings, press Test sign-in and sign in with your own account. That protects you from locking everyone out."}
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button className={btn} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save Microsoft sign-in"}</button>
        {x.configured ? (
          <a className={secondaryBtn} href="/api/auth/microsoft/start?portal=admin" target="_blank" rel="noopener">Test sign-in</a>
        ) : (
          <button className={secondaryBtn} disabled>Test sign-in</button>
        )}
        {verified && <span className={hint}>Last successful admin sign-in with Microsoft: {new Date((x.verified_at ?? 0) * 1000).toLocaleString()}.</span>}
      </div>
    </section>
  );
}
