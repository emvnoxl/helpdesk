import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* One computer, as a picture, a health check and a few numbers. Used in Admin > People (DevicePanel) and, for staff, inside a ticket
   (DeviceSummary + DeviceDrawer). Everything shown comes from two sources: what the browser reports about itself, and the optional
   full hardware report. Layout adapts to the width it is given (container queries), so the same view works full width and in a drawer. */

export interface DeviceData {
  id: number; first_seen: number; last_seen: number; ip: string | null; hardware_at: number | null;
  browser: any | null; hardware: any | null;
}

const MIN = 60, HOUR = 3600, DAY = 86400;
const nowS = () => Date.now() / 1000;
const since = (ts: number) => {
  const s = Math.max(0, nowS() - ts);
  return s < MIN ? "just now" : s < HOUR ? `${Math.floor(s / MIN)} min ago` : s < DAY ? `${Math.floor(s / HOUR)} h ago` : s < 30 * DAY ? `${Math.floor(s / DAY)} days ago` : new Date(ts * 1000).toLocaleDateString("en-GB", { dateStyle: "medium" });
};
const tidy = (s: string) => s.replace(/\((R|TM)\)/gi, "").replace(/\s+CPU\b/i, "").replace(/\s{2,}/g, " ").replace(/@.*$/, "").trim();
const gb = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);

export function kindOf(d: Pick<DeviceData, "browser" | "hardware">): "Laptop" | "Desktop" | "Phone" | "Computer" {
  const c = d.hardware?.chassis;
  if (c === "Laptop" || c === "Desktop") return c;
  if (d.browser?.mobile) return "Phone";
  return "Computer";
}

export function deviceTitle(d: Pick<DeviceData, "browser" | "hardware">): string {
  const h = d.hardware;
  if (h?.model) {
    const make = h.manufacturer && !h.model.toLowerCase().startsWith(String(h.manufacturer).toLowerCase().split(" ")[0]) ? `${String(h.manufacturer).replace(/ (Inc\.?|Corporation|Co\.?,? Ltd\.?)$/i, "")} ` : "";
    return `${make}${h.model}`.trim();
  }
  const b = d.browser;
  if (b) return [b.os && `${b.os}${b.osVersion ? ` ${b.osVersion}` : ""}`, b.model].filter(Boolean).join(" · ") || "Unknown computer";
  return "Unknown computer";
}

const osName = (d: Pick<DeviceData, "browser" | "hardware">) =>
  d.hardware?.os ? String(d.hardware.os).replace(/^Microsoft /, "") : d.browser ? [d.browser.os, d.browser.osVersion].filter(Boolean).join(" ") : "";

/* ---------- health checks ---------- */

export type Level = "bad" | "warn" | "ok" | "info";
export interface Check { level: Level; title: string; detail: string }

/** Plain-language findings IT would otherwise have to work out from the numbers. */
export function healthChecks(d: DeviceData): Check[] {
  const h = d.hardware, b = d.browser, out: Check[] = [];
  if (h?.volumes?.length) {
    const worst = [...h.volumes].filter((v: any) => v.gb && v.freeGb !== undefined).sort((a: any, c: any) => a.freeGb / a.gb - c.freeGb / c.gb)[0];
    if (worst) {
      const pct = (worst.freeGb / worst.gb) * 100;
      if (pct < 15) out.push({ level: "bad", title: "Disk nearly full", detail: `${worst.drive} has ${gb(worst.freeGb)} GB free of ${gb(worst.gb)} GB (${Math.round(pct)}%). Slowdowns and failed updates are likely.` });
      else if (pct < 25) out.push({ level: "warn", title: "Disk getting full", detail: `${worst.drive} has ${gb(worst.freeGb)} GB free (${Math.round(pct)}%).` });
      else out.push({ level: "ok", title: "Disk space is fine", detail: `${worst.drive} has ${gb(worst.freeGb)} GB free.` });
    }
  }
  if (h?.ramGb !== undefined) {
    if (h.ramGb < 7.5) out.push({ level: "bad", title: "Very little memory", detail: `${gb(h.ramGb)} GB is below what Windows 11 and Microsoft 365 need to run comfortably.` });
    else if (h.ramGb < 15) out.push({ level: "warn", title: "Modest memory", detail: `${gb(h.ramGb)} GB is fine for office work but tight with many apps open.` });
    else out.push({ level: "ok", title: "Plenty of memory", detail: `${gb(h.ramGb)} GB.` });
  }
  if (h?.lastBoot) {
    const t = Date.parse(String(h.lastBoot).replace(" ", "T"));
    if (Number.isFinite(t)) {
      const days = Math.floor((Date.now() - t) / 86400000);
      if (days >= 30) out.push({ level: "bad", title: "Not restarted for a month", detail: `Last restart ${days} days ago. Pending updates and slowdowns are likely. Ask them to restart.` });
      else if (days >= 14) out.push({ level: "warn", title: "Not restarted lately", detail: `Last restart ${days} days ago.` });
      else out.push({ level: "ok", title: "Restarted recently", detail: days <= 0 ? "Today." : `${days} day${days === 1 ? "" : "s"} ago.` });
    }
  }
  const win = `${h?.os ?? ""} ${b?.os ?? ""} ${b?.osVersion ?? ""}`;
  if (/windows 10|windows.* 10\b/i.test(win) && !/windows 11/i.test(win)) out.push({ level: "bad", title: "Windows 10 is out of support", detail: "Microsoft stopped security updates for Windows 10 in October 2025. Plan the move to Windows 11." });
  if (h?.disks?.some((x: any) => /^hdd$/i.test(x.type ?? ""))) out.push({ level: "warn", title: "Mechanical hard drive", detail: "Much slower than an SSD. An SSD upgrade is the cheapest big speed-up." });
  if (h && d.hardware_at && nowS() - d.hardware_at > 90 * DAY) out.push({ level: "info", title: "Hardware report is old", detail: `Last sent ${since(d.hardware_at)}. Ask for a fresh one if something changed.` });
  if (!h) out.push({ level: "info", title: "Browser details only", detail: "Make, model, serial number, disks and exact memory need the hardware report." });
  return out;
}

const worst = (cs: Check[]): Level => (cs.some((c) => c.level === "bad") ? "bad" : cs.some((c) => c.level === "warn") ? "warn" : cs.some((c) => c.level === "ok") ? "ok" : "info");
const LEVEL = {
  bad: { chip: "bg-[#d03b3b] text-white", dot: "bg-[#d03b3b]", icon: "M12 9v4M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" },
  warn: { chip: "bg-brand-amber text-ink", dot: "bg-brand-amber", icon: "M12 8v5M12 16.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  ok: { chip: "border border-stone-300 text-neutral-700", dot: "bg-brand-green", icon: "M5 13l4 4L19 7" },
  info: { chip: "border border-stone-300 text-neutral-600", dot: "bg-stone-400", icon: "M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
} as const;

const Ico = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const I = {
  cpu: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 7h10v10H7zM10 10h4v4h-4z",
  ram: "M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 8v8M6 16v3M18 16v3",
  disk: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5",
  gpu: "M3 7h15v10H3zM18 9h3v6h-3zM7 11a2 2 0 1 0 4 0 2 2 0 0 0-4 0M6 20h7",
  net: "M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01",
  win: "M3 5l8-1v8H3zM13 3.8L21 3v9h-8zM3 13h8v8l-8-1zM13 13h8v8l-8-1z",
  id: "M4 5h16v14H4zM8 10a2 2 0 1 0 4 0 2 2 0 0 0-4 0M7 16c.6-1.5 2-2 3-2s2.4.5 3 2M15 9h3M15 13h3",
  keyboard: "M3 7h18v10H3zM6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10",
  mouse: "M7 4h10a2 2 0 0 1 2 2v8a7 7 0 0 1-14 0V6a2 2 0 0 1 2-2zM12 4v6M5 10h14",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 13l4 4L19 7",
  close: "M6 6l12 12M18 6 6 18",
  screen: "M3 4h18v12H3zM8 20h8M12 16v4",
};

/* ---------- pieces ---------- */

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className="ml-1 inline-grid h-6 w-6 place-items-center rounded-md align-middle text-neutral-400 hover:bg-stone-200 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400); } catch { /* clipboard blocked */ } }}
    >
      <Ico d={done ? I.check : I.copy} size={13} />
    </button>
  );
}

/** The device on a dark stage, with the screen resolution and an OS logo on it. */
function Picture({ kind, os, screenText }: { kind: string; os?: string; screenText?: string }) {
  const win = /windows/i.test(os ?? "");
  const logo = win ? (
    <g transform="translate(-9 -9)"><rect width="8" height="8" fill="#ffb400" /><rect x="10" width="8" height="8" fill="#00a859" /><rect y="10" width="8" height="8" fill="#3b82c4" /><rect x="10" y="10" width="8" height="8" fill="#ee3239" /></g>
  ) : <circle r="8" fill="#00a859" />;
  const body = "#3a3a38", edge = "#5a5a57", screen = "#111";
  const cls = "h-28 w-auto drop-shadow-[0_8px_18px_rgba(0,0,0,0.45)]";
  if (kind === "Phone")
    return (
      <svg viewBox="0 0 120 130" className={cls} role="img" aria-label="Phone">
        <rect x="38" y="6" width="44" height="118" rx="9" fill={body} stroke={edge} /><rect x="42" y="13" width="36" height="102" rx="4" fill={screen} />
        <g transform="translate(60 56)">{logo}</g><text x="60" y="92" textAnchor="middle" fontSize="6" fill="#aaa">{screenText}</text>
      </svg>
    );
  if (kind === "Desktop")
    return (
      <svg viewBox="0 0 170 130" className={cls} role="img" aria-label="Desktop computer">
        <rect x="14" y="8" width="104" height="72" rx="6" fill={body} stroke={edge} /><rect x="19" y="13" width="94" height="58" rx="3" fill={screen} />
        <rect x="58" y="80" width="16" height="16" fill={edge} /><rect x="42" y="96" width="48" height="6" rx="3" fill={edge} />
        <rect x="128" y="22" width="28" height="80" rx="4" fill={body} stroke={edge} /><circle cx="142" cy="36" r="4" fill="#00a859" /><rect x="134" y="50" width="16" height="3" rx="1.5" fill={edge} /><rect x="134" y="58" width="16" height="3" rx="1.5" fill={edge} />
        <g transform="translate(66 36)">{logo}</g><text x="66" y="62" textAnchor="middle" fontSize="7" fill="#aaa">{screenText}</text>
      </svg>
    );
  return (
    <svg viewBox="0 0 170 130" className={cls} role="img" aria-label={kind === "Laptop" ? "Laptop" : "Computer"}>
      <rect x="30" y="12" width="110" height="74" rx="6" fill={body} stroke={edge} /><rect x="35" y="17" width="100" height="64" rx="3" fill={screen} />
      <path d="M12 92h146l-8 14a6 6 0 0 1-5 3H25a6 6 0 0 1-5-3z" fill={edge} /><rect x="68" y="92" width="34" height="4" rx="2" fill={body} />
      <g transform="translate(85 42)">{logo}</g><text x="85" y="68" textAnchor="middle" fontSize="7" fill="#aaa">{screenText}</text>
    </svg>
  );
}

function Tile({ icon, label, children, className = "" }: { icon: string; label: string; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-stone-200 bg-surface p-4 ${className}`}>
      <h4 className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-neutral-500"><Ico d={icon} size={14} />{label}</h4>
      {children}
    </section>
  );
}

/** A ring showing how full a drive is. */
function Donut({ used, level }: { used: number; level: Level }) {
  const r = 26, c = 2 * Math.PI * r;
  const color = level === "bad" ? "#ee3239" : level === "warn" ? "#ffb400" : "#00a859";
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" role="img" aria-label={`${Math.round(used)}% used`} className="shrink-0">
      <circle cx="34" cy="34" r={r} fill="none" stroke="var(--color-stone-200)" strokeWidth="8" />
      <circle cx="34" cy="34" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${(Math.min(100, used) / 100) * c} ${c}`} transform="rotate(-90 34 34)" />
      <text x="34" y="38" textAnchor="middle" fontSize="13" fontWeight="800" fill="currentColor">{Math.round(used)}%</text>
    </svg>
  );
}

/** One square per logical processor; the brighter ones are physical cores, the paler ones are hyper-threads. */
function Cores({ cores, threads }: { cores?: number; threads: number }) {
  const shown = Math.min(threads, 64);
  const phys = cores && cores < threads ? cores : threads;
  return (
    <div className="mt-3 flex flex-wrap gap-1" role="img" aria-label={`${threads} logical processors`}>
      {Array.from({ length: shown }, (_, i) => (
        <i key={i} className="h-3 w-3 rounded-[3px]" style={{ background: i < phys ? "#00a859" : "color-mix(in srgb, #00a859 30%, var(--color-stone-200))" }} />
      ))}
    </div>
  );
}

/** RAM sticks drawn in proportion to their size, or a plain bar when only the browser's rounded figure is known. */
function Ram({ total, modules, approx }: { total: number; modules?: { gb: number; mhz?: number }[]; approx?: boolean }) {
  if (modules && modules.length)
    return (
      <div className="mt-3 flex gap-1.5" role="img" aria-label={`${modules.length} memory modules`}>
        {modules.map((m, i) => (
          <div key={i} className="flex h-11 flex-col items-center justify-center rounded-lg text-ink" style={{ flex: Math.max(m.gb, 1), background: "linear-gradient(180deg,#ffc933,#e6a200)" }} title={`${m.gb} GB${m.mhz ? ` at ${m.mhz} MHz` : ""}`}>
            <b className="text-xs leading-none">{m.gb} GB</b>{m.mhz ? <span className="mt-0.5 text-[9px] leading-none opacity-70">{m.mhz} MHz</span> : null}
          </div>
        ))}
      </div>
    );
  return (
    <div className="mt-3 h-3 rounded-full" style={{ background: "var(--color-stone-200)" }} role="img" aria-label={`${total} GB${approx ? " (approximate)" : ""}`}>
      <div className="h-3 rounded-full" style={{ width: `${Math.min(100, (total / 32) * 100)}%`, background: "#ffb400" }} />
    </div>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 py-1 text-sm"><dt className="shrink-0 text-neutral-500">{k}</dt><dd className="min-w-0 text-right font-medium">{children}</dd></div>
);

/* ---------- mice ---------- */

/** USB vendor ids of the usual mouse makers (best effort; the id itself is always shown, so an unknown maker is still identifiable). */
const USB_VENDORS: Record<string, string> = { "046D": "Logitech", "045E": "Microsoft", "413C": "Dell", "03F0": "HP", "17EF": "Lenovo", "1532": "Razer", "0B05": "ASUS", "04F2": "Chicony", "093A": "Pixart", "04CA": "Lite-On", "0461": "Primax", "1BCF": "Sunplus", "192F": "Avago", "046A": "Cherry", "05AC": "Apple", "1A81": "Holtek", "0414": "Giga-Byte", "258A": "SINO WEALTH", "30FA": "Instant Microelectronics" };
export const mouseMaker = (m: { vid?: string }) => (m.vid ? USB_VENDORS[m.vid] ?? "" : "");
export const mouseLabel = (m: { name?: string; vid?: string; connection?: string }) => [m.name, mouseMaker(m) && !new RegExp(mouseMaker(m), "i").test(m.name ?? "") ? `(${mouseMaker(m)})` : "", m.connection && m.connection !== "Other" ? `- ${m.connection}` : ""].filter(Boolean).join(" ");

/** The three-letter code a monitor reports about its maker (its EDID). Best effort; an unknown code is shown as it is. */
const PNP_MAKERS: Record<string, string> = { DEL: "Dell", HPN: "HP", HWP: "HP", SAM: "Samsung", SDC: "Samsung", GSM: "LG", LGD: "LG", AOC: "AOC", ACR: "Acer", AUS: "ASUS", ACI: "ASUS", BNQ: "BenQ", LEN: "Lenovo", PHL: "Philips", VSC: "ViewSonic", SNY: "Sony", NEC: "NEC", MSI: "MSI", IVM: "Iiyama", EIZ: "Eizo", BOE: "BOE", AUO: "AU Optronics", CMN: "Innolux", SHP: "Sharp", IVO: "InfoVision", TSB: "Toshiba", APP: "Apple", GBT: "Gigabyte", CPQ: "Compaq", FUS: "Fujitsu", MEI: "Panasonic", HKC: "HKC", KOA: "Koala", TCL: "TCL" };
export const monitorMaker = (m: { maker?: string }) => (m.maker ? PNP_MAKERS[m.maker] ?? m.maker : "");
/** A laptop's own panel reports no friendly name, and is small. */
export const isBuiltInScreen = (m: { name?: string; inches?: number; connection?: string }) => m.connection === "Built-in" || (!m.name && (m.inches ?? 99) <= 18);
export const monitorTitle = (m: { name?: string; maker?: string; code?: string; inches?: number; connection?: string }) => m.name || (isBuiltInScreen(m) ? "Built-in screen" : [monitorMaker(m), m.code].filter(Boolean).join(" ") || "Monitor");
export const monitorLabel = (m: any) => [monitorTitle(m), m.inches ? `${m.inches}"` : "", m.year ? `${m.year}${m.week ? "-W" + m.week : ""}` : "", m.serial ? `S/N ${m.serial}` : ""].filter(Boolean).join(" ");
export const deviceLabel = (m: any) => mouseLabel(m);

/* ---------- the view ---------- */

/** A mouse or keyboard list: name, how it connects, the maker and the USB id. */
function Periph({ list }: { list?: any[] }) {
  if (!list?.length) return <p className="text-sm text-neutral-500">None reported. Ask them to send the hardware details again to include it.</p>;
  return (
    <div className="space-y-2.5">
      {list.map((m: any, i: number) => (
        <div key={i} className="min-w-0 text-sm">
          <b className="block truncate text-base leading-snug" title={m.name}>{m.name}</b>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-600">
            {m.connection && <span className="rounded-full bg-fg/10 px-2 py-0.5 font-semibold">{m.connection === "Built-in" ? "Built-in" : m.connection}</span>}
            {mouseMaker(m) && <span>{mouseMaker(m)}</span>}
            {m.vid && <span className="font-mono text-neutral-500" title="USB vendor and product id">{m.vid}:{m.pid}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DeviceView({ d }: { d: DeviceData }) {
  const h = d.hardware, b = d.browser;
  const kind = kindOf(d);
  const os = osName(d);
  const scr = b?.screen;
  const screenText = scr ? `${Math.round(scr.w * (scr.dpr || 1))}×${Math.round(scr.h * (scr.dpr || 1))}` : undefined;
  const threads: number | undefined = h?.cpu?.threads ?? b?.cores;
  const ramTotal: number | undefined = h?.ramGb ?? b?.memory;
  const gpus: string[] = h?.gpus?.length ? h.gpus.map((g: any) => g.name).filter((n: string) => n && !/basic render|remote|virtual/i.test(n)) : b?.gpu ? [b.gpu] : [];
  const boot = h?.lastBoot ? Date.parse(String(h.lastBoot).replace(" ", "T")) / 1000 : null;
  const checks = healthChecks(d);
  const issues = checks.filter((c) => c.level === "bad" || c.level === "warn");
  const lvl = worst(checks);
  const verdict = lvl === "bad" ? { t: "Needs attention", cls: "bg-[#d03b3b] text-white" } : lvl === "warn" ? { t: `${issues.length} to look at`, cls: "bg-brand-amber text-ink" } : lvl === "ok" ? { t: "Looks healthy", cls: "bg-brand-green text-ink" } : { t: "Not enough to judge", cls: "bg-white/15 text-white" };

  return (
    <div className="@container space-y-4">
      {/* header */}
      <header className="relative overflow-hidden rounded-2xl bg-ink p-5 text-white ring-1 ring-white/10">
        <div className="pointer-events-none absolute -right-6 -top-6 hidden opacity-[0.12] @xl:block" aria-hidden>
          <div className="h-24 w-16 rounded-md border-[10px] border-[#00a859]" /><div className="-mt-16 ml-8 h-24 w-16 rounded-md border-[10px] border-[#ffb400]" /><div className="-mt-16 ml-16 h-24 w-16 rounded-md border-[10px] border-[#ee3239]" />
        </div>
        <div className="relative flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="grid shrink-0 place-items-center rounded-2xl bg-white/[0.06] px-5 py-3 ring-1 ring-white/10"><Picture kind={kind} os={os} screenText={screenText} /></div>
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide">{kind}</span>
              {os && <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-white/80">{os}</span>}
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${verdict.cls}`}>{verdict.t}</span>
            </div>
            <h3 className="mt-2 text-2xl font-extrabold leading-tight">{deviceTitle(d)}</h3>
            <p className="mt-0.5 text-sm text-white/65">{[h?.name, h?.user && `user ${h.user}`, b?.browser && `${b.browser}${b.browserVersion ? ` ${b.browserVersion}` : ""}`].filter(Boolean).join(" · ")}</p>
            <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/60">
              <div className="flex items-center gap-1.5"><Ico d={I.clock} size={13} />Seen <b className="font-semibold text-white/85">{since(d.last_seen)}</b></div>
              <div>First seen <b className="font-semibold text-white/85">{since(d.first_seen)}</b></div>
              {boot && <div>Restarted <b className="font-semibold text-white/85">{since(boot)}</b></div>}
              {d.ip && <div>Last address <b className="font-semibold text-white/85">{d.ip}</b></div>}
            </dl>
            <p className="mt-3">
              {h ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-green px-2.5 py-1 text-xs font-bold text-ink"><Ico d={I.check} size={13} /> Full hardware report · {since(d.hardware_at ?? d.last_seen)}</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-amber px-2.5 py-1 text-xs font-bold text-ink">Browser details only</span>
              )}
            </p>
          </div>
        </div>
      </header>

      {/* health */}
      <section aria-label="Health checks" className="rounded-2xl border border-stone-200 bg-surface p-4">
        <h4 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-neutral-500">Health check</h4>
        <ul className="grid gap-2 @2xl:grid-cols-2">
          {[...checks].sort((a, c) => ["bad", "warn", "info", "ok"].indexOf(a.level) - ["bad", "warn", "info", "ok"].indexOf(c.level)).map((c) => (
            <li key={c.title} className="flex items-start gap-3 rounded-xl border border-stone-200 p-3">
              <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${LEVEL[c.level].chip}`}><Ico d={LEVEL[c.level].icon} size={14} /></span>
              <div className="min-w-0 text-sm"><b className="block leading-snug">{c.title}</b><span className="text-neutral-600">{c.detail}</span></div>
            </li>
          ))}
        </ul>
        {!h && <p className="mt-3 text-xs text-neutral-500">Make, model, serial number, disks and exact memory aren't visible to a browser. Ask them to open <b>Your account</b> in the helpdesk and choose <b>Send hardware details to IT</b>, once per computer.</p>}
      </section>

      {/* the numbers */}
      <div className="grid gap-3 @2xl:grid-cols-2 @6xl:grid-cols-3">
        <Tile icon={I.cpu} label="Processor">
          <b className="block text-lg leading-tight">{h?.cpu?.name ? tidy(h.cpu.name) : threads ? `${threads} threads` : "Unknown"}</b>
          {threads ? <div className="mt-1 text-sm text-neutral-500">{h?.cpu?.cores ? `${h.cpu.cores} cores · ` : ""}{threads} threads{h?.cpu?.mhz ? ` · ${(h.cpu.mhz / 1000).toFixed(1)} GHz` : ""}{!h && b?.arch ? ` · ${b.arch}${b.bits ? ` ${b.bits}-bit` : ""}` : ""}</div> : null}
          {threads ? <Cores cores={h?.cpu?.cores} threads={threads} /> : null}
        </Tile>

        <Tile icon={I.ram} label="Memory">
          <b className="block text-lg leading-tight">{ramTotal ? (h ? `${gb(ramTotal)} GB` : `${ramTotal >= 8 ? "8+" : ramTotal} GB`) : "Unknown"}</b>
          <div className="mt-1 text-sm text-neutral-500">{!h && ramTotal ? "Browsers round this and stop at 8 GB" : h?.ramModules?.length ? `${h.ramModules.length} module${h.ramModules.length === 1 ? "" : "s"}` : ""}</div>
          {ramTotal ? <Ram total={ramTotal} modules={h?.ramModules} approx={!h} /> : null}
        </Tile>

        <Tile icon={I.disk} label="Storage" className="@2xl:col-span-2 @6xl:col-span-1">
          {h?.volumes?.length ? (
            <div className="space-y-3">
              {h.volumes.map((v: any) => {
                const used = v.gb ? Math.max(0, Math.min(100, ((v.gb - (v.freeGb ?? 0)) / v.gb) * 100)) : 0;
                const low = v.gb && v.freeGb !== undefined && v.freeGb / v.gb < 0.15;
                const med = v.gb && v.freeGb !== undefined && v.freeGb / v.gb < 0.25;
                return (
                  <div key={v.drive} className="flex items-center gap-3">
                    <Donut used={used} level={low ? "bad" : med ? "warn" : "ok"} />
                    <div className="min-w-0 text-sm">
                      <b className="block">{v.drive}</b>
                      <span className={low ? "font-semibold text-red-700" : "text-neutral-600"}>{v.freeGb !== undefined ? `${gb(v.freeGb)} GB free of ${gb(v.gb)} GB` : `${gb(v.gb)} GB`}</span>
                      {low && <span className="mt-0.5 block text-xs font-bold text-red-700">nearly full</span>}
                    </div>
                  </div>
                );
              })}
              {h.disks?.length ? <div className="text-xs text-neutral-500">{h.disks.map((x: any) => `${tidy(x.model ?? "Disk")}${x.type && x.type !== "Unspecified" ? ` (${x.type})` : ""}`).join(", ")}</div> : null}
            </div>
          ) : <p className="text-sm text-neutral-500">Not visible to a browser.</p>}
        </Tile>

        <Tile icon={I.screen} label="Screen">
          {scr ? (
            <div className="flex items-center gap-4">
              <div className="grid shrink-0 place-items-center rounded-md border-[3px] border-stone-400 bg-ink text-[10px] font-bold text-white/70" style={{ width: 84, height: Math.max(36, Math.min(60, (84 * scr.h) / scr.w)) }}>{scr.dpr ? `${Math.round(scr.dpr * 100)}%` : ""}</div>
              <div className="text-sm"><b className="block text-lg leading-tight">{screenText}</b><span className="text-neutral-500">{scr.depth}-bit colour</span></div>
            </div>
          ) : <p className="text-sm text-neutral-500">Unknown</p>}
        </Tile>

        <Tile icon={I.gpu} label="Graphics">
          {gpus.length ? gpus.map((g) => <b key={g} className="block truncate text-base leading-snug" title={g}>{tidy(g)}</b>) : <p className="text-sm text-neutral-500">Unknown</p>}
          {h?.gpus?.[0]?.driver && <div className="mt-1 text-xs text-neutral-500">Driver {h.gpus[0].driver}</div>}
        </Tile>

        {h && (
          <Tile icon={I.mouse} label="Mouse"><Periph list={h.mice} /></Tile>
        )}

        {h && (
          <Tile icon={I.keyboard} label="Keyboard"><Periph list={h.keyboards} /></Tile>
        )}

        {h && (
          <Tile icon={I.screen} label="Monitors" className="@2xl:col-span-2 @6xl:col-span-3">
            {h.monitors?.length ? (
              <div className="grid gap-3 @2xl:grid-cols-2 @6xl:grid-cols-3">
                {h.monitors.map((m: any, i: number) => (
                  <div key={i} className="flex min-w-0 items-center gap-3.5 rounded-xl border border-stone-200 p-3">
                    <div className="grid h-12 w-[4.5rem] shrink-0 place-items-center rounded-md border-[3px] border-stone-400 bg-ink text-[10px] font-bold text-white/80" aria-hidden>{m.inches ? `${m.inches}"` : ""}</div>
                    <div className="min-w-0 text-sm">
                      <b className="block truncate text-base leading-snug" title={monitorTitle(m)}>{monitorTitle(m)}</b>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-neutral-600">
                        {isBuiltInScreen(m) && <span className="rounded-full bg-fg/10 px-2 py-0.5 font-semibold">Built-in</span>}
                        {m.connection && m.connection !== "Built-in" && <span className="rounded-full bg-fg/10 px-2 py-0.5 font-semibold">{m.connection}</span>}
                        {monitorMaker(m) && !new RegExp(monitorMaker(m), "i").test(m.name ?? "") && <span>{monitorMaker(m)}</span>}
                        {m.year ? <span>made {m.year}{m.week ? ` · week ${m.week}` : ""}</span> : null}
                      </div>
                      {m.serial && <div className="mt-0.5 font-mono text-xs text-neutral-500">S/N <span className="select-all">{m.serial}</span><Copy text={m.serial} label="monitor serial number" /></div>}
                    </div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm text-neutral-500">None reported. Ask them to send the hardware details again to include it.</p>}
          </Tile>
        )}

        <Tile icon={I.net} label="Network">
          {h?.nics?.length ? (
            <div className="space-y-2.5">
              {h.nics.slice(0, 3).map((n: any, i: number) => (
                <div key={i} className="min-w-0 text-sm">
                  <b className="block truncate" title={n.name}>{n.name}</b>
                  {(n.ips ?? []).map((ip: string) => <div key={ip} className="font-mono text-xs text-neutral-600">{ip}<Copy text={ip} label="IP address" /></div>)}
                  {n.mac && <div className="font-mono text-xs text-neutral-500">{n.mac}<Copy text={n.mac} label="MAC address" /></div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm"><b className="font-mono">{d.ip ?? "Unknown"}</b>{d.ip && <Copy text={d.ip} label="IP address" />}{b?.conn?.type ? <div className="mt-1 text-xs text-neutral-500">{b.conn.type}{b.conn.down ? ` · about ${b.conn.down} Mbps` : ""}{b.conn.rtt ? ` · ${b.conn.rtt} ms` : ""}</div> : null}</div>
          )}
        </Tile>

        {h && (
          <Tile icon={I.win} label="Windows">
            <dl className="divide-y divide-stone-200">
              <Row k="Edition">{os}</Row>
              {h.osBuild && <Row k="Build">{h.osBuild}{h.osArch ? ` · ${h.osArch}` : ""}</Row>}
              {h.installDate && <Row k="Installed">{h.installDate}</Row>}
              {h.lastBoot && <Row k="Last restart">{String(h.lastBoot)}</Row>}
              {h.domain && <Row k="Domain">{h.domain}</Row>}
            </dl>
          </Tile>
        )}

        {h && (
          <Tile icon={I.id} label="Identity">
            <dl className="divide-y divide-stone-200">
              {h.manufacturer && <Row k="Maker">{h.manufacturer}</Row>}
              {h.model && <Row k="Model">{h.model}</Row>}
              {h.serial && <Row k="Serial"><span className="select-all font-mono">{h.serial}</span><Copy text={h.serial} label="serial number" /></Row>}
              {h.name && <Row k="Computer name"><span className="font-mono">{h.name}</span><Copy text={h.name} label="computer name" /></Row>}
              {h.user && <Row k="Windows user">{h.user}</Row>}
              {h.biosVersion && <Row k="BIOS">{h.biosVersion}</Row>}
            </dl>
          </Tile>
        )}

        <Tile icon={I.globe} label="Browser &amp; region">
          <dl className="divide-y divide-stone-200">
            <Row k="Browser">{b?.browser ? `${b.browser}${b.browserVersion ? ` ${b.browserVersion}` : ""}` : "Unknown"}</Row>
            {b?.lang && <Row k="Language">{b.lang}</Row>}
            {b?.tz && <Row k="Time zone">{b.tz}</Row>}
          </dl>
        </Tile>
      </div>
    </div>
  );
}

/* ---------- several computers: pick one ---------- */

const pcIcon = (k: string) => (k === "Phone" ? "M8 3h8v18H8zM11 18h2" : k === "Desktop" ? "M3 4h14v10H3zM8 18h4M10 14v4M19 7h2v10h-2z" : "M5 5h14v10H5zM2 19h20");

/** People > a person's computers: a row of computers to choose from, and the full view of the one you picked. */
export function DevicePanel({ devices }: { devices: DeviceData[] }) {
  const [sel, setSel] = useState(0);
  const d = devices[Math.min(sel, devices.length - 1)]!;
  return (
    <div className="space-y-3">
      {devices.length > 1 && (
        <div role="tablist" aria-label="Computers" className="flex flex-wrap gap-2">
          {devices.map((x, i) => {
            const cs = healthChecks(x), l = worst(cs), on = i === sel;
            return (
              <button key={x.id} role="tab" aria-selected={on} onClick={() => setSel(i)}
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${on ? "border-brand-green bg-brand-green/10" : "border-stone-200 bg-surface hover:bg-stone-100"}`}>
                <span className="relative text-neutral-600"><Ico d={pcIcon(kindOf(x))} size={18} /><i className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${LEVEL[l].dot}`} /></span>
                <span className="min-w-0"><b className="block max-w-[14rem] truncate leading-tight">{deviceTitle(x)}</b><span className="text-xs text-neutral-500">seen {since(x.last_seen)}{x.hardware ? " · full report" : ""}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <DeviceView key={d.id} d={d} />
    </div>
  );
}

/* ---------- inside a ticket: a short summary and a side panel ---------- */

export function DeviceSummary({ d, onOpen }: { d: DeviceData; onOpen: () => void }) {
  const kind = kindOf(d), h = d.hardware, b = d.browser;
  const checks = healthChecks(d);
  const issues = checks.filter((c) => c.level === "bad" || c.level === "warn");
  const l = worst(checks);
  const ram = h?.ramGb ? `${gb(h.ramGb)} GB` : b?.memory ? `${b.memory >= 8 ? "8+" : b.memory} GB` : null;
  const threads = h?.cpu?.threads ?? b?.cores;
  return (
    <section className="rounded-2xl border border-stone-200 bg-surface p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ink text-white"><Ico d={pcIcon(kind)} size={22} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[11px] font-bold uppercase tracking-wider text-neutral-500">Raised from this computer</h3>
          <p className="truncate font-bold leading-snug">{deviceTitle(d)}</p>
          <p className="text-xs text-neutral-500">{[kind, osName(d), ram, threads ? `${threads} threads` : null].filter(Boolean).join(" · ")}</p>
        </div>
        <i className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${LEVEL[l].dot}`} title={issues.length ? `${issues.length} to look at` : "No problems found"} />
      </div>
      {issues.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {issues.slice(0, 3).map((c) => (
            <li key={c.title} className="flex items-center gap-2 text-sm"><span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${LEVEL[c.level].chip}`}><Ico d={LEVEL[c.level].icon} size={11} /></span><span className="truncate">{c.title}</span></li>
          ))}
        </ul>
      )}
      <button className="mt-3 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green" onClick={onOpen}>View computer</button>
    </section>
  );
}

/** A panel that slides in from the right with the full view. Esc or a click outside closes it. */
export function DeviceDrawer({ d, onClose }: { d: DeviceData; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = overflow; before?.focus?.(); };
  }, [onClose]);
  // Rendered at the top of the page: an animated ancestor (the page entrance) would otherwise become the "screen" for position: fixed.
  return createPortal(
    <div className="backdrop-in fixed inset-0 z-50 flex justify-end bg-black/55 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label="Computer details" className="drawer-in flex h-full w-full max-w-[860px] flex-col bg-page text-fg shadow-2xl">
        <div className="brand-stripe" />
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-surface px-5 py-3">
          <h2 className="text-lg font-extrabold">Computer details</h2>
          <button ref={closeRef} onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-lg border border-stone-300 hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green"><Ico d={I.close} size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5"><DeviceView d={d} /></div>
      </aside>
    </div>,
    document.body,
  );
}

/** Kept for places that just want the full view of one computer. */
export const DeviceCard = ({ d }: { d: DeviceData; compact?: boolean }) => <DeviceView d={d} />;
