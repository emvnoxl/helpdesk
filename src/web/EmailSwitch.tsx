import { useState } from "react";
import { useNotify } from "./notify";
import { card } from "./ui";

/** "Email me when my tickets change": one switch, saved the moment it is flipped. `save` calls the right endpoint for the audience. */
export function EmailSwitch({ initial, save, title, text }: { initial: boolean; save: (on: boolean) => Promise<unknown>; title: string; text: string }) {
  const { toast } = useNotify();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function flip() {
    const next = !on;
    setBusy(true);
    try {
      await save(next);
      setOn(next);
      toast(next ? "You will get an email when something changes." : "No more ticket emails. You still see everything in the helpdesk.", "success", next ? "Emails on" : "Emails off");
    } catch (x) {
      toast((x as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={card + " space-y-3"}>
      <div>
        <h2 className="text-lg font-extrabold">{title}</h2>
        <p className="text-sm text-neutral-500">{text}</p>
      </div>
      <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold">
        <button type="button" role="switch" aria-checked={on} aria-label={title} disabled={busy} onClick={() => void flip()}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-brand-green" : "bg-stone-300 dark:bg-stone-600"}`}>
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-6" : "left-1"}`} />
        </button>
        <span>{on ? "On" : "Off"}</span>
      </label>
    </section>
  );
}
