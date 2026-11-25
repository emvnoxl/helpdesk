import { lazy, Suspense, useEffect, useState } from "react";
import { loadGifConfig, type GifConfig } from "./gifConfig";

const Lazy = lazy(() => import("./GiphyGif")); // GIPHY's SDK is only downloaded when a conversation actually contains one of its GIFs

/** A GIPHY GIF inside a message. If an admin has switched GIPHY off, or it can't be reached, it says so instead of showing a broken picture. */
export function GiphyMessage({ id, staff }: { id: string; staff: boolean }) {
  const [cfg, setCfg] = useState<GifConfig | null | "error">(null);
  useEffect(() => {
    let off = false;
    loadGifConfig(staff).then((c) => { if (!off) setCfg(c); }).catch(() => { if (!off) setCfg("error"); });
    return () => { off = true; };
  }, [staff]);
  const box = "w-60 rounded-xl border border-dashed border-stone-300 px-3 py-6 text-center text-xs italic text-neutral-500";
  if (cfg === "error") return <div className={box}>GIF unavailable</div>;
  if (!cfg) return <div className="h-36 w-60 animate-pulse rounded-xl bg-black/10" aria-label="Loading GIF" />;
  if (!cfg.giphy) return <div className={box}>GIPHY GIFs are switched off</div>;
  return (
    <Suspense fallback={<div className="h-36 w-60 animate-pulse rounded-xl bg-black/10" aria-label="Loading GIF" />}>
      <Lazy gkey={cfg.giphy.key} id={id} />
    </Suspense>
  );
}
