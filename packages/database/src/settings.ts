/**
 * Runtime settings (S-D1/S-D2): values an operator changes without a deploy, and a tuning
 * run changes programmatically.
 *
 * Every write records what the value was, because "correlation stopped merging things" is
 * a question that needs an answer six weeks later.
 */

import type { Database } from "bun:sqlite";

export interface SettingsCache<T> {
  get(): T;
  reload(): void;
  readonly loadedAt: number;
}

export function readSetting<T>(db: Database, key: string, fallback: T): T {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as object) } as T;
  } catch {
    // A malformed setting must not take the pipeline down with it.
    return fallback;
  }
}

export function writeSetting(
  db: Database,
  key: string,
  value: unknown,
  options: { changedBy?: string; now?: Date } = {},
): void {
  const now = options.now ?? new Date();
  const serialized = JSON.stringify(value);
  const previous = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key);

  const run = db.transaction(() => {
    db.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
                                       updated_by = excluded.updated_by`,
    ).run(key, serialized, now.toISOString(), options.changedBy ?? "system");

    db.query(
      `INSERT INTO settings_changes (id, key, old_value, new_value, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `set_${crypto.randomUUID()}`,
      key,
      previous?.value ?? null,
      serialized,
      now.toISOString(),
      options.changedBy ?? "system",
    );
  });
  run();
}

/** Re-reads at most once per interval, so a change lands within a minute without a restart. */
export function createSettingsCache<T>(
  db: Database,
  key: string,
  fallback: T,
  options: { reloadIntervalMs?: number; now?: () => number } = {},
): SettingsCache<T> {
  const reloadIntervalMs = options.reloadIntervalMs ?? 60_000;
  const clock = options.now ?? (() => Date.now());
  let value = readSetting(db, key, fallback);
  let loadedAt = clock();

  return {
    get loadedAt() {
      return loadedAt;
    },
    reload() {
      value = readSetting(db, key, fallback);
      loadedAt = clock();
    },
    get() {
      if (clock() - loadedAt >= reloadIntervalMs) {
        value = readSetting(db, key, fallback);
        loadedAt = clock();
      }
      return value;
    },
  };
}

export function settingsHistory(db: Database, key?: string, limit = 50) {
  const where = key ? "WHERE key = ?" : "";
  const parameters = key ? [key, limit] : [limit];
  return db
    .query<
      { key: string; old_value: string | null; new_value: string; changed_at: string; changed_by: string },
      (string | number)[]
    >(`SELECT key, old_value, new_value, changed_at, changed_by FROM settings_changes ${where} ORDER BY changed_at DESC LIMIT ?`)
    .all(...parameters);
}
