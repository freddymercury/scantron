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
import { applyVerdict, judgePair, type JudgeClient } from "./judge.ts";
import {
  DEFAULT_STALENESS,
  nextStatus,
  signalsFromMetadata,
  staleStatus,
  type StatusDecision,
} from "./lifecycle.ts";
import type { CorrelationConfig } from "./config.ts";
import { DEFAULT_CORRELATION_CONFIG } from "./config.ts";
import { decide, DEFAULT_THRESHOLDS, type Decision, type DecisionResult, type Thresholds } from "./decide.ts";
import { DEFAULT_WEIGHTS, type Weights } from "./scoring.ts";
import {
  agencyOf,
  recordTimeline,
  renderStatus,
  severityRank,
  snapshotIncident,
  timelineDrafts,
} from "./timeline.ts";

export interface ApplyInput {
  observation: CandidateObservation;
  /** The observation's metadata, which carries the agency's lifecycle timestamps (S-D4). */
  metadata?: Record<string, unknown> | undefined;
  /** Used for the incident's title and type when a new one is created. */
  title?: string;
  config?: CorrelationConfig;
  weights?: Weights;
  thresholds?: Thresholds;
  now?: Date;
}

export interface JudgedApplyInput extends ApplyInput {
  judge: JudgeClient;
}

export interface ApplyResult extends DecisionResult {
  incidentId: string;
  /** True when this observation was already attached to that incident. */
  alreadyAttached: boolean;
  probableLogged: boolean;
  /** Set when the second-opinion judge moved the decision, with its reason. */
  judgedBy?: string;
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
  const agency = agencyOf(observation.source);

  db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, severity, lat, lng, neighborhood,
       location_display_name, first_observed_at, last_observed_at, last_updated_at, units,
       confidence, source_count, independent_source_count, verification_classification)
     VALUES (?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'reported')
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    id,
    observation.type ?? "unknown",
    input.title ?? observation.locationCanonical ?? observation.type ?? "Incident",
    JSON.stringify([agency]),
    observation.severity ?? null,
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
      {
        units: string;
        agency_types: string;
        primary_type: string;
        severity: string | null;
        first_observed_at: string;
        last_observed_at: string | null;
      },
      [string]
    >(
      `SELECT units, agency_types, primary_type, severity, first_observed_at, last_observed_at
         FROM incidents WHERE id = ?`,
    )
    .get(incidentId);
  if (!row) return;

  const units = new Set(JSON.parse(row.units) as string[]);
  for (const unit of observation.units ?? []) units.add(unit);

  const agencies = new Set(JSON.parse(row.agency_types) as string[]);
  agencies.add(agencyOf(observation.source));

  // Type only ever moves *off* `unknown` (S-D5). A second agency that classified the call
  // differently is not evidence the first one was wrong, so a known type is never
  // overwritten here — reclassification is a correction, and corrections are S-D7.
  const primaryType =
    row.primary_type === "unknown" && observation.type && observation.type !== "unknown"
      ? observation.type
      : row.primary_type;

  // Severity is the high-water mark across the incident's observations: an event does not
  // become less serious because a later record was calmer about it.
  const severity =
    severityRank(observation.severity) > severityRank(row.severity)
      ? (observation.severity ?? null)
      : row.severity;

  // The earliest report is the incident's start, whichever observation arrived first.
  const firstObserved =
    observation.occurredAt.toISOString() < row.first_observed_at
      ? observation.occurredAt.toISOString()
      : row.first_observed_at;

  // Distinct *agencies*, not distinct sources: SFPD's written-up report is the same agency
  // as SFPD's dispatch call, so a report must never raise corroboration (S-I2).
  const sources = db
    .query<{ n: number }, [string]>(
      `SELECT count(DISTINCT CASE o.source
                WHEN 'sf_police_cad' THEN 'police'
                WHEN 'sf_police_report' THEN 'police'
                WHEN 'sf_fire_cad' THEN 'fire'
                WHEN 'sf_ems_cad' THEN 'ems'
                ELSE o.source END) AS n
         FROM incident_observations io
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
        SET units = ?, agency_types = ?, primary_type = ?, severity = ?,
            first_observed_at = ?, last_observed_at = ?, last_updated_at = ?,
            source_count = (SELECT count(*) FROM incident_observations io
                              JOIN observations o ON o.id = io.observation_id
                             WHERE io.incident_id = ? AND o.source <> 'sf_police_report'),
            independent_source_count = ?,
            verification_classification = CASE WHEN ? >= 2 THEN 'multi-source' ELSE verification_classification END
      WHERE id = ?`,
  ).run(
    JSON.stringify([...units].sort()),
    JSON.stringify([...agencies].sort()),
    primaryType,
    severity,
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

    // The timeline is the difference this observation made, so the snapshot has to be
    // taken before the fold (S-D5). A created incident has no `before` — its first entry
    // is the initial report.
    const before = decision.decision === "merged" ? snapshotIncident(db, attachTo) : undefined;
    updateIncident(db, attachTo, observation, now);
    const after = snapshotIncident(db, attachTo);
    if (after) {
      recordTimeline(
        db,
        attachTo,
        observation.id,
        timelineDrafts({ before, after, observation }),
        now,
      );
    }
    applyLifecycle(db, attachTo, observation, input.metadata, now);

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

/**
 * Apply a decision, consulting the judge **only** when the scorer landed in the probable
 * band. Everything else is decided exactly as it would be without a judge, which is what
 * makes this safe to switch off: with no key, no network, or a slow answer, correlation
 * behaves identically.
 */
export async function applyDecisionJudged(
  db: Database,
  input: JudgedApplyInput,
): Promise<ApplyResult> {
  const preview = decide(db, {
    observation: input.observation,
    ...(input.config ? { config: input.config } : {}),
    ...(input.weights ? { weights: input.weights } : {}),
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
  });

  if (preview.decision !== "probable" || !preview.best || !input.judge.available) {
    return applyDecision(db, input);
  }

  const verdict = await judgePair(input.judge, input.observation, preview.best.candidate);
  const moved = applyVerdict(preview.decision, verdict);
  if (moved.decision === preview.decision) return applyDecision(db, input);

  // The judge moved it, so the thresholds are nudged for this one pair only — the score
  // itself is untouched, and the reason is recorded with the attachment.
  const score = preview.best.score.score;
  const thresholds =
    moved.decision === "merged"
      ? { merge: score, probable: input.thresholds?.probable ?? DEFAULT_THRESHOLDS.probable }
      : { merge: input.thresholds?.merge ?? DEFAULT_THRESHOLDS.merge, probable: score + 1e-6 };

  const result = await Promise.resolve(applyDecision(db, { ...input, thresholds }));
  const judged: ApplyResult = { ...result };
  if (moved.reason) judged.judgedBy = moved.reason;
  return judged;
}

/**
 * Move the incident's status if this observation says something new about it, and write the
 * timeline entry that says why (S-D4: every change carries its source).
 */
export function applyLifecycle(
  db: Database,
  incidentId: string,
  observation: CandidateObservation,
  metadata: Record<string, unknown> | undefined,
  now: Date,
): StatusDecision | undefined {
  const signals = signalsFromMetadata(metadata);
  const current = db
    .query<{ status: string }, [string]>("SELECT status FROM incidents WHERE id = ?")
    .get(incidentId);
  if (!current) return undefined;

  const decision = nextStatus(current.status as never, signals);
  if (decision.status === current.status) return decision;

  db.query(
    `UPDATE incidents SET status = ?, resolved_at = COALESCE(?, resolved_at), last_updated_at = ?
      WHERE id = ?`,
  ).run(decision.status, decision.resolvedAt ?? null, now.toISOString(), incidentId);

  recordTimeline(db, incidentId, observation.id, [renderStatus(decision, observation)], now);
  return decision;
}

export interface SweepResult {
  examined: number;
  movedToUnknown: number;
}

/**
 * The staleness sweep (S-D4). Idempotent: an incident already `unknown` is not touched
 * again, so running it every minute costs one query and changes nothing.
 */
export function sweepStaleIncidents(
  db: Database,
  now: Date = new Date(),
  options = DEFAULT_STALENESS,
): SweepResult {
  const open = db
    .query<{ id: string; status: string; primary_type: string; last_observed_at: string | null; first_observed_at: string }, []>(
      `SELECT id, status, primary_type, last_observed_at, first_observed_at FROM incidents
        WHERE status NOT IN ('resolved', 'unknown') AND merged_into_id IS NULL`,
    )
    .all();

  let moved = 0;
  const run = db.transaction(() => {
    for (const incident of open) {
      const decision = staleStatus(
        incident.status as never,
        incident.last_observed_at ?? incident.first_observed_at,
        incident.primary_type,
        now,
        options,
      );
      if (!decision) continue;

      db.query("UPDATE incidents SET status = 'unknown', last_updated_at = ? WHERE id = ?").run(
        now.toISOString(),
        incident.id,
      );
      moved += 1;
    }
  });
  run();
  return { examined: open.length, movedToUnknown: moved };
}
