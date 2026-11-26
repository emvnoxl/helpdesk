import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useNotify } from "./notify";
import { secondaryBtn } from "./SystemSetup";
import { btn, field } from "./ui";

/* Admin > System > Email templates: the wording of every email the helpdesk sends, the logo at the top, and the "genuine message" block, with a live
   preview. Placeholders like {name} are filled in when the email is sent; click one to put it where the cursor is. */

interface FieldMeta { key: string; label: string; rows: number; hint?: string; required?: boolean }
interface KindMeta { id: string; label: string; when: string; vars: string[]; fields: FieldMeta[] }
interface Brand { name: string; team: string; greeting: string; signoff: string; contact: string; trust: string; show_logo: boolean; show_verify: boolean; [k: string]: string | boolean }
interface Templates { brand: Brand; kinds: Record<string, Record<string, string>> }
export interface TemplatesInfo {
  templates: Templates;
  defaults: Templates;
  kinds: KindMeta[];
  brand_fields: FieldMeta[];
  custom_logo: boolean;
  app_url_set: boolean;
  customised: number;
}
const card = "rounded-2xl border border-fg/10 bg-surface p-5";
const muted = "text-sm text-neutral-600 dark:text-neutral-400";
const VAR_HELP: Record<string, string> = { name: "first name", fullname: "full name", ref: "ticket number", title: "ticket title", team: "the team name", helpdesk: "the helpdesk name", agent: "who from IT", status: "the new status", count: "how many" };

/* ---- the preview: a small mail window. Click any text in the email to edit it where it stands. ---- */
const EDIT_KEY = /^(brand\.\w+|kinds\.\w+\.\w+)$/;
const getKey = (t: Templates, key: string): string => {
  const p = key.split(".");
  return p[0] === "brand" ? String(t.brand[p[1]!] ?? "") : (t.kinds[p[1]!]?.[p[2]!] ?? "");
};
const putKey = (t: Templates, key: string, v: string): Templates => {
  const p = key.split(".");
  return p[0] === "brand" ? { ...t, brand: { ...t.brand, [p[1]!]: v } } : { ...t, kinds: { ...t.kinds, [p[1]!]: { ...t.kinds[p[1]!], [p[2]!]: v } } };
};
const FRAME_CSS = `html{scroll-behavior:auto}[data-edit]{cursor:text;outline:2px dashed transparent;outline-offset:4px;border-radius:4px;transition:outline-color .15s,background-color .15s}
[data-edit]:hover{outline-color:#00a859;background-color:rgba(0,168,89,.08)}[data-edit].fg-on{outline:2px solid #00a859;background-color:rgba(0,168,89,.12)}
a{pointer-events:none}@media (prefers-reduced-motion:reduce){[data-edit]{transition:none}}`;
const NICE: Record<string, string> = { "brand.name": "helpdesk name", "brand.team": "team name", "brand.greeting": "greeting", "brand.signoff": "sign-off", "brand.contact": "how to reach IT", "brand.trust": "safety line" };
const niceKey = (k: string) => NICE[k] ?? ({ intro: "message", intro2: "message", note: "extra line", note2: "extra line", button: "button", button2: "button", steps: "steps" } as Record<string, string>)[k.split(".")[2] ?? ""] ?? "text";

interface Anchor { top: number; left: number; width: number }

function MailPreview({ prev, draft, setDraft, kindId, vars, team, onSubject }: {
  prev: { subject?: string; html?: string; error?: string } | null;
  draft: Templates; setDraft: (f: (d: Templates) => Templates) => void; kindId: string; vars: string[]; team: string; onSubject: (v: string) => void;
}) {
  const [phone, setPhone] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [height, setHeight] = useState(560);
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const keyRef = useRef<string | null>(null);
  keyRef.current = editKey;

  // put the box just under the block being edited, whatever size the frame has now
  const place = useCallback(() => {
    const fr = frame.current, doc = fr?.contentDocument, k = keyRef.current;
    if (!fr || !doc || !k) { setAnchor(null); return; }
    doc.querySelectorAll(".fg-on").forEach((n) => n.classList.remove("fg-on"));
    const el = doc.querySelector(`[data-edit="${k}"]`);
    if (!el) { setAnchor(null); return; }
    el.classList.add("fg-on");
    const r = el.getBoundingClientRect(), w = wrap.current?.clientWidth ?? 400;
    const width = Math.min(w - 16, 440);
    setAnchor({ top: fr.offsetTop + r.bottom + 10, left: Math.max(8, Math.min(fr.offsetLeft + r.left, w - width - 8)), width });
  }, []);

  const onLoad = useCallback(() => {
    const fr = frame.current, doc = fr?.contentDocument;
    if (!fr || !doc) return;
    if (!doc.getElementById("fg-edit-css")) {
      const st = doc.createElement("style"); st.id = "fg-edit-css"; st.textContent = FRAME_CSS; doc.head.appendChild(st);
      doc.addEventListener("click", (ev) => {
        ev.preventDefault();
        const el = (ev.target as Element | null)?.closest?.("[data-edit]") as HTMLElement | null;
        const k = el?.dataset.edit;
        if (k && EDIT_KEY.test(k)) { keyRef.current = k; setEditKey(k); requestAnimationFrame(place); setTimeout(() => area.current?.focus(), 30); }
      });
    }
    doc.querySelectorAll("[data-edit]").forEach((n) => n.setAttribute("title", "Click to edit"));
    setHeight(Math.max(240, (doc.body.firstElementChild as HTMLElement | null)?.offsetHeight ?? doc.documentElement.scrollHeight));
    requestAnimationFrame(place);
  }, [place]);

  useEffect(() => { requestAnimationFrame(place); }, [phone, editKey, place]);
  // the mail reflows when the width changes (after the 300 ms width transition): fit the frame to it again so it never grows a scrollbar of its own
  useEffect(() => {
    const fit = () => { const d = frame.current?.contentDocument; if (d?.documentElement) { setHeight(Math.max(240, (d.body.firstElementChild as HTMLElement | null)?.offsetHeight ?? d.documentElement.scrollHeight)); place(); } };
    const t1 = setTimeout(fit, 120), t2 = setTimeout(fit, 380);
    window.addEventListener("resize", fit);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("resize", fit); };
  }, [phone, place]);
  useEffect(() => { const r = () => place(); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, [place]);

  const value = editKey ? getKey(draft, editKey) : "";
  const close = () => { setEditKey(null); setAnchor(null); frame.current?.contentDocument?.querySelectorAll(".fg-on").forEach((n) => n.classList.remove("fg-on")); };
  const add = (v: string) => {
    const el = area.current;
    if (!el || !editKey) return;
    const a = el.selectionStart ?? value.length, b = el.selectionEnd ?? a;
    setDraft((d) => putKey(d, editKey, value.slice(0, a) + `{${v}}` + value.slice(b)));
    setTimeout(() => { el.focus(); el.setSelectionRange(a + v.length + 2, a + v.length + 2); }, 0);
  };

  if (prev?.error) return <p role="alert" className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{prev.error}</p>;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">Click any text in the email to change it right here.</p>
        <div role="group" aria-label="Screen size" className="ml-auto inline-flex rounded-lg border border-fg/15 p-0.5 text-xs font-semibold">
          {([[false, "Desktop"], [true, "Phone"]] as const).map(([p, l]) => (
            <button key={l} type="button" aria-pressed={phone === p} onClick={() => setPhone(p)} className={`rounded-md px-3 py-1 transition-colors ${phone === p ? "bg-ink text-white dark:bg-brand-green dark:text-ink" : "text-fg hover:bg-fg/10"}`}>{l}</button>
          ))}
        </div>
      </div>

      <div ref={wrap} className="relative mt-3 overflow-hidden rounded-xl border border-fg/15 bg-surface shadow-sm">
        <div className="space-y-1.5 border-b border-fg/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-green text-sm font-bold text-ink">{(team.trim()[0] ?? "F").toUpperCase()}</span>
            <div className="min-w-0 text-sm leading-tight">
              <p className="truncate font-semibold text-fg">{team}</p>
              <p className="truncate text-xs text-neutral-600 dark:text-neutral-400">to Kofi Mensah (sample details) · just now</p>
            </div>
          </div>
          <label className="block">
            <span className="sr-only">Subject</span>
            <input className="w-full rounded-md border border-transparent bg-transparent px-1 py-1 text-base font-bold text-fg hover:border-fg/20 focus:border-brand-green focus:outline-none" value={draft.kinds[kindId]?.subject ?? ""} onChange={(e) => onSubject(e.target.value)} title="Click to change the subject" />
          </label>
          <p className="px-1 text-xs text-neutral-600 dark:text-neutral-400">Shown as: <span className="text-fg">{prev?.subject ?? "…"}</span></p>
        </div>

        <div className="bg-[#efefea] py-3">
          <div className={`mx-auto transition-[width] duration-300 ${phone ? "w-[375px] max-w-full overflow-hidden rounded-[22px] border-4 border-neutral-800 bg-white shadow-lg" : "w-full"}`}>
            <iframe ref={frame} title="Email preview" sandbox="allow-same-origin" srcDoc={prev?.html ?? ""} onLoad={onLoad} style={{ height }} className="block w-full border-0 bg-[#efefea]" />
          </div>
        </div>

        {editKey && anchor && (
          <div className="absolute z-10 rounded-xl border border-brand-green bg-surface p-2.5 shadow-xl" style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-fg">Editing the {niceKey(editKey)}</span>
              <button type="button" onClick={close} className="rounded-md bg-brand-green px-2.5 py-0.5 text-xs font-bold text-ink hover:brightness-95">Done</button>
            </div>
            <textarea ref={area} rows={Math.min(8, Math.max(2, value.split("\n").length + (value.length > 70 ? 1 : 0)))} value={value} aria-label={`Edit the ${niceKey(editKey)}`}
              onChange={(e) => { const v = e.target.value; setDraft((d) => putKey(d, editKey, v)); }}
              className="w-full resize-y rounded-lg border border-fg/20 bg-surface p-2 text-sm text-fg focus:border-brand-green focus:outline-none" />
            {!editKey.startsWith("brand.") || editKey === "brand.greeting" || editKey === "brand.contact" || editKey === "brand.trust" ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {vars.map((v) => <button key={v} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(v)} title={VAR_HELP[v]} className="rounded-full border border-fg/20 px-2 py-0.5 font-mono text-[11px] text-fg hover:bg-fg/10">{`{${v}}`}</button>)}
              </div>
            ) : null}
            <p className="mt-1.5 text-[11px] text-neutral-600 dark:text-neutral-400">{editKey.endsWith(".steps") ? "One step per line: Title | explanation. " : ""}**bold** works. Esc or Done to close.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function useTemplatesInfo() {
  const [info, setInfo] = useState<TemplatesInfo | null>(null);
  const load = useCallback(async () => { try { setInfo(await api<TemplatesInfo>("/admin/email-templates")); } catch { /* shown by the panel */ } }, []);
  useEffect(() => { void load(); }, [load]);
  return { info, load };
}

export function EmailTemplates({ info, onChanged }: { info: TemplatesInfo; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [draft, setDraft] = useState<Templates>(() => JSON.parse(JSON.stringify(info.templates)));
  const [sel, setSel] = useState<string>("brand");
  const [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState<{ subject?: string; html?: string; error?: string } | null>(null);
  const [logoTick, setLogoTick] = useState(0);
  const last = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(info.templates);
  const kind = info.kinds.find((k) => k.id === sel);

  // the preview follows what is being typed (after a short pause)
  useEffect(() => {
    const k = kind?.id ?? "created";
    const t = setTimeout(() => {
      void api<{ subject?: string; html?: string; error?: string }>("/admin/email-templates/preview", { method: "POST", json: { kind: k, templates: draft } }).then(setPrev).catch((e) => setPrev({ error: (e as Error).message }));
    }, 350);
    return () => clearTimeout(t);
  }, [draft, kind?.id, logoTick]);

  const setBrand = (key: string, v: string | boolean) => setDraft((d) => ({ ...d, brand: { ...d.brand, [key]: v } }));
  const setKind = (key: string, v: string) => setDraft((d) => ({ ...d, kinds: { ...d.kinds, [sel]: { ...d.kinds[sel], [key]: v } } }));

  const insert = (v: string) => {
    const el = last.current;
    if (!el) return toast("Click in the box you want it in first, then choose the placeholder.", "info");
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
    const next = el.value.slice(0, a) + `{${v}}` + el.value.slice(b);
    const key = el.dataset.key!;
    if (el.dataset.scope === "brand") setBrand(key, next); else setKind(key, next);
    setTimeout(() => { el.focus(); el.setSelectionRange(a + v.length + 2, a + v.length + 2); }, 0);
  };

  const save = async () => {
    setBusy(true);
    try { await api("/admin/email-templates", { method: "PUT", json: draft }); toast("Saved. The next email sent uses it.", "success", "Email templates"); onChanged(); }
    catch (e) { toast((e as Error).message, "error", "Couldn't save"); }
    setBusy(false);
  };
  const reset = async () => {
    const what = kind ? `“${kind.label}”` : "the branding and the safety line";
    if (!(await confirm({ title: `Put ${what} back to the default?`, body: "Your wording for this is replaced (it is not saved until you press Save).", confirmLabel: "Use the default", tone: "danger" }))) return;
    if (kind) setDraft((d) => ({ ...d, kinds: { ...d.kinds, [kind.id]: { ...info.defaults.kinds[kind.id] } } }));
    else setDraft((d) => ({ ...d, brand: { ...info.defaults.brand } }));
  };
  const test = async () => {
    setBusy(true);
    try { const r = await api<{ to: string; via: string }>("/admin/email-templates/test", { method: "POST", json: { kind: kind?.id ?? "created", templates: draft } }); toast(`Sent to ${r.to} (${r.via}). Check that inbox, and the junk folder.`, "success", "Sample sent"); }
    catch (e) { toast((e as Error).message, "error", "The sample was not sent"); }
    setBusy(false);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      await api("/admin/email-templates/logo", { method: "PUT", body: fd });
      setLogoTick((n) => n + 1); onChanged();
      toast("Your logo is on every email from now on.", "success", "Logo changed");
    } catch (e) { toast((e as Error).message, "error", "That logo can't be used"); }
    if (file.current) file.current.value = "";
    setBusy(false);
  };
  const useDefaultLogo = async () => { setBusy(true); try { await api("/admin/email-templates/logo", { method: "DELETE" }); setLogoTick((n) => n + 1); onChanged(); } catch (e) { toast((e as Error).message, "error"); } setBusy(false); };

  const box = (f: FieldMeta, value: string, scope: "brand" | "kind", set: (v: string) => void) => (
    <label key={f.key} className="block">
      <span className="text-sm font-semibold text-fg">{f.label}{!f.required && <span className="ml-1 text-xs font-normal text-neutral-500">(optional)</span>}</span>
      {f.rows <= 1
        ? <input className={`${field} mt-1 text-fg`} value={value} data-key={f.key} data-scope={scope} onFocus={(e) => (last.current = e.currentTarget)} onChange={(e) => set(e.target.value)} />
        : <textarea className={`${field} mt-1 text-fg`} rows={f.rows} value={value} data-key={f.key} data-scope={scope} onFocus={(e) => (last.current = e.currentTarget)} onChange={(e) => set(e.target.value)} />}
      {f.hint && <span className="mt-0.5 block text-xs text-neutral-600 dark:text-neutral-400">{f.hint}</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      <section className={card}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-bold text-fg">Email templates</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${info.customised ? "bg-brand-green text-ink" : "bg-fg/10 text-fg"}`}>{info.customised ? `${info.customised} change${info.customised === 1 ? "" : "s"} from the default` : "Default wording"}</span>
        </div>
        <p className={`mt-2 ${muted}`}>What every email says, the logo at the top, and the “genuine message” block that tells people it really is from IT. Pick an email on the left, change it, and watch the preview.</p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Emails" className="flex gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible">
          {[{ id: "brand", label: "Branding & trust", when: "" }, ...info.kinds].map((k) => (
            <button key={k.id} type="button" onClick={() => setSel(k.id)} aria-current={sel === k.id ? "page" : undefined}
              className={`shrink-0 rounded-xl px-3.5 py-2.5 text-left text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${sel === k.id ? "bg-ink text-white dark:bg-brand-green dark:text-ink" : "text-fg hover:bg-fg/10"}`}>
              {k.label}
            </button>
          ))}
        </nav>

        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <section className={`${card} min-w-0 space-y-4`}>
            {kind ? (
              <>
                <p className={muted}>{kind.when}</p>
                {kind.fields.map((f) => box(f, draft.kinds[kind.id]?.[f.key] ?? "", "kind", (v) => setKind(f.key, v)))}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Placeholders (click to add)</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {kind.vars.map((v) => <button key={v} type="button" onClick={() => insert(v)} title={VAR_HELP[v]} className="rounded-full border border-fg/20 px-2.5 py-0.5 font-mono text-xs text-fg hover:bg-fg/10">{`{${v}}`}</button>)}
                  </div>
                  <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400">Use <b>**double stars**</b> for bold. Nothing here is HTML.</p>
                </div>
              </>
            ) : (
              <>
                {info.brand_fields.map((f) => box(f, String(draft.brand[f.key] ?? ""), "brand", (v) => setBrand(f.key, v)))}
                <div className="space-y-3 rounded-xl border border-fg/15 p-4">
                  <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={draft.brand.show_logo} onChange={(e) => setBrand("show_logo", e.target.checked)} />
                    <span><b>Show the logo at the top</b><span className="block text-xs text-neutral-600 dark:text-neutral-400">It travels inside the email, so it shows wherever the email is read, also outside the office.</span></span>
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <img src={`/api/admin/email-templates/logo?t=${logoTick}`} alt="The logo used in emails" className="h-11 w-auto rounded border border-stone-200 bg-white p-1" />
                    <input ref={file} type="file" accept="image/png" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} aria-label="Choose a PNG logo" />
                    <button type="button" className={secondaryBtn} disabled={busy} onClick={() => file.current?.click()}>Use my own logo (PNG)</button>
                    {info.custom_logo && <button type="button" className={secondaryBtn} disabled={busy} onClick={() => void useDefaultLogo()}>Back to the helpdesk logo</button>}
                  </div>
                  <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={draft.brand.show_verify} onChange={(e) => setBrand("show_verify", e.target.checked)} />
                    <span><b>Add a “Verify this email” link</b><span className="block text-xs text-neutral-600 dark:text-neutral-400">It opens a page on the helpdesk itself confirming the email is genuine. Nobody can copy it onto a fake email. {info.app_url_set ? "" : <b className="text-red-700">Needs the helpdesk address under System &gt; Address.</b>}</span></span>
                  </label>
                </div>
              </>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-fg/10 pt-4">
              <button type="button" className={btn} disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
              {dirty && <button type="button" className={secondaryBtn} disabled={busy} onClick={() => setDraft(JSON.parse(JSON.stringify(info.templates)))}>Discard changes</button>}
              <button type="button" className="text-sm font-semibold text-neutral-600 underline underline-offset-2 hover:text-fg" onClick={() => void reset()}>Use the default for this</button>
              <button type="button" className={`${secondaryBtn} ml-auto`} disabled={busy} onClick={() => void test()} title="Sends this email, with your changes, to your own address">Send me this email</button>
            </div>
          </section>

          <section className={`${card} min-w-0`} aria-label="Preview">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Preview (with sample details), editable</p>
            <MailPreview prev={prev} draft={draft} setDraft={setDraft} kindId={kind?.id ?? "created"} vars={info.kinds.find((k) => k.id === (kind?.id ?? "created"))?.vars ?? []} team={draft.brand.team}
              onSubject={(v) => setDraft((d) => putKey(d, `kinds.${kind?.id ?? "created"}.subject`, v))} />
          </section>
        </div>
      </div>
    </div>
  );
}
