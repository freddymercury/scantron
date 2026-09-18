import { expect, test } from "bun:test";

import {
  DEFAULT_WEIGHTS,
  locationScore,
  scorePair,
  timeScore,
  typeScore,
  unitScore,
  weightsAreValid,
  type CandidateObservation,
  type IncidentCandidate,
} from "../src/index.ts";

const AT = new Date("2026-09-18T18:51:28.000Z");

const observation = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  id: "obs_1",
  source: "sf_police_cad",
  occurredAt: AT,
  lat: 37.7292,
  lng: -122.3957,
  neighborhood: "Bayview Hunters Point",
  type: "collision",
  locationCanonical: "Earl St & Gilman Ave",
  ...overrides,
});

const candidate = (overrides: Partial<IncidentCandidate> = {}): IncidentCandidate => ({
  id: "inc_1",
  primaryType: "collision",
  status: "active",
  lat: 37.7292,
  lng: -122.3957,
  neighborhood: "Bayview Hunters Point",
  locationDisplayName: "Earl St & Gilman Ave",
  firstObservedAt: AT.toISOString(),
  lastUpdatedAt: AT.toISOString(),
  resolvedAt: null,
  units: [],
  agencyTypes: ["police"],
  matchedBy: "proximity",
  ...overrides,
});

test("the default weights are PRD §17 and sum to 1", () => {
  expect(DEFAULT_WEIGHTS).toEqual({ location: 0.35, time: 0.25, type: 0.2, units: 0.1, text: 0.1 });
  expect(weightsAreValid(DEFAULT_WEIGHTS)).toBe(true);
  expect(weightsAreValid({ ...DEFAULT_WEIGHTS, location: 0.5 })).toBe(false);
  expect(weightsAreValid({ ...DEFAULT_WEIGHTS, location: -0.1, time: 0.7 })).toBe(false);
});

test("location decays with distance and is pinned at an exact intersection match", () => {
  // Same canonical corner, coordinates 60 m apart — two agencies geocoding one corner.
  const jittered = candidate({ lat: 37.7297, lng: -122.3957, distanceMeters: 60 });
  expect(locationScore(observation(), jittered).score).toBe(1);

  const noCanonical = candidate({ locationDisplayName: null, distanceMeters: 200 });
  expect(locationScore(observation({ locationCanonical: undefined }), noCanonical).score).toBeCloseTo(0.5, 2);

  const edge = candidate({ locationDisplayName: null, distanceMeters: 400 });
  expect(locationScore(observation({ locationCanonical: undefined }), edge).score).toBe(0);
});

test("a neighborhood-only match is weak evidence, not equivalent evidence", () => {
  const withoutPoint = observation({ lat: undefined, lng: undefined, locationCanonical: undefined });
  const result = locationScore(withoutPoint, candidate({ locationDisplayName: null }));

  expect(result.applicable).toBe(true);
  expect(result.score).toBeLessThan(0.5);
  expect(result.reason).toContain("same neighborhood");
});

test("no location on one side is inapplicable, not zero", () => {
  const withoutPoint = observation({
    lat: undefined,
    lng: undefined,
    neighborhood: undefined,
    locationCanonical: undefined,
  });
  const result = locationScore(withoutPoint, candidate({ locationDisplayName: null, neighborhood: null }));
  expect(result.applicable).toBe(false);
  expect(result.score).toBeUndefined();
});

test("time decays by distance to the incident's span, equally in both directions", () => {
  const fiveAfter = timeScore(
    observation({ occurredAt: new Date(AT.getTime() + 5 * 60_000) }),
    candidate(),
  );
  const fiveBefore = timeScore(
    observation({ occurredAt: new Date(AT.getTime() - 5 * 60_000) }),
    candidate(),
  );

  // Symmetric on purpose: an asymmetric score made correlation depend on the order records
  // were processed in, which is not a property of the world — and publication lag (median
  // 36.7 min, p90 128) means arrival order says little about what happened first.
  expect(fiveAfter.score).toBeCloseTo(fiveBefore.score as number, 6);
  expect(fiveAfter.score).toBeCloseTo(1 - 5 / 15, 3);
  expect(fiveAfter.reason).toContain("after");
  expect(fiveBefore.reason).toContain("before");
});

test("an observation inside an incident's activity window scores 1", () => {
  const ongoing = candidate({
    firstObservedAt: new Date(AT.getTime() - 10 * 60_000).toISOString(),
    lastUpdatedAt: new Date(AT.getTime() + 10 * 60_000).toISOString(),
  });
  expect(timeScore(observation(), ongoing).score).toBe(1);
  expect(timeScore(observation(), ongoing).reason).toContain("within");
});

test("type similarity is an affinity matrix, not exact match", () => {
  expect(typeScore(observation(), candidate()).score).toBe(1);
  // The cross-agency pair that matters: a police collision and a fire medical call.
  expect(typeScore(observation({ type: "collision" }), candidate({ primaryType: "medical" })).score).toBe(0.85);
  expect(typeScore(observation({ type: "assault" }), candidate({ primaryType: "medical" })).score).toBe(0.8);
  // And one that should not merge.
  expect(typeScore(observation({ type: "theft" }), candidate({ primaryType: "fire" })).score).toBe(0);
  // `unknown` is an absent classification, not a disagreement.
  expect(typeScore(observation({ type: "unknown" }), candidate()).applicable).toBe(false);
});

test("unit overlap is inapplicable across agencies — the failure that made this necessary", () => {
  const police = observation({ source: "sf_police_cad", units: ["3A12"] });
  const fireIncident = candidate({ agencyTypes: ["fire"], units: ["E07", "T07"] });

  const cross = unitScore(police, fireIncident);
  expect(cross.applicable).toBe(false);
  expect(cross.score).toBeUndefined();
  expect(cross.reason).toContain("cannot overlap");

  // Within one agency it is ordinary Jaccard.
  const sameAgency = unitScore(
    observation({ source: "sf_fire_cad", units: ["E07"] }),
    candidate({ agencyTypes: ["fire"], units: ["E07", "T07"] }),
  );
  expect(sameAgency.score).toBeCloseTo(0.5, 3);
  expect(sameAgency.reason).toContain("E07");

  // No shared units is a zero, never a penalty.
  const noOverlap = unitScore(
    observation({ source: "sf_fire_cad", units: ["E01"] }),
    candidate({ agencyTypes: ["fire"], units: ["E07"] }),
  );
  expect(noOverlap.score).toBe(0);
});

test("the score renormalizes over the features that could fire", () => {
  // The real cross-agency case from docs/05: police collision, fire medical, same corner.
  const police = observation({ type: "collision", units: ["3A12"] });
  const fireMedical = candidate({
    primaryType: "medical",
    agencyTypes: ["fire"],
    units: ["E07"],
    firstObservedAt: new Date(AT.getTime() - 4 * 60_000).toISOString(),
  });

  const result = scorePair(police, fireMedical);

  expect(result.appliedFeatures.sort()).toEqual(["location", "time", "type"]);
  expect(result.appliedWeight).toBeCloseTo(0.8, 6);
  // Flat weights would cap this at 0.79 and never merge it; renormalized it clears 0.85.
  expect(result.score).toBeGreaterThan(0.85);
  expect(result.breakdown.units.applicable).toBe(false);
  expect(result.breakdown.text.applicable).toBe(false);
});

test("flat scoring makes cross-agency merge impossible — the measurement, as a test", () => {
  const police = observation({ type: "assault", units: ["3A12"] });
  const fireMedical = candidate({ primaryType: "medical", agencyTypes: ["ems"], units: ["M18"] });

  const result = scorePair(police, fireMedical);

  // The same breakdown scored flat, as the PRD originally specified.
  const flat = Object.entries(result.breakdown).reduce(
    (sum, [name, feature]) =>
      sum + DEFAULT_WEIGHTS[name as keyof typeof DEFAULT_WEIGHTS] * (feature.score ?? 0),
    0,
  );

  expect(flat).toBeLessThan(0.85);
  expect(result.score).toBeGreaterThan(flat);
  // 20% of the weight is dead in exactly the case correlation exists for.
  expect(result.appliedWeight).toBeCloseTo(0.8, 6);
});

test("the breakdown says why, not just how much", () => {
  const result = scorePair(observation(), candidate({ distanceMeters: 0 }));
  expect(result.breakdown.location.reason).toContain("same canonical intersection");
  expect(result.breakdown.time.reason).toContain("within the incident's activity window");
  expect(result.breakdown.type.reason).toContain("both collision");
  expect(result.breakdown.units.reason).toContain("no units");
  expect(result.breakdown.text.reason).toContain("Phase 1");
});

test("a pair with nothing applicable scores zero rather than dividing by zero", () => {
  const blind = observation({
    lat: undefined,
    lng: undefined,
    neighborhood: undefined,
    locationCanonical: undefined,
    type: undefined,
    units: undefined,
  });
  const bare = candidate({
    lat: null,
    lng: null,
    neighborhood: null,
    locationDisplayName: null,
    primaryType: "unknown",
  });

  // Time is always applicable, so this is not the degenerate case it looks like.
  const result = scorePair(blind, bare);
  expect(result.appliedFeatures).toEqual(["time"]);
  expect(Number.isFinite(result.score)).toBe(true);
});
