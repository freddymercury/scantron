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

export function payloadHash(payload: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(payload));
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
  // otherwise every poll would look like a change.
  const comparable = columns.filter((column) => column !== "ingested_at" && column !== "id");
  const same = comparable.every((column) => existing[column] === row[column]);
  if (same) return "unchanged";

  const assignments = comparable.map((column) => `${String(column)} = $${String(column)}`);
  db.query(
    `UPDATE observations SET ${assignments.join(", ")}
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
}

/** Registers a source if it is unknown; never overwrites operator edits to an existing row. */
export function ensureSourceConfiguration(
  db: Database,
  input: SourceConfigurationInput,
  now: Date = new Date(),
): void {
  db.query(
    `INSERT INTO source_configuration
       (source, dataset_id, enabled, poll_seconds, publication_delay_seconds, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (source) DO NOTHING`,
  ).run(
    input.source,
    input.datasetId,
    input.enabled === false ? 0 : 1,
    input.pollSeconds ?? 60,
    input.publicationDelaySeconds ?? 180,
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
