import { useEffect, useState } from "react";
import { api } from "./api";
import { collectBrowserInfo, deviceKey } from "./device";
import { useNotify } from "./notify";
import { btn, card } from "./ui";

interface Mine { reported: boolean; hardware_at: number | null; name: string | null; model: string | null }
interface Link { cmd_url: string; command: string }

const when = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "");

/** Account page: what the helpdesk can see about THIS computer, and the one-time hardware report that fills in the rest. */
export function ThisComputer() {
  const { toast } = useNotify();
  const [info, setInfo] = useState<any>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => api<Mine>(`/devices/mine?key=${deviceKey()}`).then(setMine, () => {});
  useEffect(() => { void collectBrowserInfo().then(setInfo); void refresh(); }, []);
  // While the instructions are open, notice by itself when the report arrives.
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [link]);
  useEffect(() => { if (link && mine?.reported) toast("IT can now see the details of this computer.", "success", "Hardware report received"); }, [mine?.hardware_at]);

  async function getLink() {
    setBusy(true);
    try {
      setLink(await api<Link>("/devices/inventory-link", { method: "POST", json: { key: deviceKey() } }));
    } catch (e) {
      toast((e as Error).message, "error", "Couldn't prepare the report");
    } finally {
      setBusy(false);
    }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(link!.command); toast("Paste it into PowerShell and press Enter.", "success", "Command copied"); } catch { toast("Select the command and copy it by hand.", "info"); }
  };

  const scr = info?.screen;
  const facts: [string, string][] = info
    ? ([
        ["System", [info.os, info.osVersion].filter(Boolean).join(" ")],
        ["Browser", [info.browser, info.browserVersion].filter(Boolean).join(" ")],
        ["Processor threads", info.cores ? String(info.cores) : ""],
        ["Memory", info.memory ? `${info.memory >= 8 ? "8+" : info.memory} GB` : ""],
        ["Screen", scr ? `${Math.round(scr.w * (scr.dpr || 1))} × ${Math.round(scr.h * (scr.dpr || 1))}` : ""],
        ["Graphics", info.gpu ?? ""],
      ] as [string, string][]).filter(([, v]) => v)
    : [];

  return (
    <section className={card + " space-y-4"}>
      <div>
        <h2 className="text-lg font-extrabold">This computer</h2>
        <p className="text-sm text-neutral-500">When you raise a ticket, IT sees which computer it came from, so they can help faster. This is all the browser shares. IT cannot see your files, your screen or what you browse.</p>
      </div>
      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {facts.map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-[11px] font-bold uppercase tracking-wider text-neutral-500">{k}</dt><dd className="truncate font-medium" title={v}>{v}</dd></div>)}
        </dl>
      )}

      <div className="rounded-xl border border-stone-200 p-3.5">
        {mine?.reported ? (
          <p className="text-sm"><b className="text-ok">✓ IT has the full hardware details</b> of this computer{mine.model ? ` (${mine.model})` : ""}. Last sent {when(mine.hardware_at)}.</p>
        ) : (
          <p className="text-sm">IT only has the basics above. A browser can't see the make, model, serial number or disks.</p>
        )}
        {!link ? (
          <button className={btn + " mt-3"} disabled={busy} onClick={() => void getLink()}>{busy ? "Preparing…" : mine?.reported ? "Send them again" : "Send hardware details to IT"}</button>
        ) : (
          <div className="mt-3 space-y-3 text-sm">
            <ol className="list-decimal space-y-1.5 pl-5">
              <li>Download the file below and open it.</li>
              <li>If Windows says it "protected your PC", choose <b>More info</b> then <b>Run anyway</b>. The file only reads this computer's specifications and sends them to the helpdesk.</li>
              <li>When it says <b>Done</b> the window closes by itself, and this page notices.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <a className={btn + " no-underline"} href={link.cmd_url} download>Download hardware report</a>
              <button className="rounded-lg border border-stone-300 px-4 py-2 text-sm font-semibold hover:bg-stone-100" onClick={() => void copy()}>Copy a PowerShell command instead</button>
            </div>
            <p className="text-xs text-neutral-500">It collects: make and model, serial number, processor, memory, disks and free space, graphics, network addresses and Windows version. It does not read files, passwords or browsing. The link works for 24 hours. Windows only.</p>
          </div>
        )}
      </div>
    </section>
  );
}
