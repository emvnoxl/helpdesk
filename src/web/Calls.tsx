import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { streamFor, subscribe as live } from "./live";
import { useNotify } from "./notify";
import { ringer } from "./sound";

/* Voice calls and screen sharing on a ticket. The browser's own WebRTC does the work: sound and picture go straight from one
   computer to the other over the office network, and the helpdesk server only introduces the two (see src/server/calls.ts).
   One call at a time per tab; the engine lives outside React so a call survives moving between pages.

   The offer and the answer are sent once, complete (no trickling): both sides negotiate a sound line and a picture line up front,
   and showing a screen later is just "start sending on the picture line" (replaceTrack), with nothing to renegotiate.
   A computer without a microphone can still take a call: it listens, and can show its screen. */

export interface CallSnap {
  id: string; ticket_id: number; ref: string; title: string; state: "ringing" | "active" | "ended"; reason: string | null;
  role: "caller" | "callee" | "invited"; with: string; my_tab: string | null; offer?: string; answer?: string; remote_sharing: boolean; answered_at: number | null;
}
type Phase = "idle" | "starting" | "outgoing" | "incoming" | "connecting" | "active";
interface State {
  phase: Phase; call: CallSnap | null; ticketId: number | null;
  muted: boolean; noMic: boolean; sharing: boolean; since: number | null;
  remoteAudio: MediaStream | null; remoteVideo: MediaStream | null;
}
const IDLE: State = { phase: "idle", call: null, ticketId: null, muted: false, noMic: false, sharing: false, since: null, remoteAudio: null, remoteVideo: null };

/** The microphone and screen sharing only exist on a secure page: HTTPS, or http://localhost. */
export const callsSupported = () => typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== "undefined";
export const UNSUPPORTED = "Calls need the helpdesk to be opened over HTTPS. Please tell IT.";

const TAB = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
let state: State = IDLE;
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
let say: (text: string, kind?: "success" | "error" | "info") => void = () => {};

let base = "/tickets";
let ice: RTCIceServer[] = [];
let pc: RTCPeerConnection | null = null;
let mic: MediaStream | null = null;
let screen: MediaStream | null = null;
let videoSender: RTCRtpSender | null = null;
let answered = false; // the caller has applied the answer
let dropTimer = 0;

function teardown() {
  window.clearTimeout(dropTimer);
  for (const s of [mic, screen]) s?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  mic = screen = null;
  videoSender = null;
  answered = false;
  if (pc) { pc.ontrack = pc.onconnectionstatechange = null; pc.close(); pc = null; }
  set(IDLE);
}

const getMic = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch(() => null);

/** Resolves when the browser has listed the ways this computer can be reached (instant on an office network). */
const gathered = (p: RTCPeerConnection) =>
  new Promise<void>((done) => {
    if (p.iceGatheringState === "complete") return done();
    const t = window.setTimeout(done, 2500);
    p.addEventListener("icegatheringstatechange", () => { if (p.iceGatheringState === "complete") { window.clearTimeout(t); done(); } });
  });

function newPeer() {
  const p = new RTCPeerConnection({ iceServers: ice });
  p.ontrack = (e) => {
    const s = new MediaStream([e.track]);
    set(e.track.kind === "audio" ? { remoteAudio: s } : { remoteVideo: s });
  };
  p.onconnectionstatechange = () => {
    window.clearTimeout(dropTimer);
    if (p.connectionState === "connected") { if (state.phase === "connecting") set({ phase: "active", since: Date.now() }); }
    else if (p.connectionState === "failed") void hangUp("The connection was lost.");
    // A blip (Wi-Fi roaming) often recovers by itself; give it a moment before ending the call.
    else if (p.connectionState === "disconnected") dropTimer = window.setTimeout(() => void hangUp("The connection was lost."), 10_000);
  };
  pc = p;
  return p;
}

async function start(ticketId: number) {
  if (!callsSupported()) throw new Error(UNSUPPORTED);
  if (state.phase !== "idle") throw new Error("You are already in a call.");
  set({ phase: "starting", ticketId });
  try {
    mic = await getMic();
    const p = newPeer();
    const a = p.addTransceiver("audio", { direction: "sendrecv" });
    videoSender = p.addTransceiver("video", { direction: "sendrecv" }).sender;
    if (mic) await a.sender.replaceTrack(mic.getAudioTracks()[0]!);
    await p.setLocalDescription(await p.createOffer());
    await gathered(p);
    const r = await api<{ call: CallSnap; ice: RTCIceServer[] }>(`${base}/${ticketId}/call`, { method: "POST", json: { sdp: p.localDescription!.sdp, tab: TAB } });
    set({ phase: "outgoing", call: r.call, noMic: !mic });
  } catch (e) {
    teardown();
    throw e;
  }
}

async function accept() {
  const snap = state.call;
  if (state.phase !== "incoming" || !snap?.offer) return;
  if (!callsSupported()) { say(UNSUPPORTED, "error"); return; }
  set({ phase: "connecting", ticketId: snap.ticket_id });
  try {
    mic = await getMic();
    const p = newPeer();
    await p.setRemoteDescription({ type: "offer", sdp: snap.offer });
    for (const t of p.getTransceivers()) {
      t.direction = "sendrecv";
      if (t.receiver.track.kind === "video") videoSender = t.sender;
      else if (mic) await t.sender.replaceTrack(mic.getAudioTracks()[0]!);
    }
    await p.setLocalDescription(await p.createAnswer());
    await gathered(p);
    const r = await api<{ call: CallSnap }>(`${base}/calls/${snap.id}/accept`, { method: "POST", json: { sdp: p.localDescription!.sdp, tab: TAB } });
    set({ call: r.call, noMic: !mic });
    if (pc?.connectionState === "connected") set({ phase: "active", since: Date.now() });
  } catch (e) {
    teardown();
    say((e as Error).message || "Could not answer the call.", "error");
  }
}

async function decline() {
  const id = state.call?.id;
  if (state.phase !== "incoming" || !id) return;
  set(IDLE);
  await api(`${base}/calls/${id}/decline`, { method: "POST", json: {} }).catch(() => {});
}

async function hangUp(note?: string) {
  const id = state.call?.id;
  if (state.phase === "idle") return;
  teardown();
  if (note) say(note, "info");
  if (id) await api(`${base}/calls/${id}/hangup`, { method: "POST", json: {} }).catch(() => {});
}

function toggleMute() {
  const track = mic?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  set({ muted: !track.enabled });
}

async function stopShare() {
  const id = state.call?.id;
  screen?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  screen = null;
  await videoSender?.replaceTrack(null).catch(() => {});
  if (!state.sharing) return;
  set({ sharing: false });
  if (id) await api(`${base}/calls/${id}/share`, { method: "POST", json: { on: false } }).catch(() => {});
}

async function toggleShare() {
  if (state.phase !== "active" || !videoSender) return;
  if (state.sharing) return stopShare();
  if (!navigator.mediaDevices.getDisplayMedia) { say("This browser can't show its screen. Use Edge or Chrome on a computer.", "error"); return; }
  let s: MediaStream;
  try { s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 24 } }, audio: false }); } catch { return; } // picker cancelled
  const track = s.getVideoTracks()[0];
  const id = state.call?.id;
  if (!track || state.phase !== "active" || !videoSender || !id) { s.getTracks().forEach((t) => t.stop()); return; }
  screen = s;
  track.contentHint = "detail"; // text on a screen: prefer sharpness over smooth motion
  track.onended = () => void stopShare(); // the browser's own "Stop sharing" bar
  await videoSender.replaceTrack(track);
  set({ sharing: true });
  await api(`${base}/calls/${id}/share`, { method: "POST", json: { on: true } }).catch(() => {});
}

/** Reads what the server knows and brings this tab in line with it. Runs after every "call" push and on a slow timer. */
let syncing = false, again = false;
async function sync() {
  if (syncing) { again = true; return; }
  syncing = true;
  try {
    const r = await api<{ calls: CallSnap[]; ice: RTCIceServer[] }>(`${base}/calls`);
    ice = r.ice ?? [];
    const cur = state.call;
    if (cur && (state.phase === "outgoing" || state.phase === "connecting" || state.phase === "active")) {
      const s = r.calls.find((x) => x.id === cur.id);
      if (!s || s.state === "ended") {
        const was = state.phase;
        teardown();
        say(was === "outgoing" ? (s?.reason === "declined" ? `${cur.with} can't talk right now.` : `${cur.with} didn't answer. They will see that you called.`) : "The call has ended.", "info");
      } else if (s.role !== "invited") { // "invited" = our own answer is still on its way
        if (s.role === "caller" && s.state === "active" && s.answer && !answered && pc) {
          answered = true;
          set({ phase: "connecting", call: s });
          await pc.setRemoteDescription({ type: "answer", sdp: s.answer });
          if (pc?.connectionState === "connected" && state.phase === "connecting") set({ phase: "active", since: Date.now() });
        } else set({ call: s });
      }
    } else if (state.phase === "idle" || state.phase === "incoming") {
      const ringing = r.calls.find((x) => x.state === "ringing" && x.role === "invited") ?? null;
      if (ringing && ringing.id !== cur?.id) set({ ...IDLE, phase: "incoming", call: ringing });
      else if (!ringing && state.phase === "incoming") set(IDLE); // answered on another screen, or they gave up
    }
  } catch { /* signed out or offline: the next push or tick tries again */ }
  syncing = false;
  if (again) { again = false; void sync(); }
}

export const useCall = () => useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);

/* ---------- what you see ---------- */

const Ico = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const PHONE = "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z";
const MIC = "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3";
const MIC_OFF = "M3 3l18 18M9 9v3a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11 5.7M19 11a7 7 0 0 1-.6 2.8M12 18v3";
const SCREEN = "M3 5h18v11H3zM8 20h8M12 16v4";
const EXPAND = "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5";

/** The Call button on a ticket (IT only: requesters ask for a call instead, see RequestCallButton). */
export function CallButton({ ticketId, name, label = "Call" }: { ticketId: number; name: string; label?: string }) {
  const s = useCall();
  const { toast } = useNotify();
  const here = s.phase !== "idle" && (s.ticketId === ticketId || s.call?.ticket_id === ticketId);
  return (
    <button
      type="button"
      disabled={s.phase !== "idle"}
      title={here ? "You are in a call on this ticket" : s.phase !== "idle" ? "You are already in a call" : `Call ${name}. You can also show your screen.`}
      onClick={() => void start(ticketId).catch((e) => toast(e.message, e.data?.missed ? "info" : "error", e.data?.missed ? "No answer" : "Couldn't start the call"))}
      className="inline-flex shrink-0 items-center gap-2 rounded-full bg-brand-green px-3.5 py-1.5 text-sm font-bold text-ink shadow-sm transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green focus-visible:ring-offset-2 ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Ico d={PHONE} size={16} />
      <span>{here ? "In call" : label}</span>
    </button>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="tabular-nums">{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

const round = "grid h-11 w-11 shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40";

/** Rendered once per app (normal users, agents, admins): rings, shows the call bar and the other person's screen, plays the sound. */
export function CallDock({ staff, onOpen }: { staff: boolean; onOpen: (ticketId: number) => void }) {
  const s = useCall();
  const { toast } = useNotify();
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [big, setBig] = useState(false);
  say = (text, kind = "info") => toast(text, kind, "Call");

  useEffect(() => {
    base = staff ? "/staff/tickets" : "/tickets";
    void sync();
    const off = live(streamFor(staff), (event) => { if (event === "call" || event === "open") void sync(); });
    const bye = () => {
      // Closing the tab hangs up, so the other person is not left talking to nobody.
      if (state.call?.id && state.phase !== "idle" && state.phase !== "incoming") navigator.sendBeacon?.(`/api${base}/calls/${state.call.id}/hangup`, new Blob(["{}"], { type: "application/json" }));
    };
    window.addEventListener("pagehide", bye);
    return () => { off(); window.removeEventListener("pagehide", bye); void hangUp(); };
  }, [staff]);

  // Safety net for a missed push: quick while something is going on, slow otherwise.
  const busy = s.phase !== "idle";
  useEffect(() => {
    const t = window.setInterval(() => void sync(), busy ? 4000 : 30_000);
    return () => window.clearInterval(t);
  }, [busy]);

  // Ringing. A call rings even when notification sounds are muted: it is rare, and someone is waiting on the other end.
  const ring = s.phase === "incoming" ? "in" : s.phase === "outgoing" ? "out" : null;
  const incomingId = s.phase === "incoming" ? s.call?.id : null;
  useEffect(() => (ring ? ringer(ring) : undefined), [ring]);
  useEffect(() => {
    const c = state.call;
    if (!incomingId || !c || !document.hidden || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const n = new Notification(`${c.with} is calling`, { body: `${c.ref} · ${c.title}`, tag: "fg-call" });
      n.onclick = () => { window.focus(); n.close(); };
      return () => n.close();
    } catch { /* some browsers only allow this from a service worker */ }
  }, [incomingId]);

  useEffect(() => { if (audioRef.current) audioRef.current.srcObject = s.remoteAudio; }, [s.remoteAudio]);
  const showScreen = s.phase === "active" && !!s.call?.remote_sharing && !!s.remoteVideo;
  useEffect(() => { if (videoRef.current) videoRef.current.srcObject = showScreen ? s.remoteVideo : null; }, [showScreen, s.remoteVideo]);
  useEffect(() => { if (!showScreen) setBig(false); }, [showScreen]);

  const c = s.call;
  return createPortal(
    <>
      <audio ref={audioRef} autoPlay />

      {s.phase === "incoming" && c && (
        <div role="alertdialog" aria-label="Incoming call" className="dialog-in fixed left-1/2 top-4 z-[58] w-[min(92vw,26rem)] -translate-x-1/2 overflow-hidden rounded-3xl bg-ink text-white shadow-2xl ring-1 ring-white/15">
          <div className="brand-stripe" />
          <div className="flex items-center gap-4 p-5">
            <span className="call-pulse grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-green text-ink"><Ico d={PHONE} size={26} /></span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-extrabold">{c.with} is calling</div>
              <div className="truncate text-sm text-white/65">{c.ref} · {c.title}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 px-5 pb-5">
            <button type="button" onClick={() => void decline()} className="rounded-xl bg-white/10 py-3 text-sm font-bold hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white">Not now</button>
            <button type="button" autoFocus onClick={() => { void accept(); onOpen(c.ticket_id); }} className="rounded-xl bg-brand-green py-3 text-sm font-extrabold text-ink hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-white">Answer</button>
          </div>
        </div>
      )}

      {showScreen && (
        <div className={`fixed z-[56] flex flex-col overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/20 ${big ? "inset-3 bottom-24" : "right-4 top-20 w-[min(92vw,34rem)]"}`}>
          <div className="flex items-center gap-2 bg-ink px-3 py-2 text-xs font-semibold text-white">
            <span className="h-2 w-2 rounded-full bg-brand-red" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{c?.with}'s screen</span>
            <button type="button" onClick={() => setBig((b) => !b)} className="rounded-md px-2 py-1 hover:bg-white/15">{big ? "Smaller" : "Bigger"}</button>
            <button type="button" onClick={() => void videoRef.current?.requestFullscreen?.().catch(() => {})} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-white/15"><Ico d={EXPAND} size={13} /> Full screen</button>
          </div>
          <video ref={videoRef} autoPlay playsInline muted className={`w-full bg-black object-contain ${big ? "min-h-0 flex-1" : "aspect-video"}`} />
        </div>
      )}

      {(s.phase === "starting" || s.phase === "outgoing" || s.phase === "connecting" || s.phase === "active") && (
        <div role="region" aria-label="Call" className="dialog-in fixed bottom-4 left-1/2 z-[57] flex w-[min(96vw,34rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-2 pl-5 pr-2 text-white shadow-2xl ring-1 ring-white/15">
          <button type="button" disabled={!c} onClick={() => c && onOpen(c.ticket_id)} className="min-w-0 flex-1 text-left focus:outline-none" title="Open the ticket">
            <div className="truncate text-sm font-bold">
              {s.phase === "active" ? (c?.with ?? "Call") : s.phase === "connecting" ? "Connecting…" : `Calling ${c?.with ?? ""}…`}
            </div>
            <div className="truncate text-xs text-white/60">
              {s.phase === "active" && s.since ? <><Elapsed since={s.since} /> · </> : null}
              {s.sharing ? <b className="text-brand-amber">You are showing your screen</b> : s.noMic && s.phase === "active" ? "No microphone here: you can listen and show your screen" : c ? c.ref : "Getting ready…"}
            </div>
          </button>
          {s.phase === "active" && (
            <>
              <button type="button" onClick={toggleMute} disabled={s.noMic} aria-pressed={s.muted} title={s.noMic ? "No microphone on this computer" : s.muted ? "Unmute" : "Mute"} aria-label={s.muted ? "Unmute" : "Mute"}
                className={`${round} ${s.muted || s.noMic ? "bg-brand-amber text-ink" : "bg-white/10 hover:bg-white/20"}`}><Ico d={s.muted || s.noMic ? MIC_OFF : MIC} /></button>
              <button type="button" onClick={() => void toggleShare()} aria-pressed={s.sharing} title={s.sharing ? "Stop showing my screen" : "Show my screen"} aria-label={s.sharing ? "Stop showing my screen" : "Show my screen"}
                className={`${round} ${s.sharing ? "bg-brand-amber text-ink" : "bg-white/10 hover:bg-white/20"}`}><Ico d={SCREEN} /></button>
            </>
          )}
          <button type="button" onClick={() => void hangUp()} title={s.phase === "active" ? "Hang up" : "Cancel"} aria-label={s.phase === "active" ? "Hang up" : "Cancel the call"}
            className={`${round} bg-brand-red hover:brightness-110`}><span className="rotate-[135deg]"><Ico d={PHONE} /></span></button>
        </div>
      )}
    </>,
    document.body,
  );
}

/* ---------- asking for a call (requesters) ---------- */

export interface CallRequest { note: string; at: number; by: string }

/** The requester's side: a button that asks IT for a call, with an optional note about what it is for. IT decides when to ring. */
export function RequestCallButton({ ticketId, base: root, request, onChanged }: { ticketId: number; base: string; request: CallRequest | null; onChanged: () => void }) {
  const { toast } = useNotify();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (request) {
    return (
      <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-brand-amber/25 px-3.5 py-1.5 text-sm font-bold text-fg ring-1 ring-inset ring-amber-300" title="IT has been told and will ring you here">
        <Ico d={PHONE} size={15} /> Call requested
      </span>
    );
  }
  const send = async () => {
    setBusy(true);
    try {
      await api(`${root}/${ticketId}/call-request`, { method: "POST", json: { note } });
      setOpen(false);
      setNote("");
      toast("IT has been told. Keep the helpdesk open and they will ring you here.", "success", "Call requested");
    } catch (e) {
      toast((e as Error).message, "error", "Couldn't ask for a call");
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-full bg-brand-green px-3.5 py-1.5 text-sm font-bold text-ink shadow-sm transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green focus-visible:ring-offset-2 ring-offset-surface"
      >
        <Ico d={PHONE} size={16} /> Request a call
      </button>
      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          className="dialog-in absolute right-0 top-full z-30 mt-2 w-[min(88vw,20rem)] rounded-2xl border border-stone-200 bg-surface p-4 text-fg shadow-xl"
        >
          <h4 className="font-extrabold">Ask IT to call you</h4>
          <p className="mt-0.5 text-xs text-neutral-600">IT is told straight away and rings you here when they are ready. Keep the helpdesk open.</p>
          <label className="mt-3 block text-xs font-bold uppercase tracking-wider text-neutral-500" htmlFor="call-note">What is it about? (optional)</label>
          <textarea
            id="call-note" autoFocus rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Easier to show you on screen"
            className="mt-1 w-full resize-none rounded-lg border border-stone-300 bg-surface px-3 py-2 text-sm text-fg shadow-sm placeholder:text-neutral-500 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-sm font-semibold text-neutral-600 hover:bg-stone-100">Cancel</button>
            <button disabled={busy} className="rounded-lg bg-brand-green px-4 py-2 text-sm font-extrabold text-ink shadow-sm hover:brightness-110 disabled:opacity-50">{busy ? "Sending…" : "Send request"}</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** The strip under the conversation header while a request is open: IT sees who asked and can ring them or close it; the requester can take it back. */
export function CallRequestBar({ request, staff, ticketId, base: root, requester, onChanged }: { request: CallRequest; staff: boolean; ticketId: number; base: string; requester: string; onChanged: () => void }) {
  const { toast } = useNotify();
  const [busy, setBusy] = useState(false);
  const drop = async () => {
    setBusy(true);
    try { await api(`${root}/${ticketId}/call-request`, { method: "DELETE" }); } catch (e) { toast((e as Error).message, "error", "Couldn't close the request"); }
    setBusy(false);
    onChanged();
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-300 bg-brand-amber/20 px-4 py-2.5 text-sm">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-amber text-ink"><Ico d={PHONE} size={16} /></span>
      <span className="min-w-0 flex-1">
        {staff ? (
          <>
            <b>{requester} asked for a call.</b>
            {request.note && <span className="text-neutral-700"> “{request.note}”</span>}
          </>
        ) : (
          <>
            <b>You asked IT for a call.</b>
            <span className="text-neutral-700"> Keep the helpdesk open: IT will ring you here.{request.note && <> Your note: “{request.note}”</>}</span>
          </>
        )}
      </span>
      {staff && <CallButton ticketId={ticketId} name={requester} label="Call now" />}
      <button type="button" disabled={busy} onClick={() => void drop()} className="rounded-lg px-2.5 py-1.5 text-xs font-bold text-neutral-700 hover:bg-black/10 disabled:opacity-50 dark:hover:bg-white/10">
        {staff ? "Dismiss" : "Cancel request"}
      </button>
    </div>
  );
}
