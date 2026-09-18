/**
 * What a source adapter has to provide for `runIngestCycle` to poll it (S-B1, S-B2).
 *
 * The point of this seam: nothing source-specific leaks past the adapter. The cycle knows
 * about cursors, idempotency and queues; the adapter knows about one feed's field names.
 */

import type { Observation } from "@scantron/incident-schema";

export interface MappedRecord {
  observation: Observation;
  /** The feed's publication timestamp, which the cursor advances on. */
  publishedAt?: Date;
  /** The agency's own "when this happened", for the source-lag metric. */
  receivedAt: Date;
}

export class MalformedRecordError extends Error {
  constructor(
    message: string,
    readonly recordId: string | undefined,
  ) {
    super(message);
    this.name = "MalformedRecordError";
  }
}

export interface SourceAdapter<TRecord extends Record<string, unknown> = Record<string, unknown>> {
  /** The `source` value written onto every observation from this adapter. */
  source: string;
  datasetId: string;
  /** Column the cursor walks, and the unique row key used for keyset paging. */
  cursorField: string;
  idField: string;
  /** How long this source may be silent before /health calls it stale (S-A6). */
  silenceThresholdSeconds: number;
  /** Rows this adapter does not own — e.g. EMS rows in the fire dataset. */
  accepts?(record: TRecord): boolean;
  map(record: TRecord, ingestedAt: Date): MappedRecord;
  /**
   * Fold a new record into the observation already stored for the same key. Fire/EMS
   * publishes one row per *unit*, so several rows describe one call (docs/05); without
   * this, observation counts inflate by the number of units.
   */
  merge?(existing: Observation, incoming: Observation): Observation;
}
