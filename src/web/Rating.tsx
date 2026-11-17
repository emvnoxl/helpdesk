import { useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { btn, field } from "./ui";

/* After IT marks a ticket resolved, the requester is asked one question: was it fixed? A thumbs-down puts the ticket back in the queue. */

const Thumb = ({ up }: { up: boolean }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={up ? undefined : { transform: "scaleY(-1)" }}>
    <path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM7 11l4-8a2.5 2.5 0 0 1 2.5 2.7L13 9h5.5a2 2 0 0 1 2 2.3l-1.1 7a2 2 0 0 1-2 1.7H7" />
  </svg>
);

export const needsRating = (t: { status: string; rated_at?: number | null; resolved_at?: number | null }) =>
  (t.status === "resolved" || t.status === "closed") && (!t.rated_at || (!!t.resolved_at && t.rated_at < t.resolved_at));

export function RatingPrompt({ id, base, ticket, onDone }: { id: number; base: string; ticket: { status: string; rating?: number | null; rating_comment?: string | null; rated_at?: number | null; resolved_at?: number | null }; onDone: () => void }) {
  const { toast } = useNotify();
  const [pick, setPick] = useState<1 | -1 | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const closed = ticket.status === "closed";

  if (!needsRating(ticket)) {
    if (!ticket.rated_at) return null;
    return (
      <div className="flex items-center gap-2.5 border-t border-stone-200 bg-stone-50 px-4 py-2.5 text-xs text-neutral-600" role="status">
        <span className={ticket.rating === 1 ? "text-brand-green" : "text-red-600"}><Thumb up={ticket.rating === 1} /></span>
        <span>You said this was <b className="text-fg">{ticket.rating === 1 ? "fixed" : "not fixed"}</b>. Thanks for the feedback.</span>
      </div>
    );
  }

  const send = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const r = await api<{ reopened: boolean }>(`${base}/${id}/rating`, { method: "POST", json: { rating: pick, comment } });
      toast(r.reopened ? "IT has been told and the ticket is back in the queue." : pick === 1 ? "Thanks, glad it's sorted." : "Thanks. IT has seen your note, please raise a new ticket so it's picked up.", r.reopened || pick === -1 ? "info" : "success", r.reopened ? "Ticket reopened" : "Thanks for telling us");
      onDone();
    } catch (e: any) {
      toast(e.message, "error", "Couldn't send your feedback");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-stone-200 bg-brand-green/10 px-4 py-3" role="group" aria-label="Was this fixed?">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-bold">Was this fixed?</span>
        {([1, -1] as const).map((v) => (
          <button key={v} type="button" aria-pressed={pick === v} onClick={() => setPick(v)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${pick === v ? (v === 1 ? "border-brand-green bg-brand-green text-ink" : "border-red-500 bg-red-600 text-white") : "border-stone-300 bg-surface hover:border-stone-500"}`}>
            <Thumb up={v === 1} />{v === 1 ? "Yes, thanks" : "Not yet"}
          </button>
        ))}
      </div>
      {pick && (
        <div className="mt-3 space-y-2">
          <textarea className={field + " !min-h-0"} rows={2} maxLength={500} aria-label="Anything to add?" placeholder={pick === 1 ? "Anything to add? (optional)" : "What is still wrong? (optional)"} value={comment} onChange={(e) => setComment(e.target.value)} />
          {pick === -1 && closed && <p className="text-xs text-neutral-600">This ticket has been closed, so it can't be reopened. Your note goes to IT; please also raise a new ticket.</p>}
          <button type="button" className={btn} disabled={busy} onClick={() => void send()}>{busy ? "Sending…" : pick === -1 && !closed ? "Send and reopen the ticket" : "Send feedback"}</button>
        </div>
      )}
    </div>
  );
}
