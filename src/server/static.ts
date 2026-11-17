import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Context } from "hono";

/* Serves the built web app (dist/). Anything that isn't a file falls back to index.html so the React router can handle it,
   but a missing file with an extension (e.g. a stale /assets/x.js) is a real 404, never HTML pretending to be JavaScript. */

const ROOT = path.resolve(process.cwd(), "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};

async function readIfFile(file: string): Promise<Buffer | null> {
  try {
    const s = await stat(file);
    return s.isFile() ? await readFile(file) : null;
  } catch {
    return null;
  }
}

export async function serveWeb(c: Context) {
  let rel = "";
  try {
    rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
  } catch {
    return c.text("Bad request", 400);
  }
  const file = path.join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return c.text("Not found", 404); // path traversal guard

  const ext = path.extname(file).toLowerCase();
  const direct = rel ? await readIfFile(file) : null;
  if (direct) {
    const headers: Record<string, string> = { "Content-Type": TYPES[ext] ?? "application/octet-stream" };
    // Vite fingerprints everything under /assets, so it can be cached for a year; everything else is revalidated.
    headers["Cache-Control"] = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return c.body(new Uint8Array(direct), 200, headers);
  }
  if (ext) return c.text("Not found", 404);

  const index = await readIfFile(path.join(ROOT, "index.html"));
  if (!index) return c.text("The web app hasn't been built yet. Run `npm run build`.", 503);
  return c.body(new Uint8Array(index), 200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
}
