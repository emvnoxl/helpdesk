import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api, fmt } from "./api";
import { useNotify } from "./notify";
import { useSso } from "./sso";
import { btn, btnGhost, card, field } from "./ui";

type StaffRow = {
  id: number; name: string; email: string; role: "agent" | "admin"; active: number;
  must_change_password: number; last_login_at: number | null; open_tickets: number;
};

/** A temporary password, shown once inside a branded dialog. */
function SecretBox({ pw }: { pw: string }) {
  const { toast } = useNotify();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-stone-100 p-3">
        <code className="min-w-0 flex-1 select-all break-all font-mono text-lg font-bold tracking-wide text-fg">{pw}</code>
        <button className={btn} onClick={() => { void navigator.clipboard?.writeText(pw); toast("Temporary password copied.", "success"); }}>Copy</button>
      </div>
      <p className="mt-3 text-xs">It's shown only once and isn't stored anywhere we can show it again. Give it to them privately. They'll be asked to choose their own password the first time they sign in.</p>
    </div>
  );
}

/** Admin only: create agents, reset their passwords, disable or delete them. */
export function UsersPanel({ meId, onExpired }: { meId: number; onExpired: () => void }) {
  const sso = useSso();
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [form, setForm] = useState({ name: "", email: "", role: "agent" });
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (e: unknown, title?: string) => ((e as ApiError).status === 401 ? onExpired() : toast((e as Error).message, "error", title)),
    [onExpired, toast],
  );
  const load = useCallback(
    () => api<StaffRow[]>("/admin/users").then((r) => { setRows(r); setLoadErr(""); }, (e) => ((e as ApiError).status === 401 ? onExpired() : setLoadErr(e.message))),
    [onExpired],
  );
  useEffect(() => void load(), [load]);

  const showSecret = (title: string, pw: string) =>
    confirm({ title, body: <SecretBox pw={pw} />, confirmLabel: "Done", cancelLabel: null, tone: "success" });

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api("/admin/users", { method: "POST", json: form });
      setForm({ name: "", email: "", role: "agent" });
      await load();
      await showSecret(`Account created for ${r.name}`, r.temp_password);
    } catch (x) {
      fail(x, "Couldn't create the account");
    } finally {
      setBusy(false);
    }
  }

  async function reset(u: StaffRow) {
    const ok = await confirm({
      title: `Reset ${u.name}'s password?`,
      body: "They'll be signed out everywhere and given a new temporary password, which you'll see once.",
      confirmLabel: "Reset password",
    });
    if (!ok) return;
    try {
      const r = await api(`/admin/users/${u.id}/reset-password`, { method: "POST", json: {} });
      await load();
      await showSecret(`New temporary password for ${u.name}`, r.temp_password);
    } catch (x) {
      fail(x, "Couldn't reset the password");
    }
  }

  async function changeRole(u: StaffRow) {
    const to = u.role === "admin" ? "agent" : "admin";
    const ok = await confirm({
      title: `Make ${u.name} ${to === "admin" ? "an admin" : "an agent"}?`,
      body: to === "admin" ? "Admins can see the dashboard and the full Live board, and manage staff accounts." : "They'll lose access to the dashboard, the full Live board and staff accounts.",
      confirmLabel: to === "admin" ? "Make admin" : "Make agent",
    });
    if (!ok) return;
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", json: { role: to } });
      toast(`${u.name} is now ${to === "admin" ? "an admin" : "an agent"}. They'll need to sign in again.`, "success");
      await load();
    } catch (x) { fail(x); }
  }

  async function setActive(u: StaffRow) {
    if (u.active) {
      const ok = await confirm({
        title: `Disable ${u.name}?`,
        body: "They'll be signed out straight away and their open tickets go back to triage. You can enable them again later.",
        confirmLabel: "Disable account",
        tone: "danger",
      });
      if (!ok) return;
    }
    try {
      await api(`/admin/users/${u.id}`, { method: "PATCH", json: { active: !u.active } });
      toast(u.active ? `${u.name} has been disabled.` : `${u.name} can sign in again.`, "success");
      await load();
    } catch (x) { fail(x); }
  }

  async function remove(u: StaffRow) {
    const ok = await confirm({
      title: `Delete ${u.name}?`,
      body: (
        <ul className="list-disc space-y-1 pl-5">
          <li>Their account is removed permanently and they can no longer sign in.</li>
          <li>Their open tickets go back to triage.</li>
          <li>Replies they wrote stay on the tickets, shown as "Former team member".</li>
        </ul>
      ),
      confirmLabel: "Delete account",
      tone: "danger",
    });
    if (!ok) return;
    try {
      const r = await api(`/admin/users/${u.id}`, { method: "DELETE" });
      toast(r.mode === "deleted" ? `${u.name}'s account was deleted.` : `${u.name} was removed from the IT team. Their own tickets are kept.`, "success");
      await load();
    } catch (x) { fail(x, "Couldn't delete the account"); }
  }

  const act = "rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green";
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        {loadErr && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{loadErr}</p>}
        <div className={card + " overflow-x-auto !p-0"}>
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-stone-50 text-xs uppercase text-neutral-500">
              <tr><th className="p-3">Person</th><th>Role</th><th>Status</th><th>Open tickets</th><th>Last sign-in</th><th className="pr-3 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {(rows ?? []).map((u) => {
                const me = u.id === meId;
                return (
                  <tr key={u.id} className={`border-b last:border-0 ${u.active ? "" : "bg-stone-50 text-neutral-400"}`}>
                    <td className="p-3"><div className="font-semibold">{u.name}{me && <span className="ml-2 text-xs font-normal text-neutral-500">(you)</span>}</div><div className="text-xs text-neutral-500">{u.email}</div></td>
                    <td><span className={`rounded-full bg-ink px-2.5 py-0.5 text-xs font-bold uppercase ${u.role === "admin" ? "text-brand-amber" : "text-brand-green"}`}>{u.role}</span></td>
                    <td className="text-xs font-semibold">{!u.active ? "Disabled" : u.must_change_password ? "Must set password" : "Active"}</td>
                    <td className="tabular-nums">{u.open_tickets}</td>
                    <td className="whitespace-nowrap text-xs">{u.last_login_at ? fmt(u.last_login_at) : "Never"}</td>
                    <td className="space-x-1 whitespace-nowrap pr-3 text-right">
                      {u.active ? <button className={`${act} text-neutral-600 hover:bg-stone-200/60`} onClick={() => void reset(u)}>Reset password</button> : null}
                      {!me && u.active ? <button className={`${act} text-neutral-600 hover:bg-stone-200/60`} onClick={() => void changeRole(u)}>{u.role === "admin" ? "Make agent" : "Make admin"}</button> : null}
                      {!me ? <button className={`${act} text-neutral-600 hover:bg-stone-200/60`} onClick={() => void setActive(u)}>{u.active ? "Disable" : "Enable"}</button> : null}
                      {!me ? <button className={`${act} text-red-700 hover:bg-red-50`} onClick={() => void remove(u)}>Delete</button> : null}
                    </td>
                  </tr>
                );
              })}
              {!rows && <tr><td className="p-6 text-center text-neutral-500" colSpan={6}>Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <form onSubmit={create} className={card + " h-fit space-y-3"}>
        <h2 className="font-bold">Add someone to the IT team</h2>
        <p className="text-xs text-neutral-500">They sign in at <span className="font-mono">/agent</span> (agents) or <span className="font-mono">/admin</span> (admins) {sso?.available ? "with their Microsoft 365 account as soon as you have added them here. The temporary password is only needed if Microsoft sign-in is switched off." : "with a temporary password you give them."}</p>
        <label className="block text-sm font-semibold">Name<input className={field + " mt-1 font-normal"} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} required /></label>
        <label className="block text-sm font-semibold">Email<input className={field + " mt-1 font-normal"} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
        <label className="block text-sm font-semibold">Role
          <select className={field + " mt-1 font-normal"} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="agent">Agent: works tickets</option>
            <option value="admin">Admin: also sees the dashboard and manages people</option>
          </select>
        </label>
        <button className={btn + " w-full"} disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>
    </div>
  );
}
