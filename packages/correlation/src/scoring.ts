/**
 * Correlation scoring (S-D2): how likely is it that this observation and this incident are
 * the same event?
 *
 * Pure functions, no I/O. Every feature returns 0–1 and says whether it could fire at all,
 * because the difference between "scored zero" and "could not score" is the whole story
 * here — see `renormalize` below.
 */

import { haversineMeters } from "@scantron/sf-domain";

import type { CandidateObservation, IncidentCandidate } from "./candidates.ts";

export type FeatureName = "location" | "time" | "type" | "units" | "text";

export interface FeatureScore {
  /** 0–1, or undefined when the feature is *inapplicable* rather than zero. */
  score?: number;
  applicable: boolean;
  /** Why, in words a reviewer can check against the data. */
  reason: string;
}

export type Breakdown = Record<FeatureName, FeatureScore>;

export interface Weights {
  location: number;
  time: number;
  type: number;
  units: number;
  text: number;
}

/** PRD §17. Configurable, and validated to sum to 1. */
export const DEFAULT_WEIGHTS: Weights = {
  location: 0.35,
  time: 0.25,
  type: 0.2,
  units: 0.1,
  text: 0.1,
};

export function weightsAreValid(weights: Weights): boolean {
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  return Math.abs(total - 1) < 1e-6 && Object.values(weights).every((weight) => weight >= 0);
}

// --- location --------------------------------------------------------------

export interface LocationOptions {
  radiusMeters: number;
  /** A neighborhood-only match is real evidence, but weak; this is how weak. */
  neighborhoodScore: number;
}

export const DEFAULT_LOCATION_OPTIONS: LocationOptions = {
  radiusMeters: 400,
  neighborhoodScore: 0.35,
};

/**
 * Distance-decayed, with one override: an exact canonical intersection match scores 1.0
 * whatever the coordinates say. Two agencies geocode the same corner tens of metres apart
 * — S-C1 exists so that "19th Ave & Irving St" is the same string on both sides, and this
 * is where that pays off.
 */
export function locationScore(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
  options: LocationOptions = DEFAULT_LOCATION_OPTIONS,
): FeatureScore {
  const sameCanonical =
    observation.locationCanonical !== undefined &&
    candidate.locationDisplayName !== null &&
    observation.locationCanonical === candidate.locationDisplayName;

  if (sameCanonical) {
    return { score: 1, applicable: true, reason: "same canonical intersection" };
  }

  const hasBoth =
    typeof observation.lat === "number" &&
    typeof observation.lng === "number" &&
    candidate.lat !== null &&
    candidate.lng !== null;

  if (hasBoth) {
    const meters =
      candidate.distanceMeters ??
      haversineMeters(
        { lat: observation.lat as number, lng: observation.lng as number },
        { lat: candidate.lat as number, lng: candidate.lng as number },
      );
    // Linear decay to the candidate radius: 1.0 at the same point, 0 at the edge.
    const score = Math.max(0, 1 - meters / options.radiusMeters);
    return { score, applicable: true, reason: `${Math.round(meters)} m apart` };
  }

  if (
    observation.neighborhood !== undefined &&
    candidate.neighborhood !== null &&
    observation.neighborhood === candidate.neighborhood
  ) {
    return {
      score: options.neighborhoodScore,
      applicable: true,
      reason: `same neighborhood (${observation.neighborhood}), no point to compare`,
    };
  }

  // Neither a point nor a shared neighborhood: there is nothing to say, and saying "zero"
  // would be a claim that they are far apart.
  return { applicable: false, reason: "no location on one side" };
}

// --- time ------------------------------------------------------------------

export interface TimeOptions {
  /** Minutes of tolerance outside the incident's activity span. */
  toleranceMinutes: number;
}

export const DEFAULT_TIME_OPTIONS: TimeOptions = { toleranceMinutes: 15 };

/**
 * Distance to the incident's activity span, in both directions equally.
 *
 * The first version scored "before the incident started" lower than "after", on the
 * reasoning that a response follows a call. The concurrency test found what that actually
 * does: police-then-medic scored 0.877 and merged, while the *same pair* processed
 * medic-then-police scored 0.84 and created a duplicate. **Correlation became dependent on
 * the order we happened to process records in**, which is not a property of the world.
 *
 * It is also not supported by the data: docs/01 §5 measured publication lag at a median of
 * 36.7 minutes with a p90 of 128, so arrival order carries almost no information about
 * which event happened first. Penalising "before" penalises the feed's jitter.
 *
 * The candidate *window* stays asymmetric — that is about which rows are worth scoring at
 * all — but the score itself is symmetric in the pair.
 */
export function timeScore(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
  options: TimeOptions = DEFAULT_TIME_OPTIONS,
): FeatureScore {
  const start = Date.parse(candidate.firstObservedAt);
  const end = Math.max(start, Date.parse(candidate.lastUpdatedAt));
  const at = observation.occurredAt.getTime();

  if (at >= start && at <= end) {
    return { score: 1, applicable: true, reason: "within the incident's activity window" };
  }

  const gapMinutes = (at < start ? start - at : at - end) / 60_000;
  const score = Math.max(0, 1 - gapMinutes / options.toleranceMinutes);
  return {
    score,
    applicable: true,
    reason: `${gapMinutes.toFixed(1)} min ${at < start ? "before" : "after"} the incident's activity`,
  };
}

// --- type ------------------------------------------------------------------

/**
 * Cross-type affinity. The pairs that matter are the cross-agency ones: a police collision
 * and a fire medical call at the same corner are the same event, and exact-match scoring
 * would call them unrelated — which is precisely the case correlation exists for.
 */
export const TYPE_AFFINITY: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  collision: { medical: 0.85, traffic: 0.7, rescue: 0.6, fire: 0.4 },
  assault: { medical: 0.8, weapon: 0.75, disturbance: 0.5 },
  weapon: { assault: 0.75, medical: 0.7, police_activity: 0.3 },
  fire: { medical: 0.7, hazard: 0.6, rescue: 0.6 },
  medical: { assault: 0.8, collision: 0.85, fire: 0.7, rescue: 0.6, weapon: 0.7, public_safety: 0.3 },
  rescue: { fire: 0.6, medical: 0.6, collision: 0.6, hazard: 0.5 },
  hazard: { fire: 0.6, rescue: 0.5, traffic: 0.3 },
  traffic: { collision: 0.7, hazard: 0.3 },
  robbery: { assault: 0.6, weapon: 0.5, theft: 0.5, medical: 0.4 },
  burglary: { theft: 0.6, police_activity: 0.3 },
  theft: { burglary: 0.6, robbery: 0.5 },
  disturbance: { assault: 0.5, public_safety: 0.4, police_activity: 0.3 },
  public_safety: { disturbance: 0.4, medical: 0.3, police_activity: 0.3 },
  police_activity: { public_safety: 0.3, disturbance: 0.3 },
  missing_person: { public_safety: 0.4 },
};

export function typeScore(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
): FeatureScore {
  const a = observation.type;
  const b = candidate.primaryType;

  if (!a || !b) return { applicable: false, reason: "one side has no normalized type" };
  if (a === b) return { score: 1, applicable: true, reason: `both ${a}` };
  // `unknown` is the absence of a classification, not a type that disagrees with others.
  if (a === "unknown" || b === "unknown") {
    return { applicable: false, reason: "one side is unclassified" };
  }

  const affinity = TYPE_AFFINITY[a]?.[b] ?? TYPE_AFFINITY[b]?.[a] ?? 0;
  return { score: affinity, applicable: true, reason: `${a} ↔ ${b} affinity ${affinity.toFixed(2)}` };
}

// --- units -----------------------------------------------------------------

/**
 * Jaccard over canonical unit ids. **Inapplicable across agencies**, and that word is
 * load-bearing: police units and fire units never overlap, so scoring it zero would
 * penalise exactly the cross-agency pairs correlation exists to find. Measured
 * consequence in docs/05: flat weights produced 0 merges from 812 real observations.
 */
export function unitScore(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
): FeatureScore {
  const observationUnits = observation.units ?? [];
  const incidentUnits = candidate.units ?? [];

  if (observationUnits.length === 0 || incidentUnits.length === 0) {
    return { applicable: false, reason: "no units on one side" };
  }

  const agencyOf = (source: string): string =>
    source === "sf_police_cad" ? "police" : source === "sf_fire_cad" ? "fire" : source === "sf_ems_cad" ? "ems" : "other";
  const observationAgency = agencyOf(observation.source);
  const sharesAgency = candidate.agencyTypes.includes(observationAgency);

  if (!sharesAgency) {
    return {
      applicable: false,
      reason: `different agencies (${observationAgency} vs ${candidate.agencyTypes.join("/")}), units cannot overlap`,
    };
  }

  const left = new Set(observationUnits);
  const right = new Set(incidentUnits);
  const shared = [...left].filter((unit) => right.has(unit));
  const union = new Set([...left, ...right]);
  const score = shared.length / union.size;

  return {
    score,
    applicable: true,
    reason: shared.length > 0 ? `shares ${shared.join(", ")}` : "same agency, no shared units",
  };
}

// --- text ------------------------------------------------------------------

/**
 * Inapplicable in Phase 1 by construction: there are no transcripts, and source free-text
 * is never compared because S-E1 forbids storing it in a form that could be published.
 * Registered so the weight is accounted for rather than silently missing.
 */
export function textScore(): FeatureScore {
  return { applicable: false, reason: "no transcript on either side (Phase 1)" };
}

// --- the score ------------------------------------------------------------

export interface ScoreResult {
  score: number;
  breakdown: Breakdown;
  /** Features that actually contributed, and the weight they were renormalized over. */
  appliedFeatures: FeatureName[];
  appliedWeight: number;
  /** Set when a rule held the score below the merge threshold, with the reason. */
  cappedBy?: string;
}

/**
 * The ceiling on a pair supported by nothing but place and time.
 *
 * Found by replaying 24 hours of real data: several merges scored a flat **1.000** into
 * incidents whose type was `unknown`, because an unclassified type makes the type feature
 * inapplicable, renormalization divides by the remaining weight, and a same-corner
 * same-minute pair then scores perfectly on no corroborating evidence at all. An
 * unclassified incident became a magnet for everything near it.
 *
 * Two calls at one corner in one minute is the commonest kind of coincidence in this data
 * — a busy intersection produces them all day — so this is capped into the probable band
 * where a human can look, rather than merged silently.
 */
export const THIN_EVIDENCE_CEILING = 0.84;
const CORROBORATING: readonly FeatureName[] = ["type", "units", "text"];

/**
 * The ceiling on a pair whose types are both known and have no affinity — a theft and a
 * collision, say. Reached only with a perfect location, a simultaneous time and full unit
 * overlap:
 *
 *   (0.35·1 + 0.25·1 + 0.20·0 + 0.10·1) / (0.35 + 0.25 + 0.20 + 0.10) = 0.78
 *
 * Comfortably below the 0.85 merge threshold, so contradictory types cannot auto-merge on
 * place and time alone. This was very nearly a hand-written cap; the arithmetic already
 * guarantees it, and a cap that can never fire is worse than none — it reads as protection
 * that is not there.
 */
export const CONTRADICTORY_TYPE_CEILING = 0.78;

/**
 * **Renormalization is the whole design, not a refinement.**
 *
 * Under flat PRD §17 weights the best possible cross-agency score is 0.79 — below the 0.85
 * auto-merge threshold — because unit overlap (10%) and text similarity (10%) can never
 * fire across agencies in Phase 1. A fifth of the weight is dead in exactly the case
 * correlation exists to handle, and on 812 real observations flat scoring produced zero
 * merges. Dividing by the weight that *could* fire is what makes the question answerable.
 */
export function scorePair(
  observation: CandidateObservation,
  candidate: IncidentCandidate,
  options: {
    weights?: Weights;
    location?: LocationOptions;
    time?: TimeOptions;
  } = {},
): ScoreResult {
  const weights = options.weights ?? DEFAULT_WEIGHTS;

  const breakdown: Breakdown = {
    location: locationScore(observation, candidate, options.location ?? DEFAULT_LOCATION_OPTIONS),
    time: timeScore(observation, candidate, options.time ?? DEFAULT_TIME_OPTIONS),
    type: typeScore(observation, candidate),
    units: unitScore(observation, candidate),
    text: textScore(),
  };

  let weighted = 0;
  let applicableWeight = 0;
  const appliedFeatures: FeatureName[] = [];

  for (const [name, feature] of Object.entries(breakdown) as [FeatureName, FeatureScore][]) {
    if (!feature.applicable || feature.score === undefined) continue;
    weighted += weights[name] * feature.score;
    applicableWeight += weights[name];
    appliedFeatures.push(name);
  }

  const raw = applicableWeight === 0 ? 0 : weighted / applicableWeight;
  const corroborated = appliedFeatures.some((feature) => CORROBORATING.includes(feature));

  const result: ScoreResult = {
    score: corroborated ? raw : Math.min(raw, THIN_EVIDENCE_CEILING),
    breakdown,
    appliedFeatures,
    appliedWeight: applicableWeight,
  };
  if (!corroborated && raw > THIN_EVIDENCE_CEILING) {
    result.cappedBy =
      "nothing but place and time — no type, units or text could be compared, and one corner can hold two unrelated calls";
  }
  return result;
}
