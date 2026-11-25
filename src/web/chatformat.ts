/* Light formatting for chat messages, as data (the component that draws it is RichText.tsx). Nothing here ever becomes HTML:
   the pieces are drawn as React text, so a message can't inject markup. Only http(s) links are made clickable.
     **bold**   _italic_   `code`   ```code block```   https://links */

export type Tok = { t: "text" | "bold" | "italic" | "code" | "block" | "link"; v: string };

const RE = /(```[\s\S]+?```)|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|((?<![\w])_[^_\n]+_(?![\w]))|(https?:\/\/[^\s<>"']+)/g;

/** Only http and https are ever clickable. */
export function safeUrl(u: string): string | null {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : null;
  } catch {
    return null;
  }
}

/** A link at the end of a sentence should not swallow the full stop or a closing bracket that is not part of it. */
function trimLink(u: string): { link: string; rest: string } {
  let link = u;
  let rest = "";
  while (link && /[.,;:!?'")\]]$/.test(link)) {
    const last = link[link.length - 1]!;
    if (last === ")" && (link.match(/\(/g)?.length ?? 0) >= (link.match(/\)/g)?.length ?? 0)) break; // a bracket that is balanced stays
    rest = last + rest;
    link = link.slice(0, -1);
  }
  return { link, rest };
}

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let at = 0;
  const push = (t: Tok["t"], v: string) => { if (v) out.push({ t, v }); };
  for (const m of src.matchAll(RE)) {
    push("text", src.slice(at, m.index));
    const [whole] = m;
    if (m[1]) push("block", whole.slice(3, -3).replace(/^\n/, "").replace(/\n$/, ""));
    else if (m[2]) push("code", whole.slice(1, -1));
    else if (m[3]) push("bold", whole.slice(2, -2));
    else if (m[4]) push("italic", whole.slice(1, -1));
    else {
      const { link, rest } = trimLink(whole);
      if (safeUrl(link)) { push("link", link); push("text", rest); } else push("text", whole);
    }
    at = (m.index ?? 0) + whole.length;
  }
  push("text", src.slice(at));
  return out;
}

/** How many emoji are in a message that contains nothing else (1 to 3), otherwise 0: those are drawn large, without a bubble. */
export function onlyEmoji(text: string): number {
  const s = text.trim();
  if (!s || s.length > 40) return 0;
  const parts = [...new Intl.Segmenter().segment(s.replace(/\s+/g, ""))].map((x) => x.segment);
  if (!parts.length || parts.length > 3) return 0;
  return parts.every((p) => /\p{Extended_Pictographic}/u.test(p)) ? parts.length : 0;
}
