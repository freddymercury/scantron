/**
 * Backfill (S-B5): refill a window from the historical dataset, through the same path
 * live ingest uses.
 *
 * `2zdj-bwza` shares its schema with the real-time feed, so this is a same-shape upsert on
 * `(source, source_record_id)` — idempotent by the same constraint, never a duplicate.
 *
 * Two things are deliberately different from live ingest:
 *   * rows are flagged `backfilled`, because a record that arrives days late would
 *     otherwise ruin the latency metrics it appears in;
 *   * every row is validated before insert, and rejects go to quarantine with a reason.
 *     The historical dataset genuinely contains an export footer row whose `cad_number`
 *     reads `Completion time: 2025-03-11T11:42:36…` (verified live 2026-09-18).
 */

import type { Database } from "bun:sqlite";
import {
  classifyGap,
  enqueue,
  observationBySourceRecord,
  openGaps,
  quarantineRecord,
  recordSourcePayload,
  updateGap,
  upsertObservation,
  type GapRow,
} from "@scantron/database";
import { ObservationSchema, observationToRow, parse } from "@scantron/incident-schema";
import type { AppMetrics, Logger } from "@scantron/observability";
import { errorMessage } from "@scantron/observability";
import { scrubPersonIdentifiers, toSfNaiveString } from "@scantron/sf-domain";

import { mapSfpdRecord, SFPD_SOURCE, type SfpdCallRecord } from "./police.ts";
import type { SocrataClient } from "./socrata.ts";

export const HISTORICAL_DISPATCH_DATASET = "2zdj-bwza";

export interface BackfillDeps {
  db: Database;
  client: SocrataClient;
  metrics: AppMetrics;
  log: Logger;
  now?: () => Date;
}

export interface BackfillRange {
  source: string;
  from: Date;
  to: Date;
}

export interface BackfillResult {
  source: string;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  quarantined: number;
  enqueued: number;
}

/** A row that is not a dispatch record at all — an export artefact, not data. */
export function validationFailure(record: SfpdCallRecord): string | undefined {
  // Checked first because the footer row is also missing an id, and "export footer" is a
  // far more useful thing to read in the quarantine table than "missing id".
  if (record.cad_number && /completion time/i.test(record.cad_number)) {
    return "export footer row (cad_number is a completion timestamp)";
  }
  // The historical dataset has no row `id` at all, so the key is `cad_number`; the live
  // feed carries both.
  if (!record.cad_number?.trim() && !record.id?.trim()) return "missing cad_number and id";
  if (!record.received_datetime?.trim()) return "missing received_datetime";
  if (record.cad_number && !/^\d+$/.test(record.cad_number.trim())) {
    return `cad_number is not numeric: ${record.cad_number.slice(0, 40)}`;
  }
  return undefined;
}

export async function backfillRange(
  deps: BackfillDeps,
  range: BackfillRange,
): Promise<BackfillResult> {
  const { db, client, metrics, log } = deps;
  const now = deps.now ?? (() => new Date());

  const result: BackfillResult = {
    source: range.source,
    fetched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    quarantined: 0,
    enqueued: 0,
  };

  const records = await client.queryKeyset<SfpdCallRecord & Record<string, unknown>>({
    dataset: HISTORICAL_DISPATCH_DATASET,
    where: `received_datetime >= '${toSfNaiveString(range.from)}' AND received_datetime <= '${toSfNaiveString(range.to)}'`,
    timeField: "received_datetime",
    // The historical dataset has no row `id`; `cad_number` is its stable key.
    idField: "cad_number",
    pageSize: 1000,
  });
  result.fetched = records.length;

  for (const record of records) {
    const failure = validationFailure(record);
    if (failure) {
      quarantineRecord(db, { source: range.source, reason: failure, payload: record }, now());
      metrics.observationsFailed.increment({ source: range.source, reason: "validation" });
      result.quarantined += 1;
      continue;
    }

    const ingestedAt = now();
    let observation;
    try {
      observation = mapSfpdRecord(record, ingestedAt).observation;
      // The schema is the last gate before the database, and it is an allowlist: a
      // historical row with fields we have never seen cannot smuggle them through.
      parse(ObservationSchema, observation);
    } catch (error) {
      quarantineRecord(db, { source: range.source, reason: errorMessage(error), payload: record }, ingestedAt);
      metrics.observationsFailed.increment({ source: range.source, reason: "malformed" });
      result.quarantined += 1;
      continue;
    }

    const scrubbed = scrubPersonIdentifiers(record);
    recordSourcePayload(db, {
      source: range.source,
      sourceRecordId: String(record.cad_number ?? record.id),
      payload: scrubbed.value,
      fetchedAt: ingestedAt,
    });

    // Only a record we did not already have is a backfill. Flagging one that arrived
    // live would move a timely record out of the latency metrics it belongs in — and
    // would make every re-run of a covered window look like an update.
    const known = observationBySourceRecord(db, range.source, observation.sourceRecordId as string);
    const backfilled = known ? known.backfilled === 1 : true;
    const outcome = upsertObservation(db, observationToRow({ ...observation, backfilled }));
    result[outcome] += 1;

    if (outcome !== "unchanged") {
      const { created } = enqueue(db, {
        type: "normalize_observation",
        payload: { observationId: observation.id, source: range.source, backfill: true },
        dedupeKey: `normalize_observation:${observation.id}`,
      });
      if (created) result.enqueued += 1;
    }
  }

  log.info("backfill.completed", {
    source: range.source,
    count: result.fetched,
    result: `created=${result.created} unchanged=${result.unchanged} quarantined=${result.quarantined}`,
  });
  return result;
}

/**
 * Work the open gaps: fill what the historical dataset can serve, leave what it cannot yet
 * (it publishes ~1 day behind), and mark as unrecoverable only what neither source can
 * still provide — which is a different alert from ordinary source-health degradation.
 */
export async function fillOpenGaps(
  deps: BackfillDeps,
  options: { source?: string; retentionHours?: number } = {},
): Promise<{ filled: number; pending: number; unrecoverable: number }> {
  const now = deps.now ?? (() => new Date());
  const summary = { filled: 0, pending: 0, unrecoverable: 0 };

  for (const gap of openGaps(deps.db, options.source)) {
    const classified = classifyGap(gap, now(), options.retentionHours === undefined ? {} : { retentionHours: options.retentionHours });

    if (classified.unrecoverable) {
      updateGap(deps.db, gap.id, {
        status: "unrecoverable",
        note: "older than real-time retention and never published historically",
      }, now());
      deps.metrics.observationsFailed.increment({ source: gap.source, reason: "gap_unrecoverable" });
      deps.log.error("gap.unrecoverable", {
        source: gap.source,
        result: `${gap.gap_start} → ${gap.gap_end}`,
      });
      summary.unrecoverable += 1;
      continue;
    }

    if (!classified.historicallyFillable) {
      // Not a failure: the rows simply have not been published yet.
      updateGap(deps.db, gap.id, { note: "waiting for the historical dataset to publish" }, now());
      summary.pending += 1;
      continue;
    }

    updateGap(deps.db, gap.id, { status: "filling" }, now());
    const result = await backfillRange(deps, {
      source: gap.source,
      from: new Date(gap.gap_start),
      to: new Date(gap.gap_end),
    });
    updateGap(
      deps.db,
      gap.id,
      { status: "filled", recordsFilled: result.created + result.updated },
      now(),
    );
    summary.filled += 1;
  }
  return summary;
}

/** Gaps that could not be filled, for /health and the S-B4 viewer. */
export function unrecoverableGaps(db: Database): GapRow[] {
  return db
    .query<GapRow, []>("SELECT * FROM ingestion_gaps WHERE status = 'unrecoverable' ORDER BY gap_start")
    .all();
}
