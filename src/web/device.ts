import { api } from "./api";

/* "Which computer is this?" A browser can't read a serial number or MAC address, so each browser keeps a random id (this is what tells
   one computer, or one incognito window, from another) and, after sign-in, reports the little it is allowed to know: OS, CPU threads,
   approximate memory, screen, graphics chip and network type. Full hardware details come from the optional report script. */

const KEY = "fortress-helpdesk:device";
let memoryKey: string | null = null;

export function deviceKey(): string {
  if (memoryKey) return memoryKey;
  try {
    const k = localStorage.getItem(KEY);
    if (k && /^[a-f0-9]{32}$/.test(k)) return (memoryKey = k);
  } catch { /* private mode: fall through */ }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const k = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(KEY, k); } catch { /* the id then lasts only for this page load */ }
  return (memoryKey = k);
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3050 Laptop GPU" */
export function cleanGpu(raw: string): string {
  let s = raw.trim();
  const m = /^ANGLE \((.*)\)$/.exec(s);
  if (m) {
    const parts = m[1]!.split(", ");
    s = parts.length > 1 ? parts[1]! : parts[0]!;
  }
  return s.replace(/\(0x[0-9a-f]+\)/gi, "").replace(/\s*(Direct3D\d*.*|vs_\d.*|OpenGL.*)$/i, "").replace(/\s+/g, " ").trim();
}

function gpuName(): string | undefined {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    const raw = gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    return raw ? cleanGpu(raw) : undefined;
  } catch { return undefined; }
}

export async function collectBrowserInfo() {
  const n = navigator as any;
  const ua: string = n.userAgent ?? "";
  let os: string | undefined, osVersion: string | undefined, arch: string | undefined, bits: string | undefined, model: string | undefined;
  let browser: string | undefined, browserVersion: string | undefined;
  const uad = n.userAgentData;
  if (uad) {
    os = uad.platform;
    const brand = (uad.brands ?? []).filter((b: any) => !/not.?a.?brand|chromium/i.test(b.brand)).pop() ?? (uad.brands ?? []).pop();
    browser = brand?.brand?.replace(/^Microsoft /, "");
    browserVersion = brand?.version;
    try {
      const h = await uad.getHighEntropyValues(["platformVersion", "architecture", "bitness", "model"]);
      arch = h.architecture; bits = h.bitness; model = h.model || undefined;
      const major = parseInt(String(h.platformVersion ?? "").split(".")[0] ?? "", 10);
      osVersion = os === "Windows" && Number.isFinite(major) ? (major >= 13 ? "11" : "10") : h.platformVersion;
    } catch { /* not allowed here (needs a secure page): the basics still go through */ }
  }
  if (!browser) {
    const m = /(Edg|OPR|Firefox|Chrome|Version)\/([\d.]+)/.exec(ua);
    browser = m ? ({ Edg: "Edge", OPR: "Opera", Version: "Safari" } as Record<string, string>)[m[1]!] ?? m[1] : undefined;
    browserVersion = m?.[2]?.split(".")[0];
  }
  if (!os) os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : undefined;
  const c = n.connection;
  return {
    browser, browserVersion, os, osVersion, arch, bits, model,
    mobile: typeof uad?.mobile === "boolean" ? uad.mobile : /Mobi|Android|iPhone/.test(ua),
    cores: n.hardwareConcurrency, memory: n.deviceMemory, touch: n.maxTouchPoints,
    screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio, depth: screen.colorDepth },
    gpu: gpuName(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: n.language,
    conn: c ? { type: c.effectiveType, down: c.downlink, rtt: c.rtt } : undefined,
    ua: ua.slice(0, 300),
  };
}

/** Tells the helpdesk what this computer is. At most once every 30 minutes, and never in a way that blocks the page. */
export async function reportDevice(force = false) {
  try {
    const last = Number(sessionStorage.getItem("fg-device-reported") ?? 0);
    if (!force && Date.now() - last < 30 * 60_000) return;
    await api("/devices/report", { method: "POST", json: { key: deviceKey(), info: await collectBrowserInfo() } });
    sessionStorage.setItem("fg-device-reported", String(Date.now()));
  } catch { /* purely informational */ }
}
