/**
 * Candidate retrieval (S-D1): the cheap, bounded set of incidents an observation might
 * belong to.
 *
 * This is the query ADR-003 measured at 0.009 ms with the right index, and the reason that
 * index exists: the time window is far more selective than the bounding box, so
 * `(occurred_at, lat, lng)` is walked by time first and the box filter rides along inside
 * the index. It is the single hottest query in the system — every observation runs it.
 */

import type { Database } from "bun:sqlite";
import { boundingBoxAround, haversineMeters, type Point } from "@scantron/sf-domain";

import type { CorrelationConfig } from "./config.ts";
import { DEFAULT_CORRELATION_CONFIG } from "./config.ts";

export interface CandidateObservation {
  id: string;
  source: string;
  occurredAt: Date;
  lat?: number | undefined;
  lng?: number | undefined;
  neighborhood?: string | undefined;
  type?: string | undefined;
  /** The agency's own code, for the code-level affinity overrides in scoring. */
  rawType?: string | undefined;
  units?: string[] | undefined;
  locationCanonical?: string | undefined;
}

export interface IncidentCandidate {
  id: string;
  primaryType: string;
  /** The code of the observation that opened the incident, when it had one. */
  rawType?: string | null;
  status: string;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
  locationDisplayName: string | null;
  firstObservedAt: string;
  /** When the event was last *reported*, which is not when we last touched the row. */
  lastObservedAt: string;
  lastUpdatedAt: string;
  resolvedAt: string | null;
  units: string[];
  agencyTypes: string[];
  /** Metres from the observation, when both have a point. */
  distanceMeters?: number;
  /**
   * How the candidate was found. A neighborhood match is a much weaker claim than a
   * 40-metre one, and S-D2 degrades the location score accordingly rather than pretending
   * the two are the same kind of evidence.
   */
  matchedBy: "proximity" | "neighborhood";
}

export interface CandidateResult {
  candidates: IncidentCandidate[];
  /** True when the observation had no point and fell back to neighborhood matching. */
  degraded: boolean;
  /** Set when the count passed the warn threshold — the caller logs it with the id. */
  runaway: boolean;
  scannedRows: number;
}

interface IncidentRow {
  id: string;
  primary_type: string;
  raw_type: string | null;
  status: string;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
  location_display_name: string | null;
  first_observed_at: string;
  last_observed_at: string | null;
  last_updated_at: string;
  resolved_at: string | null;
  units: string;
  agency_types: string;
}

function toCandidate(row: IncidentRow, matchedBy: IncidentCandidate["matchedBy"]): IncidentCandidate {
  return {
    id: row.id,
    primaryType: row.primary_type,
    rawType: row.raw_type,
    status: row.status,
    lat: row.lat,
    lng: row.lng,
    neighborhood: row.neighborhood,
    locationDisplayName: row.location_display_name,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at ?? row.first_observed_at,
    lastUpdatedAt: row.last_updated_at,
    resolvedAt: row.resolved_at,
    units: JSON.parse(row.units) as string[],
    agencyTypes: JSON.parse(row.agency_types) as string[],
    matchedBy,
  };
}

const COLUMNS =
  `id, primary_type, status, lat, lng, neighborhood, location_display_name, first_observed_at,
   last_observed_at, last_updated_at, resolved_at, units, agency_types,
   (SELECT o.raw_type FROM incident_observations io
      JOIN observations o ON o.id = io.observation_id
     WHERE io.incident_id = incidents.id ORDER BY io.attached_at LIMIT 1) AS raw_type`;

/**
 * Eligibility, stated once: never a tombstone, and a resolved incident only inside its
 * grace period — a medic arriving four minutes after a call closed belongs to that call,
 * and one arriving four hours later does not.
 */
function eligibilityClause(): string {
  return `merged_into_id IS NULL
      AND (status <> 'resolved' OR resolved_at IS NULL OR resolved_at >= ?)`;
}

export function findCandidates(
  db: Database,
  observation: CandidateObservation,
  config: CorrelationConfig = DEFAULT_CORRELATION_CONFIG,
): CandidateResult {
  const occurredAt = observation.occurredAt;
  const windowStart = new Date(
    occurredAt.getTime() - config.windowBackMinutes * 60_000,
  ).toISOString();
  const windowEnd = new Date(
    occurredAt.getTime() + config.windowForwardMinutes * 60_000,
  ).toISOString();
  const graceCutoff = new Date(
    occurredAt.getTime() - config.resolvedGraceMinutes * 60_000,
  ).toISOString();

  const hasPoint = typeof observation.lat === "number" && typeof observation.lng === "number";

  if (hasPoint) {
    const point: Point = { lat: observation.lat as number, lng: observation.lng as number };
    const box = boundingBoxAround(point, config.radiusMeters);

    const rows = db
      .query<IncidentRow, (string | number)[]>(
        `SELECT ${COLUMNS} FROM incidents
          WHERE first_observed_at BETWEEN ? AND ?
            AND lat BETWEEN ? AND ?
            AND lng BETWEEN ? AND ?
            AND ${eligibilityClause()}
          LIMIT ?`,
      )
      .all(
        windowStart,
        windowEnd,
        box.south,
        box.north,
        box.west,
        box.east,
        graceCutoff,
        config.maxCandidates,
      );

    // The box is a prefilter; haversine is what decides. A corner of a 400 m box is 566 m
    // away, so skipping this step would quietly widen the radius by 40%.
    const candidates = rows
      .map((row) => {
        const candidate = toCandidate(row, "proximity");
        if (row.lat !== null && row.lng !== null) {
          candidate.distanceMeters = haversineMeters(point, { lat: row.lat, lng: row.lng });
        }
        return candidate;
      })
      .filter((candidate) => (candidate.distanceMeters ?? Infinity) <= config.radiusMeters)
      .sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));

    return {
      candidates,
      degraded: false,
      runaway: candidates.length > config.candidateWarnThreshold,
      scannedRows: rows.length,
    };
  }

  // No point — which is not rare: SFPD publishes none at all for sensitive calls, ~32% of
  // them (docs/01 §8). Neighborhood and time is the weaker claim that remains, and it is
  // flagged so scoring can treat it as weaker rather than equivalent.
  if (!observation.neighborhood) {
    return { candidates: [], degraded: true, runaway: false, scannedRows: 0 };
  }

  const rows = db
    .query<IncidentRow, (string | number)[]>(
      `SELECT ${COLUMNS} FROM incidents
        WHERE first_observed_at BETWEEN ? AND ?
          AND neighborhood = ?
          AND ${eligibilityClause()}
        LIMIT ?`,
    )
    .all(windowStart, windowEnd, observation.neighborhood, graceCutoff, config.maxCandidates);

  const candidates = rows.map((row) => toCandidate(row, "neighborhood"));
  return {
    candidates,
    degraded: true,
    runaway: candidates.length > config.candidateWarnThreshold,
    scannedRows: rows.length,
  };
}
