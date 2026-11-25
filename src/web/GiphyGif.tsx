import { useEffect, useState } from "react";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { Gif } from "@giphy/react-components";
import type { IGif } from "@giphy/js-types";

/** One GIPHY GIF in a conversation: asks GIPHY for it by id and shows it with GIPHY's own component (nothing is stored here). */
export default function GiphyGif({ gkey, id, width = 240 }: { gkey: string; id: string; width?: number }) {
  const [gif, setGif] = useState<IGif | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let off = false;
    new GiphyFetch(gkey).gif(id).then((r) => { if (!off) { if (r.data.is_removed || r.data.is_hidden) setFailed(true); else setGif(r.data); } }).catch(() => { if (!off) setFailed(true); });
    return () => { off = true; };
  }, [gkey, id]);
  if (failed) return <div className="rounded-xl border border-dashed border-stone-300 px-3 py-6 text-center text-xs italic text-neutral-500" style={{ width }}>This GIF is no longer available</div>;
  if (!gif) return <div className="animate-pulse rounded-xl bg-black/10" style={{ width, height: Math.round(width * 0.6) }} aria-label="Loading GIF" />;
  return <Gif gif={gif} width={width} noLink borderRadius={12} />;
}
