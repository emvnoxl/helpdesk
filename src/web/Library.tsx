import { useCallback, useEffect, useState } from "react";
import { ApiError, api, fmt } from "./api";
import { KbBody, youtubeId, type ArticleBrief } from "./Help";
import type { Reply } from "./Replies";
import { useNotify } from "./notify";
import { SlidingTabs } from "./Tabs";
import { btn, btnGhost, card, field } from "./ui";
import { Checklists, Recurring, WorkingHours } from "./Workflows";

/* Staff > Library: the things that save IT typing. Help articles (what requesters read before and after raising a ticket),
   saved replies for the composer, and (admins) the response targets. */

type Section = "articles" | "replies" | "checklists" | "recurring" | "targets";

export function Library({ admin, open, onExpired }: { admin: boolean; open: (id: number) => void; onExpired: () => void }) {
  const [s, setS] = useState<Section>("articles");
  const tabs = [
    { id: "articles" as Section, label: "Help articles" },
    { id: "replies" as Section, label: "Saved replies" },
    { id: "checklists" as Section, label: "Checklists" },
    ...(admin ? [{ id: "recurring" as Section, label: "Recurring" }, { id: "targets" as Section, label: "Response targets" }] : []),
  ];
  return (
    <div className="space-y-4">
      <SlidingTabs<Section> variant="pill" label="Library sections" value={s} onChange={setS} tabs={tabs} />
      <div key={s} className="page-in">
        {s === "articles" && <Articles onExpired={onExpired} />}
        {s === "replies" && <Replies admin={admin} onExpired={onExpired} />}
        {s === "checklists" && <Checklists admin={admin} open={open} onExpired={onExpired} />}
        {s === "recurring" && admin && <Recurring open={open} onExpired={onExpired} />}
        {s === "targets" && admin && <Targets onExpired={onExpired} />}
      </div>
    </div>
  );
}

const guard = (onExpired: () => void, toast: (t: string, k?: any, title?: string) => void, title: string) => (e: unknown) =>
  (e as ApiError).status === 401 ? onExpired() : toast((e as Error).message, "error", title);

/* ---------------- help articles ---------------- */
interface Draft { id: number | null; title: string; body: string; category_id: string; published: boolean }
const BLANK: Draft = { id: null, title: "", body: "", category_id: "", published: true };

function Articles({ onExpired }: { onExpired: () => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<ArticleBrief[] | null>(null);
  const [cats, setCats] = useState<{ id: number; name: string }[]>([]);
  const [q, setQ] = useState("");
  const [d, setD] = useState<Draft | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [video, setVideo] = useState("");
  const fail = guard(onExpired, toast, "Couldn't save the article");

  const load = useCallback(() => api<ArticleBrief[]>(`/staff/kb?q=${encodeURIComponent(q.trim())}`).then(setRows, fail), [q]);
  useEffect(() => { const t = setTimeout(() => void load(), q ? 250 : 0); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api("/staff/tickets/categories").then(setCats, () => {}); }, []);

  const edit = async (id: number) => {
    const a = await api(`/staff/kb/${id}`).catch(fail);
    if (a) { setD({ id, title: a.title, body: a.body, category_id: a.category_id ? String(a.category_id) : "", published: a.published }); setPreview(false); }
  };
  const save = async () => {
    if (!d || busy) return;
    setBusy(true);
    try {
      const json = { title: d.title, body: d.body, category_id: d.category_id ? Number(d.category_id) : null, published: d.published };
      if (d.id) await api(`/staff/kb/${d.id}`, { method: "PATCH", json });
      else await api("/staff/kb", { method: "POST", json });
      toast(d.published ? "Requesters can read it now." : "Saved as a draft. Only staff can see it.", "success", "Article saved");
      setD(null);
      await load();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!d?.id) return;
    if (!(await confirm({ title: "Delete this article?", body: `“${d.title}” will disappear for everyone.`, confirmLabel: "Delete", tone: "danger" }))) return;
    await api(`/staff/kb/${d.id}`, { method: "DELETE" }).then(() => { setD(null); void load(); }, fail);
  };

  if (d)
    return (
      <div className={card + " mx-auto max-w-3xl space-y-4"}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-extrabold">{d.id ? "Edit article" : "New article"}</h2>
          <button className={btnGhost} onClick={() => setD(null)}>← Back to the list</button>
        </div>
        <label className="block text-sm font-semibold">Title
          <input className={field + " mt-1"} maxLength={160} placeholder="Say it the way people ask it, e.g. The printer says offline" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
        </label>
        <label className="block text-sm font-semibold">Category
          <span className="block text-xs font-normal text-neutral-500">Helps the right article come up for the right ticket</span>
          <select className={field + " mt-1 !w-auto"} value={d.category_id} onChange={(e) => setD({ ...d, category_id: e.target.value })}>
            <option value="">Any</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div>
          <div className="mb-1 flex items-center justify-between text-sm"><label htmlFor="kb-body" className="font-semibold">Steps or answer</label>
            <button type="button" className="text-xs font-semibold text-neutral-600 hover:text-fg" onClick={() => setPreview((p) => !p)}>{preview ? "Edit" : "Preview"}</button></div>
          {preview ? <div className="min-h-48 rounded-lg border border-stone-300 p-4"><KbBody text={d.body} /></div> : (
            <textarea id="kb-body" className={field + " min-h-64 font-mono leading-relaxed"} maxLength={20000} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })}
              placeholder={"## Try these first\n1. Restart the computer.\n2. Check the cable.\n\n## Still not working?\nRaise a ticket and tell us the exact message."} />
          )}
          <p className="mt-1 text-xs text-neutral-500">Use <code>## Heading</code>, <code>- bullet</code>, <code>1. step</code>, <code>**bold**</code> and <code>[text](https://link)</code>. A line that is only a YouTube link becomes a video.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={field + " max-w-sm"} placeholder="Paste a YouTube link to add a video" aria-label="YouTube link" value={video} onChange={(e) => setVideo(e.target.value)} />
            <button type="button" className={btnGhost + " border border-stone-300"} onClick={() => {
              if (!youtubeId(video)) return toast("That doesn't look like a YouTube link. Paste the address from the browser or the Share button.", "error", "Can't add that video");
              setD({ ...d, body: d.body.replace(/\s+$/, "") + "\n\n" + video.trim() + "\n" });
              setVideo("");
              setPreview(true);
            }}>Add video</button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.published} onChange={(e) => setD({ ...d, published: e.target.checked })} /> Published (requesters can read it and see it as a suggestion)</label>
        <div className="flex flex-wrap items-center gap-3">
          <button className={btn} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save article"}</button>
          {d.id && <button className="text-sm font-semibold text-red-700 hover:underline" onClick={() => void del()}>Delete</button>}
        </div>
      </div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" className={field + " max-w-sm"} placeholder="Search articles" aria-label="Search articles" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={btn + " ml-auto"} onClick={() => { setD(BLANK); setPreview(false); }}>New article</button>
      </div>
      <p className="text-sm text-neutral-500">Requesters see these on the <b>Help</b> page, and the best matches pop up while they type a ticket's summary. When one fixes it, they may never need to raise a ticket.</p>
      <div className={card + " overflow-x-auto !p-0"}>
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-stone-50 text-xs uppercase text-neutral-500"><tr><th className="p-3">Article</th><th>Category</th><th>Read</th><th>Fixed it</th><th>Didn't</th><th>Updated</th></tr></thead>
          <tbody>
            {(rows ?? []).map((a) => (
              <tr key={a.id} className="cursor-pointer border-b last:border-0 hover:bg-stone-50" onClick={() => void edit(a.id)}>
                <td className="p-3"><span className="font-semibold">{a.title}</span>{!a.published && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-900">Draft</span>}</td>
                <td>{a.category ?? <span className="text-neutral-400">Any</span>}</td><td>{a.views}</td><td>{a.helpful}</td><td>{a.not_helpful}</td><td className="whitespace-nowrap">{fmt(a.updated_at)}</td>
              </tr>
            ))}
            {rows && !rows.length && <tr><td colSpan={6} className="p-6 text-center text-neutral-500">{q ? "No article matches." : "No articles yet. Write the first one."}</td></tr>}
            {!rows && <tr><td colSpan={6} className="p-6 text-center text-neutral-500">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- saved replies ---------------- */
function Replies({ admin, onExpired }: { admin: boolean; onExpired: () => void }) {
  const { toast, confirm } = useNotify();
  const [rows, setRows] = useState<Reply[] | null>(null);
  const [d, setD] = useState<{ id: number | null; title: string; body: string; shared: boolean } | null>(null);
  const fail = guard(onExpired, toast, "Couldn't save the reply");
  const load = useCallback(() => api<Reply[]>("/staff/replies").then(setRows, fail), []);
  useEffect(() => void load(), [load]);

  const save = async () => {
    if (!d) return;
    try {
      if (d.id) await api(`/staff/replies/${d.id}`, { method: "PATCH", json: d });
      else await api("/staff/replies", { method: "POST", json: d });
      setD(null);
      await load();
    } catch (e) { fail(e); }
  };
  const del = async (r: Reply) => {
    if (!(await confirm({ title: "Delete this reply?", body: `“${r.title}”`, confirmLabel: "Delete", tone: "danger" }))) return;
    await api(`/staff/replies/${r.id}`, { method: "DELETE" }).then(load, fail);
  };
  const may = (r: Reply) => (r.shared ? admin : r.mine);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-neutral-500">Open them in a ticket with the <b>Saved replies</b> button, or type <kbd className="rounded border border-stone-300 px-1.5">/</kbd> in an empty message box. <code>{"{name}"}</code>, <code>{"{ref}"}</code> and <code>{"{agent}"}</code> are filled in for you.</p>
        <button className={btn + " ml-auto"} onClick={() => setD({ id: null, title: "", body: "", shared: false })}>New reply</button>
      </div>
      {d && (
        <div className={card + " space-y-3"}>
          <input className={field} placeholder="Short title" aria-label="Reply title" maxLength={80} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <textarea className={field + " min-h-28"} placeholder={"Hi {name}, …"} aria-label="Reply text" maxLength={4000} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
          {admin && !d.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.shared} onChange={(e) => setD({ ...d, shared: e.target.checked })} /> Share with the whole team</label>}
          <div className="flex gap-3"><button className={btn} onClick={() => void save()}>Save reply</button><button className={btnGhost} onClick={() => setD(null)}>Cancel</button></div>
        </div>
      )}
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(rows ?? []).map((r) => (
          <li key={r.id} className={card + " min-w-0"}>
            <div className="flex items-start gap-2">
              <h3 className="min-w-0 flex-1 truncate font-bold">{r.title}</h3>
              {r.shared ? <span className="rounded-full bg-ink px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white dark:bg-brand-green dark:text-ink">Team</span> : <span className="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neutral-600">Mine</span>}
            </div>
            <p className="mt-1.5 line-clamp-4 whitespace-pre-wrap text-sm text-neutral-600">{r.body}</p>
            <div className="mt-3 flex items-center gap-3 text-xs">
              <span className="text-neutral-500">Used {r.uses} time{r.uses === 1 ? "" : "s"}</span>
              {may(r) && <><button className="ml-auto font-semibold hover:underline" onClick={() => setD({ id: r.id, title: r.title, body: r.body, shared: r.shared })}>Edit</button><button className="font-semibold text-red-700 hover:underline" onClick={() => void del(r)}>Delete</button></>}
            </div>
          </li>
        ))}
        {rows && !rows.length && <li className="text-sm text-neutral-500">No saved replies yet.</li>}
      </ul>
    </div>
  );
}

/* ---------------- response targets (admin) ---------------- */
const PRIOS = [["urgent", "Urgent"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]] as const;

function Targets({ onExpired }: { onExpired: () => void }) {
  const { toast } = useNotify();
  const [h, setH] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [cal, setCal] = useState<any>(null);
  const fail = guard(onExpired, toast, "Couldn't save the targets");
  useEffect(() => { api("/admin/sla").then((r) => { setH(Object.fromEntries(Object.entries(r.hours).map(([k, v]) => [k, String(v)]))); setCal(r.calendar); }, fail); }, []);
  if (!h || !cal) return <p className="text-neutral-500">Loading…</p>;

  const save = async () => {
    setBusy(true);
    try {
      await api("/admin/sla", { method: "PUT", json: Object.fromEntries(PRIOS.map(([k]) => [k, Number(h[k])])) });
      toast("Open tickets now follow the new targets.", "success", "Response targets saved");
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
    <div className={card + " mx-auto max-w-xl space-y-4"}>
      <div>
        <h2 className="text-lg font-extrabold">Response targets</h2>
        <p className="mt-1 text-sm text-neutral-500">How many hours IT has to fix a ticket, by priority. The team is warned when a ticket is close to its target and again when it's late. The clock stops while a ticket is <b>waiting</b> for the requester.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {PRIOS.map(([k, label]) => (
          <label key={k} className="text-sm font-semibold">{label}
            <div className="mt-1 flex items-center gap-2"><input type="number" min={0.5} max={720} step={0.5} className={field} value={h[k]} onChange={(e) => setH({ ...h, [k]: e.target.value })} /><span className="text-neutral-500">hours</span></div>
          </label>
        ))}
      </div>
      <p className="text-xs text-neutral-500">Changing these updates every open ticket, measured from when it was raised. {cal.enabled ? "The hours are working hours (see below)." : "The clock runs around the clock, nights and weekends included, unless you switch on working hours below."}</p>
      <button className={btn} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save targets"}</button>
    </div>
    <WorkingHours calendar={cal} hours={h} onSaved={setCal} onExpired={onExpired} />
    </div>
  );
}
