/**
 * The `correlate_incident` job: an observation becomes part of an incident (S-D3, S-D4).
 *
 * This is where the pipeline finally produces the product's own object rather than a
 * normalized copy of a dispatch row.
 */

import type { Database } from "bun:sqlite";
import { type Job } from "@scantron/database";
import { applyDecision, correlationConfig, type CandidateObservation } from "@scantron/correlation";
import type { AppMetrics, Logger } from "@scantron/observability";

export interface CorrelatePayload {
  observationId: string;
  requestId?: string;
  reason?: string;
}

interface ObservationRow {
  id: string;
  source: string;
  occurred_at: string;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
  type: string | null;
  subtype: string | null;
  severity: string | null;
  units: string | null;
  location_normalized: string | null;
  metadata: string | null;
}

export interface CorrelateHandlerDeps {
  db: Database;
  metrics: AppMetrics;
  log: Logger;
}

export function createCorrelateHandler(deps: CorrelateHandlerDeps) {
  const { db, metrics, log } = deps;
  const config = correlationConfig(db);

  return function handle(job: Job<CorrelatePayload>): void {
    const startedAt = performance.now();
    const row = db
      .query<ObservationRow, [string]>(
        `SELECT id, source, occurred_at, lat, lng, neighborhood, type, subtype, severity, units,
                location_normalized, metadata
           FROM observations WHERE id = ?`,
      )
      .get(job.payload.observationId);

    if (!row) {
      log.warn("correlate.observation_missing", {
        observation_id: job.payload.observationId,
        result: "skipped",
      });
      return;
    }

    const observation: CandidateObservation = {
      id: row.id,
      source: row.source,
      occurredAt: new Date(row.occurred_at),
      ...(row.lat === null ? {} : { lat: row.lat }),
      ...(row.lng === null ? {} : { lng: row.lng }),
      ...(row.neighborhood === null ? {} : { neighborhood: row.neighborhood }),
      ...(row.type === null ? {} : { type: row.type }),
      ...(row.subtype === null ? {} : { rawType: row.subtype }),
      ...(row.severity === null ? {} : { severity: row.severity }),
      ...(row.units === null ? {} : { units: JSON.parse(row.units) as string[] }),
      ...(row.location_normalized === null ? {} : { locationCanonical: row.location_normalized }),
    };

    const result = applyDecision(db, {
      observation,
      config: config.get(),
      title: row.subtype ?? row.type ?? "Incident",
      ...(row.metadata ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> } : {}),
    });

    const durationSeconds = (performance.now() - startedAt) / 1000;
    metrics.correlationDurationSeconds.observe(durationSeconds);
    metrics.stepDurationSeconds.observe(durationSeconds, { processor: "correlate_incident" });

    if (result.alreadyAttached) return;
    if (result.decision === "merged") metrics.incidentMerges.increment({ source: row.source });
    else if (result.decision === "probable") metrics.probableMatches.increment({ source: row.source });
    else metrics.incidentsCreated.increment({ source: row.source });

    log.debug("observation.correlated", {
      observation_id: row.id,
      incident_id: result.incidentId,
      result: result.decision,
      count: result.candidatesConsidered,
      ...(job.payload.requestId ? { request_id: job.payload.requestId } : {}),
    });
  };
}
