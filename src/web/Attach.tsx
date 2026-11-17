import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";

/* Attachments, on the browser side: picking, pasting and dropping files, uploading them, and showing the ones already sent.
   The server decides what is allowed (type, real file contents, size); these helpers only give quick feedback. */

export const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv,.eml,.docx,.xlsx,.pptx,.zip,.doc,.xls,.ppt,.msg";
let limitMb = 10; // replaced by the server's MAX_UPLOAD_MB once /config has answered
let limitAsked = false;
export function useUploadLimit() {
  const [mb, setMb] = useState(limitMb);
  useEffect(() => {
    if (limitAsked) return setMb(limitMb);
    limitAsked = true;
    api<{ maxUploadMb?: number }>("/config").then((c) => { if (c.maxUploadMb) { limitMb = c.maxUploadMb; setMb(limitMb); } }, () => {});
  }, []);
  return mb;
}

export const humanSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** Pasted screenshots arrive as "image.png"; give them a name that says when. */
function named(f: File): File {
  if (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
  const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return new File([f], `screenshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`, { type: f.type });
}

export function filesFromPaste(e: ClipboardEvent): File[] {
  const out: File[] = [];
  for (const it of Array.from(e.clipboardData?.items ?? [])) if (it.kind === "file") { const f = it.getAsFile(); if (f) out.push(named(f)); }
  return out;
}

/** Drag files over a box. Spread `props` on the box; `over` is true while a file is being dragged across it. */
export function useDrop(onFiles: (f: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const props = {
    onDragEnter: (e: DragEvent) => { if (has(e)) { depth.current++; setOver(true); } },
    onDragOver: (e: DragEvent) => { if (has(e)) e.preventDefault(); },
    onDragLeave: (e: DragEvent) => { if (has(e) && --depth.current <= 0) { depth.current = 0; setOver(false); } },
    onDrop: (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth.current = 0; setOver(false); onFiles(Array.from(e.dataTransfer.files).map(named)); },
  };
  return { over, props };
}

export interface Pending { key: string; name: string; size: number; state: "uploading" | "ready" | "error"; id?: number; error?: string; preview?: string }
let seq = 0;

const tooBig = (f: File) => (f.size > limitMb * 1024 * 1024 ? `Too big (limit ${limitMb} MB)` : f.size === 0 ? "Empty file" : "");

/** Files for the next message: each is uploaded as soon as it's added, and linked to the message when it is sent. */
export function useDrafts(base: string, ticketId: number, onProblem: (text: string, name: string) => void = () => {}) {
  useUploadLimit();
  const [items, setItems] = useState<Pending[]>([]);
  const live = useRef(items);
  live.current = items;

  const patch = (key: string, p: Partial<Pending>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = useCallback((files: File[]) => {
    for (const f of files.slice(0, 12)) {
      const key = `d${++seq}`;
      const problem = tooBig(f);
      const preview = isImage(f.name) && !problem ? URL.createObjectURL(f) : undefined;
      setItems((xs) => [...xs, { key, name: f.name, size: f.size, state: problem ? "error" : "uploading", error: problem || undefined, preview }]);
      if (problem) { onProblem(problem, f.name); continue; }
      const fd = new FormData();
      fd.append("file", f, f.name);
      api<{ id: number }>(`${base}/${ticketId}/attachments`, { method: "POST", body: fd }).then(
        (r) => patch(key, { state: "ready", id: r.id }),
        (e) => { patch(key, { state: "error", error: e.message }); onProblem(e.message, f.name); },
      );
    }
  }, [base, ticketId]);

  const remove = useCallback((key: string) => {
    const it = live.current.find((x) => x.key === key);
    if (it?.preview) URL.revokeObjectURL(it.preview);
    if (it?.id) void api(`${base}/${ticketId}/attachments/${it.id}`, { method: "DELETE" }).catch(() => {});
    setItems((xs) => xs.filter((x) => x.key !== key));
  }, [base, ticketId]);

  /** After sending: the files now belong to the message, so just forget them here. */
  const reset = useCallback(() => {
    live.current.forEach((x) => x.preview && URL.revokeObjectURL(x.preview));
    setItems([]);
  }, []);

  useEffect(() => () => live.current.forEach((x) => x.preview && URL.revokeObjectURL(x.preview)), []);

  return { items, add, remove, reset, ids: items.filter((x) => x.state === "ready" && x.id).map((x) => x.id!), busy: items.some((x) => x.state === "uploading") };
}

export async function uploadToTicket(base: string, ticketId: number, file: File, forTicket = false) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  return api(`${base}/${ticketId}/attachments${forTicket ? "?for=ticket" : ""}`, { method: "POST", body: fd });
}

const Clip = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21.4 11.6l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  </svg>
);

/** The paperclip button. */
export function AttachButton({ onFiles, label = "Attach files", className = "" }: { onFiles: (f: File[]) => void; label?: string; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" aria-label={label} data-testid="file-input"
        onChange={(e) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      <button type="button" onClick={() => input.current?.click()} title={`${label} (you can also paste or drop them)`} aria-label={label}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-600 hover:bg-stone-200/70 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${className}`}>
        <Clip />
      </button>
    </>
  );
}

/** Files chosen but not sent yet: a thumbnail or icon, the name, and a way to take it back. */
export function PendingTray({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files to send">
      {items.map((x) => (
        <li key={x.key} className={`flex max-w-full items-center gap-2 rounded-lg border py-1 pl-1 pr-2 text-xs ${x.state === "error" ? "border-red-300 bg-red-50 text-red-800" : "border-stone-300 bg-stone-50"}`}>
          {x.preview ? <img src={x.preview} alt="" className="h-8 w-8 rounded object-cover" /> : <span className="grid h-8 w-8 place-items-center rounded bg-stone-200 text-neutral-600"><Clip size={14} /></span>}
          <span className="min-w-0">
            <span className="block max-w-[11rem] truncate font-semibold">{x.name}</span>
            <span className="line-clamp-2 block max-w-[16rem] text-[11px] opacity-80" title={x.state === "error" ? x.error : undefined}>{x.state === "uploading" ? "Uploading…" : x.state === "error" ? x.error : humanSize(x.size)}</span>
          </span>
          <button type="button" onClick={() => onRemove(x.key)} aria-label={`Remove ${x.name}`} className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-black/10">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface SentFile { id: number; name: string; mime: string; size: number }

function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={name} onClick={onClose} className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-4">
      <figure className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={name} className="max-h-[82vh] max-w-full rounded-lg bg-white object-contain shadow-2xl" />
        <figcaption className="mt-3 flex items-center justify-center gap-4 text-sm text-white">
          <span className="max-w-[60vw] truncate">{name}</span>
          <a className="rounded-lg bg-white/15 px-3 py-1 font-semibold hover:bg-white/25" href={`${src}?download=1`} download>Download</a>
          <button className="rounded-lg bg-white/15 px-3 py-1 font-semibold hover:bg-white/25" onClick={onClose} autoFocus>Close</button>
        </figcaption>
      </figure>
    </div>,
    document.body,
  );
}

/** Files already sent: images as thumbnails (click to enlarge), everything else as a download chip. */
export function SentFiles({ files, base, ticketId, tone = "default" }: { files: SentFile[]; base: string; ticketId: number; tone?: "default" | "mine" }) {
  const [big, setBig] = useState<SentFile | null>(null);
  if (!files?.length) return null;
  const url = (f: SentFile) => `/api${base}/${ticketId}/attachments/${f.id}`;
  const images = files.filter((f) => f.mime.startsWith("image/") && f.id > 0);
  const others = files.filter((f) => !(f.mime.startsWith("image/") && f.id > 0));
  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((f) => (
            <button key={f.id} type="button" onClick={() => setBig(f)} title={`${f.name} (${humanSize(f.size)})`} aria-label={`Open ${f.name}`}
              className="overflow-hidden rounded-lg border border-black/10 bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
              <img src={url(f)} alt={f.name} loading="lazy" className="max-h-40 max-w-[14rem] object-cover" />
            </button>
          ))}
        </div>
      )}
      {others.map((f) =>
        f.id > 0 ? (
          <a key={f.id} href={`${url(f)}?download=1`} download={f.name}
            className={`flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-semibold hover:brightness-95 ${tone === "mine" ? "border-black/15 bg-white/50" : "border-stone-300 bg-stone-50"}`}>
            <Clip size={14} /><span className="truncate">{f.name}</span><span className="shrink-0 font-normal opacity-70">{humanSize(f.size)}</span>
          </a>
        ) : (
          <span key={f.name} className="flex items-center gap-2 rounded-lg border border-stone-300 bg-stone-50 px-2.5 py-1.5 text-xs opacity-70"><Clip size={14} /><span className="truncate">{f.name}</span></span>
        ),
      )}
      {big && <Lightbox src={url(big)} name={big.name} onClose={() => setBig(null)} />}
    </div>
  );
}

/** A dashed overlay shown while a file is dragged over a box. */
export const DropVeil = ({ show, text = "Drop files to attach them" }: { show: boolean; text?: string }) =>
  show ? (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-brand-green bg-surface/90 text-sm font-bold text-fg" aria-hidden>
      {text}
    </div>
  ) : null;
