import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/* Branded notifications, used instead of the browser's plain alert()/confirm() boxes:
   - toast(text, kind)   a small card that slides in at the bottom-right and dismisses itself
   - confirm({...})      a modal dialog; resolves true (confirmed) or false (cancelled / Esc / backdrop)
   Both follow the site's look: brand stripe, brand colours, and the light/dark theme. */

type Kind = "success" | "error" | "info";
interface ToastItem { id: number; kind: Kind; title?: string; text: string; onClick?: () => void }

export interface DialogOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  /** null = no Cancel button (an information dialog) */
  cancelLabel?: string | null;
  tone?: "default" | "danger" | "success";
}
interface Api {
  /** `onClick` makes the whole card clickable (e.g. open the ticket a notification is about). */
  toast: (text: string, kind?: Kind, title?: string, onClick?: () => void) => void;
  confirm: (o: DialogOpts) => Promise<boolean>;
}

const Ctx = createContext<Api>({ toast() {}, confirm: async () => false });
export const useNotify = () => useContext(Ctx);

const KIND_COLOR: Record<Kind, string> = { success: "#00a859", error: "#d03b3b", info: "#ffb400" };

const Icon = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const ICONS = {
  success: "M5 13l4 4L19 7",
  error: "M12 8v5M12 17h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3ZM9.5 12l2 2 3.5-4",
};

function ToastCard({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, t.kind === "error" ? 8000 : 5000);
    return () => window.clearTimeout(id);
  }, [t, onClose]);
  const color = KIND_COLOR[t.kind];
  return (
    <div
      role={t.kind === "error" ? "alert" : "status"}
      className="toast-in pointer-events-auto flex w-full items-start gap-3 overflow-hidden rounded-2xl border border-stone-200 bg-surface p-4 text-fg shadow-xl sm:w-96"
      style={{ borderLeft: `6px solid ${color}` }}
    >
      <span className="mt-0.5 shrink-0" style={{ color }}><Icon d={ICONS[t.kind]} /></span>
      {t.onClick ? (
        <button type="button" onClick={() => { t.onClick!(); onClose(); }} className="min-w-0 flex-1 text-left text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
          {t.title && <div className="font-bold">{t.title}</div>}
          <div className={`line-clamp-2 ${t.title ? "text-neutral-600" : "font-medium"}`}>{t.text}</div>
        </button>
      ) : (
        <div className="min-w-0 flex-1 text-sm">
          {t.title && <div className="font-bold">{t.title}</div>}
          <div className={t.title ? "text-neutral-600" : "font-medium"}>{t.text}</div>
        </div>
      )}
      <button onClick={onClose} aria-label="Dismiss" className="shrink-0 rounded-md p-1 text-neutral-400 hover:bg-stone-100 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}

function Dialog({ o, done }: { o: DialogOpts; done: (ok: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const tone = o.tone ?? "default";
  const danger = tone === "danger";
  const cancelLabel = o.cancelLabel === undefined ? "Cancel" : o.cancelLabel;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const buttons = () => [...(panel.current?.querySelectorAll<HTMLElement>("button, [href], input, select, textarea") ?? [])];
    // A destructive action starts on Cancel so an accidental Enter can't confirm it.
    const first = danger && cancelLabel ? buttons().find((b) => b.dataset.role === "cancel") : buttons().find((b) => b.dataset.role === "confirm");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      if (e.key === "Tab") {
        const els = buttons();
        if (!els.length) return;
        const i = els.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length].focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); before?.focus?.(); };
  }, []);

  const badge =
    tone === "danger" ? "bg-red-50 text-red-700" : tone === "success" ? "bg-green-50 text-green-800" : "bg-ink text-brand-amber";
  return (
    <div
      className="backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) done(false); }}
    >
      <div ref={panel} role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" className="dialog-in w-full max-w-md overflow-hidden rounded-3xl bg-surface text-fg shadow-2xl ring-1 ring-black/5">
        <div className="brand-stripe" />
        <div className="p-6">
          <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${badge}`}>
            <Icon d={danger ? ICONS.error : tone === "success" ? ICONS.success : ICONS.shield} />
          </span>
          <h2 id="dlg-title" className="mt-4 text-xl font-extrabold">{o.title}</h2>
          {o.body && <div className="mt-2 text-sm text-neutral-600">{o.body}</div>}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            {cancelLabel && (
              <button data-role="cancel" onClick={() => done(false)} className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-stone-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
                {cancelLabel}
              </button>
            )}
            <button
              data-role="confirm"
              onClick={() => done(true)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green focus-visible:ring-offset-2 ring-offset-surface ${
                danger ? "bg-[#d03b3b] text-white hover:brightness-110" : "bg-ink text-white hover:bg-neutral-700 dark:bg-brand-green dark:text-ink dark:hover:bg-brand-green dark:hover:brightness-110"
              }`}
            >
              {o.confirmLabel ?? "OK"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<{ o: DialogOpts; resolve: (ok: boolean) => void } | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: Kind = "success", title?: string, onClick?: () => void) => {
    setToasts((t) => [...t.slice(-3), { id: ++seq.current, kind, title, text, onClick }]);
  }, []);
  const close = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const confirm = useCallback((o: DialogOpts) => new Promise<boolean>((resolve) => setDialog({ o, resolve })), []);
  const finish = (ok: boolean) => { dialog?.resolve(ok); setDialog(null); };

  const api = useMemo(() => ({ toast, confirm }), [toast, confirm]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {dialog && <Dialog o={dialog.o} done={finish} />}
      <div className="pointer-events-none fixed bottom-4 left-4 right-4 z-[60] flex flex-col items-end gap-2 sm:left-auto" aria-live="polite">
        {toasts.map((t) => <ToastCard key={t.id} t={t} onClose={() => close(t.id)} />)}
      </div>
    </Ctx.Provider>
  );
}
