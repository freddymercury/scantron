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

/** Forward-only `NNN-name.sql` files, applied in filename order (S-A2). */
export const MIGRATIONS_DIR = resolve(import.meta.dir, "../migrations");

export const IN_MEMORY = ":memory:";

/**
 * Pragmas ADR-003 requires on *every* connection. WAL and `foreign_keys` are per-database
 * and per-connection respectively, but setting all four unconditionally is cheaper than
 * remembering which is which.
 */
export function applyPragmas(db: Database): void {
  // busy_timeout first: everything after it is then willing to wait for a lock.
  db.exec("PRAGMA busy_timeout = 5000");
  enableWal(db);
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}

function journalMode(db: Database): string {
  const row = db.query("PRAGMA journal_mode").get() as Record<string, unknown>;
  return String(Object.values(row)[0]).toLowerCase();
}

/**
 * `PRAGMA journal_mode = WAL` takes a brief exclusive lock and, unlike ordinary writes,
 * returns SQLITE_BUSY *immediately* rather than honouring `busy_timeout` — so two
 * processes starting together (web and a worker) can collide on boot. WAL is a persistent
 * property of the file, so the fix is to retry briefly and accept the mode another process
 * has already set.
 */
function enableWal(db: Database, attempts = 20, sleepMs = 10): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const mode = journalMode(db);
    // An in-memory database reports `memory` and cannot use WAL; that is not a failure.
    if (mode === "wal" || mode === "memory") return;
    try {
      db.exec("PRAGMA journal_mode = WAL");
      if (journalMode(db) === "wal") return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "SQLITE_BUSY") throw error;
    }
    Bun.sleepSync(sleepMs);
  }
  if (journalMode(db) !== "wal") {
    throw new Error("could not enable WAL mode; another process holds the database");
  }
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
  const pending = loadMigrations(dir);
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  for (const migration of pending) {
    // BEGIN IMMEDIATE, and the applied-check happens *inside* it: two processes starting
    // at once (web and a worker both calling migrate on boot) would otherwise each read
    // "not applied", and the loser would fail on a duplicate CREATE.
    const run = db.transaction((): "applied" | "skipped" => {
      const already = db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM schema_migrations WHERE name = ?")
        .get(migration.name);
      if ((already?.n ?? 0) > 0) return "skipped";

      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        migration.name,
        new Date().toISOString(),
      );
      return "applied";
    });

    if (run.immediate() === "applied") result.applied.push(migration.name);
    else result.alreadyApplied.push(migration.name);
  }
  return result;
}

// --- neighborhoods ---------------------------------------------------------

/**
 * DataSF "Neighborhoods - Analysis Boundaries" — 41 polygons, verified 2026-09-18.
 * The CAD feeds already carry `analysis_neighborhood` on ~63% of calls; these polygons
 * are how the other ~37% get one (S-C2).
 */
export const NEIGHBORHOODS_DATASET_ID = "ajp5-b2md";

export interface NeighborhoodRow {
  name: string;
  geometry: string;
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
  source: string;
  loaded_at: string;
}

/** Replaces the neighborhood set in one transaction. Repeatable by design. */
export function replaceNeighborhoods(db: Database, rows: readonly NeighborhoodRow[]): number {
  const insert = db.query(`
    INSERT INTO neighborhoods (name, geometry, min_lat, min_lng, max_lat, max_lng, source, loaded_at)
    VALUES ($name, $geometry, $min_lat, $min_lng, $max_lat, $max_lng, $source, $loaded_at)
    ON CONFLICT (name) DO UPDATE SET
      geometry  = excluded.geometry,
      min_lat   = excluded.min_lat,
      min_lng   = excluded.min_lng,
      max_lat   = excluded.max_lat,
      max_lng   = excluded.max_lng,
      source    = excluded.source,
      loaded_at = excluded.loaded_at
  `);
  const run = db.transaction((batch: readonly NeighborhoodRow[]) => {
    for (const row of batch) {
      // bun:sqlite wants named parameters prefixed, exactly as they appear in the SQL.
      insert.run(
        Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value])) as Record<
          string,
          string | number
        >,
      );
    }
  });
  run(rows);
  return rows.length;
}

export function neighborhoodRows(db: Database): NeighborhoodRow[] {
  return db.query<NeighborhoodRow, []>("SELECT * FROM neighborhoods ORDER BY name").all();
}

export * from "./queue.ts";
export * from "./worker.ts";

// --- source configuration --------------------------------------------------

export interface SourceConfigurationRow {
  source: string;
  dataset_id: string;
  enabled: number;
  poll_seconds: number;
  publication_delay_seconds: number;
  last_polled_at: string | null;
  last_success_at: string | null;
  last_record_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  updated_at: string;
  endpoint: string | null;
  overlap_seconds: number;
  health_max_silence_seconds: number;
  default_visibility: string;
  backoff_after_failures: number;
  max_poll_seconds: number;
}

export function sourceConfigurations(db: Database): SourceConfigurationRow[] {
  return db
    .query<SourceConfigurationRow, []>("SELECT * FROM source_configuration ORDER BY source")
    .all();
}
export * from "./ingest.ts";
export * from "./units.ts";
export * from "./source-config.ts";
