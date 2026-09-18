/**
 * Writing the decision (S-D3): attach to an incident, or create one, in one transaction.
 *
 * The concurrency rule is the interesting part. Two observations for the same corner
 * arriving together must not create two incidents, and SQLite gives us a stronger tool
 * than an advisory lock: `BEGIN IMMEDIATE` serializes writers outright. The decision is
 * therefore made *inside* the write transaction, not before it — deciding first and
 * writing after is exactly the race that produces duplicate incidents.
 */

import type { Database } from "bun:sqlite";

import type { CandidateObservation } from "./candidates.ts";
import type { CorrelationConfig } from "./config.ts";
import { DEFAULT_CORRELATION_CONFIG } from "./config.ts";
import { decide, DEFAULT_THRESHOLDS, type Decision, type DecisionResult, type Thresholds } from "./decide.ts";
import { DEFAULT_WEIGHTS, type Weights } from "./scoring.ts";

export interface ApplyInput {
  observation: CandidateObservation;
  /** Used for the incident's title and type when a new one is created. */
  title?: string;
  config?: CorrelationConfig;
  weights?: Weights;
  thresholds?: Thresholds;
  now?: Date;
}

export interface ApplyResult extends DecisionResult {
  incidentId: string;
  /** True when this observation was already attached to that incident. */
  alreadyAttached: boolean;
  probableLogged: boolean;
}

function incidentIdFor(observationId: string): string {
  return `inc_${observationId.replace(/^obs_/, "")}`;
}

/** What an incident looks like when one observation has just created it. */
function createIncident(
  db: Database,
  input: ApplyInput,
  now: Date,
): string {
  const observation = input.observation;
  const id = incidentIdFor(observation.id);
  const agency =
    observation.source === "sf_police_cad"
      ? "police"
      : observation.source === "sf_fire_cad"
        ? "fire"
        : observation.source === "sf_ems_cad"
          ? "ems"
          : "other";

  db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, lat, lng, neighborhood,
       location_display_name, first_observed_at, last_observed_at, last_updated_at, units,
       confidence, source_count, independent_source_count, verification_classification)
     VALUES (?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'reported')
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    id,
    observation.type ?? "unknown",
    input.title ?? observation.locationCanonical ?? observation.type ?? "Incident",
    JSON.stringify([agency]),
    observation.lat ?? null,
    observation.lng ?? null,
    observation.neighborhood ?? null,
    observation.locationCanonical ?? null,
    observation.occurredAt.toISOString(),
    observation.occurredAt.toISOString(),
    now.toISOString(),
    JSON.stringify(observation.units ?? []),
    0.5,
  );
  return id;
}

/** Fold an observation into an incident that already exists. */
function updateIncident(
  db: Database,
  incidentId: string,
  observation: CandidateObservation,
  now: Date,
): void {
  const row = db
    .query<
      { units: string; agency_types: string; first_observed_at: string; last_observed_at: string | null },
      [string]
    >("SELECT units, agency_types, first_observed_at, last_observed_at FROM incidents WHERE id = ?")
    .get(incidentId);
  if (!row) return;

  const units = new Set(JSON.parse(row.units) as string[]);
  for (const unit of observation.units ?? []) units.add(unit);

  const agencies = new Set(JSON.parse(row.agency_types) as string[]);
  agencies.add(
    observation.source === "sf_police_cad"
      ? "police"
      : observation.source === "sf_fire_cad"
        ? "fire"
        : observation.source === "sf_ems_cad"
          ? "ems"
          : "other",
  );

  // The earliest report is the incident's start, whichever observation arrived first.
  const firstObserved =
    observation.occurredAt.toISOString() < row.first_observed_at
      ? observation.occurredAt.toISOString()
      : row.first_observed_at;

  const sources = db
    .query<{ n: number }, [string]>(
      `SELECT count(DISTINCT o.source) AS n FROM incident_observations io
         JOIN observations o ON o.id = io.observation_id
        WHERE io.incident_id = ?`,
    )
    .get(incidentId);

  // The activity span grows with the *reported* times on both ends.
  const lastObserved =
    observation.occurredAt.toISOString() > (row.last_observed_at ?? row.first_observed_at)
      ? observation.occurredAt.toISOString()
      : (row.last_observed_at ?? row.first_observed_at);

  db.query(
    `UPDATE incidents
        SET units = ?, agency_types = ?, first_observed_at = ?, last_observed_at = ?, last_updated_at = ?,
            source_count = (SELECT count(*) FROM incident_observations WHERE incident_id = ?),
            independent_source_count = ?,
            verification_classification = CASE WHEN ? >= 2 THEN 'multi-source' ELSE verification_classification END
      WHERE id = ?`,
  ).run(
    JSON.stringify([...units].sort()),
    JSON.stringify([...agencies].sort()),
    firstObserved,
    lastObserved,
    now.toISOString(),
    incidentId,
    sources?.n ?? 1,
    sources?.n ?? 1,
    incidentId,
  );
}

export function applyDecision(db: Database, input: ApplyInput): ApplyResult {
  const now = input.now ?? new Date();
  const config = input.config ?? DEFAULT_CORRELATION_CONFIG;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const observation = input.observation;

  // Decide and write inside one immediate transaction: two observations for the same
  // corner arriving together would otherwise each see no candidate and create an incident.
  const run = db.transaction((): ApplyResult => {
    const existing = db
      .query<{ incident_id: string }, [string]>(
        "SELECT incident_id FROM incident_observations WHERE observation_id = ?",
      )
      .get(observation.id);

    if (existing) {
      // Re-processing an observation that is already attached is a no-op, not a second
      // attachment (S-D3).
      return {
        decision: "merged",
        incidentId: existing.incident_id,
        candidatesConsidered: 0,
        durationMs: 0,
        alreadyAttached: true,
        probableLogged: false,
      };
    }

    const decision = decide(db, { observation, config, weights, thresholds, now });
    const attachTo =
      decision.decision === "merged" && decision.best
        ? decision.best.candidate.id
        : createIncident(db, input, now);

    db.query(
      `INSERT INTO incident_observations (incident_id, observation_id, attached_at, score,
         decision, breakdown, applied_features)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (incident_id, observation_id) DO NOTHING`,
    ).run(
      attachTo,
      observation.id,
      now.toISOString(),
      decision.best?.score.score ?? null,
      decision.decision,
      JSON.stringify(decision.best?.score.breakdown ?? {}),
      JSON.stringify(decision.best?.score.appliedFeatures ?? []),
    );

    updateIncident(db, attachTo, observation, now);

    let probableLogged = false;
    if (decision.decision === "probable" && decision.best) {
      db.query(
        `INSERT INTO probable_matches (id, observation_id, incident_id, created_incident_id,
           score, breakdown, applied_features, decision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'probable', ?)
         ON CONFLICT (observation_id, incident_id) DO NOTHING`,
      ).run(
        `pm_${observation.id}_${decision.best.candidate.id}`,
        observation.id,
        decision.best.candidate.id,
        attachTo,
        decision.best.score.score,
        JSON.stringify(decision.best.score.breakdown),
        JSON.stringify(decision.best.score.appliedFeatures),
        now.toISOString(),
      );
      probableLogged = true;
    }

    return { ...decision, incidentId: attachTo, alreadyAttached: false, probableLogged };
  });

  return run.immediate();
}

export interface CorrelationCounts {
  merged: number;
  probable: number;
  created: number;
}

export function countDecisions(db: Database): CorrelationCounts {
  const rows = db
    .query<{ decision: string; n: number }, []>(
      "SELECT decision, count(*) AS n FROM incident_observations WHERE decision IS NOT NULL GROUP BY decision",
    )
    .all();
  const counts: CorrelationCounts = { merged: 0, probable: 0, created: 0 };
  for (const row of rows) {
    if (row.decision in counts) counts[row.decision as Decision] = row.n;
  }
  return counts;
}
