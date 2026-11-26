import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import { useNotify } from "./notify";
import { useLive } from "./live";
import { field } from "./ui";

interface Person { id: number; name: string; email: string; active: number; last_login_at: number | null; created_at: number; has_pin: number; tickets: number; computers: number; reported: number }
const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Never");

interface Here { id: number; name: string; email: string }
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** Admin > People: the normal users, who is online right now, and a way to clear a forgotten PIN (they create a new one next time they sign in).
    Their computers live under Computers: the count here opens that tab already searched for the person. */
export function PeoplePanel({ onExpired, onShowComputers }: { onExpired: () => void; onShowComputers: (email: string) => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<Person[] | null>(null);
  const [q, setQ] = useState("");
  const [qNow, setQNow] = useState("");
  const [err, setErr] = useState("");
  const [here, setHere] = useState<Here[] | null>(null);
  const [onlyOnline, setOnlyOnline] = useState(false);
  const onlineIds = useMemo(() => new Set((here ?? []).map((h) => h.id)), [here]);

  // Who has the helpdesk open: pushed by the server when someone arrives or leaves, with a slow poll as the safety net.
  const loadHere = useCallback(() => api<Here[]>("/admin/people/online").then(setHere, () => undefined), []);
  useEffect(() => { void loadHere(); const t = setInterval(() => void loadHere(), 30_000); return () => clearInterval(t); }, [loadHere]);
  useLive("/staff/stream", () => { void loadHere(); }, ["presence", "open"]);

  useEffect(() => { const t = setTimeout(() => setQNow(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = useCallback(async () => {
    try {
      setRows(await api<Person[]>(`/admin/people${qNow ? `?q=${encodeURIComponent(qNow)}` : ""}`));
      setErr("");
    } catch (e) {
      if ((e as ApiError).status === 401) onExpired();
      else setErr((e as Error).message);
    }
  }, [qNow, onExpired]);
  useEffect(() => void load(), [load]);
  useLive("/staff/stream", () => { void load(); }, ["change", "open"]);
  const shownRows = useMemo(() => {
    const list = (rows ?? []).filter((p) => !onlyOnline || onlineIds.has(p.id));
    return [...list].sort((a, b) => Number(onlineIds.has(b.id)) - Number(onlineIds.has(a.id))); // stable: online first, the rest keep their order
  }, [rows, onlyOnline, onlineIds]);

  async function reset(p: Person) {
    const yes = await confirm({
      title: `Reset ${p.name}'s PIN?`,
      body: `${p.name} is signed out on every computer, and creates a new PIN the next time they sign in. Their tickets are not touched. Only do this once you are sure it is really them asking.`,
      confirmLabel: "Reset PIN",
      tone: "danger",
    });
    if (!yes) return;
    try {
      await api(`/admin/people/${p.id}/reset-pin`, { method: "POST", json: {} });
      toast(`${p.name} will be asked to create a new PIN.`, "success", "PIN reset");
      await load();
    } catch (e) {
      toast((e as Error).message, "error", "Couldn't reset the PIN");
    }
  }

  async function setActive(p: Person, active: boolean) {
    if (!active) {
      const yes = await confirm({
        title: `Disable ${p.name}?`,
        body: `${p.name} is signed out everywhere and cannot sign in again until you re-enable them. They get no more emails. Their tickets and history stay as they are.`,
        confirmLabel: "Disable",
        tone: "danger",
      });
      if (!yes) return;
    }
    try {
      await api(`/admin/people/${p.id}/active`, { method: "POST", json: { active } });
      toast(active ? `${p.name} can sign in again.` : `${p.name} is disabled and signed out.`, "success", active ? "Re-enabled" : "Disabled");
      await load();
    } catch (e) {
      toast((e as Error).message, "error", "Couldn't change the account");
    }
  }

  const [removing, setRemoving] = useState<Person | null>(null);
  const [keep, setKeep] = useState(true);
  const [busyDel, setBusyDel] = useState(false);
  async function remove() {
    if (!removing) return;
    setBusyDel(true);
    try {
      const r = await api<{ tickets: number }>(`/admin/people/${removing.id}?tickets=${keep ? "keep" : "delete"}`, { method: "DELETE" });
      toast(`${removing.name} was deleted${r.tickets ? (keep ? `; ${r.tickets} ticket${r.tickets === 1 ? "" : "s"} kept as "Former user".` : `, with ${r.tickets} ticket${r.tickets === 1 ? "" : "s"}.`) : "."}`, "success", "Account deleted");
      setRemoving(null);
      await load();
    } catch (e) {
      toast((e as Error).message, "error", "Couldn't delete the account");
    }
    setBusyDel(false);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-extrabold">People</h2>
        <p className="text-sm text-neutral-500">Everyone who has used the helpdesk as a normal user. Reset a forgotten PIN, disable someone who should no longer have access, or delete an account. Their computers are under <b>Computers</b>.</p>
      </div>

      <section aria-label="Online now" className="rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="relative flex h-2.5 w-2.5" aria-hidden><span className={`absolute inline-flex h-full w-full rounded-full bg-brand-green ${here?.length ? "animate-ping opacity-60 motion-reduce:animate-none" : "opacity-0"}`} /><span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${here?.length ? "bg-brand-green" : "bg-neutral-400"}`} /></span>
          <h3 className="text-sm font-extrabold">Online now</h3>
          <span className="rounded-full bg-fg/10 px-2 py-0.5 text-xs font-bold" aria-live="polite">{here ? here.length : "…"}</span>
          <span className="text-xs text-neutral-500">using the helpdesk this minute (it has it open in a browser)</span>
        </div>
        {here && here.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {here.map((h) => (
              <li key={h.id} className="flex items-center gap-2 rounded-full border border-stone-200 py-1 pl-1 pr-3 text-sm" title={h.email}>
                <span className="relative grid h-7 w-7 place-items-center rounded-full bg-brand-green text-[11px] font-bold text-ink">{initials(h.name)}<span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-surface)] bg-brand-green" aria-hidden /></span>
                <span className="font-semibold">{h.name}</span>
              </li>
            ))}
          </ul>
        ) : here ? <p className="mt-2 text-sm text-neutral-500">Nobody is using the helpdesk right now.</p> : null}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <input className={field + " !w-full sm:!w-80"} type="search" placeholder="Search by name or email…" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex gap-1.5" role="radiogroup" aria-label="Show">
          {([[false, "Everyone"], [true, "Online now"]] as const).map(([v, label]) => (
            <button key={label} role="radio" aria-checked={onlyOnline === v} onClick={() => setOnlyOnline(v)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors ${onlyOnline === v ? "bg-ink text-white ring-ink dark:bg-brand-green dark:text-ink dark:ring-brand-green" : "text-neutral-600 ring-stone-300 hover:bg-stone-100"}`}>
              {label}{v && here ? <span className="ml-1 opacity-85">{here.length}</span> : null}
            </button>
          ))}
        </div>
      </div>
      {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              <th className="p-3">Name</th><th>Email</th><th>PIN</th><th>Computers</th><th>Tickets</th><th>Last signed in</th><th className="pr-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shownRows.map((p) => (
              <tr key={p.id} className="border-t border-stone-200">
                <td className="p-3 font-medium">
                  <span className="inline-flex items-center gap-2">
                    {onlineIds.has(p.id) && <span className="inline-flex items-center gap-1 rounded-full bg-brand-green/15 px-2 py-0.5 text-xs font-bold text-ok" title="Has the helpdesk open right now"><span className="h-1.5 w-1.5 rounded-full bg-brand-green" aria-hidden />Online</span>}
                    {p.name}
                  </span>
                  {!p.active && <span className="ml-2 rounded-full bg-[#d92b33] px-2 py-0.5 text-xs font-bold text-white">Disabled</span>}
                </td>
                <td className="text-neutral-600">{p.email}</td>
                <td>{p.has_pin ? <span className="rounded-full bg-brand-green px-2 py-0.5 text-xs font-bold text-ink">Set</span> : <span className="rounded-full bg-brand-amber px-2 py-0.5 text-xs font-bold text-ink" title="Not set yet: the next person to sign in with this email will create it">Not set</span>}</td>
                <td>
                  <button className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={!p.computers} onClick={() => onShowComputers(p.email)} title={p.computers ? "See their computers under Computers" : "No computer has reported yet"}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
                    {p.computers}{p.reported ? <span className="text-ok" title={`${p.reported} with a full hardware report`}> · {p.reported} full</span> : null}
                    <span aria-hidden>›</span>
                  </button>
                </td>
                <td>{p.tickets}</td>
                <td className="text-neutral-600">{onlineIds.has(p.id) ? <b className="text-ok">Now</b> : when(p.last_login_at)}</td>
                <td className="pr-3 text-right">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={!p.has_pin} onClick={() => void reset(p)}>Reset PIN</button>
                    <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-100" onClick={() => void setActive(p, !p.active)}>{p.active ? "Disable" : "Enable"}</button>
                    <button className="rounded-lg border border-red-700/50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-700/10" onClick={() => { setKeep(true); setRemoving(p); }}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {rows && !shownRows.length && <tr><td className="p-8 text-center text-neutral-500" colSpan={7}>{onlyOnline ? "Nobody is online right now." : qNow ? "Nobody matches that search." : "Nobody has signed in yet."}</td></tr>}
            {!rows && <tr><td className="p-8 text-center text-neutral-500" colSpan={7}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>

      {removing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={`Delete ${removing.name}`} onKeyDown={(e) => e.key === "Escape" && setRemoving(null)}>
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl" style={{ borderTop: "5px solid #d92b33" }}>
            <div className="space-y-3 p-5">
              <h3 className="text-lg font-extrabold">Delete {removing.name}?</h3>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">This removes the account ({removing.email}), their computers and their sign-ins for good. It cannot be undone. {removing.tickets ? `They have ${removing.tickets} ticket${removing.tickets === 1 ? "" : "s"}:` : "They have no tickets."}</p>
              {removing.tickets > 0 && (
                <div className="space-y-2">
                  <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${keep ? "border-brand-green bg-brand-green/10" : "border-stone-300"}`}>
                    <input type="radio" name="tk" className="mt-1 accent-[#00a859]" checked={keep} onChange={() => setKeep(true)} />
                    <span><b>Keep their tickets</b> for the history and reports. They show as "Former user".</span>
                  </label>
                  <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${!keep ? "border-[#d92b33] bg-[#d92b33]/10" : "border-stone-300"}`}>
                    <input type="radio" name="tk" className="mt-1 accent-[#d92b33]" checked={!keep} onChange={() => setKeep(false)} />
                    <span><b>Delete their tickets too</b>, with every message and file.</span>
                  </label>
                </div>
              )}
              <p className="text-xs text-neutral-600 dark:text-neutral-400">To just stop someone signing in, use Disable instead: nothing is lost and you can turn it back on.</p>
            </div>
            <div className="flex justify-end gap-2 border-t border-stone-200 bg-fg/5 px-5 py-3">
              <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-fg/10" onClick={() => setRemoving(null)} autoFocus>Cancel</button>
              <button className="rounded-lg bg-[#d92b33] px-4 py-2 text-sm font-bold text-white disabled:opacity-50" disabled={busyDel} onClick={() => void remove()}>{busyDel ? "Deleting…" : "Delete account"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
