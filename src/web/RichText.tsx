import { safeUrl, tokenize } from "./chatformat";

/** A chat message's text with **bold**, _italic_, `code`, code blocks and clickable links. Drawn as React text, never as HTML. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((k, i) => {
        if (k.t === "bold") return <strong key={i}>{k.v}</strong>;
        if (k.t === "italic") return <em key={i}>{k.v}</em>;
        if (k.t === "code") return <code key={i} className="rounded bg-black/10 px-1 py-px font-mono text-[0.85em]">{k.v}</code>;
        if (k.t === "block")
          return <pre key={i} className="my-1 max-w-full overflow-x-auto whitespace-pre rounded-lg bg-black/10 p-2 font-mono text-xs leading-relaxed">{k.v}</pre>;
        if (k.t === "link") {
          const href = safeUrl(k.v);
          return href ? <a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-medium underline underline-offset-2">{k.v}</a> : <span key={i}>{k.v}</span>;
        }
        return <span key={i}>{k.v}</span>;
      })}
    </>
  );
}
