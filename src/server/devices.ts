import { Hono } from "hono";
import { type AppEnv, clientIp, requesterAuth } from "./auth";
import { audit } from "./audit";
import { changed } from "./bus";
import { config, sessionSecret } from "./config";
import { db } from "./db";
import { RateLimiter, readToken, signToken } from "./security";

/* Computer details. Two sources, both stored per person per browser:
   - "browser": reported by the app itself after sign-in, limited to what a browser is allowed to say (OS, CPU threads, approximate RAM,
     screen, graphics chip, network type). It can't see make, model, serial number, exact RAM or disks.
   - "hardware": a full report from a small PowerShell script the person runs once from their Account page (make, model, serial, CPU,
     RAM sticks, disks, graphics, network). The script authenticates with a signed, expiring token tied to that one computer record.
   Everything sent in is cut down to a fixed set of fields, types and lengths here; nothing is stored as received. */

export const devices = new Hono<AppEnv>();
const SECRET = sessionSecret();
const limiter = new RateLimiter(30, 10 * 60_000);
const KEY = /^[a-f0-9]{32}$/;
const now = () => Math.floor(Date.now() / 1000);
const TOKEN_SECONDS = 24 * 3600;

/* ---------- cleaning ---------- */
const str = (v: unknown, n = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/[\u0000-\u001f]/g, " ").slice(0, n) : null);
const num = (v: unknown, min = 0, max = 1e9): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : null);
const arr = <T>(v: unknown, f: (x: any) => T | null, max = 12): T[] => (Array.isArray(v) ? v.slice(0, max).map(f).filter((x): x is T => x !== null) : []);
const drop = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))) as T;

export function cleanBrowser(x: any) {
  if (!x || typeof x !== "object") return null;
  return drop({
    browser: str(x.browser, 40), browserVersion: str(x.browserVersion, 20),
    os: str(x.os, 40), osVersion: str(x.osVersion, 30), arch: str(x.arch, 20), bits: str(x.bits, 4), model: str(x.model, 60),
    mobile: typeof x.mobile === "boolean" ? x.mobile : null,
    cores: num(x.cores, 1, 512), memory: num(x.memory, 0.25, 512), touch: num(x.touch, 0, 20),
    screen: x.screen && typeof x.screen === "object" ? drop({ w: num(x.screen.w, 1, 20000), h: num(x.screen.h, 1, 20000), dpr: num(x.screen.dpr, 0.1, 10), depth: num(x.screen.depth, 1, 64) }) : null,
    gpu: str(x.gpu, 160), tz: str(x.tz, 60), lang: str(x.lang, 20),
    conn: x.conn && typeof x.conn === "object" ? drop({ type: str(x.conn.type, 20), down: num(x.conn.down, 0, 100000), rtt: num(x.conn.rtt, 0, 100000) }) : null,
    ua: str(x.ua, 300),
  });
}

export function cleanHardware(x: any) {
  if (!x || typeof x !== "object") return null;
  const nic = (n: any) => (n && typeof n === "object" ? drop({ name: str(n.name, 100), mac: str(n.mac, 20), ips: arr(n.ips, (i) => str(i, 45), 6) }) : null);
  return drop({
    name: str(x.name, 60), manufacturer: str(x.manufacturer, 80), model: str(x.model, 80), serial: str(x.serial, 60), biosVersion: str(x.biosVersion, 80),
    chassis: ["Laptop", "Desktop", "Other"].includes(x.chassis) ? x.chassis : null,
    os: str(x.os, 80), osVersion: str(x.osVersion, 30), osBuild: str(x.osBuild, 12), osArch: str(x.osArch, 20), installDate: str(x.installDate, 12), lastBoot: str(x.lastBoot, 20),
    domain: str(x.domain, 80), user: str(x.user, 60),
    cpu: x.cpu && typeof x.cpu === "object" ? drop({ name: str(x.cpu.name, 100), cores: num(x.cpu.cores, 1, 512), threads: num(x.cpu.threads, 1, 1024), mhz: num(x.cpu.mhz, 100, 20000) }) : null,
    ramGb: num(x.ramGb, 0.1, 16384),
    ramModules: arr(x.ramModules, (m) => (m && typeof m === "object" ? drop({ gb: num(m.gb, 0.1, 1024), mhz: num(m.mhz, 100, 20000) }) : null), 16),
    disks: arr(x.disks, (d) => (d && typeof d === "object" ? drop({ model: str(d.model, 80), gb: num(d.gb, 0.1, 1e6), type: str(d.type, 20) }) : null), 8),
    volumes: arr(x.volumes, (v) => (v && typeof v === "object" ? drop({ drive: str(v.drive, 6), gb: num(v.gb, 0.1, 1e6), freeGb: num(v.freeGb, 0, 1e6) }) : null), 12),
    gpus: arr(x.gpus, (g) => (g && typeof g === "object" ? drop({ name: str(g.name, 100), gb: num(g.gb, 0, 1024), driver: str(g.driver, 30) }) : null), 4),
    nics: arr(x.nics, nic, 6),
    battery: typeof x.battery === "boolean" ? x.battery : null,
  });
}

/* ---------- the browser reports in ---------- */
devices.post("/report", requesterAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.key !== "string" || !KEY.test(body.key)) return c.json({ error: "bad key" }, 400);
  const info = cleanBrowser(body.info);
  if (!info) return c.json({ error: "no details" }, 400);
  const row = await db
    .prepare(
      `INSERT INTO devices (user_id, device_key, last_ip, browser) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, device_key) DO UPDATE SET last_seen = unixepoch(), last_ip = excluded.last_ip, browser = excluded.browser
       RETURNING id`,
    )
    .bind(user.id, body.key, clientIp(c), JSON.stringify(info))
    .first<{ id: number }>();
  return c.json({ ok: true, id: row?.id });
});

// The person's own view of this computer's record: whether a full report exists, and its make and model. Nothing sensitive.
devices.get("/mine", requesterAuth, async (c) => {
  const user = c.get("user");
  const key = c.req.query("key") ?? "";
  if (!KEY.test(key)) return c.json({ error: "bad key" }, 400);
  const d = await db.prepare("SELECT hardware, hardware_at FROM devices WHERE user_id = ? AND device_key = ?").bind(user.id, key).first<{ hardware: string | null; hardware_at: number | null }>();
  let hw: { name?: string; manufacturer?: string; model?: string } | null = null;
  try { hw = d?.hardware ? JSON.parse(d.hardware) : null; } catch { hw = null; }
  return c.json({ reported: !!d?.hardware, hardware_at: d?.hardware_at ?? null, name: hw?.name ?? null, model: hw ? [hw.manufacturer, hw.model].filter(Boolean).join(" ") : null });
});

/* ---------- the optional full hardware report ---------- */
const baseUrl = (c: { req: { url: string; header: (n: string) => string | undefined } }) => {
  if (config.appUrl) return config.appUrl;
  const u = new URL(c.req.url);
  const proto = config.trustProxy ? c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "") : u.protocol.replace(":", "");
  return `${proto}://${config.trustProxy ? c.req.header("x-forwarded-host") ?? u.host : u.host}`;
};

// The signed-in person asks for a link for THIS computer (identified by the browser's key).
devices.post("/inventory-link", requesterAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.key !== "string" || !KEY.test(body.key)) return c.json({ error: "bad key" }, 400);
  const row = await db
    .prepare(
      `INSERT INTO devices (user_id, device_key, last_ip) VALUES (?, ?, ?)
       ON CONFLICT (user_id, device_key) DO UPDATE SET last_seen = unixepoch() RETURNING id`,
    )
    .bind(user.id, body.key, clientIp(c))
    .first<{ id: number }>();
  const token = signToken({ k: "inv", d: row!.id, e: now() + TOKEN_SECONDS }, SECRET);
  const base = baseUrl(c);
  return c.json({
    expires_in: TOKEN_SECONDS,
    cmd_url: `${base}/api/devices/script.cmd?t=${token}`,
    command: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${base}/api/devices/script.ps1?t=${token}' | iex"`,
  });
});

const valid = (t: unknown) => (typeof t === "string" && t.length < 400 ? readToken<{ k: string; d: number; e: number }>(t, SECRET) : null);

/** The PowerShell. ASCII only and PowerShell 5.1 compatible (what Windows 10 and 11 ship with). */
function script(token: string, url: string): string {
  return String.raw`$ErrorActionPreference = 'SilentlyContinue'
$token = '__TOKEN__'
$url = '__URL__/api/devices/inventory'
Write-Host ''
Write-Host '  Fortress IT - hardware report' -ForegroundColor Green
Write-Host '  Reading the details of this computer...'
function Gb($b) { if ($b) { [math]::Round($b / 1GB, 1) } else { $null } }
$cs   = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$os   = Get-CimInstance Win32_OperatingSystem
$cpu  = @(Get-CimInstance Win32_Processor)[0]
$enc  = Get-CimInstance Win32_SystemEnclosure
$laptop  = 8,9,10,11,12,14,18,21,30,31,32
$desktop = 3,4,5,6,7,13,15,16,23,24,35,36
$chassis = 'Other'
foreach ($t in @($enc.ChassisTypes)) {
  if ($laptop -contains $t) { $chassis = 'Laptop' }
  elseif (($desktop -contains $t) -and ($chassis -ne 'Laptop')) { $chassis = 'Desktop' }
}
$ram   = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ gb = (Gb $_.Capacity); mhz = $_.Speed } })
$disks = @(Get-PhysicalDisk | ForEach-Object { @{ model = $_.FriendlyName; gb = (Gb $_.Size); type = [string]$_.MediaType } })
if ($disks.Count -eq 0) { $disks = @(Get-CimInstance Win32_DiskDrive | ForEach-Object { @{ model = $_.Model; gb = (Gb $_.Size); type = '' } }) }
$vols  = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ drive = $_.DeviceID; gb = (Gb $_.Size); freeGb = (Gb $_.FreeSpace) } })
$gpus  = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; gb = (Gb $_.AdapterRAM); driver = $_.DriverVersion } })
$nics  = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=true' | ForEach-Object { @{ name = $_.Description; mac = $_.MACAddress; ips = @($_.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }) } })
$installed = $null; if ($os.InstallDate) { $installed = $os.InstallDate.ToString('yyyy-MM-dd') }
$boot = $null; if ($os.LastBootUpTime) { $boot = $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm') }
$domain = 'Workgroup: ' + $cs.Domain; if ($cs.PartOfDomain) { $domain = [string]$cs.Domain }
$hw = @{
  name = $env:COMPUTERNAME; manufacturer = $cs.Manufacturer; model = $cs.Model; serial = $bios.SerialNumber; biosVersion = $bios.SMBIOSBIOSVersion; chassis = $chassis
  os = $os.Caption; osVersion = $os.Version; osBuild = $os.BuildNumber; osArch = $os.OSArchitecture; installDate = $installed; lastBoot = $boot
  domain = $domain; user = $env:USERNAME
  cpu = @{ name = $cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; mhz = $cpu.MaxClockSpeed }
  ramGb = (Gb $cs.TotalPhysicalMemory); ramModules = $ram; disks = $disks; volumes = $vols; gpus = $gpus; nics = $nics
  battery = [bool](Get-CimInstance Win32_Battery)
}
$json = @{ token = $token; hw = $hw } | ConvertTo-Json -Depth 6 -Compress
try {
  Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
  $fgOk = $true
  Write-Host ''
  Write-Host '  Done. IT can now see the details of this computer.' -ForegroundColor Green
  Write-Host ('  ' + $hw.manufacturer + ' ' + $hw.model + ', ' + $hw.ramGb + ' GB RAM, ' + $hw.cpu.name)
} catch {
  Write-Host ''
  Write-Host '  Could not send the report:' -ForegroundColor Red
  Write-Host ('  ' + $_.Exception.Message)
  Write-Host '  Check you are on the office network, then run it again.'
}
`.replace("__TOKEN__", token).replace("__URL__", url);
}

devices.get("/script.ps1", (c) => {
  if (!limiter.take(clientIp(c))) return c.text("Too many requests", 429);
  const t = c.req.query("t") ?? "";
  if (!valid(t)) return c.text("This link has expired. Open Your account in the helpdesk and get a new one.", 410);
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "no-store");
  return c.body(script(t, baseUrl(c)));
});

// A double-clickable version: a .cmd file whose first lines start PowerShell on the rest of the same file.
devices.get("/script.cmd", (c) => {
  if (!limiter.take(clientIp(c))) return c.text("Too many requests", 429);
  const t = c.req.query("t") ?? "";
  if (!valid(t)) return c.text("This link has expired. Open Your account in the helpdesk and get a new one.", 410);
  const head = [
    "@echo off",
    "title Fortress IT hardware report",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText('%~f0').Split([string[]]('#PS1'+'START'),2,[StringSplitOptions]::None)[1]); if (-not $fgOk) { exit 1 }"`,
    // Sent: the helpdesk page notices by itself, so the window just closes. Not sent: stay open so the reason can be read.
    "if errorlevel 1 goto failed",
    "echo.",
    "echo   You can go back to the helpdesk. This window closes by itself.",
    "%SystemRoot%\\System32\\timeout.exe /t 5 /nobreak >nul 2>&1",
    "exit /b",
    ":failed",
    "echo.",
    "pause",
    "exit /b",
    "#PS1" + "START",
  ];
  c.header("Content-Type", "application/octet-stream");
  c.header("Content-Disposition", 'attachment; filename="fortress-hardware-report.cmd"');
  c.header("Cache-Control", "no-store");
  return c.body(head.join("\r\n") + "\r\n" + script(t, baseUrl(c)).replace(/\r?\n/g, "\r\n"));
});

// The script posts here. No session cookie: the signed token says which computer record it belongs to.
devices.post("/inventory", async (c) => {
  if (!limiter.take(clientIp(c))) return c.json({ error: "Too many requests" }, 429);
  if (Number(c.req.header("content-length") ?? 0) > 60_000) return c.json({ error: "too large" }, 413);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const tok = valid(body.token);
  if (!tok || tok.k !== "inv") return c.json({ error: "This link has expired." }, 401);
  const hw = cleanHardware(body.hw);
  if (!hw || !Object.keys(hw).length) return c.json({ error: "no details" }, 400);
  const dev = await db
    .prepare("SELECT d.id, d.user_id, u.name FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?")
    .bind(tok.d)
    .first<{ id: number; user_id: number; name: string }>();
  if (!dev) return c.json({ error: "unknown computer" }, 404);
  await db.prepare("UPDATE devices SET hardware = ?, hardware_at = unixepoch(), last_seen = unixepoch(), last_ip = ? WHERE id = ?").bind(JSON.stringify(hw), clientIp(c), dev.id).run();
  await audit(c, "hardware.reported", "account", `Hardware report received for ${dev.name}'s computer${hw.name ? ` ${hw.name}` : ""}${hw.model ? ` (${hw.manufacturer ?? ""} ${hw.model})`.replace("( ", "(") : ""}`, { who: { id: dev.user_id, name: dev.name, role: "requester" } });
  changed();
  return c.json({ ok: true });
});

/** A device row as the UI wants it (JSON columns parsed). Used by the admin People list and the ticket view. */
export function shapeDevice(r: { id: number; first_seen: number; last_seen: number; last_ip: string | null; browser: string | null; hardware: string | null; hardware_at: number | null }) {
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  return { id: r.id, first_seen: r.first_seen, last_seen: r.last_seen, ip: r.last_ip, browser: parse(r.browser), hardware: parse(r.hardware), hardware_at: r.hardware_at };
}
