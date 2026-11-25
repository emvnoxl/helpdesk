import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { CategoryIcon } from "./CategoryIcon";
import { useNotify } from "./notify";
import { btn, card, field } from "./ui";

/* Library > Request forms (admins): the few questions asked when someone picks a category on the new-ticket form. */

interface F { id?: string; label: string; type: "text" | "longtext" | "select" | "yesno"; required: boolean; options?: string[] }
interface Cat { id: number; name: string; fields: F[] }
const TYPE_LABEL: Record<F["type"], string> = { text: "Short answer", longtext: "Long answer", select: "Choose one", yesno: "Yes / No" };

export function RequestForms({ onExpired }: { onExpired: () => void }) {
  const { toast } = useNotify();
  const [cats, setCats] = useState<Cat[] | null>(null);
  const [edit, setEdit] = useState<{ id: number; name: string; fields: F[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setCats(await api<Cat[]>("/admin/forms")); } catch (e) { if ((e as ApiError).status === 401) onExpired(); else toast((e as Error).message, "error"); }
  }, [onExpired, toast]);
  useEffect(() => { void load(); }, [load]);

  const patch = (i: number, p: Partial<F>) => setEdit((e) => e && { ...e, fields: e.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const move = (i: number, d: number) => setEdit((e) => {
    if (!e || i + d < 0 || i + d >= e.fields.length) return e;
    const fields = [...e.fields];
    [fields[i], fields[i + d]] = [fields[i + d]!, fields[i]!];
    return { ...e, fields };
  });
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api(`/admin/forms/${edit.id}`, { method: "PUT", json: { fields: edit.fields } });
      toast(`The ${edit.name} form is saved. New tickets in that category ask these questions.`, "success", "Saved");
      setEdit(null);
      await load();
    } catch (e) { toast((e as Error).message, "error", "Couldn't save the form"); }
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-extrabold">Request forms</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">A few questions asked when someone picks a category, so IT gets what it needs the first time (“Which printer?”, “Where are you?”). Keep them short: every extra question makes people less likely to answer.</p>
      </div>
      {!cats && <p className="text-neutral-500">Loading…</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {cats?.map((c) => (
          <li key={c.id} className={card + " flex flex-col gap-2"}>
            <div className="flex items-center gap-2">
              <span className="text-neutral-500"><CategoryIcon name={c.name} /></span>
              <h3 className="font-bold">{c.name}</h3>
              <span className="ml-auto rounded-full bg-fg/10 px-2 py-0.5 text-xs font-bold">{c.fields.length ? `${c.fields.length} question${c.fields.length === 1 ? "" : "s"}` : "No questions"}</span>
            </div>
            {c.fields.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-sm text-neutral-700 dark:text-neutral-300">{c.fields.map((f, i) => <li key={i}>{f.label}{f.required ? " *" : ""}</li>)}</ul>}
            <button type="button" className="mt-auto self-start text-sm font-semibold underline underline-offset-2" onClick={() => setEdit({ id: c.id, name: c.name, fields: c.fields.map((f) => ({ ...f })) })}>{c.fields.length ? "Edit the questions" : "Add questions"}</button>
          </li>
        ))}
      </ul>

      {edit && (
        <div className="fixed inset-0 z-[95] grid place-items-center overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={`Questions for ${edit.name}`} onKeyDown={(e) => e.key === "Escape" && setEdit(null)}>
          <div className="my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-stone-200 bg-surface text-fg shadow-2xl" style={{ borderTop: "5px solid #00a859" }}>
            <div className="space-y-3 p-5">
              <div>
                <h3 className="text-lg font-extrabold">Questions for {edit.name}</h3>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">Up to 8. A question marked required must be answered before the ticket can be sent. An old ticket keeps the questions it was asked.</p>
              </div>
              <ol className="space-y-3">
                {edit.fields.map((f, i) => (
                  <li key={i} className="rounded-xl border border-stone-200 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <input className={`${field} min-w-[12rem] flex-1 text-fg`} placeholder="The question, e.g. Which printer?" maxLength={80} value={f.label} onChange={(e) => patch(i, { label: e.target.value })} aria-label={`Question ${i + 1}`} />
                      <select className={`${field} !w-auto text-fg`} value={f.type} onChange={(e) => patch(i, { type: e.target.value as F["type"], options: e.target.value === "select" ? f.options ?? ["", ""] : undefined })} aria-label="Kind of answer">
                        {(Object.keys(TYPE_LABEL) as F["type"][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                      </select>
                    </div>
                    {f.type === "select" && (
                      <textarea className={`${field} mt-2 min-h-[5rem] text-fg`} placeholder={"One choice per line\nWon't print\nPaper jam"} value={(f.options ?? []).join("\n")} onChange={(e) => patch(i, { options: e.target.value.split("\n") })} aria-label="Choices, one per line" />
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                      <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[#00a859]" checked={f.required} onChange={(e) => patch(i, { required: e.target.checked })} />Required</label>
                      <span className="ml-auto flex gap-1">
                        <button type="button" className="rounded px-2 py-1 hover:bg-fg/10 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                        <button type="button" className="rounded px-2 py-1 hover:bg-fg/10 disabled:opacity-30" disabled={i === edit.fields.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                        <button type="button" className="rounded px-2 py-1 font-semibold text-red-700 hover:bg-red-700/10" onClick={() => setEdit({ ...edit, fields: edit.fields.filter((_, j) => j !== i) })}>Remove</button>
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
              {edit.fields.length < 8 && <button type="button" className="text-sm font-semibold underline underline-offset-2" onClick={() => setEdit({ ...edit, fields: [...edit.fields, { label: "", type: "text", required: false }] })}>+ Add a question</button>}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-stone-200 bg-fg/5 px-5 py-3">
              <button type="button" className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-fg/10" onClick={() => setEdit(null)}>Cancel</button>
              <button type="button" className={btn} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save the questions"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
