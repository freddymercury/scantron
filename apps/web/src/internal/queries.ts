/**
 * Queries behind the raw observation viewer (S-B4) — the Phase 0 exit gate.
 *
 * The page exists to answer one question honestly: can this data drive an incident feed?
 * So the counters are the ones that would expose the failure modes, not the ones that
 * flatter: duplicate upserts, unmapped codes, ungeocoded records, failed jobs, and gaps.
 */

import type { Database } from "bun:sqlite";

export interface ObservationFilter {
  source?: string;
  type?: string;
  neighborhood?: string;
  from?: string;
  to?: string;
  /** "yes" | "no" — has coordinates. */
  geocoded?: string;
  /** Only rows whose type is unknown, i.e. a taxonomy gap. */
  unmappedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ObservationListRow {
  id: string;
  source: string;
  source_record_id: string | null;
  occurred_at: string;
  ingested_at: string;
  type: string | null;
  type_confidence: number | null;
  raw_type: string | null;
  subtype: string | null;
  priority: string | null;
  priority_rank: number | null;
  location_raw: string | null;
  location_normalized: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  location_method: string | null;
  units: string | null;
  sensitive: number | null;
  backfilled: number;
}

function conditions(filter: ObservationFilter): { sql: string; parameters: (string | number)[] } {
  const clauses: string[] = [];
  const parameters: (string | number)[] = [];

  if (filter.source) {
    clauses.push("source = ?");
    parameters.push(filter.source);
  }
  if (filter.type) {
    clauses.push("type = ?");
    parameters.push(filter.type);
  }
  if (filter.neighborhood) {
    clauses.push("neighborhood = ?");
    parameters.push(filter.neighborhood);
  }
  if (filter.from) {
    clauses.push("occurred_at >= ?");
    parameters.push(filter.from);
  }
  if (filter.to) {
    clauses.push("occurred_at <= ?");
    parameters.push(filter.to);
  }
  if (filter.geocoded === "yes") clauses.push("lat IS NOT NULL");
  if (filter.geocoded === "no") clauses.push("lat IS NULL");
  if (filter.unmappedOnly) clauses.push("(type IS NULL OR type = 'unknown')");

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", parameters };
}

export function listObservations(db: Database, filter: ObservationFilter = {}): ObservationListRow[] {
  const { sql, parameters } = conditions(filter);
  return db
    .query<ObservationListRow, (string | number)[]>(
      `SELECT id, source, source_record_id, occurred_at, ingested_at, type, type_confidence,
              raw_type, subtype, priority, priority_rank, location_raw, location_normalized,
              neighborhood, lat, lng, location_method, units, sensitive, backfilled
         FROM observations ${sql}
        ORDER BY occurred_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...parameters, filter.limit ?? 50, filter.offset ?? 0);
}

export interface WindowCounters {
  total: number;
  bySource: { source: string; n: number }[];
  geocoded: number;
  geocodedPercent: number;
  /** Excludes sensitive calls, whose location SFPD suppresses upstream (docs/01 §8). */
  locatablePercent: number;
  typed: number;
  typedPercent: number;
  duplicateUpserts: number;
  failedJobs: number;
  pendingJobs: number;
  quarantined: number;
  openGaps: number;
  unrecoverableGaps: number;
  backfilled: number;
  oldest?: string;
  newest?: string;
  /** Hours between the oldest and newest observation in the window. */
  coverageHours: number;
}

export function windowCounters(db: Database, filter: ObservationFilter = {}): WindowCounters {
  const { sql, parameters } = conditions(filter);

  const totals = db
    .query<
      {
        total: number;
        geocoded: number;
        typed: number;
        backfilled: number;
        locatable: number;
        locatable_geocoded: number;
        oldest: string | null;
        newest: string | null;
      },
      (string | number)[]
    >(
      `SELECT count(*) AS total,
              sum(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) AS geocoded,
              sum(CASE WHEN type IS NOT NULL AND type <> 'unknown' THEN 1 ELSE 0 END) AS typed,
              sum(backfilled) AS backfilled,
              sum(CASE WHEN sensitive IS NULL OR sensitive = 0 THEN 1 ELSE 0 END) AS locatable,
              sum(CASE WHEN (sensitive IS NULL OR sensitive = 0) AND lat IS NOT NULL THEN 1 ELSE 0 END)
                AS locatable_geocoded,
              min(occurred_at) AS oldest,
              max(occurred_at) AS newest
         FROM observations ${sql}`,
    )
    .get(...parameters);

  const bySource = db
    .query<{ source: string; n: number }, (string | number)[]>(
      `SELECT source, count(*) AS n FROM observations ${sql} GROUP BY source ORDER BY n DESC`,
    )
    .all(...parameters);

  // A duplicate upsert is a source record we stored more than once for the same call —
  // the number that would explode if idempotency were broken.
  const duplicates = db
    .query<{ n: number }, []>(
      `SELECT count(*) AS n FROM (
         SELECT source, source_record_id FROM source_records
          GROUP BY source, source_record_id HAVING count(*) > 1
       )`,
    )
    .get();

  const jobs = db
    .query<{ status: string; n: number }, []>("SELECT status, count(*) AS n FROM jobs GROUP BY status")
    .all();
  const jobCount = (status: string) => jobs.find((row) => row.status === status)?.n ?? 0;

  const quarantined = db.query<{ n: number }, []>("SELECT count(*) AS n FROM quarantined_records").get();
  const gaps = db
    .query<{ status: string; n: number }, []>("SELECT status, count(*) AS n FROM ingestion_gaps GROUP BY status")
    .all();
  const gapCount = (status: string) => gaps.find((row) => row.status === status)?.n ?? 0;

  const total = totals?.total ?? 0;
  const percent = (part: number, whole: number) => (whole === 0 ? 0 : (part / whole) * 100);

  const counters: WindowCounters = {
    total,
    bySource,
    geocoded: totals?.geocoded ?? 0,
    geocodedPercent: percent(totals?.geocoded ?? 0, total),
    locatablePercent: percent(totals?.locatable_geocoded ?? 0, totals?.locatable ?? 0),
    typed: totals?.typed ?? 0,
    typedPercent: percent(totals?.typed ?? 0, total),
    duplicateUpserts: duplicates?.n ?? 0,
    failedJobs: jobCount("failed"),
    pendingJobs: jobCount("pending"),
    quarantined: quarantined?.n ?? 0,
    openGaps: gapCount("open") + gapCount("filling"),
    unrecoverableGaps: gapCount("unrecoverable"),
    backfilled: totals?.backfilled ?? 0,
    coverageHours: 0,
  };
  if (totals?.oldest) counters.oldest = totals.oldest;
  if (totals?.newest) counters.newest = totals.newest;
  if (totals?.oldest && totals.newest) {
    counters.coverageHours =
      (new Date(totals.newest).getTime() - new Date(totals.oldest).getTime()) / 3_600_000;
  }
  return counters;
}

export interface UnmappedCode {
  source: string;
  raw_type: string | null;
  subtype: string | null;
  n: number;
}

/** Ordered by frequency, so mapping effort goes where the volume is (S-C3). */
export function unmappedCodes(db: Database, limit = 20): UnmappedCode[] {
  return db
    .query<UnmappedCode, [number]>(
      `SELECT source, raw_type, subtype, count(*) AS n
         FROM observations
        WHERE type IS NULL OR type = 'unknown'
        GROUP BY source, raw_type, subtype
        ORDER BY n DESC LIMIT ?`,
    )
    .all(limit);
}

export interface RawPayload {
  fetched_at: string;
  payload: string;
}

/** Every payload stored for a record, newest first — the correction trail (S-D7). */
export function rawPayloads(db: Database, source: string, sourceRecordId: string): RawPayload[] {
  return db
    .query<RawPayload, [string, string]>(
      `SELECT fetched_at, payload FROM source_records
        WHERE source = ? AND source_record_id = ?
        ORDER BY fetched_at DESC LIMIT 5`,
    )
    .all(source, sourceRecordId);
}

export interface FailedJob {
  id: string;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  updated_at: string;
}

export function failedJobs(db: Database, limit = 25): FailedJob[] {
  return db
    .query<FailedJob, [number]>(
      `SELECT id, type, payload, attempts, max_attempts, last_error, updated_at
         FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

/** One-click requeue: back to pending, attempts reset, runnable now. */
export function requeueJob(db: Database, jobId: string, now: Date = new Date()): boolean {
  const result = db
    .query(
      `UPDATE jobs
          SET status = 'pending', attempts = 0, run_after = ?, updated_at = ?, last_error = NULL
        WHERE id = ? AND status = 'failed'`,
    )
    .run(now.toISOString(), now.toISOString(), jobId);
  return result.changes > 0;
}

export interface SourceCoverage {
  source: string;
  observations: number;
  first_at: string | null;
  last_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
}

export function sourceCoverage(db: Database): SourceCoverage[] {
  return db
    .query<SourceCoverage, []>(
      `SELECT sc.source,
              (SELECT count(*) FROM observations o WHERE o.source = sc.source) AS observations,
              (SELECT min(occurred_at) FROM observations o WHERE o.source = sc.source) AS first_at,
              (SELECT max(occurred_at) FROM observations o WHERE o.source = sc.source) AS last_at,
              sc.last_success_at,
              sc.consecutive_failures
         FROM source_configuration sc ORDER BY sc.source`,
    )
    .all();
}

export interface MapPoint {
  lat: number;
  lng: number;
  source: string;
  type: string | null;
}

/**
 * Located observations for the map. Capped, because this is a server-rendered SVG and a
 * page with 50,000 circles in it helps nobody.
 */
export function mapPoints(db: Database, filter: ObservationFilter = {}, limit = 3000): MapPoint[] {
  const { sql, parameters } = conditions(filter);
  const where = sql ? `${sql} AND lat IS NOT NULL` : "WHERE lat IS NOT NULL";
  return db
    .query<MapPoint, (string | number)[]>(
      `SELECT lat, lng, source, type FROM observations ${where} ORDER BY occurred_at DESC LIMIT ?`,
    )
    .all(...parameters, limit);
}

export interface NeighborhoodShape {
  name: string;
  geometry: string;
}

export function neighborhoodShapes(db: Database): NeighborhoodShape[] {
  return db.query<NeighborhoodShape, []>("SELECT name, geometry FROM neighborhoods").all();
}

export interface NeighborhoodBounds {
  name: string;
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
}

export function neighborhoodBounds(db: Database, name: string): NeighborhoodBounds | undefined {
  return (
    db
      .query<NeighborhoodBounds, [string]>(
        "SELECT name, min_lat, min_lng, max_lat, max_lng FROM neighborhoods WHERE name = ?",
      )
      .get(name) ?? undefined
  );
}

/** Neighborhoods that have actually been seen in the data, with counts. */
export function neighborhoodsSeen(db: Database): { neighborhood: string; n: number }[] {
  return db
    .query<{ neighborhood: string; n: number }, []>(
      `SELECT neighborhood, count(*) AS n FROM observations
        WHERE neighborhood IS NOT NULL GROUP BY neighborhood ORDER BY neighborhood`,
    )
    .all();
}
