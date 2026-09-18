/**
 * One poll cycle: fetch what is new, store it verbatim, upsert observations, queue the
 * work that follows.
 *
 * The cursor walks `data_loaded_at` (when DataSF published a row), with an overlap window
 * so a row published a moment before the previous cycle's high-water mark is not lost.
 * It advances only on success, so a failed cycle repeats its window rather than skipping.
 */

import type { Database } from "bun:sqlite";
import {
  enqueue,
  ensureSourceConfiguration,
  readCursor,
  recordPollFailure,
  recordPollSuccess,
  recordSourcePayload,
  upsertObservation,
} from "@scantron/database";
import type { AppMetrics, Logger } from "@scantron/observability";
import { errorMessage } from "@scantron/observability";
import { toSfNaiveString } from "@scantron/sf-domain";

import type { SocrataClient } from "./socrata.ts";
import {
  MalformedRecordError,
  SFPD_CURSOR_FIELD,
  SFPD_DATASET_ID,
  SFPD_SOURCE,
  mapSfpdRecord,
  type SfpdCallRecord,
} from "./police.ts";

/** Late rows are the reason this exists; 2 minutes is the spec's window. */
export const OVERLAP_SECONDS = 120;

export interface IngestDeps {
  db: Database;
  client: SocrataClient;
  metrics: AppMetrics;
  log: Logger;
  now?: () => Date;
  pageSize?: number;
  /** How far back the first cycle reaches when there is no cursor yet. */
  coldStartHours?: number;
}

export interface IngestResult {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  enqueued: number;
  cursor?: string;
  /** Seconds between the newest record's `received_datetime` and now — the city's lag. */
  sourceLagSeconds?: number;
}

export function cursorWhere(cursor: string | undefined, coldStart: Date): string {
  const from = cursor
    ? new Date(new Date(cursor).getTime() - OVERLAP_SECONDS * 1000)
    : coldStart;
  // DataSF compares against naive local timestamps, so the bound is rendered as one.
  return `${SFPD_CURSOR_FIELD} > '${toSfNaiveString(from)}'`;
}

export async function runIngestCycle(deps: IngestDeps): Promise<IngestResult> {
  const { db, client, metrics, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();

  ensureSourceConfiguration(db, {
    source: SFPD_SOURCE,
    datasetId: SFPD_DATASET_ID,
    pollSeconds: Number(process.env.INGEST_POLL_SECONDS ?? 60),
  });

  const cursor = readCursor(db, SFPD_SOURCE);
  const coldStart = new Date(startedAt.getTime() - (deps.coldStartHours ?? 48) * 3600 * 1000);
  const result: IngestResult = {
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    quarantined: 0,
    enqueued: 0,
  };

  let records: SfpdCallRecord[];
  try {
    records = await client.queryKeyset<SfpdCallRecord & Record<string, unknown>>({
      dataset: SFPD_DATASET_ID,
      where: cursorWhere(cursor, coldStart),
      timeField: SFPD_CURSOR_FIELD,
      idField: "id",
      pageSize: deps.pageSize ?? 1000,
    });
  } catch (error) {
    recordPollFailure(db, SFPD_SOURCE, errorMessage(error), startedAt);
    metrics.observationsFailed.increment({ source: SFPD_SOURCE, reason: "fetch" });
    log.error("source.poll_failed", { source: SFPD_SOURCE, error: errorMessage(error) });
    throw error;
  }

  result.fetched = records.length;
  let highWaterMark = cursor;
  let newestReceivedAt: Date | undefined;

  for (const record of records) {
    const ingestedAt = now();
    let mapped;
    try {
      mapped = mapSfpdRecord(record, ingestedAt);
    } catch (error) {
      result.quarantined += 1;
      metrics.observationsFailed.increment({ source: SFPD_SOURCE, reason: "malformed" });
      log.warn("observation.quarantined", {
        source: SFPD_SOURCE,
        error: errorMessage(error),
        ...(error instanceof MalformedRecordError && error.recordId
          ? { observation_id: error.recordId }
          : {}),
      });
      continue;
    }

    const { isNew } = recordSourcePayload(db, {
      source: SFPD_SOURCE,
      sourceRecordId: mapped.observation.sourceRecordId as string,
      payload: record,
      fetchedAt: ingestedAt,
    });
    if (!isNew) metrics.duplicateSourceRecords.increment({ source: SFPD_SOURCE });

    const outcome = upsertObservation(db, mapped.row);
    result[outcome] += 1;

    if (outcome !== "unchanged") {
      metrics.observationsIngested.increment({ source: SFPD_SOURCE });
      // Exactly once per changed record: the dedupe key collapses repeats within a cycle
      // and across cycles until the job runs.
      const { created } = enqueue(db, {
        type: "normalize_observation",
        payload: {
          observationId: mapped.observation.id,
          source: SFPD_SOURCE,
          requestId: `req_${mapped.observation.id}`,
        },
        dedupeKey: `normalize_observation:${mapped.observation.id}`,
      });
      if (created) result.enqueued += 1;

      // A changed record must be re-correlated; the previous values stay in source_records.
      if (outcome === "updated") {
        enqueue(db, {
          type: "correlate_incident",
          payload: { observationId: mapped.observation.id, reason: "source_update" },
          dedupeKey: `correlate_incident:${mapped.observation.id}`,
        });
      }
    }

    if (mapped.publishedAt) {
      const published = mapped.publishedAt.toISOString();
      if (!highWaterMark || published > highWaterMark) highWaterMark = published;
    }
    if (!newestReceivedAt || mapped.receivedAt > newestReceivedAt) {
      newestReceivedAt = mapped.receivedAt;
    }
  }

  const finishedAt = now();
  if (newestReceivedAt) {
    // Source lag: how old the newest thing the city has published is. Not ours to fix,
    // and tracked separately from pipeline lag for exactly that reason.
    result.sourceLagSeconds = (finishedAt.getTime() - newestReceivedAt.getTime()) / 1000;
    metrics.sourceLagSeconds.set(result.sourceLagSeconds, { source: SFPD_SOURCE });
  }
  metrics.stepDurationSeconds.observe((finishedAt.getTime() - startedAt.getTime()) / 1000, {
    processor: "sf-cad-ingest",
  });

  if (highWaterMark) result.cursor = highWaterMark;
  recordPollSuccess(db, SFPD_SOURCE, highWaterMark, finishedAt);

  log.info("source.polled", {
    source: SFPD_SOURCE,
    count: result.fetched,
    result: `created=${result.created} updated=${result.updated} unchanged=${result.unchanged} quarantined=${result.quarantined}`,
    ...(result.sourceLagSeconds === undefined ? {} : { lag_seconds: result.sourceLagSeconds }),
    processing_time_ms: finishedAt.getTime() - startedAt.getTime(),
  });

  return result;
}
