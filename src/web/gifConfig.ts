import { api } from "./api";

/* What the GIF picker and the chat need to know: is GIPHY on (and its public SDK key), and how many library GIFs exist.
   Asked once and remembered for a minute, so a hundred GIF messages on screen make one request. */
export interface GifConfig { giphy: { key: string } | null; library: number }

const cache = new Map<boolean, { at: number; p: Promise<GifConfig> }>();

export function loadGifConfig(staff: boolean, fresh = false): Promise<GifConfig> {
  const hit = cache.get(staff);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = api<GifConfig>(`${staff ? "/staff/gifs" : "/gifs"}/config`);
  cache.set(staff, { at: Date.now(), p });
  p.catch(() => cache.delete(staff));
  return p;
}
