import { EmojiPicker } from "./EmojiPicker";
import { GifPicker, type PickedGif } from "./GifPicker";

export type MediaTab = "emoji" | "gif";

/** The emoji and GIF panel that opens right above the message box, like WhatsApp Web or Teams: one place, two tabs, and it stays open
    while you add several emoji. Picking a GIF sends it and closes the panel. */
export function MediaPanel({ staff, tab, onTab, onEmoji, onGif, onClose }: { staff: boolean; tab: MediaTab; onTab: (t: MediaTab) => void; onEmoji: (e: string) => void; onGif: (g: PickedGif) => void; onClose: () => void }) {
  const tabs: { id: MediaTab; label: string; icon: React.ReactNode }[] = [
    { id: "emoji", label: "Emoji", icon: <span className="text-base leading-none">😊</span> },
    { id: "gif", label: "GIF", icon: <span className="rounded border-2 border-current px-0.5 text-[9px] font-extrabold leading-tight">GIF</span> },
  ];
  return (
    <div className="media-rise flex h-[52%] max-h-[20rem] min-h-[15rem] shrink-0 flex-col border-t border-stone-200 bg-surface text-fg" aria-label="Emoji and GIFs">
      <div className="flex items-center gap-1 border-b border-stone-200 px-2 py-1" role="tablist" aria-label="Emoji or GIF">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${tab === t.id ? "bg-brand-green/25 text-fg" : "text-neutral-600 hover:bg-fg/10"}`}>
            {t.icon}{t.label}
          </button>
        ))}
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="ml-auto grid h-8 w-8 place-items-center rounded-full text-neutral-600 hover:bg-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "emoji" ? <EmojiPicker docked onPick={onEmoji} onClose={onClose} /> : <GifPicker docked staff={staff} onPick={onGif} onClose={onClose} />}
      </div>
    </div>
  );
}
