import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import { type Check, type DeviceData, DeviceView, deviceTitle, healthChecks, kindOf } from "./DeviceCard";
import { useLive } from "./live";
import { field } from "./ui";

/* Admin > Computers: the asset register. Every machine that has reported to the helpdesk, one row per physical computer (rows with the
   same serial number are the same machine seen from several accounts or browsers), who uses it, and what needs attention. */

interface AssetDevice extends DeviceData { user_id: number; owner: string; owner_email: string; tickets: number; open_tickets: number }
interface Asset { key: string; d: AssetDevice; people: { name: string; email: string }[]; tickets: number; open: number; checks: Check[]; level: "bad" | "warn" | "ok" | "info" }
type Filter = "all" | "attention" | "noreport" | "win10";

const JUNK_SERIAL = /^(0+|none|n\/a|default string|to be filled by o\.?e\.?m\.?|system serial number|not specified|unknown)$/i;
const serialOf = (d: DeviceData) => { const s = String(d.hardware?.serial ?? "").trim(); return s && !JUNK_SERIAL.test(s) ? s : ""; };
const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
const ago = (ts: number) => { const d = Math.floor((Date.now() / 1000 - ts) / 86400); return d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 60 ? `${d} days ago` : when(ts); };
const osOf = (d: DeviceData) => (d.hardware?.os ? String(d.hardware.os).replace(/^Microsoft /, "") : [d.browser?.os, d.browser?.osVersion].filter(Boolean).join(" "));
const freeOf = (d: DeviceData) => { const v = (d.hardware?.volumes ?? []).find((x: any) => /^c:?$/i.test(x.drive ?? "")) ?? d.hardware?.volumes?.[0]; return v?.gb ? { free: v.freeGb ?? 0, gb: v.gb, pct: Math.round(((v.freeGb ?? 0) / v.gb) * 100) } : null; };
const isWin10 = (a: Asset) => a.checks.some((c) => /Windows 10/.test(c.title));

function group(rows: AssetDevice[]): Asset[] {
  const map = new Map<string, AssetDevice[]>();
  for (const r of rows) {
    const key = serialOf(r) ? `s:${serialOf(r)}` : `d:${r.id}`;
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  return [...map.entries()].map(([key, list]) => {
    // The freshest full report describes the machine; the row lists everyone seen on it.
    const d = [...list].sort((a, b) => (b.hardware_at ?? 0) - (a.hardware_at ?? 0) || b.last_seen - a.last_seen)[0]!;
    const shown = { ...d, last_seen: Math.max(...list.map((x) => x.last_seen)) };
    const people = [...new Map(list.map((x) => [x.owner_email, { name: x.owner, email: x.owner_email }])).values()];
    const checks = healthChecks(shown);
    const level = checks.some((c) => c.level === "bad") ? "bad" : checks.some((c) => c.level === "warn") ? "warn" : checks.some((c) => c.level === "ok") ? "ok" : "info";
    return { key, d: shown, people, tickets: list.reduce((n, x) => n + x.tickets, 0), open: list.reduce((n, x) => n + x.open_tickets, 0), checks, level };
  });
}

const CHIP = { bad: "bg-red-50 text-red-800 ring-red-300", warn: "bg-amber-50 text-amber-900 ring-amber-400", ok: "bg-green-50 text-green-800 ring-green-300", info: "bg-stone-100 text-neutral-600 ring-stone-300" } as const;
const csvCell = (v: unknown) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };

export function Assets({ onExpired }: { onExpired: () => void }) {
  const [rows, setRows] = useState<AssetDevice[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(() => api<AssetDevice[]>("/admin/assets").then((r) => { setRows(r); setErr(""); }, (e) => ((e as ApiError).status === 401 ? onExpired() : setErr((e as Error).message))), [onExpired]);
  useEffect(() => void load(), [load]);
  useLive("/staff/stream", () => void load()); // a hardware report arriving shows up by itself

  const all = useMemo(() => group(rows ?? []), [rows]);
  const computers = all.filter((a) => kindOf(a.d) !== "Phone");
  const counts = {
    all: all.length,
    attention: all.filter((a) => a.level === "bad" || a.level === "warn").length,
    noreport: computers.filter((a) => !a.d.hardware).length,
    win10: all.filter(isWin10).length,
  };
  const needle = q.trim().toLowerCase();
  const shown = all
    .filter((a) => (filter === "attention" ? a.level === "bad" || a.level === "warn" : filter === "noreport" ? !a.d.hardware && kindOf(a.d) !== "Phone" : filter === "win10" ? isWin10(a) : true))
    .filter((a) => !needle || [deviceTitle(a.d), a.d.hardware?.name, serialOf(a.d), osOf(a.d), ...a.people.flatMap((p) => [p.name, p.email])].some((v) => String(v ?? "").toLowerCase().includes(needle)))
    .sort((a, b) => ({ bad: 0, warn: 1, info: 2, ok: 3 })[a.level] - ({ bad: 0, warn: 1, info: 2, ok: 3 })[b.level] || b.d.last_seen - a.d.last_seen);

  const download = () => {
    const head = ["Computer name", "Make and model", "Serial number", "Type", "Used by", "Email", "System", "Processor", "Memory (GB)", "Free disk (GB)", "Disk size (GB)", "Last seen", "Hardware report", "Needs attention", "Tickets"];
    const lines = shown.map((a) => {
      const h = a.d.hardware, f = freeOf(a.d);
      return [h?.name, deviceTitle(a.d), serialOf(a.d), kindOf(a.d), a.people.map((p) => p.name).join("; "), a.people.map((p) => p.email).join("; "), osOf(a.d), h?.cpu?.name, h?.ramGb, f?.free, f?.gb, when(a.d.last_seen), when(a.d.hardware_at),
        a.checks.filter((c) => c.level === "bad" || c.level === "warn").map((c) => c.title).join("; "), a.tickets].map(csvCell).join(",");
    });
    const url = URL.createObjectURL(new Blob(["﻿" + [head.map(csvCell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const el = document.createElement("a");
    el.href = url;
    el.download = `fortress-computers-${new Date().toISOString().slice(0, 10)}.csv`;
    el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const FILTERS: [Filter, string][] = [["all", "All"], ["attention", "Needs attention"], ["win10", "Windows 10"], ["noreport", "No full report"]];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-extrabold">Computers</h2>
          <p className="text-sm text-neutral-500">Every machine that has reported to the helpdesk. The full details come from the hardware report people send during setup; without it only the browser's basics are known.</p>
        </div>
        <button className="rounded-lg border border-stone-300 px-3.5 py-2 text-sm font-semibold hover:bg-stone-100 disabled:opacity-40" disabled={!shown.length} onClick={download}>Download CSV</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className={field + " !w-full sm:!w-72"} type="search" placeholder="Search name, model, serial, person…" aria-label="Search computers" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Show">
          {FILTERS.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors ${filter === id ? "bg-ink text-white ring-ink dark:bg-brand-green dark:text-ink dark:ring-brand-green" : "text-neutral-600 ring-stone-300 hover:bg-stone-100"}`}>
              {label} <span className="ml-1 opacity-85">{counts[id]}</span>
            </button>
          ))}
        </div>
      </div>

      {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}
      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-surface shadow-sm">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              <th className="p-3">Computer</th><th>Used by</th><th>System</th><th>Memory</th><th>Free disk</th><th>Last seen</th><th>Health</th><th className="pr-3 text-right">Tickets</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const h = a.d.hardware, f = freeOf(a.d), on = openKey === a.key;
              const issues = a.checks.filter((c) => c.level === "bad" || c.level === "warn");
              return (
                <Fragment key={a.key}>
                  <tr className={`cursor-pointer border-t border-stone-200 hover:bg-stone-50 ${on ? "bg-stone-50" : ""}`} onClick={() => setOpenKey(on ? null : a.key)}>
                    <td className="p-3">
                      <button className="text-left focus:outline-none focus-visible:underline" aria-expanded={on}>
                        <b className="block max-w-[18rem] truncate">{deviceTitle(a.d)}</b>
                        <span className="text-xs text-neutral-500">{[kindOf(a.d), h?.name, serialOf(a.d) && `S/N ${serialOf(a.d)}`].filter(Boolean).join(" · ")}</span>
                      </button>
                    </td>
                    <td><span className="block max-w-[14rem] truncate" title={a.people.map((p) => `${p.name} (${p.email})`).join("\n")}>{a.people[0]?.name}{a.people.length > 1 ? ` +${a.people.length - 1}` : ""}</span></td>
                    <td className="text-neutral-600"><span className="block max-w-[11rem] truncate">{osOf(a.d) || "—"}</span></td>
                    <td className="text-neutral-600">{h?.ramGb ? `${Math.round(h.ramGb)} GB` : "—"}</td>
                    <td className="text-neutral-600">{f ? `${Math.round(f.free)} GB (${f.pct}%)` : "—"}</td>
                    <td className="text-neutral-600">{ago(a.d.last_seen)}</td>
                    <td>
                      <span className={`inline-block max-w-[13rem] truncate rounded-full px-2.5 py-0.5 align-middle text-xs font-semibold ring-1 ring-inset ${CHIP[a.level]}`} title={issues.map((c) => c.title).join("\n")}>
                        {issues.length ? `${issues[0]!.title}${issues.length > 1 ? ` +${issues.length - 1}` : ""}` : h ? "Looks fine" : "Basics only"}
                      </span>
                    </td>
                    <td className="pr-3 text-right">{a.tickets}{a.open ? <span className="ml-1 text-xs text-neutral-500">({a.open} open)</span> : null}</td>
                  </tr>
                  {on && (
                    <tr className="border-t border-stone-200 bg-stone-50">
                      <td colSpan={8} className="p-4">
                        {a.people.length > 1 && <p className="mb-3 text-sm text-neutral-600">Used by {a.people.map((p) => p.name).join(", ")}.</p>}
                        <DeviceView d={a.d} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {rows && !shown.length && <tr><td className="p-8 text-center text-neutral-500" colSpan={8}>{all.length ? "Nothing matches." : "No computer has reported yet. They appear here as people sign in."}</td></tr>}
            {!rows && !err && <tr><td className="p-8 text-center text-neutral-500" colSpan={8}>Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
