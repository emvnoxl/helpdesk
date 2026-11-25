import { useCallback, useMemo } from "react";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { pingback } from "@giphy/js-analytics";
import { Grid } from "@giphy/react-components";
import type { PickedGif } from "./GifPicker";

/* GIPHY's own web SDK, in the browser, as GIPHY asks: it searches, shows the pictures from GIPHY's servers, loads more as you scroll and
   reports views and clicks. Loaded only when somebody opens the GIF tab (it is a separate chunk). */
export default function GiphyGrid({ gkey, q, width, scroller, onPick }: { gkey: string; q: string; width: number; scroller: HTMLElement | null; onPick: (g: PickedGif) => void }) {
  const gf = useMemo(() => new GiphyFetch(gkey), [gkey]);
  const fetchGifs = useCallback(
    (offset: number) => (q ? gf.search(q, { offset, limit: 12, rating: "pg", lang: "en" }) : gf.trending({ offset, limit: 12, rating: "pg" })),
    [gf, q],
  );
  const columns = Math.max(3, Math.min(9, Math.floor(width / 125))); // tiles of roughly 120 px, so many GIFs are visible at once
  return (
    <Grid
      key={q}
      width={width}
      columns={columns}
      gutter={4}
      fetchGifs={fetchGifs}
      noLink
      borderRadius={8}
      noResultsMessage={<p className="py-8 text-center text-sm text-neutral-500">No GIFs found for that.</p>}
      loaderConfig={{ root: scroller, rootMargin: "240px" }}
      onGifClick={(gif, e) => {
        e.preventDefault();
        pingback({ actionType: "SENT", analyticsResponsePayload: gif.analytics_response_payload, eventType: q ? "GIF_SEARCH" : "GIF_TRENDING" });
        onPick({ source: "giphy", id: String(gif.id), title: gif.title });
      }}
    />
  );
}
