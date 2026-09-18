/**
 * The `normalize_observation` job (S-C3): raw agency vocabulary → the product's.
 *
 * It writes alongside the raw values, never over them: `raw_type` and the agency's own
 * label stay exactly as ingested, and `type`, `type_confidence`, `severity` and
 * `priority_rank` are added as a second reading (PRD §10). That is what makes
 * re-normalizing after a taxonomy change safe — the input is still there.
 */

import type { Database } from "bun:sqlite";
import { enqueue, type Job } from "@scantron/database";
import type { PriorityMapper, Taxonomy } from "@scantron/event-taxonomy";
import type { AppMetrics, Logger } from "@scantron/observability";

export interface NormalizePayload {
  observationId: string;
  requestId?: string;
  source?: string;
}

interface ObservationTypeRow {
  id: string;
  source: string;
  raw_type: string | null;
  subtype: string | null;
  priority: string | null;
  type: string | null;
  location_raw: string | null;
  lat: number | null;
}

export interface NormalizeHandlerDeps {
  db: Database;
  taxonomy: Taxonomy;
  priorities: PriorityMapper;
  metrics: AppMetrics;
  log: Logger;
  now?: () => Date;
}

export interface NormalizeOutcome {
  observationId: string;
  type: string;
  changed: boolean;
}

export function normalizeObservation(
  deps: NormalizeHandlerDeps,
  observationId: string,
): NormalizeOutcome | undefined {
  const { db, taxonomy, priorities, metrics } = deps;
  const now = deps.now ?? (() => new Date());

  const observation = db
    .query<ObservationTypeRow, [string]>(
      `SELECT id, source, raw_type, subtype, priority, type, location_raw, lat
         FROM observations WHERE id = ?`,
    )
    .get(observationId);
  if (!observation) return undefined;

  const classification = taxonomy.classify({
    source: observation.source,
    rawCode: observation.raw_type ?? undefined,
    rawLabel: observation.subtype ?? undefined,
  });
  const rank = priorities.rank(observation.source, observation.priority);

  const changed = observation.type !== classification.type;

  db.query(
    `UPDATE observations
        SET type = ?, type_confidence = ?, severity = ?, priority_rank = ?, normalized_at = ?
      WHERE id = ?`,
  ).run(
    classification.type,
    classification.confidence,
    classification.severity ?? null,
    rank ?? null,
    now().toISOString(),
    observation.id,
  );

  if (classification.matchedBy === "unmapped") {
    metrics.unmappedCodes.increment({ source: observation.source });
  }

  // Geocoding is the other half of normalization and runs as its own job, so a slow or
  // failing lookup never holds up classification (S-C2).
  if (observation.lat === null && observation.location_raw !== null) {
    enqueue(db, {
      type: "geocode_location",
      payload: { observationId: observation.id },
      dedupeKey: `geocode_location:${observation.id}`,
    });
  } else {
    enqueue(db, {
      type: "correlate_incident",
      payload: { observationId: observation.id },
      dedupeKey: `correlate_incident:${observation.id}`,
    });
  }

  return { observationId: observation.id, type: classification.type, changed };
}

export function createNormalizeHandler(deps: NormalizeHandlerDeps) {
  return function handle(job: Job<NormalizePayload>): void {
    const startedAt = performance.now();
    const outcome = normalizeObservation(deps, job.payload.observationId);

    if (!outcome) {
      deps.log.warn("normalize.observation_missing", {
        observation_id: job.payload.observationId,
        result: "skipped",
      });
      return;
    }

    deps.metrics.stepDurationSeconds.observe((performance.now() - startedAt) / 1000, {
      processor: "normalize_observation",
    });
    deps.log.debug("observation.normalized", {
      observation_id: outcome.observationId,
      result: outcome.type,
      ...(job.payload.requestId ? { request_id: job.payload.requestId } : {}),
    });
  };
}

export interface RenormalizeRange {
  /** ISO-8601 UTC bounds on `occurred_at`. */
  from?: string;
  to?: string;
  source?: string;
  limit?: number;
}

export interface RenormalizeResult {
  examined: number;
  changed: number;
  recorrelated: number;
}

/**
 * Re-normalize a range in place after a taxonomy change (S-C3's backfill).
 *
 * Observations whose *type actually changed* and that belong to a live incident enqueue
 * re-correlation; the rest are updated silently. Re-running it is safe and cheap — the
 * second pass changes nothing.
 */
export function renormalizeRange(
  deps: NormalizeHandlerDeps,
  range: RenormalizeRange = {},
): RenormalizeResult {
  const { db } = deps;
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];

  if (range.from) {
    clauses.push("occurred_at >= ?");
    parameters.push(range.from);
  }
  if (range.to) {
    clauses.push("occurred_at <= ?");
    parameters.push(range.to);
  }
  if (range.source) {
    clauses.push("source = ?");
    parameters.push(range.source);
  }
  parameters.push(range.limit ?? 100_000);

  const ids = db
    .query<{ id: string }, (string | number)[]>(
      `SELECT id FROM observations
        ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
        ORDER BY occurred_at LIMIT ?`,
    )
    .all(...parameters)
    .map((row) => row.id);

  const result: RenormalizeResult = { examined: 0, changed: 0, recorrelated: 0 };

  for (const id of ids) {
    const outcome = normalizeObservation(deps, id);
    if (!outcome) continue;
    result.examined += 1;
    if (!outcome.changed) continue;
    result.changed += 1;

    const active = db
      .query<{ incident_id: string }, [string]>(
        `SELECT io.incident_id FROM incident_observations io
           JOIN incidents i ON i.id = io.incident_id
          WHERE io.observation_id = ? AND i.status <> 'resolved' AND i.merged_into_id IS NULL`,
      )
      .all(id);

    for (const row of active) {
      const { created } = enqueue(db, {
        type: "correlate_incident",
        payload: { incidentId: row.incident_id, observationId: id, reason: "taxonomy_change" },
        dedupeKey: `correlate_incident:${row.incident_id}:taxonomy`,
      });
      if (created) result.recorrelated += 1;
    }
  }
  return result;
}
