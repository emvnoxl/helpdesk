import { Hono } from "hono";
import type { AppEnv } from "./auth";
import { audit } from "./audit";
import { db } from "./db";
import { getSetting, putSetting } from "./sla";
import { addTasks, cleanItems } from "./tasks";
import { createTicket } from "./tickets";

/* Checklist templates: the jobs with many steps where one is easily forgotten (a new starter, someone leaving, a new laptop).
   Mounted at /api/staff/checklists. Every agent can read them and start one; only admins change them.
   Starting one raises a ticket assigned to whoever started it, with the steps copied on (they can then be changed on the ticket). */

export const checklists = new Hono<AppEnv>();
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

interface Row { id: number; name: string; description: string; category_id: number | null; items: string; category: string | null }
const shape = (r: Row) => {
  let items: string[] = [];
  try { items = cleanItems(JSON.parse(r.items)); } catch { /* shown as empty */ }
  return { id: r.id, name: r.name, description: r.description, category_id: r.category_id, category: r.category, items };
};
const one = (id: number) =>
  db.prepare("SELECT k.id, k.name, k.description, k.category_id, k.items, c.name AS category FROM checklist_templates k LEFT JOIN categories c ON c.id = k.category_id WHERE k.id = ?").bind(id).first<Row>();

checklists.get("/", async (c) => {
  const { results } = await db
    .prepare("SELECT k.id, k.name, k.description, k.category_id, k.items, c.name AS category FROM checklist_templates k LEFT JOIN categories c ON c.id = k.category_id ORDER BY k.name COLLATE NOCASE LIMIT 100")
    .all<Row>();
  return c.json(results.map(shape));
});

function read(b: Record<string, unknown>) {
  const name = str(b.name, 80), description = str(b.description, 1000), items = cleanItems(b.items);
  if (name.length < 2) return { error: "Give the checklist a name." };
  if (!items.length) return { error: "Add at least one step." };
  return { name, description, items, categoryId: Number(b.category_id) || null };
}

checklists.post("/", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Only an admin can change checklists." }, 403);
  const v = read(await c.req.json().catch(() => ({})));
  if ("error" in v) return c.json({ error: v.error }, 400);
  const row = await db.prepare("INSERT INTO checklist_templates (name, description, category_id, items) VALUES (?, ?, ?, ?) RETURNING id").bind(v.name, v.description, v.categoryId, JSON.stringify(v.items)).first<{ id: number }>();
  await audit(c, "checklist.created", "admin", `Created the checklist “${v.name}” (${v.items.length} steps)`);
  return c.json({ id: row!.id }, 201);
});

checklists.patch("/:id{[0-9]+}", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Only an admin can change checklists." }, 403);
  const id = Number(c.req.param("id"));
  const v = read(await c.req.json().catch(() => ({})));
  if ("error" in v) return c.json({ error: v.error }, 400);
  const r = await db.prepare("UPDATE checklist_templates SET name = ?, description = ?, category_id = ?, items = ? WHERE id = ?").bind(v.name, v.description, v.categoryId, JSON.stringify(v.items), id).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  await audit(c, "checklist.updated", "admin", `Changed the checklist “${v.name}”`);
  return c.json({ ok: true });
});

checklists.delete("/:id{[0-9]+}", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "Only an admin can change checklists." }, 403);
  const id = Number(c.req.param("id"));
  const t = await one(id);
  if (!t) return c.json({ error: "not found" }, 404);
  await db.prepare("DELETE FROM checklist_templates WHERE id = ?").bind(id).run();
  await audit(c, "checklist.deleted", "admin", `Deleted the checklist “${t.name}” (tickets already started keep their steps)`);
  return c.json({ ok: true });
});

// Start one: { subject: "Ama Boateng", note?: "Starts Monday, Finance" } => a ticket with the steps on it, assigned to you.
checklists.post("/:id{[0-9]+}/start", async (c) => {
  const user = c.get("user");
  const row = await one(Number(c.req.param("id")));
  if (!row) return c.json({ error: "not found" }, 404);
  const tpl = shape(row);
  const b = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const subject = str(b.subject, 120), note = str(b.note, 4000);
  if (!subject) return c.json({ error: "Say who or what this is for." }, 400);
  const title = `${tpl.name}: ${subject}`.slice(0, 200);
  const t = await createTicket(user, { title, description: note || tpl.description || title, categoryId: tpl.category_id, assigneeId: user.id, source: "checklist" });
  await addTasks(t.id, tpl.items);
  await audit(c, "ticket.created", "ticket", `Started the “${tpl.name}” checklist as ${t.ref}: ${subject}`, { ticketId: t.id });
  return c.json(t, 201);
});

const STARTERS: [string, string, string, string[]][] = [
  ["New starter", "Everything a new member of staff needs on their first day.", "Accounts & Access", [
    "Create the Microsoft 365 account and assign a licence",
    "Add to the right groups, shared mailboxes and Teams",
    "Prepare a laptop: Windows updates, Office, antivirus, printers",
    "Record the laptop's serial number against the person",
    "Set up multi-factor authentication with them",
    "Give access to the shared folders their department uses",
    "Door access / CCTV account if their role needs it",
    "Walk them through the helpdesk and how to raise a ticket",
    "Confirm with their manager that everything works",
  ]],
  ["Leaver", "Someone is leaving: close their access and get the equipment back.", "Accounts & Access", [
    "Confirm the last working day with HR or their manager",
    "Block sign-in on the Microsoft 365 account at the end of the last day",
    "Reset the password and sign out all sessions",
    "Forward their email or convert the mailbox to shared, as the manager decides",
    "Hand ownership of their OneDrive and Teams files to the manager",
    "Remove from groups, shared mailboxes and distribution lists",
    "Collect the laptop, charger, phone and any access cards",
    "Remove door access and any CCTV or system accounts",
    "Wipe the laptop and return it to stock",
    "Remove the licence after the agreed retention period",
  ]],
  ["New laptop setup", "Preparing a machine before it is handed over.", "Hardware", [
    "Install all Windows updates and firmware",
    "Rename the computer to the naming standard",
    "Install Microsoft 365 apps and sign in",
    "Install antivirus and check it reports in",
    "Turn on BitLocker and save the recovery key",
    "Add printers and the office Wi-Fi",
    "Send the hardware report from the helpdesk (Account > This computer)",
    "Label the machine and record who has it",
  ]],
];

export async function seedChecklists() {
  if (await getSetting("checklists_seeded")) return;
  for (const [name, description, category, items] of STARTERS) {
    const cat = await db.prepare("SELECT id FROM categories WHERE name = ?").bind(category).first<{ id: number }>();
    await db.prepare("INSERT INTO checklist_templates (name, description, category_id, items) VALUES (?, ?, ?, ?)").bind(name, description, cat?.id ?? null, JSON.stringify(items)).run();
  }
  await putSetting("checklists_seeded", "1");
}
