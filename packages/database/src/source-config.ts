/**
 * Source configuration (S-B3): how a feed is polled, when it counts as unhealthy, and what
 * visibility its observations start with — all as data, re-read while running.
 *
 * The reload interval is what makes `UPDATE source_configuration SET enabled = 0` a
 * working off switch: a poller notices within a minute, without a restart.
 */

import type { Database } from "bun:sqlite";

export interface SourceConfig {
  source: string;
  datasetId: string;
  endpoint?: string;
  enabled: boolean;
  pollSeconds: number;
  overlapSeconds: number;
  healthMaxSilenceSeconds: number;
  defaultVisibility: "public" | "delayed" | "restricted" | "discard";
  publicationDelaySeconds: number;
  backoffAfterFailures: number;
  maxPollSeconds: number;
  consecutiveFailures: number;
  lastPolledAt?: string;
  lastSuccessAt?: string;
  cursor?: string;
  lastError?: string;
}

interface ConfigRow {
  source: string;
  dataset_id: string;
  endpoint: string | null;
  enabled: number;
  poll_seconds: number;
  overlap_seconds: number;
  health_max_silence_seconds: number;
  default_visibility: string;
  publication_delay_seconds: number;
  backoff_after_failures: number;
  max_poll_seconds: number;
  consecutive_failures: number;
  last_polled_at: string | null;
  last_success_at: string | null;
  last_record_at: string | null;
  last_error: string | null;
}

function toConfig(row: ConfigRow): SourceConfig {
  const config: SourceConfig = {
    source: row.source,
    datasetId: row.dataset_id,
    enabled: row.enabled === 1,
    pollSeconds: row.poll_seconds,
    overlapSeconds: row.overlap_seconds,
    healthMaxSilenceSeconds: row.health_max_silence_seconds,
    defaultVisibility: row.default_visibility as SourceConfig["defaultVisibility"],
    publicationDelaySeconds: row.publication_delay_seconds,
    backoffAfterFailures: row.backoff_after_failures,
    maxPollSeconds: row.max_poll_seconds,
    consecutiveFailures: row.consecutive_failures,
  };
  if (row.endpoint) config.endpoint = row.endpoint;
  if (row.last_polled_at) config.lastPolledAt = row.last_polled_at;
  if (row.last_success_at) config.lastSuccessAt = row.last_success_at;
  if (row.last_record_at) config.cursor = row.last_record_at;
  if (row.last_error) config.lastError = row.last_error;
  return config;
}

export function readSourceConfig(db: Database, source: string): SourceConfig | undefined {
  const row = db
    .query<ConfigRow, [string]>("SELECT * FROM source_configuration WHERE source = ?")
    .get(source);
  return row ? toConfig(row) : undefined;
}

export function readSourceConfigs(db: Database): SourceConfig[] {
  return db
    .query<ConfigRow, []>("SELECT * FROM source_configuration ORDER BY source")
    .all()
    .map(toConfig);
}

const FIELD_COLUMNS: Record<string, string> = {
  enabled: "enabled",
  pollSeconds: "poll_seconds",
  overlapSeconds: "overlap_seconds",
  healthMaxSilenceSeconds: "health_max_silence_seconds",
  defaultVisibility: "default_visibility",
  publicationDelaySeconds: "publication_delay_seconds",
  backoffAfterFailures: "backoff_after_failures",
  maxPollSeconds: "max_poll_seconds",
  endpoint: "endpoint",
  datasetId: "dataset_id",
};

export interface ConfigChange {
  field: string;
  from: string | null;
  to: string | null;
}

/**
 * Update configuration, recording every field that actually changed with its before and
 * after value. Returns the changes so a caller can log them at the level it prefers.
 */
export function updateSourceConfig(
  db: Database,
  source: string,
  patch: Partial<Omit<SourceConfig, "source" | "consecutiveFailures">>,
  options: { changedBy?: string; now?: Date } = {},
): ConfigChange[] {
  const before = readSourceConfig(db, source);
  if (!before) return [];

  const now = options.now ?? new Date();
  const changes: ConfigChange[] = [];

  const run = db.transaction(() => {
    for (const [field, value] of Object.entries(patch)) {
      const column = FIELD_COLUMNS[field];
      if (!column || value === undefined) continue;

      const currentValue = (before as unknown as Record<string, unknown>)[field];
      if (currentValue === value) continue;

      const stored = typeof value === "boolean" ? (value ? 1 : 0) : (value as string | number);
      db.query(`UPDATE source_configuration SET ${column} = ?, updated_at = ? WHERE source = ?`).run(
        stored,
        now.toISOString(),
        source,
      );
      const change: ConfigChange = {
        field,
        from: currentValue === undefined || currentValue === null ? null : String(currentValue),
        to: value === null ? null : String(value),
      };
      changes.push(change);
      db.query(
        `INSERT INTO source_configuration_changes (id, source, field, old_value, new_value, changed_at, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `cfg_${crypto.randomUUID()}`,
        source,
        field,
        change.from,
        change.to,
        now.toISOString(),
        options.changedBy ?? "system",
      );
    }
  });
  run();
  return changes;
}

export function configChanges(db: Database, source?: string, limit = 50) {
  const where = source ? "WHERE source = ?" : "";
  const parameters = source ? [source, limit] : [limit];
  return db
    .query<
      { source: string; field: string; old_value: string | null; new_value: string | null; changed_at: string; changed_by: string },
      (string | number)[]
    >(`SELECT * FROM source_configuration_changes ${where} ORDER BY changed_at DESC LIMIT ?`)
    .all(...parameters);
}

export interface ConfigCache {
  /** Current config, re-read at most once per `reloadIntervalMs`. */
  get(source: string): SourceConfig | undefined;
  reload(): void;
  readonly loadedAt: number;
}

export function createConfigCache(
  db: Database,
  options: { reloadIntervalMs?: number; now?: () => number } = {},
): ConfigCache {
  const reloadIntervalMs = options.reloadIntervalMs ?? 60_000;
  const clock = options.now ?? (() => Date.now());
  let cache = new Map<string, SourceConfig>();
  let loadedAt = 0;

  function load(): void {
    cache = new Map(readSourceConfigs(db).map((config) => [config.source, config]));
    loadedAt = clock();
  }
  load();

  return {
    get loadedAt() {
      return loadedAt;
    },
    reload: load,
    get(source) {
      if (clock() - loadedAt >= reloadIntervalMs) load();
      return cache.get(source);
    },
  };
}

/**
 * The interval to wait before the next poll of this source.
 *
 * Past `backoffAfterFailures`, the interval doubles per additional failure up to
 * `maxPollSeconds`: a source that is down stays polled, but stops being hammered, and the
 * log line that goes with it is an error rather than a warning.
 */
export function effectivePollSeconds(config: SourceConfig): number {
  if (config.consecutiveFailures < config.backoffAfterFailures) return config.pollSeconds;
  const excess = config.consecutiveFailures - config.backoffAfterFailures + 1;
  return Math.min(config.maxPollSeconds, config.pollSeconds * 2 ** excess);
}
