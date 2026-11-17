import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { btn, field } from "./ui";

/* Saved replies in the staff composer. A button (or typing "/" in an empty box) opens a searchable list; picking one puts the text in the
   message box with {name}, {ref} and {agent} filled in. Staff can also save what they've typed as a new reply. */

export interface Reply { id: number; title: string; body: string; uses: number; shared: boolean; mine: boolean }
export interface Vars { name: string; ref: string; agent: string }

export const fillReply = (body: string, v: Vars) =>
  body.replace(/\{name\}/gi, v.name.split(/\s+/)[0] || "there").replace(/\{ref\}/gi, v.ref).replace(/\{agent\}/gi, v.agent.split(/\s+/)[0] || "IT");

export function useReplies(enabled = true) {
  const [list, setList] = useState<Reply[]>([]);
  const load = () => (enabled ? api<Reply[]>("/staff/replies").then(setList, () => {}) : Promise.resolve());
  useEffect(() => void load(), [enabled]);
  return { list, reload: load };
}

export function RepliesPicker({ list, reload, vars, draft, admin, onInsert, onClose }: { list: Reply[]; reload: () => Promise<unknown>; vars: Vars; draft: string; admin: boolean; onInsert: (text: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [shared, setShared] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((r) => w.every((x) => r.title.toLowerCase().includes(x) || r.body.toLowerCase().includes(x)));
  }, [list, q]);
  useEffect(() => setAt(0), [q]);
  useEffect(() => { search.current?.focus(); }, []);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  const pick = (r: Reply) => {
    onInsert(fillReply(r.body, vars));
    void api(`/staff/replies/${r.id}/use`, { method: "POST", json: {} }).catch(() => {});
    onClose();
  };
  const save = async () => {
    setErr("");
    try {
      await api("/staff/replies", { method: "POST", json: { title, body: draft, shared } });
      await reload();
      setSaving(false);
      setTitle("");
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div ref={box} role="dialog" aria-label="Saved replies" className="absolute inset-x-3 bottom-full z-30 mb-2 max-h-[22rem] overflow-hidden rounded-2xl border border-stone-300 bg-surface shadow-2xl sm:inset-x-auto sm:left-3 sm:w-[26rem]">
      <div className="border-b border-stone-200 p-2.5">
        <input ref={search} className={field} placeholder="Search saved replies…" aria-label="Search saved replies" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); if (rows[at]) pick(rows[at]!); }
          }} />
      </div>
      <ul className="max-h-60 overflow-y-auto p-1.5" role="listbox" aria-label="Replies">
        {rows.map((r, i) => (
          <li key={r.id} role="option" aria-selected={i === at}>
            <button type="button" onMouseEnter={() => setAt(i)} onClick={() => pick(r)} className={`w-full rounded-lg px-3 py-2 text-left ${i === at ? "bg-stone-200/70" : ""}`}>
              <span className="flex items-center gap-2 text-sm font-bold">{r.title}{r.shared && <span className="rounded-full bg-ink px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white dark:bg-brand-green dark:text-ink">Team</span>}</span>
              <span className="line-clamp-2 text-xs text-neutral-500">{r.body}</span>
            </button>
          </li>
        ))}
        {!rows.length && <li className="px-3 py-6 text-center text-sm text-neutral-500">{list.length ? "No reply matches." : "No saved replies yet."}</li>}
      </ul>
      <div className="border-t border-stone-200 p-2.5 text-xs">
        {!saving ? (
          <button type="button" disabled={draft.trim().length < 2} onClick={() => setSaving(true)} className="font-semibold text-neutral-600 hover:text-fg disabled:opacity-40" title={draft.trim().length < 2 ? "Type a message first, then save it" : undefined}>
            + Save what I've typed as a reply
          </button>
        ) : (
          <div className="space-y-2">
            <input className={field} placeholder="Short title, e.g. Restart and tell me" aria-label="Reply title" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            {admin && <label className="flex items-center gap-2"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with the whole team</label>}
            {err && <p className="text-red-700" role="alert">{err}</p>}
            <div className="flex gap-2"><button type="button" className={btn + " !px-3 !py-1.5 !text-xs"} disabled={title.trim().length < 2} onClick={() => void save()}>Save reply</button><button type="button" className="px-2 font-semibold text-neutral-600" onClick={() => setSaving(false)}>Cancel</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
