/**
 * The `geocode_location` job (S-C2).
 *
 * Idempotent by construction: it recomputes from the observation's own stored location text
 * and writes the same answer every time, so a retry, a replay, or a second worker costs
 * nothing but the lookup. A failure here retries on its own and never blocks another
 * observation — that is the whole reason it is a queue job rather than part of ingest.
 */

import type { Database } from "bun:sqlite";
import { enqueue, type Job } from "@scantron/database";
import type { Geocoder } from "@scantron/location-normalizer/geocode";
import type { AppMetrics, Logger } from "@scantron/observability";

export interface GeocodePayload {
  observationId: string;
  requestId?: string;
}

interface ObservationLocationRow {
  id: string;
  source: string;
  location_raw: string | null;
  location_normalized: string | null;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
}

export interface GeocodeHandlerDeps {
  db: Database;
  geocoder: Geocoder;
  metrics: AppMetrics;
  log: Logger;
  now?: () => Date;
}

export function createGeocodeHandler(deps: GeocodeHandlerDeps) {
  const { db, geocoder, metrics, log } = deps;
  const now = deps.now ?? (() => new Date());

  return function handle(job: Job<GeocodePayload>): void {
    const startedAt = performance.now();
    const observation = db
      .query<ObservationLocationRow, [string]>(
        `SELECT id, source, location_raw, location_normalized, lat, lng, neighborhood
           FROM observations WHERE id = ?`,
      )
      .get(job.payload.observationId);

    if (!observation) {
      // Not an error worth retrying forever: the observation is gone or never existed.
      log.warn("geocode.observation_missing", {
        observation_id: job.payload.observationId,
        result: "skipped",
      });
      return;
    }

    const result = geocoder.geocode({
      raw: observation.location_raw ?? observation.location_normalized ?? undefined,
      latitude: observation.lat ?? undefined,
      longitude: observation.lng ?? undefined,
      neighborhood: observation.neighborhood ?? undefined,
    });

    db.query(
      `UPDATE observations
          SET lat = COALESCE(?, lat),
              lng = COALESCE(?, lng),
              neighborhood = COALESCE(?, neighborhood),
              location_normalized = COALESCE(?, location_normalized),
              location_method = ?,
              location_confidence = ?
        WHERE id = ?`,
    ).run(
      result.latitude ?? null,
      result.longitude ?? null,
      result.neighborhood ?? null,
      result.canonical || null,
      result.method,
      result.confidence,
      observation.id,
    );

    // The resolved location is cached by its canonical text, so the next observation at the
    // same corner costs one indexed lookup rather than a re-resolution.
    if (result.canonical && result.latitude !== undefined && result.longitude !== undefined) {
      db.query(
        `INSERT INTO locations (id, normalized, display_name, lat, lng, neighborhood, geocoder,
                                confidence, resolved_at, method, kind)
         VALUES (?, ?, ?, ?, ?, ?, 'scantron', ?, ?, ?, ?)
         ON CONFLICT (normalized) DO UPDATE SET
           lat = excluded.lat, lng = excluded.lng,
           neighborhood = COALESCE(excluded.neighborhood, locations.neighborhood),
           confidence = excluded.confidence, resolved_at = excluded.resolved_at,
           method = excluded.method`,
      ).run(
        `loc_${Bun.hash(result.canonical).toString(36)}`,
        result.canonical,
        result.canonical,
        result.latitude,
        result.longitude,
        result.neighborhood ?? null,
        result.confidence,
        now().toISOString(),
        result.method,
        result.kind,
      );
    }

    metrics.stepDurationSeconds.observe((performance.now() - startedAt) / 1000, {
      processor: "geocode_location",
    });
    if (result.method === "unresolved") {
      metrics.observationsFailed.increment({
        source: observation.source,
        reason: result.reason ?? "unresolved",
      });
    }

    log.debug("geocode.resolved", {
      observation_id: observation.id,
      source: observation.source,
      result: result.method,
      ...(job.payload.requestId ? { request_id: job.payload.requestId } : {}),
    });

    // Correlation is the next step, and it wants a located observation.
    enqueue(db, {
      type: "correlate_incident",
      payload: { observationId: observation.id, requestId: job.payload.requestId },
      dedupeKey: `correlate_incident:${observation.id}`,
    });
  };
}
