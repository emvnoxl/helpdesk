import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { config } from "./config";
import { applyPendingRestore } from "./restore";

/* SQLite through Node's built-in driver (no native add-ons to compile). The wrapper below deliberately keeps the
   prepare().bind().first()/all()/run() and batch() shape the queries were written in, so the SQL reads the same. */

/** Bump when you add a file to migrations/. A fresh database is created from schema.sql at this version. */
export const SCHEMA_VERSION = 13;

type Param = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Param => (v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as Param));

export interface RunMeta {
  last_row_id: number;
  changes: number;
}

class Prepared {
  constructor(private owner: Database, readonly sql: string, private params: Param[] = []) {}

  bind(...values: unknown[]) {
    return new Prepared(this.owner, this.sql, values.map(norm));
  }
  /** Synchronous core, used by batch(). */
  rows<T>(): T[] {
    return this.owner.stmt(this.sql).all(...this.params) as T[];
  }
  async first<T = Record<string, any>>(): Promise<T | null> {
    return ((this.owner.stmt(this.sql).get(...this.params) as T | undefined) ?? null) as T | null;
  }
  async all<T = Record<string, any>>(): Promise<{ results: T[] }> {
    return { results: this.rows<T>() };
  }
  async run(): Promise<{ meta: RunMeta }> {
    const r = this.owner.stmt(this.sql).run(...this.params);
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  }
}

export class Database {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 300) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  prepare(sql: string) {
    return new Prepared(this, sql);
  }

  /** Runs every statement in ONE transaction: all succeed or none do. */
  async batch(statements: Prepared[]): Promise<{ results: any[] }[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map((s) => ({ results: s.rows<any>() }));
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  exec(sql: string) {
    this.raw.exec(sql);
  }

  close() {
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* closing anyway */
    }
    this.raw.close();
  }
}

function findFile(...candidates: string[]): string | null {
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function migrate(db: Database) {
  const version = (db.raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version === 0) {
    const schema = findFile(path.resolve(process.cwd(), "schema.sql"), path.resolve(path.dirname(process.argv[1] ?? "."), "../schema.sql"));
    if (!schema) throw new Error("schema.sql not found (it must sit next to the app)");
    db.raw.exec("BEGIN");
    db.raw.exec(readFileSync(schema, "utf8"));
    db.raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.raw.exec("COMMIT");
    console.log(`[db] created a new database (schema v${SCHEMA_VERSION})`);
    return;
  }
  // Existing database: apply any newer migrations/NNN_name.sql in order.
  const dir = findFile(path.resolve(process.cwd(), "migrations"), path.resolve(path.dirname(process.argv[1] ?? "."), "../migrations"));
  if (!dir) return;
  const pending = readdirSync(dir)
    .map((f) => ({ f, n: Number(f.match(/^(\d+)_/)?.[1]) }))
    .filter((m) => m.n > version)
    .sort((a, b) => a.n - b.n);
  for (const m of pending) {
    db.raw.exec("BEGIN");
    try {
      db.raw.exec(readFileSync(path.join(dir, m.f), "utf8"));
      db.raw.exec(`PRAGMA user_version = ${m.n}`);
      db.raw.exec("COMMIT");
      console.log(`[db] applied migration ${m.f}`);
    } catch (e) {
      db.raw.exec("ROLLBACK");
      throw new Error(`migration ${m.f} failed: ${(e as Error).message}`);
    }
  }
}

applyPendingRestore(config.dataDir); // a restore chosen on the System page takes effect here, at the start after it
export const db = new Database(path.join(config.dataDir, "helpdesk.db"));
migrate(db);
