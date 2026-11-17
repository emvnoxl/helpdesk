import { config } from "./config";
import { db } from "./db";
import { hashPassword, randomPassword } from "./security";

const prettyName = (email: string) =>
  email.split("@")[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || email;

/** Create (or promote/reset) an admin with a password the person must replace at first sign-in. */
async function upsertAdmin(email: string, password: string) {
  const hash = await hashPassword(password);
  const row = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: number }>();
  if (row) {
    await db
      .prepare(
        `UPDATE users SET role = 'admin', active = 1, password_hash = ?, must_change_password = 1,
                credential_version = credential_version + 1, failed_attempts = 0, locked_until = 0 WHERE id = ?`,
      )
      .bind(hash, row.id)
      .run();
  } else {
    await db.prepare("INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES (?, ?, 'admin', ?, 1)").bind(email, prettyName(email), hash).run();
  }
}

/** First run only: if there is no admin yet, create one from ADMIN_EMAIL (and ADMIN_PASSWORD, or a generated one printed once). */
export async function ensureAdmin() {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").first<{ n: number }>();
  if (existing && existing.n > 0) return;

  const email = config.adminEmail;
  if (!email || !email.includes("@")) {
    console.warn("\n[setup] There is no admin account yet. Set ADMIN_EMAIL (and optionally ADMIN_PASSWORD) and restart.\n");
    return;
  }
  const generated = !config.adminPassword;
  const password = config.adminPassword || randomPassword();
  await upsertAdmin(email, password);
  console.log("\n[setup] ----------------------------------------------------------------");
  console.log(`[setup] Admin account created: ${email}`);
  if (generated) console.log(`[setup] Temporary password (shown once): ${password}`);
  else console.log("[setup] Password: the ADMIN_PASSWORD you provided");
  console.log("[setup] You will be asked to choose a new password the first time you sign in at /admin.");
  console.log("[setup] ----------------------------------------------------------------\n");
}

/**
 * Recovery when nobody can sign in as admin:
 *   docker compose exec helpdesk node dist-server/index.js reset-admin someone@company.com
 * Creates that admin (or promotes/unlocks the existing account) and prints a new temporary password.
 */
export async function resetAdmin(emailArg: string) {
  const email = emailArg.trim().toLowerCase();
  if (!email.includes("@")) {
    console.error("Usage: node dist-server/index.js reset-admin <email>");
    return false;
  }
  const password = randomPassword();
  await upsertAdmin(email, password);
  console.log(`\nAdmin ${email} is ready. Temporary password: ${password}`);
  console.log("Sign in at /admin; you will be asked to choose a new password.\n");
  return true;
}
