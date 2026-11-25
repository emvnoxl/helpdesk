import { Hono } from "hono";
import { type AppEnv } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { getSetting, putSetting } from "./sla";

/* Request forms: a few questions per category, asked on the new-ticket form, so IT gets what it needs the first time ("Which printer?",
   "Where are you?"). An admin edits them under Library > Request forms. The answers are stored on the ticket as label + value, so
   changing a form later never changes what an old ticket says. */

export type FieldType = "text" | "longtext" | "select" | "yesno";
export interface Field { id: string; label: string; type: FieldType; required: boolean; options?: string[] }
const TYPES: FieldType[] = ["text", "longtext", "select", "yesno"];
const MAX_FIELDS = 8;
const MAX_LEN: Record<FieldType, number> = { text: 200, longtext: 2000, select: 80, yesno: 3 };

const oneLine = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** Cleans what an admin sent: fixed field types, short labels, 2 to 12 options for a choice. Ids stay stable (f1, f2...) so a form can be edited. */
export function cleanForm(raw: unknown): { fields: Field[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "fields must be a list" };
  if (raw.length > MAX_FIELDS) return { error: `A form can have at most ${MAX_FIELDS} questions.` };
  const fields: Field[] = [];
  const used = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const label = oneLine(r?.label, 80);
    if (!label) return { error: "Every question needs some text." };
    const type = TYPES.includes(r.type as FieldType) ? (r.type as FieldType) : "text";
    let id = typeof r.id === "string" && /^f\d{1,2}$/.test(r.id) && !used.has(r.id) ? r.id : "";
    for (let i = 1; !id; i++) if (!used.has("f" + i)) id = "f" + i;
    used.add(id);
    const f: Field = { id, label, type, required: r.required === true };
    if (type === "select") {
      const opts = [...new Set((Array.isArray(r.options) ? r.options : []).map((o) => oneLine(o, 60)).filter(Boolean))].slice(0, 12);
      if (opts.length < 2) return { error: `“${label}” is a choice: give it at least two options.` };
      f.options = opts;
    }
    fields.push(f);
  }
  return { fields };
}

export async function formFor(categoryId: number | null): Promise<Field[]> {
  if (!categoryId) return [];
  const row = await db.prepare("SELECT form FROM categories WHERE id = ?").bind(categoryId).first<{ form: string | null }>();
  try { const v = JSON.parse(row?.form ?? "[]"); return Array.isArray(v) ? (v as Field[]) : []; } catch { return []; }
}

/** Checks the answers sent with a new ticket against its category's form. `json` is what to store: [{label, value}]. */
export async function validateAnswers(categoryId: number | null, raw: unknown): Promise<{ ok: true; json: string | null } | { ok: false; error: string }> {
  const fields = await formFor(categoryId);
  if (!fields.length) return { ok: true, json: null };
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: { label: string; value: string }[] = [];
  for (const f of fields) {
    const v = typeof given[f.id] === "string" ? (given[f.id] as string).trim() : "";
    if (!v) {
      if (f.required) return { ok: false, error: `Please answer: ${f.label}` };
      continue;
    }
    if (f.type === "select" && !f.options?.includes(v)) return { ok: false, error: `“${f.label}”: please pick one of the choices.` };
    if (f.type === "yesno" && v !== "Yes" && v !== "No") return { ok: false, error: `“${f.label}”: answer Yes or No.` };
    if (v.length > MAX_LEN[f.type]) return { ok: false, error: `“${f.label}” is too long.` };
    out.push({ label: f.label, value: v });
  }
  return { ok: true, json: out.length ? JSON.stringify(out) : null };
}

/** Admin only (mounted at /api/admin/forms). */
export const forms = new Hono<AppEnv>();

forms.get("/", async (c) => {
  const { results } = await db.prepare("SELECT id, name, form FROM categories ORDER BY name").all<{ id: number; name: string; form: string | null }>();
  return c.json(results.map((r) => ({ id: r.id, name: r.name, fields: (() => { try { const v = JSON.parse(r.form ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })() })));
});

// { fields: [...] } replaces the whole form for that category.
forms.put("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const cat = await db.prepare("SELECT name FROM categories WHERE id = ?").bind(id).first<{ name: string }>();
  if (!cat) return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const r = cleanForm(b.fields);
  if ("error" in r) return c.json({ error: r.error }, 400);
  await db.prepare("UPDATE categories SET form = ? WHERE id = ?").bind(r.fields.length ? JSON.stringify(r.fields) : null, id).run();
  await audit(c, "forms.updated", "admin", `Request form for ${cat.name}: ${r.fields.length ? r.fields.map((f) => f.label).join(" · ") : "no questions"}`);
  return c.json({ ok: true, fields: r.fields });
});

const SEED: Record<string, Omit<Field, "id">[]> = {
  Printing: [
    { label: "Which printer?", type: "text", required: true },
    { label: "What is it doing?", type: "select", required: true, options: ["Won't print", "Paper jam", "Poor print quality", "Can't connect to it", "Out of toner or paper", "Something else"] },
  ],
  Network: [
    { label: "Where are you? (floor, office or desk)", type: "text", required: true },
    { label: "Wi-Fi or cable?", type: "select", required: false, options: ["Wi-Fi", "Cable", "Not sure"] },
    { label: "Is anyone else affected?", type: "select", required: false, options: ["Just me", "A few people", "Everyone near me", "Not sure"] },
  ],
  Hardware: [
    { label: "Which device?", type: "select", required: true, options: ["Laptop", "Desktop", "Monitor", "Phone", "Other"] },
    { label: "Name or asset tag (the sticker on it)", type: "text", required: false },
  ],
  "Accounts & Access": [
    { label: "What do you need?", type: "select", required: true, options: ["Password reset", "I'm locked out", "A new account", "Change of access", "Something else"] },
    { label: "Which system or app?", type: "text", required: false },
  ],
};
/** A few sensible starting forms, once. After that the admin owns them (clearing a form does not bring it back). */
export async function seedForms() {
  if (process.env.SEED_FORMS === "0" || (await getSetting("forms_seeded"))) return; // SEED_FORMS=0: the test suite builds its own forms
  for (const [name, fields] of Object.entries(SEED)) {
    const cleaned = cleanForm(fields);
    if ("fields" in cleaned) await db.prepare("UPDATE categories SET form = ? WHERE name = ? AND form IS NULL").bind(JSON.stringify(cleaned.fields), name).run();
  }
  await putSetting("forms_seeded", "1");
}
