import { useRef, useState } from "react";
import { api } from "./api";
import { SentFiles } from "./Attach";
import { EmojiPicker } from "./EmojiPicker";
import { GiphyMessage } from "./GiphyMessage";
import { QUICK } from "./emoji";
import { useNotify } from "./notify";
import { RichText } from "./RichText";
import { onlyEmoji } from "./chatformat";
import { field } from "./ui";

/* One message in the conversation: avatar, name, the bubble (text with light formatting, a GIF, or "deleted"), reactions under it,
   the time with "edited" and read receipts, and a small toolbar on hover or tap (react, edit, delete). */

export interface Reaction { emoji: string; n: number; mine: boolean; names: string[] }

const Ticks = () => (
  <svg width="15" height="11" viewBox="0 0 20 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M1.5 7.5 5.5 11.5 12 3" /><path d="M8 11.5 8.8 12.3 18 2.5" /></svg>
);

interface Props {
  m: any;
  mine: boolean;
  isIT: boolean;
  grouped: boolean;
  staff: boolean;
  admin: boolean;
  pending?: boolean;
  closed: boolean;
  base: string;
  ticketId: number;
  editWindow: number;
  avatar: string;
  time: string;
  fullTime: string;
  seenIcon: boolean;
  seenText: string | null;
  onChanged: () => void;
}

export function ChatMessage({ m, mine, isIT, grouped, staff, admin, pending, closed, base, ticketId, editWindow, avatar, time, fullTime, seenIcon, seenText, onChanged }: Props) {
  const { toast, confirm } = useNotify();
  const [active, setActive] = useState(false); // a tap shows the toolbar on phones
  const [reacting, setReacting] = useState(false);
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  const deleted = !!m.deleted_at;
  const within = Date.now() / 1000 - m.created_at < editWindow;
  const canEdit = mine && !pending && !closed && !deleted && m.kind === "text" && within;
  const canDelete = !pending && !deleted && !closed && ((mine && within) || (admin && !mine));
  const gif = (m.files ?? []).find((f: any) => f.mime === "image/gif" && f.id > 0);
  const giphy = m.kind === "giphy" && m.gif_ref ? String(m.gif_ref) : "";
  const big = !deleted && !m.internal && m.kind === "text" && !(m.files ?? []).length ? onlyEmoji(m.body) : 0;
  const reactions: Reaction[] = m.reactions ?? [];
  const url = `${base}/${ticketId}/comments/${m.id}`;

  const fail = (e: unknown, title: string) => toast((e as Error).message, "error", title);
  const react = async (emoji: string) => {
    setReacting(false);
    setMore(false);
    setActive(false);
    try { await api(`${url}/react`, { method: "POST", json: { emoji } }); onChanged(); } catch (e) { fail(e, "Couldn't add the reaction"); }
  };
  const save = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    if (body === m.body) return setEditing(false);
    setBusy(true);
    try { await api(url, { method: "PATCH", json: { body } }); setEditing(false); onChanged(); } catch (e) { fail(e, "Couldn't save the change"); }
    setBusy(false);
  };
  const remove = async () => {
    setActive(false);
    const ok = await confirm({
      title: "Delete this message?",
      body: mine ? "It disappears for everyone in the conversation. This can't be undone." : "You are removing someone else's message as an admin. It disappears for everyone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    try { await api(url, { method: "DELETE" }); onChanged(); } catch (e) { fail(e, "Couldn't delete the message"); }
  };

  const bubble = deleted
    ? "rounded-2xl border border-dashed border-stone-300 bg-transparent text-neutral-500"
    : big
      ? "bg-transparent shadow-none"
      : m.internal
        ? "border border-dashed border-amber-400 bg-amber-50 text-amber-900"
        : mine
          ? "rounded-br-md bg-brand-green text-ink"
          : "rounded-bl-md border border-stone-200 bg-surface";
  const showTools = !pending && !deleted && !editing;

  return (
    <div className={`msg-in flex items-end gap-2 ${mine ? "flex-row-reverse" : ""} ${grouped ? "mt-0.5" : "mt-3"}`}>
      <div className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold ${grouped ? "invisible" : isIT ? "bg-ink text-white" : "bg-brand-amber text-ink"}`} aria-hidden>{avatar}</div>
      <div className={`flex min-w-0 max-w-[82%] flex-col ${mine ? "items-end" : "items-start"}`}>
        {!grouped && (
          <div className="mb-0.5 px-1 text-xs text-neutral-500">
            <span className="font-semibold text-neutral-700">{mine ? "You" : m.author}</span>
            {isIT && !mine && !staff && " · IT"}
          </div>
        )}
        <div className="group relative max-w-full">
          {showTools && (
            <div className={`absolute -top-4 z-10 items-center gap-0.5 rounded-full border border-stone-200 bg-surface px-1 py-0.5 text-sm text-fg shadow-md ${mine ? "right-1" : "left-1"} ${active || reacting || more ? "flex" : "hidden group-focus-within:flex group-hover:flex"}`}>
              {!closed && (
                <button ref={toggle} type="button" aria-label="React" title="React" onClick={() => { setReacting((v) => !v); setMore(false); }} className="grid h-6 w-6 place-items-center rounded-full hover:bg-fg/10">😊</button>
              )}
              {canEdit && <button type="button" aria-label="Edit message" title="Edit" onClick={() => { setDraft(m.body); setEditing(true); setActive(false); }} className="grid h-6 w-6 place-items-center rounded-full hover:bg-fg/10">✏️</button>}
              {canDelete && <button type="button" aria-label="Delete message" title="Delete" onClick={() => void remove()} className="grid h-6 w-6 place-items-center rounded-full hover:bg-fg/10">🗑️</button>}
            </div>
          )}
          {reacting && !more && (
            <div className={`absolute -top-12 z-20 flex items-center gap-0.5 rounded-full border border-stone-200 bg-surface px-1.5 py-1 shadow-xl ${mine ? "right-0" : "left-0"}`}>
              {QUICK.map((e) => <button key={e} type="button" onClick={() => void react(e)} aria-label={`React ${e}`} className="grid h-8 w-8 place-items-center rounded-full text-xl transition-transform hover:scale-125 hover:bg-fg/10">{e}</button>)}
              <button type="button" onClick={() => setMore(true)} aria-label="More emoji" title="More" className="grid h-8 w-8 place-items-center rounded-full text-sm font-bold hover:bg-fg/10">＋</button>
            </div>
          )}
          {more && <EmojiPicker onPick={(e) => void react(e)} onClose={() => { setMore(false); setReacting(false); }} ignore={toggle} className={`absolute bottom-full mb-6 ${mine ? "right-0" : "left-0"}`} />}

          <div
            onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button,textarea,img")) setActive((v) => !v); }}
            className={`${bubble} ${big ? "" : "rounded-2xl px-3.5 py-2 shadow-sm"} ${(gif || giphy) && !m.body ? "!p-1" : ""} min-w-0 text-sm ${pending ? "opacity-60" : ""}`}
          >
            {deleted ? (
              <span className="italic">This message was deleted</span>
            ) : editing ? (
              <div className="w-[min(26rem,70vw)]">
                <textarea
                  autoFocus
                  value={draft}
                  maxLength={10000}
                  rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditing(false);
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
                  }}
                  aria-label="Edit your message"
                  className={`${field} !bg-surface text-fg`}
                />
                <div className="mt-1.5 flex items-center justify-end gap-2 text-xs">
                  <span className="mr-auto text-neutral-600">Enter to save · Esc to cancel</span>
                  <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2 py-1 font-semibold text-neutral-700 hover:bg-black/10">Cancel</button>
                  <button type="button" disabled={busy || !draft.trim()} onClick={() => void save()} className="rounded-md bg-ink px-3 py-1 font-bold text-white disabled:opacity-50">Save</button>
                </div>
              </div>
            ) : (
              <>
                {!!m.internal && <div className="mb-0.5 text-[11px] font-bold uppercase tracking-wide">Internal note · only IT sees this</div>}
                {giphy && <GiphyMessage id={giphy} staff={staff} />}
                {gif && <img src={`/api${base}/${ticketId}/attachments/${gif.id}`} alt={m.body || "GIF"} loading="lazy" className="max-h-56 max-w-[min(16rem,100%)] rounded-xl" />}
                {big ? <div className="text-5xl leading-tight" aria-label={m.body}>{m.body}</div> : m.body && <p className={`whitespace-pre-wrap break-words ${gif || giphy ? "px-2 pb-1 pt-1.5" : ""}`}><RichText text={m.body} /></p>}
                {!gif && <SentFiles files={m.files ?? []} base={base} ticketId={ticketId} tone={mine && !m.internal ? "mine" : "default"} />}
              </>
            )}
          </div>

          {reactions.length > 0 && (
            <div className={`-mt-1.5 flex flex-wrap gap-1 px-1 ${mine ? "justify-end" : ""}`}>
              {reactions.map((r) => (
                <button key={r.emoji} type="button" disabled={closed} onClick={() => void react(r.emoji)} title={r.names.join(", ") + (r.n > r.names.length ? ` and ${r.n - r.names.length} more` : "")} aria-pressed={r.mine}
                  className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-xs shadow-sm transition-colors ${r.mine ? "border-brand-green bg-brand-green/20 font-bold" : "border-stone-300 bg-surface hover:bg-fg/10"}`}>
                  <span className="text-sm leading-none">{r.emoji}</span>{r.n > 1 && <span>{r.n}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1 px-1 text-[11px] text-neutral-500" title={fullTime}>
          {pending ? "Sending…" : <>{time}{m.edited_at && !deleted ? " · edited" : ""}</>}
          {!pending && (seenIcon || seenText) && (
            <span className="inline-flex items-center gap-1 font-semibold text-ok">
              {seenIcon && <Ticks />}
              {seenText && <span>{seenText}</span>}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
