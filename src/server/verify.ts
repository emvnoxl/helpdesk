import { Hono } from "hono";
import { sessionSecret } from "./config";
import { esc } from "./mailrender";
import { RateLimiter, readToken } from "./security";
import { clientIp } from "./auth";

/* "Verify this email". Every email the helpdesk sends carries a link here with a signed token (what kind of email, which ticket, a masked version of who it
   went to, when). Only this server can make a token that checks out, so a fake email cannot copy it. Opening the link on the helpdesk's own address
   shows a plain page saying it is genuine, or a warning when the token does not check out. No sign-in is needed and nothing private is shown. */

const limiter = new RateLimiter(60, 60_000);
const KIND: Record<string, string> = {
  created: "a confirmation that your ticket was received", reply: "a reply from IT", status: "a change to the status of your ticket", assigned: "a note that someone from IT took your ticket",
  digest: "an update on your ticket", report: "the monthly report", welcome: "a welcome to the helpdesk", staff: "an update for the IT team", test: "a test email from the helpdesk",
};

const page = (ok: boolean, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${ok ? "Genuine email" : "Could not verify this email"}</title>
<style>body{margin:0;background:#efefea;font-family:'Segoe UI',Arial,sans-serif;color:#0b0b0b}main{max-width:520px;margin:8vh auto;padding:0 16px}.card{background:#fff;border:1px solid #e3e3dc;border-radius:14px;overflow:hidden}.bar{display:flex;height:5px}.bar i{flex:1}.in{padding:26px 28px 30px}h1{margin:0 0 6px;font-size:22px}p{line-height:1.55;margin:8px 0}.tick{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:50%;font-size:26px;font-weight:800;margin-bottom:10px;color:#fff;background:${ok ? "#00a859" : "#d92b33"}}dl{margin:14px 0 0;padding:12px 14px;background:#f4f4f1;border-radius:10px;font-size:14px}dt{font-size:12px;color:#6b6b66;margin-top:8px}dt:first-child{margin-top:0}dd{margin:0;font-weight:600}.small{font-size:13px;color:#6b6b66}</style></head><body><main><div class="card"><div class="bar"><i style="background:#00a859"></i><i style="background:#ffb400"></i><i style="background:#ee3239"></i></div><div class="in">${body}</div></div></main></body></html>`;

export const verify = new Hono();

verify.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  if (!limiter.take(clientIp(c as any))) return c.html(page(false, `<h1>Too many checks</h1><p>Please wait a minute and try again.</p>`), 429);
  const m = readToken<{ k: string; r: string; m: string; t: number; e: number }>(c.req.query("m"), sessionSecret());
  if (!m) {
    return c.html(
      page(false, `<div class="tick">!</div><h1>We could not verify this email</h1><p>It does not carry a valid mark from this helpdesk. It may be old, damaged, or <b>not from IT at all</b>.</p><p><b>Do not click its links or follow its instructions.</b> IT will never ask for your password, PIN or bank details by email. Please tell IT about it.</p><p class="small">If it is only an old email, open the helpdesk by typing its address yourself and check your ticket there.</p>`),
      404,
    );
  }
  const when = new Date(m.t * 1000).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" });
  return c.html(
    page(true, `<div class="tick">&#10003;</div><h1>This email is genuine</h1><p>The helpdesk sent it. Nobody can copy this mark onto a fake email.</p>
<dl><dt>What it was</dt><dd>${esc(KIND[m.k] ?? "a message from the helpdesk")}</dd>${m.r ? `<dt>About</dt><dd>${esc(m.r)}</dd>` : ""}<dt>Sent to</dt><dd>${esc(m.m)}</dd><dt>Sent on</dt><dd>${esc(when)} (Ghana time)</dd></dl>
<p class="small">Still unsure about something in the message itself? Open the helpdesk by typing its address in your browser and look at your ticket there.</p>`),
  );
});
