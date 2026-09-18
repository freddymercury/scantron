/**
 * One poll cycle for one source: fetch what is new, store it verbatim, upsert
 * observations, queue the work that follows.
 *
 * The cursor walks the feed's publication column with an overlap window, so a row
 * published a moment before the previous high-water mark is not lost, and advances only on
 * success, so a failed cycle repeats its window rather than skipping it.
 *
 * Paging is keyset, never `$offset` — docs/01 §7 measured offset paging losing 11 records
 * and duplicating 12 in a single 4,078-row window.
 */

import type { Database } from "bun:sqlite";
import {
  enqueue,
  ensureSourceConfiguration,
  observationBySourceRecord,
  readCursor,
  recordPollFailure,
  recordPollSuccess,
  recordSourcePayload,
  upsertObservation,
} from "@scantron/database";
import { observationToRow, rowToObservation, type Observation } from "@scantron/incident-schema";
import { recordUnits } from "@scantron/database";
import type { AppMetrics, Logger } from "@scantron/observability";
import { errorMessage } from "@scantron/observability";
import { scrubPersonIdentifiers, toSfNaiveString } from "@scantron/sf-domain";

import { MalformedRecordError, type SourceAdapter } from "./adapter.ts";
import type { SocrataClient } from "./socrata.ts";

/** Late rows are the reason this exists; 2 minutes is the spec's window. */
export const OVERLAP_SECONDS = 120;

export interface IngestDeps<TRecord extends Record<string, unknown> = Record<string, unknown>> {
  db: Database;
  adapter: SourceAdapter<TRecord>;
  client: SocrataClient;
  metrics: AppMetrics;
  log: Logger;
  now?: () => Date;
  pageSize?: number;
  /** How far back the first cycle reaches when there is no cursor yet. */
  coldStartHours?: number;
  pollSeconds?: number;
}

export interface IngestResult {
  source: string;
  fetched: number;
  /** Rows this adapter does not own — e.g. EMS rows seen by the fire adapter. */
  skipped: number;
  created: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  enqueued: number;
  cursor?: string;
  /** Seconds between the newest record's own timestamp and now — the city's lag, not ours. */
  sourceLagSeconds?: number;
}

export function cursorWhere(
  cursorField: string,
  cursor: string | undefined,
  coldStart: Date,
): string {
  const from = cursor ? new Date(new Date(cursor).getTime() - OVERLAP_SECONDS * 1000) : coldStart;
  // DataSF compares against naive local timestamps, so the bound is rendered as one.
  return `${cursorField} > '${toSfNaiveString(from)}'`;
}

export async function runIngestCycle<TRecord extends Record<string, unknown>>(
  deps: IngestDeps<TRecord>,
): Promise<IngestResult> {
  const { db, adapter, client, metrics, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  ensureSourceConfiguration(db, {
    source: adapter.source,
    datasetId: adapter.datasetId,
    pollSeconds: deps.pollSeconds ?? Number(process.env.INGEST_POLL_SECONDS ?? 60),
  });

  const cursor = readCursor(db, adapter.source);
  const coldStart = new Date(startedAt.getTime() - (deps.coldStartHours ?? 48) * 3600 * 1000);
  const result: IngestResult = {
    source: adapter.source,
    fetched: 0,
    skipped: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    quarantined: 0,
    enqueued: 0,
  };

  let records: TRecord[];
  try {
    records = await client.queryKeyset<TRecord>({
      dataset: adapter.datasetId,
      where: cursorWhere(adapter.cursorField, cursor, coldStart),
      timeField: adapter.cursorField,
      idField: adapter.idField,
      pageSize: deps.pageSize ?? 1000,
    });
  } catch (error) {
    recordPollFailure(db, adapter.source, errorMessage(error), startedAt);
    metrics.observationsFailed.increment({ source: adapter.source, reason: "fetch" });
    log.error("source.poll_failed", { source: adapter.source, error: errorMessage(error) });
    throw error;
  }

  result.fetched = records.length;
  let highWaterMark = cursor;
  let newestReceivedAt: Date | undefined;

  /**
   * Fold first, write once. Fire/EMS publishes one row per unit, so a cycle that wrote a
   * row at a time would rewrite the same call k times — and a re-poll would look like k
   * updates rather than "nothing changed". Grouping in memory makes a replay genuinely
   * idempotent and cuts the writes to one per call.
   */
  const pending = new Map<string, Observation>();

  for (const record of records) {
    if (adapter.accepts && !adapter.accepts(record)) {
      result.skipped += 1;
      continue;
    }

    const ingestedAt = now();
    let mapped;
    try {
      mapped = adapter.map(record, ingestedAt);
    } catch (error) {
      result.quarantined += 1;
      metrics.observationsFailed.increment({ source: adapter.source, reason: "malformed" });
      log.warn("observation.quarantined", {
        source: adapter.source,
        error: errorMessage(error),
        ...(error instanceof MalformedRecordError && error.recordId
          ? { observation_id: error.recordId }
          : {}),
      });
      continue;
    }

    // Person-identifying fields are dropped here, before anything is stored — S-C4, and
    // the reason it happens at the adapter rather than at publication is that a field we
    // never wrote cannot leak.
    const scrubbed = scrubPersonIdentifiers(record);
    if (scrubbed.dropped.length > 0) {
      metrics.observationsFailed.increment({ source: adapter.source, reason: "person_fields_dropped" });
      log.warn("record.person_fields_dropped", {
        source: adapter.source,
        count: scrubbed.dropped.length,
      });
    }

    // Every row keeps its own payload, even when several describe one call.
    const { isNew } = recordSourcePayload(db, {
      source: adapter.source,
      sourceRecordId: String(record[adapter.idField] ?? mapped.observation.sourceRecordId),
      payload: scrubbed.value,
      fetchedAt: ingestedAt,
    });
    if (!isNew) metrics.duplicateSourceRecords.increment({ source: adapter.source });

    const existing = pending.get(mapped.observation.id);
    pending.set(
      mapped.observation.id,
      existing && adapter.merge ? adapter.merge(existing, mapped.observation) : mapped.observation,
    );

    if (mapped.publishedAt) {
      const published = mapped.publishedAt.toISOString();
      if (!highWaterMark || published > highWaterMark) highWaterMark = published;
    }
    if (!newestReceivedAt || mapped.receivedAt > newestReceivedAt) {
      newestReceivedAt = mapped.receivedAt;
    }
  }

  for (const candidate of pending.values()) {
    let observation = candidate;
    if (adapter.merge) {
      const storedRow = observationBySourceRecord(
        db,
        adapter.source,
        observation.sourceRecordId as string,
      );
      // Units seen in an earlier cycle must survive this one; a later cycle's window can
      // contain only some of a call's rows.
      if (storedRow) observation = adapter.merge(rowToObservation(storedRow), observation);
    }

    // Canonicalize units and register them, so unit overlap can act as a correlation
    // signal (S-D2) and the UI can name who is responding.
    if (observation.units && observation.units.length > 0) {
      const unitTypes = unitTypesFrom(observation);
      const parsed = recordUnits(db, observation.units, observation.ingestedAt, {
        unitTypes,
        source: adapter.source,
      });
      observation = { ...observation, units: parsed.map((unit) => unit.designator).sort() };
    }

    const outcome = upsertObservation(db, observationToRow(observation));
    result[outcome] += 1;
    if (outcome === "unchanged") continue;

    metrics.observationsIngested.increment({ source: adapter.source });
    const { created } = enqueue(db, {
      type: "normalize_observation",
      payload: {
        observationId: observation.id,
        source: adapter.source,
        requestId: `req_${observation.id}`,
      },
      dedupeKey: `normalize_observation:${observation.id}`,
    });
    if (created) result.enqueued += 1;

    // A changed record must be re-correlated; previous values stay in source_records.
    if (outcome === "updated") {
      enqueue(db, {
        type: "correlate_incident",
        payload: { observationId: observation.id, reason: "source_update" },
        dedupeKey: `correlate_incident:${observation.id}`,
      });
    }
  }

  const finishedAt = now();
  if (newestReceivedAt) {
    result.sourceLagSeconds = (finishedAt.getTime() - newestReceivedAt.getTime()) / 1000;
    // Per source: the fire feed runs ~19 h behind and the police feed ~30 min, so one
    // shared number would describe neither.
    metrics.sourceLagSeconds.set(result.sourceLagSeconds, { source: adapter.source });
  }
  metrics.stepDurationSeconds.observe((finishedAt.getTime() - startedAt.getTime()) / 1000, {
    processor: `ingest:${adapter.source}`,
  });

  if (highWaterMark) result.cursor = highWaterMark;
  recordPollSuccess(db, adapter.source, highWaterMark, finishedAt);

  log.info("source.polled", {
    source: adapter.source,
    count: result.fetched,
    result: `created=${result.created} updated=${result.updated} unchanged=${result.unchanged} skipped=${result.skipped} quarantined=${result.quarantined}`,
    ...(result.sourceLagSeconds === undefined ? {} : { lag_seconds: result.sourceLagSeconds }),
    processing_time_ms: finishedAt.getTime() - startedAt.getTime(),
  });

  return result;
}

/** The per-unit `unit_type` the fire feed records in metadata, keyed by raw designator. */
function unitTypesFrom(observation: Observation): Record<string, string | undefined> {
  const timestamps = observation.metadata?.unit_timestamps as
    | Record<string, { unit_type?: string }>
    | undefined;
  if (!timestamps) return {};
  return Object.fromEntries(
    Object.entries(timestamps).map(([unit, value]) => [unit, value?.unit_type]),
  );
}
