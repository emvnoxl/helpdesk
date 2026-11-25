// Unit tests for the chat's light formatting and emoji search (src/web/chatformat.ts, src/web/emoji.ts).
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(os.tmpdir(), "fg-chat-"));
const load = async (entry, name) => {
  const out = path.join(dir, name + ".mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
};
const F = await load("src/web/chatformat.ts", "format");
const E = await load("src/web/emoji.ts", "emoji");
const H = await load("src/server/teamshosts.ts", "teamshosts");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name} ${cond ? "" : extra}`); };
const kinds = (s) => F.tokenize(s).map((t) => t.t + ":" + t.v).join(" | ");

ok("plain text stays one piece", kinds("hello there") === "text:hello there");
ok("**bold**, _italic_ and `code`", kinds("a **b** _c_ `d` e") === "text:a  | bold:b | text:  | italic:c | text:  | code:d | text: e", kinds("a **b** _c_ `d` e"));
ok("a snake_case_name is not italic", kinds("use my_var_name here") === "text:use my_var_name here");
ok("a code block keeps its lines and drops the fences", kinds("see\n```\nline1\n  line2\n```\nok") === "text:see\n | block:line1\n  line2 | text:\nok", kinds("see\n```\nline1\n  line2\n```\nok"));
ok("formatting inside code is left alone", kinds("`**not bold**`") === "code:**not bold**");
ok("an https link becomes a link", kinds("go to https://example.com/a?b=1 now") === "text:go to  | link:https://example.com/a?b=1 | text: now");
ok("a full stop after a link is not part of it", kinds("see https://example.com.") === "text:see  | link:https://example.com | text:.");
ok("a bracket around a link is not part of it", kinds("(https://example.com)") === "text:( | link:https://example.com | text:)");
ok("a link with its own brackets keeps them", kinds("https://en.wikipedia.org/wiki/Foo_(bar)") === "link:https://en.wikipedia.org/wiki/Foo_(bar)");
ok("only http(s) is ever clickable", F.safeUrl("javascript:alert(1)") === null && F.safeUrl("data:text/html,x") === null && F.safeUrl("ftp://x.com") === null && F.safeUrl("https://x.com") === "https://x.com/");
ok("markup in a message stays text", kinds("<img src=x onerror=alert(1)>") === "text:<img src=x onerror=alert(1)>");
ok("an unclosed ** or ` stays text", kinds("2 ** 3 and `oops") === "text:2 ** 3 and `oops");

ok("one to three emoji alone are 'big'", F.onlyEmoji("👍") === 1 && F.onlyEmoji("😂😂") === 2 && F.onlyEmoji(" 🎉 🎉 🎉 ") === 3);
ok("four emoji, or emoji with words, are not", F.onlyEmoji("😂😂😂😂") === 0 && F.onlyEmoji("ok 👍") === 0 && F.onlyEmoji("") === 0 && F.onlyEmoji("hello") === 0);
ok("a skin-tone or family emoji counts as one", F.onlyEmoji("👍🏽") === 1 && F.onlyEmoji("👨‍💻") === 1);

ok("emoji search finds by name", E.searchEmoji("thumbs").some((x) => x.e === "👍") && E.searchEmoji("laptop")[0].e === "💻");
ok("emoji search takes several words", E.searchEmoji("thumbs up")[0].e === "👍" && E.searchEmoji("zzzz").length === 0);
ok("emoji search matches the start of a word first", E.searchEmoji("fire")[0].e === "🔥");
ok("every picker emoji is a single emoji with search words", E.ALL.length > 250 && E.ALL.every((x) => x.e && x.words && [...new Intl.Segmenter().segment(x.e)].length === 1));
ok("no emoji is listed twice in a group", E.GROUPS.every((g) => new Set(g.items.map((s) => s.split(" ")[0])).size === g.items.length));
ok("the quick reactions are all real emoji", E.QUICK.length === 6 && E.QUICK.every((q) => F.onlyEmoji(q) === 1));

// Teams webhook addresses: only Microsoft's own hosts, over https, because the server fetches them
delete process.env.TEAMS_ALLOW_ANY;
ok("teams: Microsoft Workflows and connector addresses are accepted", ["https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=x", "https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def/ghi", "https://abc.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=y", "https://outlook.office.com/webhook/abc"].every(H.webhookOk));
ok("teams: anything else is refused (other hosts, look-alikes, http, odd ports, passwords, internal addresses)", ["http://prod.logic.azure.com/x", "https://example.com/hook", "https://logic.azure.com.evil.example/x", "https://evil.example/logic.azure.com", "https://prod.logic.azure.com:8443/x", "https://user:pw@prod.logic.azure.com/x", "https://localhost/hook", "https://127.0.0.1/hook", "https://192.168.1.10/hook", "https://169.254.169.254/latest/meta-data", "ftp://prod.logic.azure.com/x", "javascript:alert(1)", "", "not a url"].every((u) => !H.webhookOk(u)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
