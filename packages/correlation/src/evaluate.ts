/**
 * The correlation evaluation harness (S-D10) — the guard on PRD §55, the system's biggest
 * technical risk.
 *
 * A fixture is a handful of real observations plus a human judgement: *are these one event
 * or not?* The harness replays each case through the real correlator against a throwaway
 * database and scores the grouping it produced. Changing a weight is then a measured
 * decision instead of a guess.
 */

import type { Database } from "bun:sqlite";
import { upsertObservation } from "@scantron/database";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import { applyDecision, applyDecisionJudged } from "./apply.ts";
import type { JudgeClient } from "./judge.ts";
import type { CandidateObservation } from "./candidates.ts";
import { DEFAULT_CORRELATION_CONFIG, type CorrelationConfig } from "./config.ts";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./decide.ts";
import { DEFAULT_WEIGHTS, type Weights } from "./scoring.ts";

export interface FixtureObservation {
  id: string;
  source: string;
  occurredAt: string;
  type?: string;
  subtype?: string;
  rawType?: string;
  lat?: number;
  lng?: number;
  neighborhood?: string;
  locationCanonical?: string;
  units?: string[];
}

export interface FixtureCase {
  id: string;
  /** `same` means every observation in this case is one event. */
  label: "same" | "different";
  /** Where the label came from, so its weight is visible. */
  labelSource: "agency_call_number" | "hand" | "same_cad_number";
  note: string;
  observations: FixtureObservation[];
}

export interface FixtureSet {
  version: string;
  generatedAt: string;
  note: string;
  cases: FixtureCase[];
}

export interface CaseOutcome {
  id: string;
  label: FixtureCase["label"];
  /** How many distinct incidents the correlator produced for this case. */
  incidents: number;
  /** True when the grouping matched the label. */
  correct: boolean;
  /** Pair-level counts, which is what the metrics are computed from. */
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  note: string;
  labelSource: FixtureCase["labelSource"];
}

export interface EvaluationMetrics {
  cases: number;
  casesCorrect: number;
  precision: number;
  recall: number;
  f1: number;
  /** Pairs merged that the label says are different events — the visible kind of error. */
  falseMerges: number;
  /** Pairs left apart that the label says are one event — the invisible kind. */
  missedMerges: number;
  /** Cases labelled `same` that produced more than one incident. */
  splitCases: number;
}

export interface EvaluationResult {
  metrics: EvaluationMetrics;
  outcomes: CaseOutcome[];
  config: { weights: Weights; thresholds: Thresholds; correlation: CorrelationConfig };
}

export interface EvaluateOptions {
  weights?: Weights;
  thresholds?: Thresholds;
  config?: CorrelationConfig;
  /** Consulted on the probable band only, exactly as in production. */
  judge?: JudgeClient;
}

function toObservation(fixture: FixtureObservation): Observation {
  return {
    id: fixture.id,
    source: fixture.source as Observation["source"],
    sourceRecordId: fixture.id,
    occurredAt: new Date(fixture.occurredAt),
    ingestedAt: new Date(fixture.occurredAt),
    confidence: 0.6,
    ...(fixture.type ? { type: fixture.type as Observation["type"] } : {}),
    ...(fixture.subtype ? { subtype: fixture.subtype } : {}),
    ...(fixture.rawType ? { rawType: fixture.rawType } : {}),
    ...(fixture.units ? { units: fixture.units } : {}),
    location: {
      ...(fixture.lat === undefined ? {} : { latitude: fixture.lat }),
      ...(fixture.lng === undefined ? {} : { longitude: fixture.lng }),
      ...(fixture.neighborhood ? { neighborhood: fixture.neighborhood } : {}),
      ...(fixture.locationCanonical ? { normalized: fixture.locationCanonical } : {}),
    },
  } as Observation;
}

function toCandidate(fixture: FixtureObservation): CandidateObservation {
  return {
    id: fixture.id,
    source: fixture.source,
    occurredAt: new Date(fixture.occurredAt),
    ...(fixture.lat === undefined ? {} : { lat: fixture.lat }),
    ...(fixture.lng === undefined ? {} : { lng: fixture.lng }),
    ...(fixture.neighborhood ? { neighborhood: fixture.neighborhood } : {}),
    ...(fixture.type ? { type: fixture.type } : {}),
    ...(fixture.rawType ? { rawType: fixture.rawType } : {}),
    ...(fixture.units ? { units: fixture.units } : {}),
    ...(fixture.locationCanonical ? { locationCanonical: fixture.locationCanonical } : {}),
  };
}

/** Replay one case against an empty database and report the grouping it produced. */
export function runCase(
  db: Database,
  testCase: FixtureCase,
  options: EvaluateOptions = {},
): CaseOutcome {
  db.query("DELETE FROM incident_observations").run();
  db.query("DELETE FROM probable_matches").run();
  db.query("DELETE FROM incidents").run();
  db.query("DELETE FROM observations").run();

  const ordered = [...testCase.observations].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const fixture of ordered) upsertObservation(db, observationToRow(toObservation(fixture)));

  const incidentOf = new Map<string, string>();
  for (const fixture of ordered) {
    const result = applyDecision(db, {
      observation: toCandidate(fixture),
      ...(options.config ? { config: options.config } : {}),
      ...(options.weights ? { weights: options.weights } : {}),
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      title: fixture.subtype ?? fixture.type ?? "Incident",
    });
    incidentOf.set(fixture.id, result.incidentId);
  }

  return scoreGrouping(testCase, ordered, incidentOf);
}

/** Pair-level scoring: each pair is either together or not, and the label says which. */
function scoreGrouping(
  testCase: FixtureCase,
  ordered: FixtureObservation[],
  incidentOf: Map<string, string>,
): CaseOutcome {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const together =
        incidentOf.get((ordered[i] as FixtureObservation).id) ===
        incidentOf.get((ordered[j] as FixtureObservation).id);
      const shouldBe = testCase.label === "same";

      if (together && shouldBe) truePositives += 1;
      else if (together && !shouldBe) falsePositives += 1;
      else if (!together && shouldBe) falseNegatives += 1;
      else trueNegatives += 1;
    }
  }

  const incidents = new Set(incidentOf.values()).size;
  return {
    id: testCase.id,
    label: testCase.label,
    labelSource: testCase.labelSource,
    incidents,
    correct: testCase.label === "same" ? incidents === 1 : incidents === ordered.length,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    note: testCase.note,
  };
}

export function evaluate(
  db: Database,
  fixtures: FixtureSet,
  options: EvaluateOptions = {},
): EvaluationResult {
  return summarize(
    fixtures.cases.map((testCase) => runCase(db, testCase, options)),
    options,
  );
}

function summarize(outcomes: CaseOutcome[], options: EvaluateOptions): EvaluationResult {
  const truePositives = outcomes.reduce((sum, outcome) => sum + outcome.truePositives, 0);
  const falsePositives = outcomes.reduce((sum, outcome) => sum + outcome.falsePositives, 0);
  const falseNegatives = outcomes.reduce((sum, outcome) => sum + outcome.falseNegatives, 0);

  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    metrics: {
      cases: outcomes.length,
      casesCorrect: outcomes.filter((outcome) => outcome.correct).length,
      precision,
      recall,
      f1,
      falseMerges: falsePositives,
      missedMerges: falseNegatives,
      splitCases: outcomes.filter((outcome) => outcome.label === "same" && outcome.incidents > 1).length,
    },
    outcomes,
    config: {
      weights: options.weights ?? DEFAULT_WEIGHTS,
      thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
      correlation: options.config ?? DEFAULT_CORRELATION_CONFIG,
    },
  };
}

/** The same replay, with the judge consulted on the probable band. */
export async function runCaseJudged(
  db: Database,
  testCase: FixtureCase,
  judge: JudgeClient,
  options: EvaluateOptions = {},
): Promise<CaseOutcome> {
  db.query("DELETE FROM incident_observations").run();
  db.query("DELETE FROM probable_matches").run();
  db.query("DELETE FROM incidents").run();
  db.query("DELETE FROM observations").run();

  const ordered = [...testCase.observations].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  for (const fixture of ordered) upsertObservation(db, observationToRow(toObservation(fixture)));

  const incidentOf = new Map<string, string>();
  for (const fixture of ordered) {
    const result = await applyDecisionJudged(db, {
      observation: toCandidate(fixture),
      judge,
      ...(options.config ? { config: options.config } : {}),
      ...(options.weights ? { weights: options.weights } : {}),
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      title: fixture.subtype ?? fixture.type ?? "Incident",
    });
    incidentOf.set(fixture.id, result.incidentId);
  }
  return scoreGrouping(testCase, ordered, incidentOf);
}

export async function evaluateJudged(
  db: Database,
  fixtures: FixtureSet,
  judge: JudgeClient,
  options: EvaluateOptions = {},
): Promise<EvaluationResult> {
  const outcomes: CaseOutcome[] = [];
  for (const testCase of fixtures.cases) {
    outcomes.push(await runCaseJudged(db, testCase, judge, options));
  }
  return summarize(outcomes, options);
}
