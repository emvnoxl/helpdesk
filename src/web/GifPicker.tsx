import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from "react";
import { api } from "./api";
import { loadGifConfig, type GifConfig } from "./gifConfig";

/* The GIF picker: GIPHY (its own web SDK, talking to GIPHY straight from the browser, as GIPHY requires) and the company's own library,
   in one place. Picking either sends it. The GIPHY part is a separate chunk, downloaded only when that tab is opened. */

const GiphyGrid = lazy(() => import("./GiphyGrid"));

export interface PickedGif { source: "giphy" | "library"; id: string | number; title: string }
interface Item { id: number; title: string }

export function GifPicker({ staff, onPick, onClose, ignore, className = "", docked = false }: { staff: boolean; onPick: (g: PickedGif) => void; onClose: () => void; ignore?: RefObject<HTMLElement | null>; className?: string; docked?: boolean }) {
  const base = staff ? "/staff/gifs" : "/gifs";
  const box = useRef<HTMLDivElement>(null);
  const [cfg, setCfg] = useState<GifConfig | null>(null);
  const [tab, setTab] = useState<"giphy" | "library">("giphy");
  const [q, setQ] = useState("");
  const [qNow, setQNow] = useState(""); // the search that is actually run (after a short pause in typing)
  const [lib, setLib] = useState<Item[]>([]);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [w, setW] = useState(340);

  useEffect(() => {
    if (docked) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || ignore?.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose, ignore, docked]);

  useEffect(() => {
    void loadGifConfig(staff, true)
      .then((c) => {
        setCfg(c);
        setTab(c.giphy ? "giphy" : "library");
        if (c.library) void api<{ items: Item[] }>(`${base}/library`).then((r) => setLib(r.items)).catch(() => {});
      })
      .catch(() => setCfg({ giphy: null, library: 0 }));
  }, [staff, base]);

  useEffect(() => { const t = setTimeout(() => setQNow(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (!scroller) return;
    const measure = () => setW(Math.max(200, scroller.clientWidth - 16));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [scroller]);

  const libShown = lib.filter((g) => !q.trim() || g.title.toLowerCase().includes(q.trim().toLowerCase()));
  const none = cfg && !cfg.giphy && !cfg.library;

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="GIFs"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      className={docked ? "flex h-full min-h-0 flex-col text-fg" : `z-30 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl ${className}`}
    >
      <div className="flex items-center gap-2 p-2">
        {cfg && cfg.giphy && cfg.library > 0 && (
          <div className="flex shrink-0 rounded-full bg-stone-100 p-0.5 text-xs font-semibold" role="tablist" aria-label="GIF source">
            {([["giphy", "Search GIPHY"], ["library", `Our GIFs (${cfg.library})`]] as const).map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => { setTab(v); setQ(""); }}
                className={`whitespace-nowrap rounded-full px-3 py-1 transition-colors ${tab === v ? "bg-ink text-white dark:bg-brand-green dark:text-ink" : "text-neutral-600"}`}>{label}</button>
            ))}
          </div>
        )}
        {!none && (
          <input
            autoFocus={!docked}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === "giphy" ? "Search GIPHY…" : "Find one of our GIFs…"}
            aria-label="Search GIFs"
            className="min-w-0 flex-1 rounded-lg border border-stone-300 bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-neutral-500 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25"
          />
        )}
      </div>
      <div ref={setScroller} className={docked ? "min-h-0 flex-1 overflow-y-auto px-2 pb-2" : "max-h-72 overflow-y-auto px-2 pb-2"}>
        {!cfg && <p className="py-8 text-center text-sm text-neutral-500">Loading…</p>}
        {none && (
          <p className="px-3 py-8 text-center text-sm text-neutral-600">
            No GIFs are set up yet.{staff ? " Switch on GIPHY or upload your own under System > Chat." : " IT can switch them on."}
          </p>
        )}
        {cfg && tab === "giphy" && cfg.giphy && (
          <Suspense fallback={<p className="py-8 text-center text-sm text-neutral-500">Loading…</p>}>
            <GiphyGrid gkey={cfg.giphy.key} q={qNow} width={w} scroller={scroller} onPick={onPick} />
          </Suspense>
        )}
        {cfg && tab === "library" && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-1.5">
            {libShown.map((g) => (
              <button key={g.id} type="button" onClick={() => onPick({ source: "library", id: g.id, title: g.title })} title={g.title} aria-label={g.title}
                className="aspect-square overflow-hidden rounded-lg bg-stone-100 transition-transform hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
                <img src={`/api${base}/library/${g.id}/img`} alt={g.title} loading="lazy" className="h-full w-full object-cover" />
              </button>
            ))}
            {!libShown.length && cfg.library > 0 && <p className="col-span-full py-8 text-center text-sm text-neutral-500">No GIF has that name.</p>}
          </div>
        )}
      </div>
      {cfg?.giphy && tab === "giphy" && <p className="border-t border-stone-200 px-3 py-1.5 text-right text-[10px] font-bold uppercase tracking-wider text-neutral-500">Powered by GIPHY</p>}
    </div>
  );
}
