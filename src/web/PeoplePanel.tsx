import { Fragment, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { useNotify } from "./notify";
import { DevicePanel, type DeviceData, kindOf } from "./DeviceCard";
import { field } from "./ui";

interface Person { id: number; name: string; email: string; active: number; last_login_at: number | null; created_at: number; has_pin: number; tickets: number; computers: number; reported: number }
const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "Never");

/** Admin > People: the normal users, and a way to clear a forgotten PIN (they create a new one next time they sign in). */
export function PeoplePanel({ onExpired }: { onExpired: () => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<Person[] | null>(null);
  const [q, setQ] = useState("");
  const [qNow, setQNow] = useState("");
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [devs, setDevs] = useState<Record<number, DeviceData[] | "loading">>({});

  async function toggle(p: Person) {
    if (openId === p.id) return setOpenId(null);
    setOpenId(p.id);
    setDevs((d) => ({ ...d, [p.id]: "loading" }));
    try {
      const list = await api<DeviceData[]>(`/admin/people/${p.id}/devices`);
      setDevs((d) => ({ ...d, [p.id]: list }));
    } catch (e) {
      setDevs((d) => ({ ...d, [p.id]: [] }));
      toast((e as Error).message, "error", "Couldn't load their computers");
    }
  }

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
        <p className="text-sm text-neutral-500">Everyone who has used the helpdesk as a normal user. Reset a forgotten PIN, disable someone who should no longer have access, or delete an account.</p>
      </div>
      <input className={field + " !w-full sm:!w-80"} type="search" placeholder="Search by name or email…" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              <th className="p-3">Name</th><th>Email</th><th>PIN</th><th>Computers</th><th>Tickets</th><th>Last signed in</th><th className="pr-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((p) => (
              <Fragment key={p.id}>
                <tr className="border-t border-stone-200">
                  <td className="p-3 font-medium">{p.name}{!p.active && <span className="ml-2 rounded-full bg-[#d92b33] px-2 py-0.5 text-xs font-bold text-white">Disabled</span>}</td>
                  <td className="text-neutral-600">{p.email}</td>
                  <td>{p.has_pin ? <span className="rounded-full bg-brand-green px-2 py-0.5 text-xs font-bold text-ink">Set</span> : <span className="rounded-full bg-brand-amber px-2 py-0.5 text-xs font-bold text-ink" title="Not set yet: the next person to sign in with this email will create it">Not set</span>}</td>
                  <td>
                    <button className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={!p.computers} aria-expanded={openId === p.id} onClick={() => void toggle(p)} title={p.computers ? "Show their computers" : "No computer has reported yet"}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>
                      {p.computers}{p.reported ? <span className="text-ok" title={`${p.reported} with a full hardware report`}> · {p.reported} full</span> : null}
                      <span aria-hidden>{openId === p.id ? "▴" : "▾"}</span>
                    </button>
                  </td>
                  <td>{p.tickets}</td>
                  <td className="text-neutral-600">{when(p.last_login_at)}</td>
                  <td className="pr-3 text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={!p.has_pin} onClick={() => void reset(p)}>Reset PIN</button>
                      <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-100" onClick={() => void setActive(p, !p.active)}>{p.active ? "Disable" : "Enable"}</button>
                      <button className="rounded-lg border border-red-700/50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-700/10" onClick={() => { setKeep(true); setRemoving(p); }}>Delete</button>
                    </div>
                  </td>
                </tr>
                {openId === p.id && (
                  <tr className="border-t border-stone-200 bg-stone-50">
                    <td colSpan={7} className="p-4">
                      {devs[p.id] === "loading" || !devs[p.id] ? (
                        <p className="text-sm text-neutral-500">Loading…</p>
                      ) : (devs[p.id] as DeviceData[]).length === 0 ? (
                        <p className="text-sm text-neutral-500">No computer has reported yet.</p>
                      ) : (
                        <DevicePanel devices={devs[p.id] as DeviceData[]} />
                      )}
                      {(devs[p.id] as DeviceData[] | undefined)?.some?.((d) => !d.hardware && kindOf(d) !== "Phone") && (
                        <p className="mt-3 text-xs text-neutral-500">Make, model, serial number, disks and exact memory aren't visible to a browser. Ask {p.name.split(" ")[0]} to open <b>Your account</b> in the helpdesk and choose <b>Send hardware details to IT</b>, once per computer.</p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows && !rows.length && <tr><td className="p-8 text-center text-neutral-500" colSpan={7}>{qNow ? "Nobody matches that search." : "Nobody has signed in yet."}</td></tr>}
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
