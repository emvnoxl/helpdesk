import { useEffect, useState, type ReactNode } from "react";
import { deviceKey } from "./device";
import { api } from "./api";
import { AttachButton, DropVeil, PendingTray, filesFromPaste, uploadToTicket, useDrop, useUploadLimit, type Pending } from "./Attach";
import { CategoryIcon } from "./CategoryIcon";
import { Suggest } from "./Help";
import { useNotify } from "./notify";
import { btn, btnGhost, card, field } from "./ui";

type Category = { id: number; name: string };
type Draft = { title: string; description: string; category_id: string; asset_tag: string };
const EMPTY: Draft = { title: "", description: "", category_id: "", asset_tag: "" };
const DRAFT_KEY = "fortress-helpdesk:draft";

// Drafts live only in this browser, so a refresh or a dropped connection doesn't lose a long description.
function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}
function saveDraft(d: Draft) {
  try {
    if (d.title || d.description || d.category_id || d.asset_tag) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable: the form still works */
  }
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 flex items-center gap-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-xs font-bold text-white">{n}</span>
        <span className="text-base font-bold">{title}</span>
        {hint && <span className="text-xs font-normal text-neutral-500">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function Aside() {
  const steps = [
    ["IT reviews it", "We read your ticket, set its priority and pick it up."],
    ["You can follow along", "Check the status any time under “Check my tickets”."],
    ["Reply on the ticket", "Add details or answer questions right on the ticket page."],
  ];
  return (
    <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
      <div className={card}>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-neutral-500">What happens next</h2>
        <ol className="space-y-3">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-ink" style={{ background: ["#00a859", "#ffb400", "#ee3239"][i] }}>{i + 1}</span>
              <div>
                <div className="text-sm font-semibold">{t}</div>
                <div className="text-sm text-neutral-500">{d}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className={card}>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-neutral-500">For a faster fix</h2>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-neutral-600">
          <li>Copy any error message exactly.</li>
          <li>Say when it started and what changed.</li>
          <li>Tell us what you've already tried.</li>
          <li>Include your location or desk if it's a device.</li>
          <li>Never put passwords in a ticket.</li>
        </ul>
      </div>
    </aside>
  );
}

interface Chosen { key: string; file: File; preview?: string; problem?: string }
let chosenSeq = 0;

export function NewTicket({ name, email, onView, onList, initialTitle = "" }: { name: string; email: string; onView: (id: number) => void; onList: () => void; /** typed on Home */ initialTitle?: string }) {
  const [cats, setCats] = useState<Category[] | null>(null);
  const [f, setF] = useState<Draft>(() => (initialTitle ? { ...loadDraft(), title: initialTitle } : loadDraft()));
  const [showMore, setShowMore] = useState(() => !!loadDraft().asset_tag);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState<{ id: number; ref: string; title: string; failed: string[] } | null>(null);
  const [files, setFiles] = useState<Chosen[]>([]);
  const { toast } = useNotify();
  const LIMIT_MB = useUploadLimit();

  const addFiles = (list: File[]) =>
    setFiles((cur) => {
      const room = Math.max(0, 10 - cur.length);
      return [
        ...cur,
        ...list.slice(0, room).map((file): Chosen => {
          const problem = file.size > LIMIT_MB * 1024 * 1024 ? `Too big (limit ${LIMIT_MB} MB)` : file.size === 0 ? "Empty file" : undefined;
          return { key: `n${++chosenSeq}`, file, problem, preview: !problem && /\.(png|jpe?g|gif|webp)$/i.test(file.name) ? URL.createObjectURL(file) : undefined };
        }),
      ];
    });
  const dropFiles = (key: string) => setFiles((cur) => (cur.find((x) => x.key === key)?.preview && URL.revokeObjectURL(cur.find((x) => x.key === key)!.preview!), cur.filter((x) => x.key !== key)));
  const clearFiles = () => setFiles((cur) => (cur.forEach((x) => x.preview && URL.revokeObjectURL(x.preview)), []));
  const drop = useDrop(addFiles);
  const tray: Pending[] = files.map((x) => ({ key: x.key, name: x.file.name, size: x.file.size, state: x.problem ? "error" : "ready", error: x.problem, preview: x.preview }));

  useEffect(() => {
    // "Other" is the catch-all, so it always goes last.
    api<Category[]>("/tickets/categories").then(
      (r) => setCats([...r].sort((a, b) => Number(a.name === "Other") - Number(b.name === "Other") || a.name.localeCompare(b.name))),
      () => setCats([]),
    );
  }, []);

  const update = (patch: Partial<Draft>) =>
    setF((p) => {
      const next = { ...p, ...patch };
      saveDraft(next);
      return next;
    });

  const titleOk = f.title.trim().length >= 5;
  const descOk = f.description.trim().length >= 15;
  const valid = !!f.category_id && titleOk && descOk;
  const missing = [!f.category_id && "a category", !titleOk && "a short summary", !descOk && "a few details"].filter(Boolean) as string[];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ id: number; ref: string }>("/tickets", {
        method: "POST",
        json: { ...f, category_id: Number(f.category_id), device_key: deviceKey() },
      });
      saveDraft(EMPTY);
      // The files go up once the ticket exists. If one is refused the ticket is still raised, and we say which.
      const failed: string[] = [];
      for (const x of files.filter((x) => !x.problem)) await uploadToTicket("/tickets", r.id, x.file, true).catch((e) => failed.push(`${x.file.name} (${e.message})`));
      failed.push(...files.filter((x) => x.problem).map((x) => `${x.file.name} (${x.problem})`));
      clearFiles();
      setSent({ ...r, title: f.title.trim(), failed });
    } catch (x: any) {
      setErr(x.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className={card + " mx-auto max-w-lg space-y-4 p-8 text-center"}>
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-green text-white">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
        </div>
        <div>
          <h2 className="text-2xl font-extrabold">Ticket submitted</h2>
          <p className="mt-1 text-sm text-neutral-500">Thanks {name.split(" ")[0]}, IT has it and will review it shortly.</p>
        </div>
        <div className="rounded-xl bg-stone-50 p-4 text-left">
          <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">Your reference</div>
          <div className="text-2xl font-extrabold tracking-wide">{sent.ref}</div>
          <div className="mt-1 text-sm text-neutral-600">{sent.title}</div>
        </div>
        {sent.failed.length > 0 && (
          <div className="rounded-xl bg-amber-50 p-3 text-left text-sm text-amber-900" role="alert">
            <b>Your ticket is in, but {sent.failed.length === 1 ? "one file" : `${sent.failed.length} files`} didn't upload:</b>
            <ul className="mt-1 list-disc pl-5">{sent.failed.map((x) => <li key={x}>{x}</li>)}</ul>
            <span>Open the ticket and attach {sent.failed.length === 1 ? "it" : "them"} to a message.</span>
          </div>
        )}
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <button className={btn} onClick={() => onView(sent.id)}>View ticket</button>
          <button className={btnGhost + " border border-stone-300"} onClick={() => { setSent(null); setF(EMPTY); setShowMore(false); clearFiles(); }}>Submit another</button>
          <button className={btnGhost} onClick={onList}>My tickets</button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <form
        onSubmit={submit}
        className={card + " relative space-y-8 p-5 sm:p-7 lg:col-span-2"}
        noValidate
        onPaste={(e) => { const p = filesFromPaste(e); if (p.length) { e.preventDefault(); addFiles(p); } }}
        {...drop.props}
      >
        <DropVeil show={drop.over} text="Drop screenshots or files to attach them" />
        <Step n={1} title="What's it about?" hint="Pick the closest match">
          {cats === null ? (
            <p className="text-sm text-neutral-500">Loading categories…</p>
          ) : (
            <div role="radiogroup" aria-label="Category" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {cats.map((c) => {
                const on = String(c.id) === f.category_id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => update({ category_id: String(c.id) })}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${
                      on ? "border-brand-green bg-brand-green/10 shadow-[0_0_0_1px_var(--color-brand-green)]" : "border-stone-200 bg-surface hover:border-stone-400"
                    }`}
                  >
                    <span className={on ? "text-brand-green" : "text-neutral-500"}><CategoryIcon name={c.name} /></span>
                    <span>{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </Step>

        <Step n={2} title="Tell us what's wrong">
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <label htmlFor="t-title" className="font-semibold">Summary</label>
              <span className="text-xs text-neutral-400">{f.title.length}/200</span>
            </div>
            <input id="t-title" className={field} placeholder="e.g. Can't connect to the office Wi-Fi on floor 2" maxLength={200} value={f.title} onChange={(e) => update({ title: e.target.value })} />
          </div>
          <Suggest title={f.title} categoryId={f.category_id} onSolved={() => { saveDraft(EMPTY); setF(EMPTY); setShowMore(false); clearFiles(); toast("Nothing was submitted. If it comes back, raise a ticket any time.", "success", "Glad that fixed it"); }} />
          <div>
            <div className="mb-1 flex justify-between text-sm">
              <label htmlFor="t-desc" className="font-semibold">Details</label>
              <span className="text-xs text-neutral-400">{descOk ? "Looks good" : "A few sentences helps"}</span>
            </div>
            <textarea
              id="t-desc"
              className={field + " min-h-40 leading-relaxed"}
              rows={7}
              maxLength={10000}
              placeholder={"What happened, and what did you expect?\nAny error message?\nWhen did it start?"}
              value={f.description}
              onChange={(e) => update({ description: e.target.value })}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="font-semibold">Screenshots or files <span className="font-normal text-neutral-500">(optional)</span></span>
              <span className="text-xs text-neutral-400">{files.length}/10</span>
            </div>
            <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-3">
              <PendingTray items={tray} onRemove={dropFiles} />
              <div className="flex flex-wrap items-center gap-3 text-sm text-neutral-600">
                <AttachButton onFiles={addFiles} label="Choose files" className="border border-stone-300 bg-surface" />
                <span>Paste a screenshot with <kbd className="rounded border border-stone-300 bg-surface px-1.5 text-xs">Ctrl</kbd> + <kbd className="rounded border border-stone-300 bg-surface px-1.5 text-xs">V</kbd>, or drag files here. Photos, PDFs, documents and logs up to {LIMIT_MB} MB.</span>
              </div>
            </div>
          </div>
        </Step>

        <div>
          <button type="button" className="text-sm font-semibold text-neutral-600 hover:text-fg" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>
            {showMore ? "− Hide extra details" : "+ Add extra details (optional)"}
          </button>
          {showMore && (
            <div className="mt-3">
              <label htmlFor="t-asset" className="mb-1 block text-sm font-semibold">Asset tag</label>
              <input id="t-asset" className={field + " max-w-xs"} placeholder="Sticker on the device, e.g. FG-LT-0142" maxLength={100} value={f.asset_tag} onChange={(e) => update({ asset_tag: e.target.value })} />
              <p className="mt-1 text-xs text-neutral-500">Only for tickets about a specific laptop, phone or other device.</p>
            </div>
          )}
        </div>

        {err && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{err}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-5">
          <div className="text-sm text-neutral-500">
            Submitting as <b className="text-fg">{name}</b> <span className="text-neutral-400">({email})</span>
            {!valid && <div className="text-xs text-neutral-400">Still needed: {missing.join(", ")}</div>}
          </div>
          <button className={btn + " px-6 py-2.5"} disabled={!valid || busy}>{busy ? (files.length ? "Submitting and uploading…" : "Submitting…") : "Submit ticket"}</button>
        </div>
      </form>
      <Aside />
    </div>
  );
}
