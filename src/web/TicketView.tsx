import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, fmt } from "./api";
import { useNotify } from "./notify";
import { DeviceDrawer, DeviceSummary } from "./DeviceCard";
import { AttachButton, DropVeil, PendingTray, SentFiles, filesFromPaste, useDrop } from "./Attach";
import { streamFor, useLive } from "./live";
import { RepliesPicker, fillReply, useReplies } from "./Replies";
import { RatingPrompt } from "./Rating";
import { SlaBar } from "./Sla";
import { TaskList, type Task } from "./Tasks";
import { DuplicatesCard } from "./Duplicates";
import { CallButton, CallRequestBar, RequestCallButton } from "./Calls";
import { useDrafts } from "./Attach";
import { ChatMessage } from "./ChatMessage";
import { MediaPanel, type MediaTab } from "./MediaPanel";
import type { PickedGif } from "./GifPicker";
import { btn, card, field } from "./ui";

export type Role = "requester" | "agent" | "manager" | "admin";

// Priority uses the same traffic-light colours as the logo and the live board.
const BADGE: Record<string, string> = {
  urgent: "bg-red-50 text-red-800 ring-red-300",
  high: "bg-orange-50 text-orange-800 ring-orange-300",
  medium: "bg-amber-50 text-amber-800 ring-amber-300",
  low: "bg-green-50 text-green-800 ring-green-300",
  open: "bg-sky-50 text-sky-800 ring-sky-300",
  in_progress: "bg-indigo-50 text-indigo-800 ring-indigo-300",
  waiting: "bg-purple-50 text-purple-800 ring-purple-300",
  resolved: "bg-emerald-50 text-emerald-800 ring-emerald-300",
  closed: "bg-stone-100 text-stone-600 ring-stone-300",
};
export const Badge = ({ v }: { v: string }) => (
  <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ring-1 ring-inset ${BADGE[v] ?? BADGE.open}`}>
    {v.replace("_", " ")}
  </span>
);

const STATUSES = [
  { v: "open", label: "Open", dot: "bg-sky-500" },
  { v: "in_progress", label: "In progress", dot: "bg-indigo-500" },
  { v: "waiting", label: "Waiting", dot: "bg-purple-500" },
  { v: "resolved", label: "Resolved", dot: "bg-emerald-500" },
  { v: "closed", label: "Closed", dot: "bg-stone-500" },
];

const initials =(n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(ts: number) {
  const d = new Date(ts * 1000), today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
const eventText = (e: any) => {
  const who = e.actor ?? "Someone";
  if (e.field === "call_request") {
    if (e.new_value === "asked") return `📞 ${who} asked for a call${e.old_value ? ` · “${e.old_value}”` : ""}`;
    if (e.old_value === "cancelled") return `${who} cancelled the call request`;
    if (e.old_value === "dismissed") return `${who} closed the call request`;
    return ""; // answered: the call itself has its own line
  }
  if (e.field === "call") {
    const s = Number(e.new_value) || 0;
    if (e.old_value === "ended") return `📞 Call started by ${who} · ${s < 60 ? s + " s" : Math.round(s / 60) + " min"}`;
    return `📞 ${who} called · ${e.old_value === "declined" ? "declined" : "no answer"}`;
  }
  if (e.field === "status") return `${who} changed the status to ${String(e.new_value).replace("_", " ")}`;
  if (e.field === "priority") return `${who} set the priority to ${e.new_value}`;
  if (e.field === "duplicate") return e.new_value ? `${who} marked this as a duplicate of ${e.new_value}` : `${who} unlinked this from ${e.old_value ?? "another ticket"}`;
  if (e.field === "assignee") return e.new_name ? `${who} assigned this to ${e.new_name}` : `${who} unassigned this ticket`;
  return ""; // a kind of event this version does not know: leave it out rather than guess
};

type Item =
  | { kind: "msg"; key: string; ts: number; m: any; pending?: boolean }
  | { kind: "event"; key: string; ts: number; text: string };

/** One ticket: the description and controls on the left, a chat with the other side on the right.
    Used by normal users, agents and admins. Staff can also leave internal notes the requester never sees. */
export function TicketView({ id, role, base }: { id: number; role: Role; base: string }) {
  const staff = role !== "requester";
  const admin = role === "admin"; // admins can set a final (locked) priority and release it
  const [d, setD] = useState<any>(null);
  const [agents, setAgents] = useState<any[]>([]);
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [pending, setPending] = useState<any[]>([]);
  const [sending, setSending] = useState(false);
  const [alsoLinked, setAlsoLinked] = useState(false); // send this reply to the tickets that follow this one, too
  const [showPc, setShowPc] = useState(false);
  const [busy, setBusy] = useState(false); // a status/priority/assignee change is on its way
  const { toast, confirm } = useNotify();
  const drafts = useDrafts(base, id); // a refused file shows its reason on its own chip, so no toast (it would cover the Send button)
  const drop = useDrop(drafts.add);
  const { list: replyList, reload: reloadReplies } = useReplies(staff);
  const [picker, setPicker] = useState(false);
  const [panel, setPanel] = useState<MediaTab | null>(null); // the emoji / GIF panel above the message box
  const [typer, setTyper] = useState(""); // who is typing to us right now
  const typerTimer = useRef(0);
  const lastTypingSent = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true); // keep the view pinned to the newest message unless the reader scrolled up
  const seen = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<number | null>(null); // pixel height that makes the page exactly fill the window, so nothing scrolls
  const [pane, setPane] = useState<"chat" | "details">("chat"); // phones show one pane at a time

  // A tab nobody is looking at asks with peek=1, so it does not mark messages as seen (read receipts).
  const load = () => api(`${base}/${id}${document.hidden ? "?peek=1" : ""}`).then(setD);
  useEffect(() => {
    void load();
    if (staff) void api(`${base}/agents`).then(setAgents);
    // New messages arrive without a refresh. Paused while the tab is hidden.
    const timer = setInterval(() => { if (!document.hidden) void load().catch(() => {}); }, 30000); // safety net; pushes below are instant
    // A notification about this ticket means a new message: fetch it now instead of waiting for the next tick.
    const onNote = (e: Event) => { if ((e as CustomEvent).detail?.some((n: any) => n.ticket_id === id)) void load().catch(() => {}); };
    window.addEventListener("fg:notify", onNote);
    // Coming back to the tab: fetch now, which is also the moment the new messages count as seen.
    const onVisible = () => { if (!document.hidden) void load().catch(() => {}); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); window.removeEventListener("fg:notify", onNote); document.removeEventListener("visibilitychange", onVisible); window.clearTimeout(typerTimer.current); };
  }, [id]);

  useLive(streamFor(staff), () => void load().catch(() => {})); // a message or status change anywhere refreshes the open ticket at once
  useLive(streamFor(staff), (_e, data) => {
    if (data.ticket !== id || !data.name) return;
    setTyper(staff ? data.name : "IT");
    window.clearTimeout(typerTimer.current);
    typerTimer.current = window.setTimeout(() => setTyper(""), 5000);
  }, ["typing"]);

  // Size the page to the window: whatever is above the ticket (header, back button) and below it (footer) is subtracted, and the
  // two panes scroll inside themselves. The message box therefore never leaves the screen.
  const ready = !!d;
  useLayoutEffect(() => {
    const measure = () => {
      const el = rootRef.current;
      if (!el) return;
      // Where the box sits on the page, from layout positions: getBoundingClientRect() includes the page's slide-in animation, which made the
      // first measurement too small and left a visible jump when the box was measured again after the animation.
      let top = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;
      const main = el.closest("main");
      const below = (main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 24) + (document.querySelector("footer")?.getBoundingClientRect().height ?? 0);
      setFit(Math.max(360, Math.floor(window.innerHeight - top - below - 2)));
    };
    window.scrollTo(0, 0);
    measure();
    // Keep measuring every frame while things above are still opening or sliding (the page animation, a banner), so the box follows them
    // smoothly instead of jumping once at the end. Then stop: after that only a resize matters.
    let raf = 0;
    const until = performance.now() + 900;
    const follow = () => { measure(); if (performance.now() < until) raf = requestAnimationFrame(follow); };
    raf = requestAnimationFrame(follow);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", measure); };
  }, [ready]);

  const count = d ? d.comments.length + d.events.length + pending.length : 0;
  useEffect(() => { setTyper(""); }, [d?.comments.length]);
  useLayoutEffect(() => { const el = listRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [panel]);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current && (count !== seen.current || typer)) el.scrollTop = el.scrollHeight;
    seen.current = count;
  }, [count, typer]);
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
    ta.style.overflowY = ta.scrollHeight > 160 ? "auto" : "hidden";
  }, [text]);

  if (!d) return <p className="text-neutral-500">Loading…</p>;
  const t = d.ticket;
  const locked = !!t.priority_locked;
  const closed = t.status === "closed";
  const patch = (json: object) => {
    setBusy(true);
    return api(`${base}/${id}`, { method: "PATCH", json })
      .then(() => {}, (e) => toast(e.message, "error", "Couldn't update the ticket"))
      .then(load).catch(() => {}).finally(() => setBusy(false));
  };

  // Resolving with steps still unticked is allowed (a step may not apply), but never by accident.
  const resolve = async () => {
    const left = ((d.tasks ?? []) as Task[]).filter((k) => !k.done).length;
    if (left && !(await confirm({ title: `${left} checklist step${left === 1 ? " is" : "s are"} not ticked`, body: "Resolve the ticket anyway?", confirmLabel: "Resolve anyway" }))) return;
    await patch({ status: "resolved" });
  };

  const items: Item[] = [
    ...d.comments.map((m: any): Item => ({ kind: "msg", key: "c" + m.id, ts: m.created_at, m })),
    ...d.events.filter((e: any) => eventText(e)).map((e: any): Item => ({ kind: "event", key: "e" + e.id, ts: e.created_at, text: eventText(e) })),
    ...pending.map((m: any): Item => ({ kind: "msg", key: "p" + m.id, ts: m.created_at, m, pending: true })),
  ].sort((a, b) => a.ts - b.ts);

  const send = async () => {
    const body = text.trim();
    if ((!body && !drafts.ids.length) || sending || drafts.busy) return;
    const temp = {
      id: Date.now(), body, internal, created_at: Math.floor(Date.now() / 1000), author_id: d.me, author: "You",
      files: drafts.items.filter((x) => x.state === "ready").map((x) => ({ id: 0, name: x.name, mime: "", size: x.size })),
    };
    setSending(true);
    setPending((p) => [...p, temp]);
    stick.current = true;
    setText("");
    try {
      const sentTo = await api<{ also?: number }>(`${base}/${id}/comments`, { method: "POST", json: { body, internal, attachment_ids: drafts.ids, also_linked: staff && !internal && alsoLinked ? true : undefined } });
      drafts.reset(); // the files now belong to the message
      if (alsoLinked) { setAlsoLinked(false); if (sentTo.also) toast(`Also sent to ${sentTo.also} linked ticket${sentTo.also === 1 ? "" : "s"}.`, "success"); }
      await load();
    } catch (e: any) {
      setText(body); // hand the words back so nothing is lost
      toast(e.message, "error", "Message not sent");
    } finally {
      setPending((p) => p.filter((x) => x.id !== temp.id));
      setSending(false);
      taRef.current?.focus();
    }
  };

  const insertEmoji = (e: string) => {
    const ta = taRef.current;
    const at = ta ? ta.selectionStart : text.length;
    const to = ta ? ta.selectionEnd : text.length;
    setText((p) => p.slice(0, at) + e + p.slice(to));
    setTimeout(() => { ta?.focus(); ta?.setSelectionRange(at + e.length, at + e.length); }, 0);
  };
  const sendGif = async (g: PickedGif) => {
    setPanel(null);
    if (sending) return;
    setSending(true);
    stick.current = true;
    try {
      await api(`${base}/${id}/gif`, { method: "POST", json: { source: g.source, id: g.id, caption: text.trim(), internal } });
      setText("");
      await load();
    } catch (e: any) {
      toast(e.message, "error", "GIF not sent");
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  };
  const announceTyping = (value: string) => {
    if (internal || !value.trim() || Date.now() - lastTypingSent.current < 3000) return;
    lastTypingSent.current = Date.now();
    void api(`${base}/${id}/typing`, { method: "POST", json: {} }).catch(() => {});
  };

  // Read receipts: the other side's marker says which of MY messages they have had on screen.
  const seenInfo: { id: number; at: number; by: string } | null = d.seen ?? null;
  const seenMine: number[] = seenInfo ? d.comments.filter((m: any) => m.author_id === d.me && !m.internal && !m.deleted_at && m.id <= seenInfo.id).map((m: any) => m.id) : [];
  const lastSeenId = seenMine.length ? seenMine[seenMine.length - 1] : null;

  let lastDay = "";
  let prev: Item | undefined;
  return (
    <div ref={rootRef} style={fit ? { height: fit } : undefined} className="flex min-h-0 flex-col gap-3 xl:grid xl:grid-cols-5 xl:grid-rows-1 xl:gap-6">
      <div className="flex shrink-0 rounded-full bg-stone-100 p-0.5 text-sm font-semibold xl:hidden" role="tablist" aria-label="Ticket view">
        {([["chat", "Chat"], ["details", "Details"]] as const).map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={pane === v} onClick={() => setPane(v)}
            className={`flex-1 rounded-full py-1.5 transition-colors ${pane === v ? "bg-ink text-white dark:bg-brand-green dark:text-ink" : "text-neutral-600"}`}>
            {label}
          </button>
        ))}
      </div>
      <div className={`min-h-0 min-w-0 space-y-4 overflow-y-auto pr-1 max-xl:flex-1 xl:col-span-2 xl:h-full ${pane === "chat" ? "max-xl:hidden" : ""}`}>
        <div>
          <div className="text-sm text-neutral-500">{t.ref}</div>
          <h2 className="text-2xl font-extrabold">{t.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-neutral-600">
            <Badge v={t.status} /><Badge v={t.priority} />
            {t.status === "in_progress" && (
              <span className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-xs font-bold text-white">
                <span className="now-dot" /> Being worked on <span className="working-dots"><i /><i /><i /></span>
              </span>
            )}
            {locked && <span className="text-xs font-semibold text-neutral-500">🔒 set by admin</span>}
          </div>
          <div className="mt-2 space-y-0.5 text-sm text-neutral-600">
            <div>Raised by {t.requester}{staff && t.requester_email ? ` (${t.requester_email})` : ""} · {fmt(t.created_at)}</div>
            {t.category && <div>Category: {t.category}</div>}
            {t.assignee && <div>Assigned to {t.assignee}</div>}
          </div>
        </div>
        {staff && t.due_at && <SlaBar t={t} due={fmt(t.due_at)} />}
        {staff && (
          <section className={card + " space-y-4"} aria-label="Ticket controls">
            {/* The one big action: whatever moves this ticket forward from where it is now. */}
            {t.status !== "resolved" && !closed && (
              <button type="button" disabled={busy} onClick={() => void resolve()}
                className="flex w-full items-center justify-center gap-3 rounded-2xl bg-brand-green px-6 py-5 text-xl font-extrabold text-ink shadow-md transition hover:brightness-110 active:scale-[0.99] focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-green/40 disabled:cursor-wait disabled:opacity-60">
                <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                Mark as resolved
              </button>
            )}
            {t.status === "resolved" && (
              <div className="rounded-2xl bg-emerald-50 p-4 ring-1 ring-inset ring-emerald-300">
                <div className="flex items-center gap-2 text-lg font-extrabold text-emerald-800">
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  Resolved
                </div>
                <p className="mt-0.5 text-xs text-emerald-800/80">{admin ? "Close it to finish, or pick another status below to keep working on it." : "An admin closes resolved tickets at the end of the day."}</p>
                {admin && (
                  <button type="button" disabled={busy} onClick={() => patch({ status: "closed" })} className={btn + " mt-3 w-full !py-3 !text-base"}>Close ticket</button>
                )}
              </div>
            )}
            {closed && (
              <div className="rounded-2xl bg-stone-100 p-4 ring-1 ring-inset ring-stone-300">
                <div className="text-lg font-extrabold text-fg">Closed</div>
                <p className="mt-0.5 text-xs text-neutral-500">{admin ? "Messaging is off. Reopen it to continue." : "Closed by an admin. Only an admin can reopen it."}</p>
                {admin && (
                  <button type="button" disabled={busy} onClick={() => patch({ status: "open" })} className={btn + " mt-3 w-full !py-3 !text-base"}>Reopen ticket</button>
                )}
              </div>
            )}

            <div>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-neutral-500">Status</h3>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Status">
                {STATUSES.filter((s) => s.v !== "closed" || admin || closed).map((s) => {
                  const on = t.status === s.v;
                  return (
                    <button key={s.v} type="button" role="radio" aria-checked={on} disabled={busy || (closed && !admin)}
                      title={s.v === "closed" && !admin ? "Only an admin can close or reopen" : undefined}
                      onClick={() => { if (!on) void (s.v === "resolved" ? resolve() : patch({ status: s.v })); }}
                      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold ring-1 ring-inset transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green disabled:cursor-not-allowed disabled:opacity-60 ${on ? BADGE[s.v] + " shadow-sm" : "bg-surface text-neutral-600 ring-stone-300 hover:bg-stone-100"}`}>
                      <span className={`h-2 w-2 rounded-full ${s.dot} ${on ? "" : "opacity-50"}`} />{s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-neutral-500">Priority {locked && <span className="normal-case tracking-normal">🔒</span>}</h3>
              <div className="grid grid-cols-4 gap-1 rounded-xl bg-stone-100 p-1" role="radiogroup" aria-label="Priority">
                {["low", "medium", "high", "urgent"].map((p) => {
                  const on = t.priority === p;
                  return (
                    <button key={p} type="button" role="radio" aria-checked={on} disabled={busy || (locked && !admin)}
                      onClick={() => { if (!on) patch({ priority: p }); }}
                      className={`min-w-0 truncate rounded-lg px-2 py-1.5 text-sm font-semibold capitalize transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green disabled:cursor-not-allowed ${on ? BADGE[p] + " shadow-sm ring-1 ring-inset" : "text-neutral-600 hover:bg-stone-200/70 disabled:opacity-50"}`}>
                      {p}
                    </button>
                  );
                })}
              </div>
              {locked && !admin && <p className="mt-1.5 text-xs text-neutral-500">An admin set this priority, so it can't be changed.</p>}
              {admin && !locked && <p className="mt-1.5 text-xs text-neutral-500">As an admin, the priority you set is final: agents won't be able to change it.</p>}
              {admin && locked && (
                <p className="mt-1.5 text-xs text-neutral-500">Locked by an admin. <button className="font-semibold underline" onClick={() => patch({ priority_locked: false })}>Unlock for agents</button></p>
              )}
            </div>

            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-neutral-500">Assigned to</span>
              <select className={field} value={t.assignee_id ?? ""} disabled={busy} onChange={(e) => patch({ assignee_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Unassigned</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          </section>
        )}
        {staff && <TaskList base={base} id={id} tasks={d.tasks ?? []} readOnly={closed} onChanged={() => void load().catch(() => {})} />}
        {staff && <DuplicatesCard base={base} id={id} role={role} ticket={{ ref: t.ref, requester: t.requester }} duplicateOf={d.duplicate_of ?? null} duplicates={d.duplicates ?? []} closed={closed} onChanged={() => void load().catch(() => {})} />}
        {staff && d.device && <DeviceSummary d={d.device} onOpen={() => setShowPc(true)} />}
        {staff && d.device && showPc && <DeviceDrawer d={d.device} onClose={() => setShowPc(false)} />}
        <section className={card}>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-500">Description</h3>
          <p className="whitespace-pre-wrap break-words text-sm">{t.description}</p>
          <SentFiles files={d.files ?? []} base={base} ticketId={id} />
        </section>
        {(d.answers ?? []).length > 0 && (
          <section className={card} aria-label="Answers to the questions">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-500">Quick questions</h3>
            <dl className="space-y-2 text-sm">
              {(d.answers as { label: string; value: string }[]).map((a, i) => (
                <div key={i}><dt className="text-xs text-neutral-500">{a.label}</dt><dd className="whitespace-pre-wrap break-words font-semibold">{a.value}</dd></div>
              ))}
            </dl>
          </section>
        )}
        {staff && !!t.rating && (
          <section className={card} aria-label="Requester feedback">
            <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-neutral-500">Requester feedback</h3>
            <p className={`text-sm font-semibold ${t.rating === 1 ? "text-ok" : "text-red-700"}`}>{t.rating === 1 ? "👍 Said it was fixed" : "👎 Said it was not fixed"}</p>
            {t.rating_comment && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-600">“{t.rating_comment}”</p>}
            <p className="mt-1 text-xs text-neutral-500">{fmt(t.rated_at)}</p>
          </section>
        )}
      </div>

      <section
        className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-stone-200 bg-surface shadow-sm max-xl:flex-1 xl:col-span-3 xl:h-full ${pane === "details" ? "max-xl:hidden" : ""}`}
        aria-label="Conversation"
        {...(closed ? {} : drop.props)}
      >
        <DropVeil show={drop.over && !closed} />
        <header className="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-bold"><span className="xl:hidden">{t.ref} · {t.title}</span><span className="hidden xl:inline">Conversation</span></h3>
            <p className="truncate text-xs text-neutral-500">
              {closed ? "Closed. Read only." : staff ? `With ${t.requester}. Internal notes stay inside IT.` : t.assignee ? `${t.assignee} from IT is on this.` : "IT will reply here."}
            </p>
          </div>
          <span className="hidden rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-600 sm:inline">
            {d.comments.length} message{d.comments.length === 1 ? "" : "s"}
          </span>
          {!closed && staff && t.requester_id !== d.me && <CallButton ticketId={id} name={t.requester} />}
          {!closed && !staff && <RequestCallButton ticketId={id} base={base} request={d.call_request} onChanged={() => void load().catch(() => {})} />}
        </header>
        {!staff && d.duplicate_of && (
          <div className="border-b border-stone-200 bg-brand-amber/15 px-4 py-2 text-xs text-fg" role="status">IT is handling this together with another ticket about the same problem ({d.duplicate_of.ref}). You will be told here as soon as it is fixed.</div>
        )}
        {!closed && d.call_request && <CallRequestBar request={d.call_request} staff={staff} ticketId={id} base={base} requester={t.requester} onChanged={() => void load().catch(() => {})} />}

        <div
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="flex-1 space-y-1 overflow-y-auto bg-stone-50 px-4 py-4"
          role="log"
          aria-live="polite"
        >
          {items.length === 0 && (
            <div className="grid h-full place-items-center text-center text-sm text-neutral-500">
              <div>
                <div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-full bg-brand-green/15 text-xl">💬</div>
                {staff ? "No messages yet. Reply to start the conversation." : "No messages yet. Write below and IT will reply here."}
              </div>
            </div>
          )}
          {items.map((it) => {
            const day = dayLabel(it.ts);
            const sep = day !== lastDay ? (lastDay = day) : "";
            const before = prev;
            prev = it;
            const separator = sep ? (
              <div key={"d" + it.key} className="flex justify-center py-2">
                <span className="rounded-full bg-stone-200 px-3 py-0.5 text-[11px] font-semibold text-neutral-600">{sep}</span>
              </div>
            ) : null;
            if (it.kind === "event")
              return [separator, <div key={it.key} className="py-1 text-center text-xs text-neutral-500">{it.text} · {clock(it.ts)}</div>];
            const m = it.m;
            const mine = m.author_id === d.me;
            const isIT = m.author_role === "agent" || m.author_role === "admin";
            const grouped = !sep && before?.kind === "msg" && before.m.author_id === m.author_id && !!before.m.internal === !!m.internal && it.ts - before.ts < 300;
            const seenHere = !it.pending && seenMine.includes(m.id);
            return [
              separator,
              <ChatMessage
                key={it.key}
                m={m}
                mine={mine}
                isIT={isIT}
                grouped={grouped}
                staff={staff}
                admin={admin}
                pending={it.pending}
                closed={closed}
                base={base}
                ticketId={id}
                editWindow={d.edit_window ?? 900}
                avatar={initials(m.author)}
                time={clock(it.ts)}
                fullTime={fmt(it.ts)}
                seenIcon={seenHere}
                seenText={seenHere && m.id === lastSeenId && seenInfo ? `Seen by ${staff ? (t.requester as string).split(" ")[0] : seenInfo.by.split(" ")[0]} · ${clock(seenInfo.at)}` : null}
                onChanged={() => void load().catch(() => {})}
              />,
            ];
          })}
          {typer && (
            <div className="mt-2 flex items-center gap-2 px-1 text-xs text-neutral-500" role="status">
              <span className="working-dots"><i /><i /><i /></span> {typer} {typer === "IT" ? "is" : "is"} typing…
            </div>
          )}
        </div>

        {!staff && <RatingPrompt id={id} base={base} ticket={t} onDone={() => void load()} />}

        {closed ? (
          <div className="flex items-center gap-3 border-t border-stone-200 bg-stone-100 px-4 py-3.5 text-sm text-neutral-600" role="status">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-stone-200" aria-hidden>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
            </span>
            <span><b className="text-fg">This ticket is closed.</b> {staff ? (admin ? "Messaging is off. Reopen it from the status box to continue." : "Messaging is off.") : "Messaging is off. If the problem comes back, please raise a new ticket."}</span>
          </div>
        ) : (
        <>
        {panel && <MediaPanel staff={staff} tab={panel} onTab={setPanel} onEmoji={insertEmoji} onGif={(g) => void sendGif(g)} onClose={() => { setPanel(null); taRef.current?.focus(); }} />}
        <form
          className={`relative border-t border-stone-200 p-3 ${internal ? "bg-amber-400/10" : "bg-surface"}`}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {picker && staff && (
            <RepliesPicker list={replyList} reload={reloadReplies} admin={admin} draft={text}
              vars={{ name: t.requester, ref: t.ref, agent: agents.find((a) => a.id === d.me)?.name ?? "" }}
              onInsert={(s) => { setText((p) => (p.trim() ? p.replace(/\s+$/, "") + "\n" + s : s)); setTimeout(() => taRef.current?.focus(), 0); }}
              onClose={() => { setPicker(false); setTimeout(() => taRef.current?.focus(), 0); }} />
          )}
          {staff && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full bg-stone-100 p-0.5 text-xs font-semibold" role="tablist" aria-label="Message type">
              {([["Reply to requester", false], ["Internal note", true]] as const).map(([label, v]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={internal === v}
                  key={label}
                  onClick={() => setInternal(v)}
                  className={`rounded-full px-3 py-1 transition-colors ${internal === v ? (v ? "bg-amber-400 text-ink" : "bg-ink text-white dark:bg-brand-green dark:text-ink") : "text-neutral-600 hover:text-fg"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setPicker((p) => !p)} aria-expanded={picker} className="rounded-full border border-stone-300 px-3 py-1 text-xs font-semibold text-neutral-600 hover:border-stone-500 hover:text-fg">
              Saved replies <span className="text-neutral-400">/</span>
            </button>
            {!internal && (d.duplicates ?? []).filter((x: any) => x.status !== "resolved" && x.status !== "closed").length > 0 && (
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-brand-green/60 bg-brand-green/10 px-3 py-1 text-xs font-semibold text-fg">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#00a859]" checked={alsoLinked} onChange={(e) => setAlsoLinked(e.target.checked)} />
                Also send to {(d.duplicates ?? []).filter((x: any) => x.status !== "resolved" && x.status !== "closed").length} linked ticket{(d.duplicates ?? []).filter((x: any) => x.status !== "resolved" && x.status !== "closed").length === 1 ? "" : "s"}
              </label>
            )}
            </div>
          )}
          <PendingTray items={drafts.items} onRemove={drafts.remove} />
          <div className={`flex items-end gap-0.5 rounded-3xl border px-1.5 py-1 transition-shadow focus-within:ring-2 ${internal ? "border-amber-400 bg-amber-400/15 focus-within:ring-amber-400/40" : "border-stone-300 bg-surface focus-within:border-brand-green focus-within:ring-brand-green/25"}`}>
            <button type="button" aria-label="Emoji" title="Emoji" aria-pressed={panel === "emoji"} onClick={() => setPanel((p) => (p === "emoji" ? null : "emoji"))}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${panel === "emoji" ? "bg-brand-green/25 text-fg" : "text-neutral-600 hover:bg-fg/10 hover:text-fg"}`}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9.5" /><path d="M8 14.2c.9 1.4 2.3 2.2 4 2.2s3.1-.8 4-2.2" /><path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" /></svg>
            </button>
            <button type="button" aria-label="GIF" title="GIF" aria-pressed={panel === "gif"} onClick={() => setPanel((p) => (p === "gif" ? null : "gif"))}
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${panel === "gif" ? "bg-brand-green/25 text-fg" : "text-neutral-600 hover:bg-fg/10 hover:text-fg"}`}>
              <span className="rounded-md border-2 border-current px-1 text-[10px] font-extrabold leading-4 tracking-tight">GIF</span>
            </button>
            <AttachButton onFiles={drafts.add} className="!h-9 !w-9 !rounded-full" />
            <textarea
              ref={taRef}
              className="min-h-0 flex-1 resize-none bg-transparent px-1.5 py-2 text-sm text-fg placeholder:text-neutral-500 focus:outline-none"
              rows={1}
              maxLength={10000}
              aria-label={internal ? "Internal note" : "Message"}
              placeholder={internal ? "Write a note for the IT team only…" : staff ? `Message ${String(t.requester).split(" ")[0]}…` : "Message IT…"}
              value={text}
              onChange={(e) => { if (staff && e.target.value === "/" && !text) setPicker(true); else { setText(e.target.value); announceTyping(e.target.value); } }}
              onPaste={(e) => {
                const f = filesFromPaste(e);
                if (f.length) { e.preventDefault(); drafts.add(f); }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && panel) { setPanel(null); return; }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button type="submit" disabled={(!text.trim() && !drafts.ids.length) || sending || drafts.busy} aria-label="Send message" title="Send (Enter)"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-green text-ink shadow-sm transition hover:brightness-110 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green focus-visible:ring-offset-2 ring-offset-surface disabled:bg-stone-300 disabled:text-neutral-500 disabled:shadow-none disabled:hover:brightness-100">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9l.1 6.5Z" /></svg>
            </button>
          </div>
          <p className="mt-1 px-1 text-[11px] text-neutral-500">Enter to send · Shift+Enter for a new line · **bold** _italic_ `code`</p>
        </form>
        </>
        )}
      </section>
    </div>
  );
}
