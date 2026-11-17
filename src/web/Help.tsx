import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { CategoryIcon } from "./CategoryIcon";
import { btn, btnGhost, card, field } from "./ui";

/* Help articles for normal users: a searchable Help page, and "these might help" suggestions while a ticket is being written.
   Article text is plain text with a few conventions (## heading, - bullets, 1. steps, **bold**). It is rendered into elements,
   never as HTML, so nothing an author types can run in a reader's browser. */

export interface ArticleBrief { id: number; title: string; excerpt: string; category: string | null; category_id: number | null; published: boolean; video: boolean; views: number; helpful: number; not_helpful: number; updated_at: number }
interface Article extends ArticleBrief { body: string; my_vote: "yes" | "no" | null }

/** The 11-character id of a YouTube link (watch, youtu.be, shorts or embed), or null. Only this id ever reaches the page. */
export function youtubeId(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\.|^m\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0] ?? null;
    else if (host === "youtube.com" || host === "youtube-nocookie.com") id = u.pathname === "/watch" ? u.searchParams.get("v") : (u.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] ?? null);
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

const SAFE_URL = /^https?:\/\/[^\s<>"]+$/i;
function Video({ id }: { id: string }) {
  return (
    <figure className="mt-4">
      <div className="relative aspect-video w-full max-w-4xl overflow-hidden rounded-xl border border-stone-300 bg-black">
        <iframe
          className="absolute inset-0 h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${id}`}
          title="Video"
          loading="lazy"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <figcaption className="mt-1.5 text-xs text-neutral-500">
        Video not playing? <a className="font-semibold underline" href={`https://www.youtube.com/watch?v=${id}`} target="_blank" rel="noopener noreferrer">Watch it on YouTube</a> (some company networks block video sites).
      </figcaption>
    </figure>
  );
}

/** **bold**, [text](https://link) and bare links. Links open in a new tab; only http(s) addresses become links. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"]+)/g).map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
    const md = p.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (md) return <a key={i} className="font-semibold underline" href={md[2]} target="_blank" rel="noopener noreferrer">{md[1]}</a>;
    if (SAFE_URL.test(p)) return <a key={i} className="break-all font-semibold underline" href={p} target="_blank" rel="noopener noreferrer">{p}</a>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

export function KbBody({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i]!.trimEnd();
    if (!line.trim()) { i++; continue; }
    const vid = youtubeId(line.trim().replace(/^\[[^\]]*\]\(|\)$/g, ""));
    if (vid && /^(\[[^\]]*\]\()?https?:\/\/\S+\)?$/.test(line.trim())) { out.push(<Video key={k++} id={vid} />); i++; continue; }
    if (/^#{1,3}\s+/.test(line)) { out.push(<h3 key={k++} className="mt-5 text-base font-extrabold first:mt-0">{inline(line.replace(/^#{1,3}\s+/, ""))}</h3>); i++; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!.trim())) items.push(lines[i++]!.trim().replace(/^[-*]\s+/, ""));
      out.push(<ul key={k++} className="mt-2 list-disc space-y-1 pl-5">{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i]!.trim())) items.push(lines[i++]!.trim().replace(/^\d+[.)]\s+/, ""));
      out.push(<ol key={k++} className="mt-2 list-decimal space-y-1.5 pl-5">{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s+|[-*]\s+|\d+[.)]\s+)/.test(lines[i]!.trim()) && !(para.length && youtubeId(lines[i]!.trim()))) para.push(lines[i++]!.trim());
    out.push(<p key={k++} className="mt-2">{inline(para.join(" "))}</p>);
  }
  return <div className="text-sm leading-relaxed">{out}</div>;
}

/** One article with the "did this solve it?" question. */
export function ArticleView({ id, onSolved, onNeedMore, onBack }: { id: number; onSolved?: () => void; onNeedMore?: () => void; onBack?: () => void }) {
  const [a, setA] = useState<Article | null>(null);
  const [err, setErr] = useState("");
  const [voted, setVoted] = useState<"yes" | "no" | null>(null);
  // The question is asked again on every visit: an earlier answer doesn't hide it.
  useEffect(() => { api<Article>(`/kb/${id}`).then(setA, (e) => setErr(e.message)); }, [id]);

  const vote = async (yes: boolean) => {
    setVoted(yes ? "yes" : "no");
    await api(`/kb/${id}/vote`, { method: "POST", json: { helpful: yes } }).catch(() => {});
    if (yes) onSolved?.();
  };
  if (err) return <p className="text-sm text-red-700">{err}</p>;
  if (!a) return <p className="text-sm text-neutral-500">Loading…</p>;
  return (
    <article>
      {onBack && <button className="mb-3 text-sm font-semibold text-neutral-600 hover:text-fg" onClick={onBack}>← All articles</button>}
      {a.category && <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-semibold text-neutral-600">{a.category}</span>}
      <h2 className="mt-2 text-xl font-extrabold">{a.title}</h2>
      <div className="mt-3"><KbBody text={a.body} /></div>
      <div className="mt-6 rounded-xl bg-stone-50 p-4" role="group" aria-label="Did this help?">
        {voted === "yes" ? (
          <p className="text-sm font-semibold">Glad that helped. Thanks for letting us know.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-bold">Did this solve it?</span>
            <button className={btn} onClick={() => void vote(true)}>Yes, that fixed it</button>
            <button className={btnGhost + " border border-stone-300"} onClick={() => { void vote(false); onNeedMore?.(); }}>{voted === "no" ? "Still not fixed" : "No, I still need help"}</button>
          </div>
        )}
      </div>
    </article>
  );
}

/* ---------------- the Help page ----------------
   A category sidebar (chips on a phone), a search box, a view toggle (cards, list, grouped by category) and a sort. It uses the whole
   screen width; an open article gets the wide column for reading plus a "more in this category" rail on big screens. */

type View = "cards" | "list" | "grouped";
type Sort = "az" | "read" | "helpful" | "new";
const VIEW_KEY = "fortress-helpdesk:help-view";
const loadView = (): View => { try { const v = localStorage.getItem(VIEW_KEY); return v === "list" || v === "grouped" ? v : "cards"; } catch { return "cards"; } };

const VIEWS: { id: View; label: string; d: string }[] = [
  { id: "cards", label: "Cards", d: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v6H4zM13 14h7v6h-7z" },
  { id: "list", label: "List", d: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" },
  { id: "grouped", label: "By category", d: "M3 6h8M3 12h8M3 18h8M15 6h6M15 12h6M15 18h6" },
];
const SORTS: { id: Sort; label: string }[] = [{ id: "az", label: "A to Z" }, { id: "read", label: "Most read" }, { id: "helpful", label: "Most helpful" }, { id: "new", label: "Recently updated" }];
const catName = (a: ArticleBrief) => a.category ?? "Other";

const Play = () => (
  <span className="inline-flex items-center gap-1 rounded-full bg-[#d92b33] px-2 py-0.5 text-[11px] font-bold text-white" title="Includes a video">
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 4.5v15l13-7.5z" /></svg>Video
  </span>
);

function Tile({ a, view, onOpen, i }: { a: ArticleBrief; view: View; onOpen: () => void; i: number }) {
  const row = view === "list";
  return (
    <li className="rise-in min-w-0" style={{ ["--i" as string]: Math.min(i, 12) }}>
      <button
        onClick={onOpen}
        className={`group w-full border border-stone-200 bg-surface text-left shadow-sm transition hover:border-brand-green/70 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${
          row ? "flex items-center gap-4 rounded-xl px-4 py-3" : "flex h-full flex-col rounded-2xl p-4"
        }`}
      >
        <span className={`grid shrink-0 place-items-center rounded-xl bg-stone-100 text-neutral-600 transition group-hover:bg-brand-green group-hover:text-ink ${row ? "h-10 w-10" : "mb-3 h-11 w-11"}`}>
          <CategoryIcon name={catName(a)} size={row ? 20 : 22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold leading-snug">{a.title}</span>
          <span className={`mt-1 block text-sm text-neutral-500 ${row ? "truncate" : "line-clamp-3"}`}>{a.excerpt}</span>
        </span>
        <span className={`flex shrink-0 items-center gap-2 ${row ? "" : "mt-3 flex-wrap"}`}>
          {!row && <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-600">{catName(a)}</span>}
          {a.video && <Play />}
          {a.helpful > 0 && <span className="text-[11px] font-semibold text-neutral-500" title="People who said it fixed their problem">{a.helpful} found it helpful</span>}
        </span>
      </button>
    </li>
  );
}

export function Help({ onNewTicket }: { onNewTicket: () => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ArticleBrief[] | null>(null);
  const [open, setOpen] = useState<ArticleBrief | null>(null);
  const [cat, setCat] = useState<string>("All");
  const [view, setViewState] = useState<View>(loadView);
  const [sort, setSort] = useState<Sort>("az");
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* the choice just won't be remembered */ } };

  useEffect(() => {
    const t = setTimeout(() => void api<ArticleBrief[]>(`/kb?q=${encodeURIComponent(q.trim())}`).then(setRows, () => setRows([])), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const cats = useMemo(() => {
    const m = new Map<string, number>();
    (rows ?? []).forEach((a) => m.set(catName(a), (m.get(catName(a)) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => Number(a[0] === "Other") - Number(b[0] === "Other") || a[0].localeCompare(b[0]));
  }, [rows]);
  const videos = (rows ?? []).filter((a) => a.video).length;

  const shown = useMemo(() => {
    let r = (rows ?? []).filter((a) => cat === "All" || (cat === "Videos" ? a.video : catName(a) === cat));
    // With a search the server's best-match order is kept; otherwise the chosen sort applies.
    if (!q.trim()) {
      const by: Record<Sort, (a: ArticleBrief, b: ArticleBrief) => number> = {
        az: (a, b) => a.title.localeCompare(b.title),
        read: (a, b) => b.views - a.views || a.title.localeCompare(b.title),
        helpful: (a, b) => b.helpful - a.helpful || a.title.localeCompare(b.title),
        new: (a, b) => b.updated_at - a.updated_at,
      };
      r = [...r].sort(by[sort]);
    }
    return r;
  }, [rows, cat, sort, q]);

  const pick = (c: string) => { setCat(c); setOpen(null); };
  const filters: { id: string; label: string; n: number }[] = [
    { id: "All", label: "All articles", n: rows?.length ?? 0 },
    ...(videos ? [{ id: "Videos", label: "Videos", n: videos }] : []),
    ...cats.map(([name, n]) => ({ id: name, label: name, n })),
  ];

  const sidebar = (
    <nav aria-label="Help categories" className="lg:sticky lg:top-4 lg:self-start">
      <ul className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0">
        {filters.map((f) => {
          const on = cat === f.id;
          return (
            <li key={f.id} className="shrink-0">
              <button
                onClick={() => pick(f.id)}
                aria-current={on ? "true" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${
                  on ? "bg-ink text-white shadow dark:bg-brand-green dark:text-ink" : "border border-stone-200 bg-surface text-neutral-700 hover:border-stone-400 lg:border-transparent lg:bg-transparent lg:hover:bg-stone-200/60"
                }`}
              >
                <span className={f.id === "Videos" && !on ? "text-[#ee3239]" : ""}><CategoryIcon name={f.id} size={18} /></span>
                <span className="whitespace-nowrap lg:flex-1 lg:whitespace-normal">{f.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${on ? "bg-white/20 dark:bg-ink/15" : "bg-stone-200 text-neutral-600"}`}>{f.n}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 hidden rounded-2xl border border-dashed border-stone-300 p-4 text-sm text-neutral-600 lg:block">
        <b className="block text-fg">Can't find it?</b>
        Tell IT what's wrong and we'll sort it out.
        <button className={btn + " mt-3 w-full"} onClick={onNewTicket}>Submit a ticket</button>
      </div>
    </nav>
  );

  /* ---- an article open ---- */
  if (open) {
    const related = (rows ?? []).filter((a) => a.id !== open.id && catName(a) === catName(open)).slice(0, 6);
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        {sidebar}
        <div className="grid min-w-0 grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className={card + " min-w-0 p-5 sm:p-8"}>
            <div className="max-w-4xl">
              <ArticleView id={open.id} onBack={() => setOpen(null)} />
              <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-stone-200 pt-4 text-sm text-neutral-600">
                Still stuck? <button className={btn} onClick={onNewTicket}>Submit a ticket</button>
              </div>
            </div>
          </div>
          {related.length > 0 && (
            <aside className="min-w-0 2xl:sticky 2xl:top-4 2xl:self-start" aria-label="More in this category">
              <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-neutral-500">More in {catName(open)}</h2>
              <ul className="space-y-2">
                {related.map((a) => (
                  <li key={a.id}>
                    <button onClick={() => { setOpen(a); window.scrollTo({ top: 0 }); }} className="flex w-full items-start gap-3 rounded-xl border border-stone-200 bg-surface p-3 text-left shadow-sm transition hover:border-brand-green/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
                      <span className="mt-0.5 text-neutral-500"><CategoryIcon name={catName(a)} size={18} /></span>
                      <span className="min-w-0 flex-1"><span className="block text-sm font-bold leading-snug">{a.title}</span>{a.video && <span className="mt-1 inline-block"><Play /></span>}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </div>
    );
  }

  /* ---- the library ---- */
  const grid = view === "list" ? "grid grid-cols-1 gap-2" : "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";
  const groups = view === "grouped" ? cats.map(([name]) => [name, shown.filter((a) => catName(a) === name)] as const).filter(([, l]) => l.length) : [];
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {sidebar}
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[14rem] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg></span>
            <input type="search" className={field + " !pl-9"} placeholder="Search help, e.g. printer, Wi-Fi, password" aria-label="Search help articles" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {!q.trim() && (
            <label className="flex items-center gap-2 text-sm text-neutral-500">Sort
              <select className={field + " !w-auto"} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort articles">
                {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          )}
          <div className="inline-flex rounded-xl border border-stone-200 bg-surface p-0.5" role="radiogroup" aria-label="How to show articles">
            {VIEWS.map((v) => (
              <button key={v.id} role="radio" aria-checked={view === v.id} onClick={() => setView(v.id)} title={v.label}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green ${view === v.id ? "bg-ink text-white dark:bg-brand-green dark:text-ink" : "text-neutral-600 hover:text-fg"}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={v.d} /></svg>
                <span className="max-sm:sr-only">{v.label}</span>
              </button>
            ))}
          </div>
        </div>

        <p className="text-sm text-neutral-500" aria-live="polite">
          {rows === null ? "Loading…" : `${shown.length} article${shown.length === 1 ? "" : "s"}${cat !== "All" ? ` in ${cat}` : ""}${q.trim() ? ` for “${q.trim()}”` : ""}`}
        </p>

        {rows !== null && !shown.length ? (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-surface p-10 text-center text-sm text-neutral-500">
            {q ? <>Nothing matches “{q}”{cat !== "All" ? <> in {cat}. <button className="font-semibold underline" onClick={() => setCat("All")}>Search all articles</button></> : "."}</> : <>No help articles here yet.</>}{" "}
            <button className="font-semibold underline" onClick={onNewTicket}>Submit a ticket</button> and IT will help.
          </div>
        ) : view === "grouped" ? (
          <div className="space-y-8">
            {groups.map(([name, list]) => (
              <section key={name} aria-label={name}>
                <h2 className="mb-3 flex items-center gap-2.5 text-lg font-extrabold">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-stone-100 text-neutral-600"><CategoryIcon name={name} size={18} /></span>
                  {name}<span className="rounded-full bg-stone-200 px-2 py-0.5 text-xs font-bold text-neutral-600">{list.length}</span>
                </h2>
                <ul className={grid}>{list.map((a, i) => <Tile key={a.id} a={a} view="cards" i={i} onOpen={() => setOpen(a)} />)}</ul>
              </section>
            ))}
          </div>
        ) : (
          <ul className={grid}>{shown.map((a, i) => <Tile key={a.id} a={a} view={view} i={i} onOpen={() => setOpen(a)} />)}</ul>
        )}
      </div>
    </div>
  );
}

/** While someone writes a ticket: articles that may already answer it. Hidden when there is nothing relevant. */
export function Suggest({ title, categoryId, onSolved }: { title: string; categoryId: string; onSolved: () => void }) {
  const [rows, setRows] = useState<ArticleBrief[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [hidden, setHidden] = useState("");
  const q = title.trim();

  useEffect(() => {
    if (q.length < 6) return setRows([]);
    const t = setTimeout(() => void api<ArticleBrief[]>(`/kb/suggest?q=${encodeURIComponent(q)}${categoryId ? `&category_id=${categoryId}` : ""}`).then(setRows, () => setRows([])), 450);
    return () => clearTimeout(t);
  }, [q, categoryId]);

  const shown = rows.filter((r) => hidden !== q);
  if (!shown.length) return null;
  return (
    <>
      <div className="rise-in rounded-xl border border-brand-green/50 bg-brand-green/10 p-3.5" role="region" aria-label="Suggested help articles">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-bold">These might fix it already</p>
          <button type="button" className="text-xs font-semibold text-neutral-600 hover:text-fg" onClick={() => setHidden(q)}>Hide</button>
        </div>
        <ul className="mt-2 space-y-1.5">
          {shown.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setOpen(a.id)} className="flex w-full items-start gap-2.5 rounded-lg bg-surface px-3 py-2 text-left text-sm shadow-sm hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-green">
                <svg className="mt-0.5 shrink-0 text-brand-green" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM8 7h6" /></svg>
                <span className="min-w-0"><span className="block font-semibold">{a.title}</span><span className="line-clamp-1 text-xs text-neutral-500">{a.excerpt}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {open !== null && createPortal(<Reader id={open} onClose={() => setOpen(null)} onSolved={() => { setOpen(null); onSolved(); }} />, document.body)}
    </>
  );
}

function Reader({ id, onClose, onSolved }: { id: number; onClose: () => void; onSolved: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Help article" className="fixed inset-0 z-[70] grid place-items-center bg-black/55 p-3 sm:p-6" onClick={onClose}>
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-2xl border border-stone-200 bg-surface p-5 shadow-2xl sm:p-7" onClick={(e) => e.stopPropagation()}>
        <ArticleView id={id} onSolved={onSolved} onNeedMore={onClose} />
        <div className="mt-4 text-right"><button className={btnGhost} onClick={onClose}>Back to my ticket</button></div>
      </div>
    </div>
  );
}
