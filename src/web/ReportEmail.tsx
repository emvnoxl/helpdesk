import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { DateTimePicker } from "./DateTimePicker";
import { secondaryBtn } from "./SystemSetup";
import { btn, field } from "./ui";

/* Admin > System > Report email: the monthly report goes out by itself to the people chosen here (all admins, picked colleagues, any other addresses). */

export interface StaffPick { id: number; name: string; email: string; role: string }
export interface ReportEmailInfo {
  enabled: boolean; repeat: boolean; day: number; send_at: string; covers: string; now_local: string; suggestion: string; admins: boolean; staff_ids: number[]; custom: string[];
  last: { at: number; month: string; sent: number; failed: number; error: string | null; by: string } | null;
  next_at: number | null; recipient_count: number; staff: StaffPick[]; transport: string; app_url_set: boolean; report_month: string;
}
const card = "rounded-2xl border border-fg/10 bg-surface p-5";
const muted = "text-sm text-neutral-600 dark:text-neutral-400";
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const monthName = (m: string) => new Date(m + "-15T12:00:00Z").toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const when = (ts: number) => new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const ordinal = (n: number) => `${n}${[, "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] ?? "th"}`;
const splitList = (t: string) => t.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

export function useReportEmailInfo() {
  const [info, setInfo] = useState<ReportEmailInfo | null>(null);
  const load = useCallback(async () => { try { setInfo(await api<ReportEmailInfo>("/admin/report-email")); } catch { /* shown by the panel */ } }, []);
  useEffect(() => { void load(); }, [load]);
  return { info, load };
}

export function ReportEmail({ info, onChanged }: { info: ReportEmailInfo; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [enabled, setEnabled] = useState(info.enabled);
  const [sendAt, setSendAt] = useState(info.send_at); // "2026-12-05T08:30", Ghana time
  const [repeat, setRepeat] = useState(info.repeat);
  const [admins, setAdmins] = useState(info.admins);
  const [ids, setIds] = useState<number[]>(info.staff_ids);
  const [text, setText] = useState(info.custom.join("\n"));
  const [month, setMonth] = useState(info.report_month);
  const [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState<{ subject?: string; html?: string; error?: string } | null>(null);

  const months = useMemo(() => {
    const [y, m] = info.report_month.split("-").map(Number) as [number, number];
    return Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(y, m - 1 - i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });
  }, [info.report_month]);

  const typed = splitList(text);
  const bad = typed.filter((e) => !EMAIL.test(e));
  const good = [...new Set(typed.filter((e) => EMAIL.test(e)).map((e) => e.toLowerCase()))];
  const chosen = new Set<string>();
  for (const s of info.staff) if ((admins && s.role === "admin") || ids.includes(s.id)) chosen.add(s.email.toLowerCase());
  good.forEach((e) => chosen.add(e));
  const body = { enabled, send_at: sendAt, repeat, admins, staff_ids: ids, custom: good };
  const dirty = JSON.stringify(body) !== JSON.stringify({ enabled: info.enabled, send_at: info.send_at, repeat: info.repeat, admins: info.admins, staff_ids: info.staff_ids, custom: info.custom });
  const picked = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(sendAt) ? sendAt : "";
  const pastPick = enabled && !!picked && picked < info.now_local && sendAt !== info.send_at;
  const covers = (() => { if (!picked) return ""; const [y, m] = picked.slice(0, 7).split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 2, 1)); return monthName(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`); })();
  const dayN = picked ? Number(picked.slice(8, 10)) : 0;
  const mailWarn = info.transport === "off" ? "Email is switched off, so nothing can be sent yet. Set it up under System > Email." : info.transport === "log" ? "Email is in trial mode: reports are printed in the server log, not delivered." : "";

  useEffect(() => {
    let live = true;
    setPrev(null);
    void api<{ subject?: string; html?: string }>("/admin/report-email/preview", { method: "POST", json: { month } }).then((r) => live && setPrev(r)).catch((e) => live && setPrev({ error: (e as Error).message }));
    return () => { live = false; };
  }, [month]);

  // quick picks: they only fill the box, nothing is sent or saved until Save
  const quick: [string, string][] = [["1st of next month, 08:00", info.suggestion], ["Tomorrow, 08:00", (() => { const d = new Date(info.now_local + ":00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) + "T08:00"; })()]];
  const toggleId = (id: number) => setIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  const save = async () => {
    if (!picked) return toast("Pick a date and a time for the report.", "error", "Check the date");
    if (pastPick) return toast("That moment has already passed. Pick a date and time in the future.", "error", "Check the date");
    if (bad.length) return toast(`“${bad[0]}” doesn't look like an email address.`, "error", "Check the addresses");
    setBusy(true);
    try { await api("/admin/report-email", { method: "PUT", json: body }); toast(enabled ? "Saved. The report will go out on its own each month." : "Saved. Nothing will be sent by itself.", "success", "Report email"); onChanged(); }
    catch (e) { toast((e as Error).message, "error", "Couldn't save"); }
    setBusy(false);
  };
  const send = async (to: "me" | "saved") => {
    if (to === "saved") {
      if (dirty) return toast("Save your changes first, then send.", "info");
      if (!(await confirm({ title: `Send the ${monthName(month)} report to ${info.recipient_count} ${info.recipient_count === 1 ? "person" : "people"} now?`, body: "It goes to everyone chosen above, at once. The automatic one for this month is then skipped if this was last month's report.", confirmLabel: "Send now" }))) return;
    }
    setBusy(true);
    try {
      const r = await api<{ sent: number; failed: { email: string }[] }>("/admin/report-email/send", { method: "POST", json: { month, to } });
      toast(r.failed.length ? `Sent to ${r.sent}; ${r.failed.length} failed (${r.failed.map((f) => f.email).join(", ")}).` : to === "me" ? "Sent to you. Check your inbox, and the junk folder." : `Sent to ${r.sent} ${r.sent === 1 ? "person" : "people"}.`, r.failed.length ? "error" : "success", to === "me" ? "Test sent" : "Report sent");
      onChanged();
    } catch (e) { toast((e as Error).message, "error", "Not sent"); }
    setBusy(false);
  };

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className={`${card} min-w-0 space-y-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-bold text-fg">Monthly report by email</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${info.enabled ? "bg-brand-green text-ink" : "bg-fg/10 text-fg"}`}>{info.enabled ? "On" : "Off"}</span>
        </div>
        <p className={muted}>Once a month the numbers for the month that just ended (tickets, how fast, how many met their target, the busiest categories) are emailed to the people you choose. It holds totals only: no ticket titles and no names, so it is safe to send to someone outside IT.</p>

        <div className="space-y-3">
          <label className="flex cursor-pointer items-center gap-3 text-sm text-fg">
            <input type="checkbox" className="h-4 w-4 accent-[#00a859]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <b>Send the report by email automatically</b>
          </label>
          <div className={`space-y-3 rounded-xl border border-fg/10 p-4 ${enabled ? "" : "opacity-60"}`}>
            <div>
              <p className="mb-2 text-sm font-semibold text-fg">{repeat ? "First send" : "Send on"} <span className="text-xs font-normal text-neutral-600 dark:text-neutral-400">Ghana time (it is {info.now_local.slice(11)} there now)</span></p>
              <DateTimePicker value={sendAt} min={info.now_local} onChange={setSendAt} label="When to send the report" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-neutral-600 dark:text-neutral-400">Quick pick:</span>
              {quick.map(([l, v]) => <button key={l} type="button" onClick={() => setSendAt(v)} className="rounded-full border border-fg/20 px-2.5 py-0.5 text-xs font-semibold text-fg hover:bg-fg/10">{l}</button>)}
            </div>
            <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
              <span><b>Repeat every month</b> on the same day and at the same time{repeat && dayN > 28 ? <span className="block text-xs text-neutral-600 dark:text-neutral-400">Months without a {ordinal(dayN)} use their last day.</span> : null}</span>
            </label>
            <p id="rp-when" className={muted} aria-live="polite">
              {pastPick ? <b className="text-red-700">That moment has already passed. Pick one in the future.</b>
                : picked ? <>Goes out <b className="text-fg">{new Date(picked + ":00Z").toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}</b>{repeat ? <>, then on the {ordinal(dayN)} of every month at {picked.slice(11)}</> : ", once"}. Each report covers the month before it is sent: this first one is <b className="text-fg">{covers}</b>.</>
                : "Pick a date and time."}
            </p>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-fg">Who gets it</legend>
          <label className="flex cursor-pointer items-center gap-3 text-sm text-fg">
            <input type="checkbox" className="h-4 w-4 accent-[#00a859]" checked={admins} onChange={(e) => setAdmins(e.target.checked)} />
            <span><b>All administrators</b> <span className="text-neutral-600 dark:text-neutral-400">({info.staff.filter((s) => s.role === "admin").length}, including anyone added later)</span></span>
          </label>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {info.staff.map((s) => {
              const viaAdmins = admins && s.role === "admin";
              return (
                <li key={s.id}>
                  <label className={`flex cursor-pointer items-center gap-2.5 rounded-lg border border-fg/10 px-3 py-2 text-sm ${viaAdmins ? "opacity-70" : "hover:bg-fg/5"}`}>
                    <input type="checkbox" className="h-4 w-4 accent-[#00a859]" checked={viaAdmins || ids.includes(s.id)} disabled={viaAdmins} onChange={() => toggleId(s.id)} />
                    <span className="min-w-0"><b className="block truncate text-fg">{s.name}</b><span className="block truncate text-xs text-neutral-600 dark:text-neutral-400">{s.email} · {s.role}</span></span>
                  </label>
                </li>
              );
            })}
          </ul>
          <label className="block pt-1">
            <span className="text-sm font-semibold text-fg">Other email addresses <span className="text-xs font-normal text-neutral-500">(a manager, a director… one per line, or separated by commas)</span></span>
            <textarea className={`${field} mt-1 text-fg`} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="manager@yourcompany.com" aria-invalid={bad.length > 0} />
            {bad.length > 0 && <span role="alert" className="mt-0.5 block text-xs font-semibold text-red-700">Not an email address: {bad.slice(0, 3).join(", ")}{bad.length > 3 ? "…" : ""}</span>}
          </label>
          <p className="text-sm text-fg"><b>{chosen.size}</b> {chosen.size === 1 ? "person gets" : "people get"} it.</p>
        </fieldset>

        {mailWarn && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{mailWarn}</p>}
        {!info.app_url_set && <p className={muted}>Tip: set the helpdesk address under System &gt; Address so the email's button and “verify” link work.</p>}

        <div className="flex flex-wrap items-center gap-3 border-t border-fg/10 pt-4">
          <button type="button" className={btn} disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Working…" : "Save"}</button>
          {dirty && <button type="button" className={secondaryBtn} disabled={busy} onClick={() => { setEnabled(info.enabled); setSendAt(info.send_at); setRepeat(info.repeat); setAdmins(info.admins); setIds(info.staff_ids); setText(info.custom.join("\n")); }}>Discard changes</button>}
        </div>

        <div className="space-y-1 rounded-xl border border-fg/10 p-3 text-sm text-fg">
          <p>{info.enabled && info.next_at ? <>{info.next_at * 1000 < Date.now() ? "Was due" : "Next automatic send"}: <b>{when(info.next_at)}</b>, the report for {monthName(info.covers)}.{info.next_at * 1000 < Date.now() ? <span className="font-semibold text-red-700"> It is waiting: check that email is set up and working.</span> : null}</> : "Nothing is sent automatically right now."}</p>
          <p className={muted}>{info.last ? <>Last sent: <b className="text-fg">{monthName(info.last.month)}</b> report, {when(info.last.at)} to {info.last.sent} {info.last.sent === 1 ? "person" : "people"} ({info.last.by}){info.last.failed ? <span className="font-semibold text-red-700"> · {info.last.failed} failed: {info.last.error}</span> : null}.</> : "Nothing has been sent yet."}</p>
        </div>
      </section>

      <section className={`${card} min-w-0`} aria-label="Preview">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Preview with real numbers</p>
          <select aria-label="Month" className={`${field} ml-auto !w-auto text-fg`} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        </div>
        {prev?.error ? <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{prev.error}</p> : (
          <>
            <p className="mt-2 truncate text-sm text-fg"><span className="text-neutral-500">Subject: </span><b>{prev?.subject ?? "…"}</b></p>
            <iframe title="Report email preview" sandbox="" srcDoc={prev?.html ?? ""} className="mt-2 h-[44rem] w-full rounded-lg border border-stone-200 bg-[#efefea]" />
          </>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={secondaryBtn} disabled={busy || info.transport === "off"} onClick={() => void send("me")} title="Sends this report to your own address only">Send me a test</button>
          <button type="button" className={secondaryBtn} disabled={busy || info.transport === "off" || !info.recipient_count} onClick={() => void send("saved")} title="Sends it now to everyone chosen (saved)">Send to everyone now</button>
          <span className={muted}>Wording and look: System &gt; Email templates &gt; Monthly report.</span>
        </div>
      </section>
    </div>
  );
}
