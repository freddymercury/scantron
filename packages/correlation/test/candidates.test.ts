import { expect, test } from "bun:test";
import { createTestDatabase } from "@scantron/database/testing";
import { writeSetting } from "@scantron/database";

import {
  correlationConfig,
  DEFAULT_CORRELATION_CONFIG,
  findCandidates,
  type CandidateObservation,
} from "../src/index.ts";

const BASE = new Date("2026-09-18T12:00:00.000Z");
/** 16th & Mission. */
const HERE = { lat: 37.7649, lng: -122.4194 };

function incident(
  db: ReturnType<typeof createTestDatabase>,
  id: string,
  overrides: {
    lat?: number | null;
    lng?: number | null;
    at?: Date;
    status?: string;
    resolvedAt?: Date;
    mergedInto?: string;
    neighborhood?: string | null;
    units?: string[];
    type?: string;
  } = {},
): void {
  const at = (overrides.at ?? BASE).toISOString();
  db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, lat, lng, neighborhood,
       first_observed_at, last_updated_at, resolved_at, merged_into_id, units, confidence,
       verification_classification)
     VALUES (?, ?, ?, '["police"]', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.5, 'reported')`,
  ).run(
    id,
    overrides.type ?? "collision",
    id,
    overrides.status ?? "active",
    overrides.lat === undefined ? HERE.lat : overrides.lat,
    overrides.lng === undefined ? HERE.lng : overrides.lng,
    overrides.neighborhood === undefined ? "Mission" : overrides.neighborhood,
    at,
    at,
    overrides.resolvedAt?.toISOString() ?? null,
    overrides.mergedInto ?? null,
    JSON.stringify(overrides.units ?? []),
  );
}

const observation = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  id: "obs_1",
  source: "sf_fire_cad",
  occurredAt: BASE,
  lat: HERE.lat,
  lng: HERE.lng,
  neighborhood: "Mission",
  ...overrides,
});

/** Metres → a latitude offset, for placing a fixture at a known distance. */
function north(meters: number): number {
  return HERE.lat + (meters / 6_371_008.8) * (180 / Math.PI);
}

test("an incident at the same corner, at the same time, is a candidate", () => {
  const db = createTestDatabase();
  incident(db, "inc_here");

  const result = findCandidates(db, observation());
  expect(result.candidates.map((candidate) => candidate.id)).toEqual(["inc_here"]);
  expect(result.candidates[0]?.distanceMeters).toBeCloseTo(0, 1);
  expect(result.candidates[0]?.matchedBy).toBe("proximity");
  expect(result.degraded).toBe(false);
  db.close();
});

test("the radius is a circle, not the bounding box that prefilters it", () => {
  const db = createTestDatabase();
  incident(db, "inc_close", { lat: north(350) });
  incident(db, "inc_far", { lat: north(450) });
  // A corner of the box is 566 m out: without the haversine step this would come back too.
  incident(db, "inc_corner", { lat: north(390), lng: HERE.lng + 0.0045 });

  const ids = findCandidates(db, observation()).candidates.map((candidate) => candidate.id);
  expect(ids).toEqual(["inc_close"]);
  db.close();
});

test("candidates are ordered by distance, nearest first", () => {
  const db = createTestDatabase();
  incident(db, "inc_300", { lat: north(300) });
  incident(db, "inc_50", { lat: north(50) });
  incident(db, "inc_150", { lat: north(150) });

  expect(findCandidates(db, observation()).candidates.map((candidate) => candidate.id)).toEqual([
    "inc_50",
    "inc_150",
    "inc_300",
  ]);
  db.close();
});

test("the time window reaches further back than forward, because a response follows a call", () => {
  const db = createTestDatabase();
  // Started 20 minutes ago: this medic plausibly belongs to it.
  incident(db, "inc_20_back", { at: new Date(BASE.getTime() - 20 * 60_000) });
  // Starts 20 minutes from now: the same gap, the other way, and not plausible.
  incident(db, "inc_20_forward", { at: new Date(BASE.getTime() + 20 * 60_000) });
  // Just inside the forward window.
  incident(db, "inc_12_forward", { at: new Date(BASE.getTime() + 12 * 60_000) });
  incident(db, "inc_50_back", { at: new Date(BASE.getTime() - 50 * 60_000) });

  const ids = findCandidates(db, observation()).candidates.map((candidate) => candidate.id);
  expect(ids).toContain("inc_20_back");
  expect(ids).toContain("inc_12_forward");
  expect(ids).not.toContain("inc_20_forward");
  expect(ids).not.toContain("inc_50_back");
  db.close();
});

test("a tombstoned incident is never a candidate", () => {
  const db = createTestDatabase();
  incident(db, "inc_survivor");
  incident(db, "inc_merged", { mergedInto: "inc_survivor" });

  expect(findCandidates(db, observation()).candidates.map((c) => c.id)).toEqual(["inc_survivor"]);
  db.close();
});

test("a resolved incident stays eligible only inside its grace period", () => {
  const db = createTestDatabase();
  // Closed four minutes ago: the medic arriving now belongs to it.
  incident(db, "inc_just_closed", {
    status: "resolved",
    resolvedAt: new Date(BASE.getTime() - 4 * 60_000),
  });
  // Closed half an hour ago: it does not.
  incident(db, "inc_long_closed", {
    status: "resolved",
    resolvedAt: new Date(BASE.getTime() - 30 * 60_000),
  });

  const ids = findCandidates(db, observation()).candidates.map((candidate) => candidate.id);
  expect(ids).toEqual(["inc_just_closed"]);
  db.close();
});

test("an observation with no point falls back to neighborhood, and says so", () => {
  const db = createTestDatabase();
  incident(db, "inc_mission", { neighborhood: "Mission" });
  incident(db, "inc_soma", { neighborhood: "South of Market", lat: 37.78, lng: -122.4 });

  const result = findCandidates(db, observation({ lat: undefined, lng: undefined }));
  expect(result.candidates.map((candidate) => candidate.id)).toEqual(["inc_mission"]);
  expect(result.degraded).toBe(true);
  // The weaker claim is labelled as such, so scoring can treat it as weaker.
  expect(result.candidates[0]?.matchedBy).toBe("neighborhood");
  db.close();
});

test("no point and no neighborhood yields nothing, rather than everything", () => {
  const db = createTestDatabase();
  incident(db, "inc_here");

  const result = findCandidates(db, observation({ lat: undefined, lng: undefined, neighborhood: undefined }));
  expect(result.candidates).toEqual([]);
  expect(result.degraded).toBe(true);
  db.close();
});

test("a runaway candidate count is reported rather than silently processed", () => {
  const db = createTestDatabase();
  for (let i = 0; i < 60; i += 1) incident(db, `inc_${i}`, { lat: north(i) });

  const result = findCandidates(db, observation());
  expect(result.candidates.length).toBeGreaterThan(DEFAULT_CORRELATION_CONFIG.candidateWarnThreshold);
  expect(result.runaway).toBe(true);
  db.close();
});

test("radius, window and grace period are configuration, read at runtime", () => {
  const db = createTestDatabase();
  incident(db, "inc_800m", { lat: north(800) });

  expect(findCandidates(db, observation()).candidates).toEqual([]);

  writeSetting(db, "correlation", { ...DEFAULT_CORRELATION_CONFIG, radiusMeters: 1000 });
  const config = correlationConfig(db);
  expect(config.get().radiusMeters).toBe(1000);
  expect(findCandidates(db, observation(), config.get()).candidates.map((c) => c.id)).toEqual([
    "inc_800m",
  ]);
  db.close();
});
