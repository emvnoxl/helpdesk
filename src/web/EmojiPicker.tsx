import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { GROUPS, recentEmoji, rememberEmoji, searchEmoji } from "./emoji";

/** A small emoji popover: search, groups and recently used. Closes on Escape or a click elsewhere (except on `ignore`, the button that opened it). */
export function EmojiPicker({ onPick, onClose, ignore, className = "", docked = false }: { onPick: (e: string) => void; onClose: () => void; ignore?: RefObject<HTMLElement | null>; className?: string; docked?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(() => (recentEmoji().length ? "recent" : GROUPS[0]!.id));
  const recent = useMemo(recentEmoji, []);

  useEffect(() => {
    if (docked) return; // a docked panel is closed by its own button, not by clicking elsewhere
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || ignore?.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose, ignore, docked]);

  const shown: string[] = q.trim() ? searchEmoji(q).map((x) => x.e) : group === "recent" ? recent : (GROUPS.find((g) => g.id === group)?.items ?? []).map((s) => s.slice(0, s.indexOf(" ")));
  const words = (e: string) => GROUPS.flatMap((g) => g.items).find((s) => s.startsWith(e + " "))?.slice(e.length + 1).split(" ").slice(0, 3).join(" ") ?? e;
  const pick = (e: string) => { rememberEmoji(e); onPick(e); };
  const tabs = [...(recent.length ? [{ id: "recent", label: "Recent", icon: "🕘" }] : []), ...GROUPS];

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Emoji"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      className={docked ? "flex h-full min-h-0 flex-col text-fg" : `z-30 w-[21rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl ${className}`}
    >
      <div className="px-2 pb-1 pt-2">
        <input
          autoFocus={!docked}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          className="w-full rounded-lg border border-stone-300 bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-neutral-500 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25"
        />
      </div>
      {!q.trim() && (
        <div className="flex gap-0.5 overflow-x-auto border-b border-stone-200 px-2 pb-1.5" role="tablist" aria-label="Emoji groups">
          {tabs.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={group === g.id} title={g.label} onClick={() => setGroup(g.id)}
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-lg transition-colors ${group === g.id ? "bg-brand-green/25" : "hover:bg-fg/10"}`}>
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div className={docked ? "min-h-0 flex-1 overflow-y-auto p-2" : "max-h-60 overflow-y-auto p-2"}>
        {!q.trim() && <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wider text-neutral-500">{tabs.find((g) => g.id === group)?.label}</p>}
        {shown.length ? (
          <div className={docked ? "grid grid-cols-[repeat(auto-fill,minmax(2.6rem,1fr))] gap-0.5" : "grid grid-cols-8 gap-0.5"}>
            {shown.map((e, i) => (
              <button key={e + i} type="button" onClick={() => pick(e)} title={words(e)} aria-label={words(e)}
                className="grid h-9 w-9 place-items-center rounded-lg text-[1.35rem] leading-none hover:bg-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
                {e}
              </button>
            ))}
          </div>
        ) : (
          <p className="px-1 py-6 text-center text-sm text-neutral-500">{q.trim() ? "No emoji match that." : "Nothing here yet."}</p>
        )}
      </div>
    </div>
  );
}
