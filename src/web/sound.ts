/* Notification sounds, synthesised with the Web Audio API (no audio files to ship). Browsers only allow sound after the person has
   interacted with the page once, so the audio context is unlocked on the first click or key press; before that, chimes stay silent. */

const KEY = "fortress-helpdesk:sound";
export const soundEnabled = () => {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
};
export const setSoundEnabled = (on: boolean) => {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* private window: the choice just won't persist */ }
};

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}
if (typeof window !== "undefined") {
  const unlock = () => { audio(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

function tone(c: AudioContext, freq: number, at: number, dur: number, vol: number, type: OscillatorType = "sine") {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t0 = c.currentTime + at;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

export type Chime = "message" | "new_ticket" | "assigned" | "status" | "note" | "sla_warn" | "sla_breach" | "call_request" | "call" | "update" | "alert";

/** Short, soft and distinct per kind: a two-note ping for messages, a rising three-note for a new ticket, and so on. */
export function chime(kind: Chime = "message", force = false) {
  if (!force && !soundEnabled()) return;
  const c = audio();
  if (!c || c.state !== "running") return;
  switch (kind) {
    case "new_ticket": [523.25, 659.25, 783.99].forEach((f, i) => tone(c, f, i * 0.11, 0.38, 0.12, "triangle")); break;
    case "assigned": [783.99, 1046.5].forEach((f, i) => tone(c, f, i * 0.12, 0.4, 0.11, "triangle")); break;
    case "status": tone(c, 587.33, 0, 0.32, 0.09); break;
    case "call_request": [0, 0.26, 0.52].forEach((at) => { tone(c, 880, at, 0.18, 0.12, "triangle"); tone(c, 1108.73, at, 0.18, 0.08, "triangle"); }); break; // three quick double-tones, like a phone
    case "call": tone(c, 392, 0, 0.4, 0.09, "triangle"); break; // a missed call: one low note
    case "note": tone(c, 440, 0, 0.3, 0.08); break;
    case "update": tone(c, 587.33, 0, 0.32, 0.09); break;
    case "alert": [587.33, 493.88].forEach((f, i) => tone(c, f, i * 0.14, 0.34, 0.1, "triangle")); break;
    case "sla_warn": [587.33, 493.88].forEach((f, i) => tone(c, f, i * 0.14, 0.34, 0.1, "triangle")); break; // two falling notes: heads up
    case "sla_breach": [392, 329.63, 261.63].forEach((f, i) => tone(c, f, i * 0.15, 0.42, 0.12, "triangle")); break; // three falling notes: late
    default: [659.25, 880].forEach((f, i) => tone(c, f, i * 0.1, 0.34, 0.11)); // message
  }
}

/** A ringing tone that repeats until the returned function is called: "in" = someone is calling you, "out" = you are calling. */
export function ringer(kind: "in" | "out"): () => void {
  const play = () => {
    const c = audio();
    if (!c || c.state !== "running") return;
    if (kind === "in") [0, 0.24].forEach((at) => { tone(c, 880, at, 0.2, 0.13, "triangle"); tone(c, 1108.73, at, 0.2, 0.09, "triangle"); });
    else tone(c, 440, 0, 0.9, 0.045);
  };
  play();
  const t = window.setInterval(play, kind === "in" ? 1700 : 3000);
  return () => window.clearInterval(t);
}
