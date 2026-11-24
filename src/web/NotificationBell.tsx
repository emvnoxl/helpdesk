import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { chime, setSoundEnabled, soundEnabled, type Chime } from "./sound";
import { streamFor, useLive } from "./live";

interface Item { id: number; kind: Chime; title: string; body: string; ticket_id: number | null; ref: string | null; created_at: number; read_at: number | null }

const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
// When several arrive at once, play only the most important sound.
const RANK: Chime[] = ["sla_breach", "alert", "call_request", "new_ticket", "assigned", "message", "sla_warn", "note", "update", "status"];

const KIND_STYLE: Record<string, string> = {
  new_ticket: "bg-brand-green text-ink",
  assigned: "bg-brand-amber text-ink",
  message: "bg-ink text-white",
  note: "bg-amber-100 text-amber-900",
  status: "bg-stone-200 text-neutral-700",
  sla_warn: "bg-brand-amber text-ink",
  sla_breach: "bg-[#d92b33] text-white",
  call_request: "bg-brand-green text-ink",
  call: "bg-stone-200 text-neutral-700",
  update: "bg-brand-green text-ink",
  alert: "bg-[#d92b33] text-white",
};
const KIND_ICON: Record<string, string> = {
  update: "M12 3v12M7 10l5 5 5-5M5 21h14",
  alert: "M12 8v5M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  new_ticket: "M12 5v14M5 12h14",
  assigned: "M5 12h14M13 6l6 6-6 6",
  message: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z",
  note: "M6 3h9l4 4v14H6zM9 12h7M9 16h5",
  status: "M5 13l4 4L19 7",
  sla_warn: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  sla_breach: "M12 8v5M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  call_request: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
  call: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z",
};

/** The bell: unread count, a list of recent things, a toast and a sound when something new arrives, and a "(2)" in the tab title.
    `base` is "/notifications" for normal users and "/staff/notifications" for agents and admins. `viewing` is the ticket that is open
    right now: messages for it are marked read straight away and don't pop a toast. */
export function NotificationBell({ base, onOpen, viewing = null, tone = "light" }: { base: string; onOpen: (ticketId: number) => void; viewing?: number | null; tone?: "light" | "dark" }) {
  const { toast } = useNotify();
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState(soundEnabled);
  const [perm, setPerm] = useState<string>(() => (typeof Notification !== "undefined" && window.isSecureContext ? Notification.permission : "unsupported"));
  const [ring, setRing] = useState(0);
  const lastId = useRef<number | null>(null); // null until the first load, so old notifications don't make noise on page load
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const wrap = useRef<HTMLDivElement>(null);
  const baseTitle = useRef(typeof document !== "undefined" ? document.title : "");

  const markRead = useCallback((body: object) => api(`${base}/read`, { method: "POST", json: body }).catch(() => {}), [base]);

  const load = useCallback(async () => {
    let data: { items: Item[]; unread: number };
    try { data = await api(base); } catch { return; } // signed out or offline: stay quiet
    const top = data.items.reduce((m, i) => Math.max(m, i.id), 0);
    if (lastId.current === null) {
      lastId.current = top;
      setItems(data.items); setUnread(data.unread);
      return;
    }
    const fresh = data.items.filter((i) => i.id > lastId.current! && !i.read_at);
    lastId.current = Math.max(lastId.current, top);
    if (fresh.length) {
      window.dispatchEvent(new CustomEvent("fg:notify", { detail: fresh }));
      const here = (i: Item) => i.ticket_id !== null && i.ticket_id === viewingRef.current && !document.hidden;
      const loud = fresh.filter((i) => !here(i));
      if (fresh.some(here)) void markRead({ ticket_id: viewingRef.current });
      const kind = RANK.find((k) => fresh.some((i) => i.kind === k)) ?? "message";
      chime(loud.length ? kind : "status"); // a quiet tick when it's the conversation you're already looking at
      if (loud.length) {
        setRing((n) => n + 1);
        const first = loud[0]!;
        const extra = loud.length > 1 ? ` (+${loud.length - 1} more)` : "";
        toast(first.body + extra, "info", first.title, () => { if (first.ticket_id) openRef.current(first.ticket_id); void markRead({ ids: loud.map((l) => l.id) }); void load(); });
        if (document.hidden && perm === "granted") {
          try {
            const n = new Notification(first.title, { body: first.body, tag: "fg-" + first.id });
            n.onclick = () => { window.focus(); if (first.ticket_id) openRef.current(first.ticket_id); n.close(); };
          } catch { /* some browsers only allow this from a service worker */ }
        }
      }
      if (fresh.some(here)) { const again: { items: Item[]; unread: number } = await api(base).catch(() => data); setItems(again.items); setUnread(again.unread); return; }
    }
    setItems(data.items); setUnread(data.unread);
  }, [base, perm, toast, markRead]);

  // Instant: the server nudges every open screen when anything changes, so a reply rings the bell within a moment.
  useLive(streamFor(base.startsWith("/staff")), () => void load());

  // Safety net: every 30 s while the tab is visible (60 s hidden), and straight away when you come back to the tab.
  useEffect(() => {
    let timer = 0;
    const tick = async () => { await load(); timer = window.setTimeout(tick, document.hidden ? 60000 : 30000); };
    void tick();
    const onVis = () => { if (!document.hidden) { window.clearTimeout(timer); void tick(); } };
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [load]);

  // Opening a ticket reads its notifications.
  useEffect(() => {
    if (viewing !== null) void markRead({ ticket_id: viewing }).then(() => load());
  }, [viewing]);

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${baseTitle.current}` : baseTitle.current;
  }, [unread]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const pick = (i: Item) => {
    setOpen(false);
    if (!i.read_at) void markRead({ ids: [i.id] }).then(load);
    if (i.ticket_id) onOpen(i.ticket_id);
  };
  const look = tone === "dark" ? "border-white/25 text-white/85 hover:bg-white/10" : "border-stone-200 text-neutral-600 hover:bg-stone-100 hover:text-fg";

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
        className={`relative flex items-center rounded-lg border p-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${look}`}
      >
        <svg key={ring} className={ring ? "bell-ring" : ""} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span data-testid="bell-count" className="absolute -right-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-[#d92b33] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-surface">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="dialog" aria-label="Notifications" className="dialog-in absolute right-0 z-40 mt-2 w-[min(92vw,380px)] overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl">
          <div className="brand-stripe" />
          <div className="flex items-center justify-between px-4 py-3">
            <h3 className="font-extrabold">Notifications</h3>
            {unread > 0 && <button className="text-xs font-semibold text-neutral-500 hover:text-fg" onClick={() => void markRead({ all: true }).then(load)}>Mark all read</button>}
          </div>
          <ul className="max-h-[55vh] divide-y divide-stone-200 overflow-y-auto border-t border-stone-200">
            {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-neutral-500">Nothing yet. Replies and updates will show up here.</li>}
            {items.map((i) => (
              <li key={i.id}>
                <button onClick={() => pick(i)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none">
                  <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${KIND_STYLE[i.kind] ?? KIND_STYLE.status}`}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={KIND_ICON[i.kind] ?? KIND_ICON.status} /></svg>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${i.read_at ? "font-medium" : "font-bold"}`}>{i.title}</span>
                    <span className="block truncate text-xs text-neutral-500">{i.body}</span>
                    <span className="mt-0.5 block text-[11px] text-neutral-500">{ago(i.created_at)}</span>
                  </span>
                  {!i.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-brand-green" aria-label="Unread" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="space-y-2 border-t border-stone-200 px-4 py-3 text-sm">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>Play a sound</span>
              <input
                type="checkbox"
                role="switch"
                className="h-4 w-4 accent-[#00a859]"
                checked={sound}
                onChange={(e) => { setSound(e.target.checked); setSoundEnabled(e.target.checked); if (e.target.checked) chime("message", true); }}
              />
            </label>
            {perm !== "unsupported" && (
              <div className="flex items-center justify-between gap-3">
                <span>Desktop alerts</span>
                {perm === "granted" ? (
                  <span className="text-xs font-semibold text-ok">On</span>
                ) : perm === "denied" ? (
                  <span className="text-xs text-neutral-500">Blocked in browser settings</span>
                ) : (
                  <button className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs font-semibold hover:bg-stone-100" onClick={() => void Notification.requestPermission().then(setPerm)}>Turn on</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
