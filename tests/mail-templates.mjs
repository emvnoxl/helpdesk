// Unit tests for the emails' templates and look (src/server/mailrender.ts): defaults, editing rules, the logo, the "genuine message" block and the verify link.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(os.tmpdir(), "fg-mail-"));
const load = async (entry, name) => {
  const out = path.join(dir, name + ".mjs");
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
  return import(pathToFileURL(out).href);
};
const M = await load("src/server/mailrender.ts", "mailrender");
const S = await load("src/server/security.ts", "security");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"}  ${name} ${cond ? "" : extra}`); };

const SECRET = "unit-test-secret-0123456789";
const ctx = (over = {}, brand = {}) => ({ t: M.merge({ brand }), appUrl: "https://helpdesk.example.com", repliesBack: true, secret: SECRET, now: 1_800_000_000, ...over });
const pending = { id: 1, ticket_id: 42, field: "reply", new_value: "1", ref: "FG-0042", title: "Printer <b>offline</b>", source: "web", to_email: "kofi.mensah@example.com", to_name: "Kofi Mensah", new_assignee: null, actor: "Esi Mensah", reply: "Please try again." };

// ---- the defaults say what they always said ----
let m = M.composeRequester({ ...pending, field: "created" }, ctx());
ok("default: 'ticket received' wording is unchanged", /Hi Kofi,\n\nWe have your ticket\. IT will pick it up, and you will get an email when something changes\./.test(m.text) && m.subject === "[FG-0042] Printer <b>offline</b>");
m = M.composeRequester(pending, ctx());
ok("default: the reply email names who replied and quotes the reply", /Esi Mensah from IT replied:\n\n> Please try again\./.test(m.text) && /Reply to this email to answer/.test(m.text));
m = M.composeRequester({ ...pending, field: "assignee", new_assignee: "Esi Mensah" }, ctx());
ok("default: 'someone took it'", /Esi Mensah is now working on your ticket\./.test(m.text));
m = M.composeRequester({ ...pending, field: "status", new_value: "resolved" }, ctx());
ok("default: a resolved status adds the 'not fixed' line", /now Resolved\./.test(m.text) && /If it is not fixed/.test(m.text));
ok("default: the welcome email keeps its five steps", (M.composeWelcome({ name: "Ama Boateng", email: "a@x.com" }, ctx()).text.match(/^- /gm) ?? []).length === 5);

// ---- the genuine-message block and the signature ----
m = M.composeRequester(pending, ctx());
ok("every email is signed by the team", /Kind regards,\nFortress IT Team/.test(m.text) && /Kind regards,/.test(m.html) && /<b>Fortress IT Team<\/b>/.test(m.html));
ok("…and says who sent it, to whom and about what", /A genuine message from the Fortress IT Team: sent by the Fortress Oil & Gas Helpdesk \(helpdesk\.example\.com\) to kofi\.mensah@example\.com about FG-0042\./.test(m.text));
ok("…with the safety line", /will never ask you for your password, PIN or bank details by email/.test(m.text) && /will never ask you for your password/.test(m.html));
const link = (m.text.match(/Verify this email: (\S+)/) ?? [])[1];
ok("…and a verify link on the helpdesk's own address", /^https:\/\/helpdesk\.example\.com\/verify\?m=/.test(link ?? ""), link);
const tok = S.readToken(new URL(link).searchParams.get("m"), SECRET);
ok("the verify token carries the kind, the ticket, a MASKED recipient and the time (and no full address)", tok && tok.k === "reply" && tok.r === "FG-0042" && tok.m === "ko***@example.com" && tok.t === 1_800_000_000 && !JSON.stringify(tok).includes("kofi.mensah"), JSON.stringify(tok));
ok("a token made with another secret does not check out, nor does a changed one", S.readToken(new URL(link).searchParams.get("m"), "another-secret") === null && S.readToken(new URL(link).searchParams.get("m").replace(/.$/, "x"), SECRET) === null);
ok("no helpdesk address, no verify link (it would point nowhere)", !/Verify this email/.test(M.composeRequester(pending, ctx({ appUrl: "" })).text));
ok("the verify link can be switched off", !/Verify this email/.test(M.composeRequester(pending, ctx({}, { show_verify: false })).text));
ok("a contact line shows when it is set", /Call IT on ext 100/.test(M.composeRequester(pending, ctx({}, { contact: "Reply to this email, or\nCall IT on ext 100" })).text));

// ---- the logo ----
ok("the logo is an inline attachment (cid) in the real email", /<img src="cid:fglogo"/.test(m.html) && m.logo === true);
ok("in the preview it is a data: picture instead (the preview frame cannot fetch anything)", /<img src="data:image\/png;base64,AAAA"/.test(M.composeRequester(pending, { ...ctx(), preview: true, previewLogo: "data:image/png;base64,AAAA" }).html));
const noLogo = M.composeRequester(pending, ctx({}, { show_logo: false }));
ok("with the logo switched off the name is shown as text and nothing is attached", !/cid:fglogo/.test(noLogo.html) && noLogo.logo === false && /Fortress Oil &#38; Gas Helpdesk<\/p>/.test(noLogo.html));

// ---- editing: wording, placeholders, safety ----
const custom = M.merge({ brand: { team: "Acme IT", greeting: "Dear {fullname}," }, kinds: { created: { subject: "We got it ({ref})", intro: "Thanks **{name}**! {unknown} <script>alert(1)</script>" } } });
m = M.composeRequester({ ...pending, field: "created" }, { ...ctx(), t: custom });
ok("custom wording, greeting, subject and team are used", m.subject === "We got it (FG-0042)" && /^Dear Kofi Mensah,/.test(m.text) && /Acme IT/.test(m.text) && /Thanks Kofi! \{unknown\}/.test(m.text), m.text.slice(0, 200));
ok("**bold** becomes bold in HTML, and a placeholder that does not exist is left visible", /Thanks <b>Kofi<\/b>! \{unknown\}/.test(m.html));
ok("a template can never inject HTML (it is escaped)", !/<script>/.test(m.html) && /&#60;script&#62;alert\(1\)&#60;\/script&#62;/.test(m.html));
ok("a ticket title with HTML in it is escaped too", /Printer &#60;b&#62;offline&#60;\/b&#62;/.test(m.html) && !/Printer <b>offline/.test(m.html));
ok("limits and control characters are cleaned", M.merge({ kinds: { reply: { intro: "x".repeat(5000) + "\u0007" } } }).kinds.reply.intro.length === 700 && !/\u0007/.test(M.merge({ brand: { team: "a\u0007b\nc" } }).brand.team) && M.merge({ brand: { team: "a\nb" } }).brand.team === "a b");

// ---- validation ----
ok("an empty required part is refused with its name", /Ticket received.*Message/.test(M.validate({ kinds: { created: { intro: "   " } } }).error ?? "") && /Who the emails are from/.test(M.validate({ brand: { team: "" } }).error ?? ""));
ok("welcome steps need 'Title | text' and at most 8", /Title \| explanation/.test(M.validate({ kinds: { welcome: { steps: "just a line" } } }).error ?? "") && /at most 8/.test(M.validate({ kinds: { welcome: { steps: Array.from({ length: 9 }, (_, i) => `S${i} | text`).join("\n") } } }).error ?? "") && M.validate({ kinds: { welcome: { steps: "One | first\nTwo | second" } } }).ok);
ok("the safety line and contact can be emptied", M.validate({ brand: { trust: "", contact: "" } }).ok === true && !/will never ask/.test(M.composeRequester(pending, { ...ctx(), t: M.validate({ brand: { trust: "" } }).t }).text));
const t2 = M.validate({ brand: { team: "Acme IT" }, kinds: { status: { button: "See it" } } }).t;
const d = M.diff(t2);
ok("only changes from the default are stored", JSON.stringify(d) === JSON.stringify({ brand: { team: "Acme IT" }, kinds: { status: { button: "See it" } } }), JSON.stringify(d));
ok("what is stored gives the same templates back", JSON.stringify(M.merge(d)) === JSON.stringify(t2));
ok("nothing changed = nothing stored", JSON.stringify(M.diff(M.merge({}))) === JSON.stringify({ brand: {}, kinds: {} }));

// ---- every email can be previewed ----
for (const k of M.KINDS) {
  const s = M.sampleMail(k.id, { ...ctx(), preview: true });
  ok(`preview: "${k.label}" builds, with a subject, the signature and the genuine-message block`, !!s.subject && /Fortress IT Team/.test(s.html) && /A genuine message/.test(s.html) && /Verify this email/.test(s.html));
}
const g = M.composeRequesterGroup([{ ...pending, field: "assignee", new_assignee: "Esi Mensah" }, pending, { ...pending, field: "status", new_value: "waiting" }], ctx());
ok("several updates: one email with the digest wording, the status, who took it and the reply", /not seen yet/.test(g.text) && /now Waiting for your reply/.test(g.text) && /Esi Mensah is now working/.test(g.text) && /> Please try again\./.test(g.text) && g.subject === "[FG-0042] Printer <b>offline</b>");
const st = M.composeStaff([{ id: 1, user_id: 1, kind: "message", title: "T1", body: "b1", ticket_id: 1, ref: "FG-1", email: "e@x.com", name: "Esi M", role: "agent" }, { id: 2, user_id: 1, kind: "message", title: "T2", body: "b2", ticket_id: 2, ref: "FG-2", email: "e@x.com", name: "Esi M", role: "agent" }], ctx());
ok("staff digest: count in the subject and the intro", st.subject === "2 updates waiting on the helpdesk" && /2 things are waiting for you/.test(st.text) && /Hi Esi,/.test(st.text));
ok("a test email uses the same wrapper", /A genuine message/.test(M.composeTest("a@x.com", ctx()).text) && M.composeTest("a@x.com", ctx()).subject === "Test email from the Fortress Oil & Gas Helpdesk");

// ---- the editable preview: markers only in the preview, never in a real email ----
for (const k of M.KINDS) {
  const real = M.sampleMail(k.id, ctx());
  const pv = M.sampleMail(k.id, { ...ctx(), preview: true });
  ok(`editable preview: "${k.label}" is marked, the real email carries no markers, the text is identical`, /data-edit="/.test(pv.html) && !/data-edit/.test(real.html) && pv.text.replace(/Verify this email: .*/, "") === real.text.replace(/Verify this email: .*/, ""));
}
const pvh = M.sampleMail("welcome", { ...ctx(), preview: true }).html;
ok("preview marks greeting, signature, steps and button with their template field", ["brand.greeting", "brand.signoff", "brand.team", "kinds.welcome.intro", "kinds.welcome.steps", "kinds.welcome.button"].every((k) => pvh.includes(`data-edit="${k}"`)));
const empty = M.sampleMail("created", { ...ctx({}, { contact: "", trust: "" }), preview: true }).html;
ok("an empty optional line shows a clickable 'add' stand-in in the preview only", /data-edit="brand\.contact"[^>]*>\+ Add/.test(empty) && /data-edit="brand\.trust"[^>]*>\+ Add/.test(empty) && !/\+ Add/.test(M.sampleMail("created", ctx({}, { contact: "", trust: "" })).html));
ok("every marker names a real template field", [...pvh.matchAll(/data-edit="([^"]+)"/g)].every(([, k]) => /^(brand\.\w+|kinds\.\w+\.\w+)$/.test(k)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
