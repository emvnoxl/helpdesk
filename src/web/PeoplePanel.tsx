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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-extrabold">People</h2>
        <p className="text-sm text-neutral-500">Everyone who has used the helpdesk as a normal user. If someone forgets their PIN, reset it here.</p>
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
                  <td className="p-3 font-medium">{p.name}</td>
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
                    <button className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={!p.has_pin} onClick={() => void reset(p)}>Reset PIN</button>
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
    </div>
  );
}
