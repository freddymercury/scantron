/**
 * The merge/create decision (S-D3).
 *
 * Three outcomes and one rule about the middle one: a score that is *nearly* a merge
 * creates a new incident **and** records what it nearly joined. Thresholds in this system
 * are guesses until they are measured, and they cannot be measured from incidents alone —
 * the rejected pairs are half the evidence.
 */

import type { Database } from "bun:sqlite";

import type { CandidateObservation, IncidentCandidate } from "./candidates.ts";
import { findCandidates } from "./candidates.ts";
import type { CorrelationConfig } from "./config.ts";
import { DEFAULT_CORRELATION_CONFIG } from "./config.ts";
import {
  DEFAULT_WEIGHTS,
  scorePair,
  type ScoreResult,
  type Weights,
} from "./scoring.ts";

export type Decision = "merged" | "probable" | "created";

export interface Thresholds {
  /** PRD §18. At or above, attach to the best candidate. */
  merge: number;
  /** At or above but below merge: a new incident, and a logged near miss. */
  probable: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { merge: 0.85, probable: 0.65 };

/**
 * Float slack on the threshold comparison. The replay produced pairs scoring
 * 0.8499999999999999 — arithmetically 0.85, representationally not — which fell into the
 * probable band for no reason a reviewer could ever have understood.
 */
const EPSILON = 1e-9;

export interface DecisionInput {
  observation: CandidateObservation;
  config?: CorrelationConfig;
  weights?: Weights;
  thresholds?: Thresholds;
  now?: Date;
}

export interface DecisionResult {
  decision: Decision;
  /** The incident the observation ended up on, whether joined or created. */
  incidentId?: string;
  /** The best candidate considered, present for every decision including `created`. */
  best?: { candidate: IncidentCandidate; score: ScoreResult };
  candidatesConsidered: number;
  durationMs: number;
}

/**
 * Ties break deterministically: better location first, then the older incident. Without
 * this, two equally-scored candidates would be chosen by whatever order SQLite returned,
 * and a replay would make different incidents from the same data.
 */
export function pickBest(
  scored: { candidate: IncidentCandidate; score: ScoreResult }[],
): { candidate: IncidentCandidate; score: ScoreResult } | undefined {
  return [...scored].sort((a, b) => {
    if (b.score.score !== a.score.score) return b.score.score - a.score.score;
    const locationA = a.score.breakdown.location.score ?? 0;
    const locationB = b.score.breakdown.location.score ?? 0;
    if (locationB !== locationA) return locationB - locationA;
    return a.candidate.firstObservedAt.localeCompare(b.candidate.firstObservedAt);
  })[0];
}

export function decide(db: Database, input: DecisionInput): DecisionResult {
  const startedAt = performance.now();
  const config = input.config ?? DEFAULT_CORRELATION_CONFIG;
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  const { candidates } = findCandidates(db, input.observation, config);
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scorePair(input.observation, candidate, {
      weights,
      location: { radiusMeters: config.radiusMeters, neighborhoodScore: 0.35 },
      time: { toleranceMinutes: config.windowBackMinutes },
    }),
  }));

  const best = pickBest(scored);
  const result: DecisionResult = {
    decision: "created",
    candidatesConsidered: candidates.length,
    durationMs: 0,
  };
  if (best) result.best = best;

  if (best && best.score.score >= thresholds.merge - EPSILON) result.decision = "merged";
  else if (best && best.score.score >= thresholds.probable - EPSILON) result.decision = "probable";

  result.durationMs = performance.now() - startedAt;
  return result;
}
