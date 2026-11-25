import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { loadGifConfig } from "./gifConfig";
import { useNotify } from "./notify";
import { secondaryBtn } from "./SystemSetup";
import { btn, field } from "./ui";

/* Admin > System > Chat: where the chat's GIFs come from. GIPHY search needs a free API key (kept encrypted, never shown again);
   the library is the company's own GIFs that everyone can pick from. */

interface Info {
  giphy: { configured: boolean; enabled: boolean; source: "saved" | "env" | "none" };
  library: { id: number; title: string; size: number; created_at: number }[];
  max_mb: number;
  max_items: number;
}
const card = "rounded-2xl border border-fg/10 bg-surface p-5";
const muted = "text-sm text-neutral-600 dark:text-neutral-400";

export function useGifInfo() {
  const [info, setInfo] = useState<Info | null>(null);
  const load = useCallback(async () => { try { setInfo(await api<Info>("/admin/gifs")); } catch { /* shown by the panel */ } }, []);
  useEffect(() => { void load(); }, [load]);
  return { info, load };
}

export function ChatSetup({ info, onChanged }: { info: Info; onChanged: () => void }) {
  const { toast, confirm } = useNotify();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const file = useRef<HTMLInputElement>(null);

  // The test runs in THIS browser with GIPHY's SDK, which is exactly how everyone else will use it.
  const test = async (quiet = false) => {
    try {
      const cfg = await loadGifConfig(true, true);
      if (!cfg.giphy) { if (!quiet) toast("GIPHY is switched off or has no key yet.", "info", "GIPHY test"); return false; }
      const { GiphyFetch } = await import("@giphy/js-fetch-api");
      const r = await new GiphyFetch(cfg.giphy.key).trending({ limit: 1 });
      toast(r.data.length ? "GIPHY answered to this browser: GIFs will work." : "GIPHY answered but returned nothing.", "success", "GIPHY test");
      return true;
    } catch (e) {
      const offline = e instanceof TypeError; // "Failed to fetch": the request never got an answer
      toast(offline ? "This computer could not reach GIPHY (api.giphy.com). Check its internet access: a firewall, proxy or ad blocker may be blocking it." : "GIPHY did not accept it: " + ((e as Error).message || "check the key") + ". If the key is new, give it a few minutes.", "error", "GIPHY test failed");
      return false;
    }
  };
  const saveKey = async () => {
    setBusy(true);
    try {
      await api("/admin/gifs/settings", { method: "PUT", json: { key } });
      setKey("");
      onChanged();
      await test();
    } catch (e) { toast((e as Error).message, "error", "Couldn't save the key"); }
    setBusy(false);
  };
  const setOn = async (enabled: boolean) => {
    setBusy(true);
    try { await api("/admin/gifs/settings", { method: "PUT", json: { enabled } }); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };
  const removeKey = async () => {
    if (!(await confirm({ title: "Remove the GIPHY key?", body: "GIPHY stops working in the chat. The company library stays.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy(true);
    try { await api("/admin/gifs/settings", { method: "PUT", json: { key: "-" } }); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
    setBusy(false);
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      if (title.trim()) fd.append("title", title.trim());
      await api("/admin/gifs/library", { method: "POST", body: fd });
      setTitle("");
      if (file.current) file.current.value = "";
      toast(`"${title.trim() || f.name.replace(/\.gif$/i, "")}" is in the library.`, "success", "GIF added");
      onChanged();
    } catch (e) { toast((e as Error).message, "error", "Couldn't add the GIF"); }
    setBusy(false);
  };
  const remove = async (g: Info["library"][number]) => {
    if (!(await confirm({ title: `Remove "${g.title}"?`, body: "It disappears from the picker. GIFs already sent in conversations stay there.", confirmLabel: "Remove", tone: "danger" }))) return;
    try { await api(`/admin/gifs/library/${g.id}`, { method: "DELETE" }); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
  };

  return (
    <div className="space-y-5">
      <section className={card}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-bold text-fg">GIF search (GIPHY)</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${info.giphy.configured && info.giphy.enabled ? "bg-brand-green text-ink" : "bg-fg/10 text-fg"}`}>{!info.giphy.configured ? "Not set up" : info.giphy.enabled ? "On" : "Switched off"}</span>
          {info.giphy.configured && info.giphy.enabled && <button className={`${secondaryBtn} ml-auto`} disabled={busy} onClick={() => void test()}>Test</button>}
        </div>
        <p className={`mt-2 ${muted}`}>
          Lets people search GIPHY's GIFs in the chat, like in WhatsApp or Teams. It uses GIPHY's own web kit, as GIPHY asks: each person's browser talks to GIPHY directly, a sent GIF is stored only as a reference (GIPHY shows it), and nothing is copied to this server.
        </p>
        <p className={`mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900`}>
          Because of that, <b>every computer needs internet access to GIPHY</b> and GIPHY sees those computers' addresses. If that is not acceptable, leave GIPHY off and use your own library below.
        </p>
        <ol className={`mt-3 list-decimal space-y-1 pl-5 ${muted}`}>
          <li>Go to <b className="text-fg">developers.giphy.com</b>, sign in (free) and choose <b className="text-fg">Create an App</b>, then pick <b className="text-fg">SDK</b>.</li>
          <li>Copy the <b className="text-fg">SDK key</b> it shows and paste it below. (It is meant to be public: it sits in the page, so it is not a secret.)</li>
        </ol>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <input className={`${field} min-w-0 flex-1 text-fg`} type="text" autoComplete="off" spellCheck={false} placeholder={info.giphy.configured ? "Paste a new key to replace the saved one" : "Paste the SDK key"} value={key} onChange={(e) => setKey(e.target.value)} aria-label="GIPHY SDK key" />
          <button className={btn} disabled={busy || !key.trim()} onClick={() => void saveKey()}>Save and test</button>
          {info.giphy.configured && info.giphy.source === "saved" && <button className={secondaryBtn} disabled={busy} onClick={() => void removeKey()}>Remove</button>}
        </div>
        {info.giphy.configured && (
          <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-fg">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-[#00a859]" checked={info.giphy.enabled} disabled={busy} onChange={(e) => void setOn(e.target.checked)} />
            <span><b>Allow GIPHY GIFs in the chat</b><span className="block text-xs text-neutral-600 dark:text-neutral-400">Untick to switch GIPHY off for everyone. Earlier GIPHY GIFs then show "GIPHY GIFs are switched off", and your library keeps working.</span></span>
          </label>
        )}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-bold text-fg">Our GIF library</h2>
          <span className="rounded-full bg-fg/10 px-2.5 py-0.5 text-xs font-bold text-fg">{info.library.length} GIF{info.library.length === 1 ? "" : "s"}</span>
        </div>
        <p className={`mt-2 ${muted}`}>Company-approved GIFs that everyone can pick from the "Our GIFs" tab: reactions, mascots, "have you tried turning it off and on again". Up to {info.max_mb} MB each.</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <input className={`${field} w-56 text-fg`} placeholder="Name (optional)" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Name for the GIF" />
          <input ref={file} type="file" accept=".gif,image/gif" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} aria-label="Choose a GIF file" />
          <button className={btn} disabled={busy || info.library.length >= info.max_items} onClick={() => file.current?.click()}>Add a GIF</button>
        </div>
        {info.library.length > 0 && (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {info.library.map((g) => (
              <li key={g.id} className="group relative overflow-hidden rounded-xl border border-fg/10 bg-fg/5">
                <img src={`/api/staff/gifs/library/${g.id}/img`} alt={g.title} loading="lazy" className="aspect-square w-full object-cover" />
                <div className="flex items-center gap-1 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate font-semibold text-fg" title={g.title}>{g.title}</span>
                  <button type="button" onClick={() => void remove(g)} aria-label={`Remove ${g.title}`} className="rounded px-1.5 py-0.5 font-bold text-red-700 hover:bg-red-700/10">Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
