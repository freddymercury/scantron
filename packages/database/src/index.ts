/**
 * @scantron/database — the only place that talks to SQLite.
 *
 * ADR-003 chose SQLite via `bun:sqlite` and asked that a future Postgres migration stay
 * cheap: plain parameterized SQL, no ORM, no SQLite-only syntax where standard SQL does.
 * The schema itself arrives with S-A2; this module owns the connection, its pragmas, and
 * the migration runner.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_DATABASE_PATH = "./data/scantron.db";

/** Directory holding `NNN-name.sql` files, relative to the repo root. */
export const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../migrations");

export const IN_MEMORY = ":memory:";

/**
 * Pragmas ADR-003 requires on *every* connection. WAL and `foreign_keys` are per-database
 * and per-connection respectively, but setting all four unconditionally is cheaper than
 * remembering which is which.
 */
export function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
}

export function databasePath(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_PATH;
}

export interface OpenOptions {
  /** Defaults to `DATABASE_URL`, then `./data/scantron.db`. */
  path?: string;
  /** Open read-only, and fail if the file does not exist. Readers are unrestricted. */
  readonly?: boolean;
  /** Create the parent directory if missing. Default true for writable connections. */
  create?: boolean;
}

export function openDatabase(options: OpenOptions = {}): Database {
  const path = options.path ?? databasePath();
  const readonly = options.readonly ?? false;

  if (!readonly && (options.create ?? true) && path !== IN_MEMORY) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = readonly
    ? new Database(path, { readonly: true })
    : new Database(path, { create: true });

  if (readonly) {
    db.exec("PRAGMA busy_timeout = 5000");
  } else {
    applyPragmas(db);
  }
  return db;
}

export interface Migration {
  name: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT NOT NULL PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
}

export function appliedMigrations(db: Database): string[] {
  ensureMigrationsTable(db);
  return db
    .query<{ name: string }, []>("SELECT name FROM schema_migrations ORDER BY name")
    .all()
    .map((row) => row.name);
}

/** Reads `*.sql` from `dir` in filename order. Missing directory means no migrations yet. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return [];
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/**
 * Applies every pending migration, each in its own transaction, in filename order.
 * Idempotent: running it twice applies nothing the second time.
 */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): MigrationResult {
  ensureMigrationsTable(db);
  const done = new Set(appliedMigrations(db));
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const migration of loadMigrations(dir)) {
    if (done.has(migration.name)) {
      result.alreadyApplied.push(migration.name);
      continue;
    }
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        migration.name,
        new Date().toISOString(),
      );
    });
    run();
    result.applied.push(migration.name);
  }
  return result;
}
