/**
 * Write paths shared by every ingester (S-B1, S-B2).
 *
 * Two rules the whole pipeline depends on live here:
 *   1. The raw payload is stored verbatim *before* anything interprets it, so a mapping bug
 *      is recoverable without re-fetching a feed that only keeps ~48 hours.
 *   2. Observations upsert on `(source, source_record_id)`. Re-reading a source updates;
 *      it never duplicates (PRD §38).
 */

import type { Database } from "bun:sqlite";
import type { ObservationRow } from "@scantron/incident-schema";

/**
 * Feed bookkeeping: when DataSF last republished the window, not anything about the call.
 *
 * Every record in a batch carries the same `data_loaded_at`, so a new batch changes it on
 * *every* record — and comparing it made one new call look like 3,700 updated ones. Caught
 * by reading the poll log after three days of running: 34,000 normalize jobs an hour for
 * 14,000 observations that had not changed, and 5.1 million completed jobs in a 5.6 GB
 * database.
 *
 * `call_last_updated_at` is deliberately *not* in this list — that one is per-call and a
 * change to it is a real revision.
 */
const VOLATILE_METADATA_KEYS = ["data_as_of", "data_loaded_at"] as const;

function stableMetadata(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    for (const key of VOLATILE_METADATA_KEYS) delete parsed[key];
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

/**
 * Hashed on the *content*, with feed bookkeeping removed.
 *
 * The payload is still stored verbatim — that rule is the point of the table — but the
 * hash decides whether this is a new version, and a republished batch is not. Without
 * this, `data_loaded_at` changing on every record in every batch made every poll store a
 * fresh copy of every payload: 2.5 million rows for 14,000 observations, 354 identical
 * versions of a single call, and most of a 5.6 GB database.
 */
export function payloadHash(payload: unknown): string {
  const stable =
    payload !== null && typeof payload === "object"
      ? Object.fromEntries(
          Object.entries(payload as Record<string, unknown>).filter(
            ([key]) => !VOLATILE_METADATA_KEYS.includes(key as (typeof VOLATILE_METADATA_KEYS)[number]),
          ),
        )
      : payload;

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(stable));
  return hasher.digest("hex");
}

export interface SourcePayloadInput {
  source: string;
  sourceRecordId: string;
  payload: unknown;
  fetchedAt: Date;
}

export interface SourcePayloadResult {
  hash: string;
  /** False when this exact payload has been seen before — i.e. the record did not change. */
  isNew: boolean;
}

/** Stores the payload verbatim. Seeing the same bytes again is recorded as a duplicate. */
export function recordSourcePayload(
  db: Database,
  input: SourcePayloadInput,
): SourcePayloadResult {
  const hash = payloadHash(input.payload);
  const result = db
    .query(
      `INSERT INTO source_records (id, source, source_record_id, fetched_at, payload, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, source_record_id, payload_hash) DO NOTHING`,
    )
    .run(
      `src_${input.source}_${input.sourceRecordId}_${hash.slice(0, 12)}`,
      input.source,
      input.sourceRecordId,
      input.fetchedAt.toISOString(),
      JSON.stringify(input.payload),
      hash,
    );
  return { hash, isNew: result.changes > 0 };
}

export type UpsertOutcome = "created" | "updated" | "unchanged";

/**
 * Columns downstream jobs own. Ingest never writes them on an update: normalization and
 * geocoding fill them in, and a poll that re-read an unchanged source record would
 * otherwise wipe them back to null and re-enqueue the same work — which is exactly what
 * happened, at 4,110 "updates" per cycle over records nothing had changed.
 */
const DERIVED_COLUMNS = new Set<keyof ObservationRow>([
  "type",
  "type_confidence",
  "severity",
  "priority_rank",
  "normalized_at",
  "location_normalized",
  "location_display_name",
  "location_method",
  "location_confidence",
  "visibility",
  "backfilled",
]);

/**
 * Columns the source supplies when it has them and enrichment fills when it does not.
 * A later poll may legitimately add a point the first one lacked, but must never blank one.
 */
const COALESCE_COLUMNS = new Set<keyof ObservationRow>([
  "lat",
  "lng",
  "neighborhood",
  "address",
  "intersection",
]);

/**
 * Upsert on the idempotency key. `unchanged` is reported rather than written, so a poll
 * cycle that re-reads a static snapshot does not churn `last_updated` timestamps or
 * enqueue work that has nothing to do.
 */
export function upsertObservation(db: Database, row: ObservationRow): UpsertOutcome {
  const existing = db
    .query<ObservationRow, [string, string]>(
      "SELECT * FROM observations WHERE source = ? AND source_record_id = ?",
    )
    .get(row.source, row.source_record_id ?? "");

  const columns = Object.keys(row) as (keyof ObservationRow)[];

  if (!existing) {
    db.query(
      `INSERT INTO observations (${columns.join(", ")})
       VALUES (${columns.map((column) => `$${String(column)}`).join(", ")})`,
    ).run(named(row));
    return "created";
  }

  // `ingested_at` is ours, not the source's, so it is excluded from the comparison —
  // otherwise every poll would look like a change. Derived columns are excluded because
  // the source has nothing to say about them.
  const sourceColumns = columns.filter(
    (column) =>
      column !== "ingested_at" && column !== "id" && !DERIVED_COLUMNS.has(column),
  );
  const changed = sourceColumns.filter((column) => {
    if (COALESCE_COLUMNS.has(column)) {
      // Absent in this poll is not a change; present and different is.
      return row[column] !== null && existing[column] !== row[column];
    }
    if (column === "metadata") {
      return stableMetadata(existing.metadata) !== stableMetadata(row.metadata);
    }
    return existing[column] !== row[column];
  });
  if (changed.length === 0) return "unchanged";

  const assignments = changed.map((column) => `${String(column)} = $${String(column)}`);
  db.query(
    `UPDATE observations SET ${assignments.join(", ")}, ingested_at = $ingested_at
      WHERE source = $source AND source_record_id = $source_record_id`,
  ).run(named({ ...row, id: existing.id }));
  return "updated";
}

function named(row: ObservationRow): Record<string, string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [`$${key}`, value as string | number | null]),
  );
}

export function observationBySourceRecord(
  db: Database,
  source: string,
  sourceRecordId: string,
): ObservationRow | undefined {
  return (
    db
      .query<ObservationRow, [string, string]>(
        "SELECT * FROM observations WHERE source = ? AND source_record_id = ?",
      )
      .get(source, sourceRecordId) ?? undefined
  );
}

// --- source configuration and cursor ---------------------------------------

export interface SourceConfigurationInput {
  source: string;
  datasetId: string;
  pollSeconds?: number;
  publicationDelaySeconds?: number;
  enabled?: boolean;
  endpoint?: string;
  overlapSeconds?: number;
  healthMaxSilenceSeconds?: number;
  defaultVisibility?: "public" | "delayed" | "restricted" | "discard";
}

/** Registers a source if it is unknown; never overwrites operator edits to an existing row. */
export function ensureSourceConfiguration(
  db: Database,
  input: SourceConfigurationInput,
  now: Date = new Date(),
): void {
  db.query(
    `INSERT INTO source_configuration
       (source, dataset_id, enabled, poll_seconds, publication_delay_seconds, endpoint,
        overlap_seconds, health_max_silence_seconds, default_visibility, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source) DO NOTHING`,
  ).run(
    input.source,
    input.datasetId,
    input.enabled === false ? 0 : 1,
    input.pollSeconds ?? 60,
    input.publicationDelaySeconds ?? 180,
    input.endpoint ?? null,
    input.overlapSeconds ?? 120,
    input.healthMaxSilenceSeconds ?? 3600,
    input.defaultVisibility ?? "public",
    now.toISOString(),
  );
}

/**
 * The poll cursor is `last_record_at`: the newest source publication timestamp we have
 * processed. It advances only after a cycle succeeds, so a failed cycle re-reads its
 * window rather than skipping it.
 */
export function readCursor(db: Database, source: string): string | undefined {
  const row = db
    .query<{ last_record_at: string | null }, [string]>(
      "SELECT last_record_at FROM source_configuration WHERE source = ?",
    )
    .get(source);
  return row?.last_record_at ?? undefined;
}

export function recordPollSuccess(
  db: Database,
  source: string,
  cursor: string | undefined,
  now: Date = new Date(),
): void {
  db.query(
    `UPDATE source_configuration
        SET last_polled_at = ?, last_success_at = ?, last_record_at = COALESCE(?, last_record_at),
            last_error = NULL, consecutive_failures = 0, updated_at = ?
      WHERE source = ?`,
  ).run(now.toISOString(), now.toISOString(), cursor ?? null, now.toISOString(), source);
}

export function recordPollFailure(
  db: Database,
  source: string,
  error: string,
  now: Date = new Date(),
): void {
  db.query(
    `UPDATE source_configuration
        SET last_polled_at = ?, last_error = ?, consecutive_failures = consecutive_failures + 1,
            updated_at = ?
      WHERE source = ?`,
  ).run(now.toISOString(), error, now.toISOString(), source);
}

// --- geocoding gazetteer (S-C2) --------------------------------------------

export interface IntersectionRow {
  canonical: string;
  street_a: string;
  street_b: string;
  lat: number;
  lng: number;
  observations: number;
  source: string;
  loaded_at: string;
}

export function upsertIntersections(db: Database, rows: readonly IntersectionRow[]): number {
  const insert = db.query(
    `INSERT INTO intersections (canonical, street_a, street_b, lat, lng, observations, source, loaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (canonical) DO UPDATE SET
       lat = excluded.lat, lng = excluded.lng, observations = excluded.observations,
       source = excluded.source, loaded_at = excluded.loaded_at`,
  );
  const run = db.transaction((batch: readonly IntersectionRow[]) => {
    for (const row of batch) {
      insert.run(
        row.canonical,
        row.street_a,
        row.street_b,
        row.lat,
        row.lng,
        row.observations,
        row.source,
        row.loaded_at,
      );
    }
  });
  run(rows);
  return rows.length;
}

export interface StreetSegmentRow {
  cnn: string;
  street: string;
  left_from: number | null;
  left_to: number | null;
  right_from: number | null;
  right_to: number | null;
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
  line: string;
  neighborhood: string | null;
  source: string;
  loaded_at: string;
}

export function upsertStreetSegments(db: Database, rows: readonly StreetSegmentRow[]): number {
  const columns = [
    "cnn",
    "street",
    "left_from",
    "left_to",
    "right_from",
    "right_to",
    "min_lat",
    "min_lng",
    "max_lat",
    "max_lng",
    "line",
    "neighborhood",
    "source",
    "loaded_at",
  ];
  const insert = db.query(
    `INSERT INTO street_segments (${columns.join(", ")})
     VALUES (${columns.map((column) => `$${column}`).join(", ")})
     ON CONFLICT (cnn) DO UPDATE SET
       ${columns
         .filter((column) => column !== "cnn")
         .map((column) => `${column} = excluded.${column}`)
         .join(", ")}`,
  );
  const run = db.transaction((batch: readonly StreetSegmentRow[]) => {
    for (const row of batch) {
      insert.run(
        Object.fromEntries(Object.entries(row).map(([key, value]) => [`$${key}`, value])) as Record<
          string,
          string | number | null
        >,
      );
    }
  });
  run(rows);
  return rows.length;
}
