import { expect, test } from "bun:test";
import { enqueue, listJobs, upsertObservation } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { createPriorityMapper, createTaxonomy, seedTaxonomy } from "@scantron/event-taxonomy";
import { observationToRow, type Observation } from "@scantron/incident-schema";
import { createAppMetrics, createLogger } from "@scantron/observability";

import {
  createNormalizeHandler,
  normalizeObservation,
  renormalizeRange,
} from "../src/handlers/normalize.ts";

function harness() {
  const db = createTestDatabase();
  seedTaxonomy(db);
  return {
    db,
    taxonomy: createTaxonomy(db),
    priorities: createPriorityMapper(),
    metrics: createAppMetrics(),
    log: createLogger({ sink: () => {}, level: "debug" }),
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "1",
    occurredAt: new Date("2026-09-18T01:00:00.000Z"),
    ingestedAt: new Date("2026-09-18T01:30:00.000Z"),
    rawType: "219",
    subtype: "STABBING",
    priority: "A",
    confidence: 0.6,
    ...overrides,
  };
}

function insert(db: ReturnType<typeof createTestDatabase>, obs: Observation): void {
  upsertObservation(db, observationToRow(obs));
}

test("classification writes the normalized reading and keeps the raw one", () => {
  const h = harness();
  insert(h.db, observation());

  normalizeObservation(h, "obs_1");

  const row = h.db.query<Record<string, unknown>, []>("SELECT * FROM observations").get();
  expect(row?.type).toBe("assault");
  expect(row?.severity).toBe("critical");
  expect(row?.type_confidence).toBe(0.9);
  // The agency's own words are untouched.
  expect(row?.raw_type).toBe("219");
  expect(row?.subtype).toBe("STABBING");
  expect(row?.normalized_at).toBeTruthy();
  h.db.close();
});

test("priority letters and numbers land on one comparable scale", () => {
  const h = harness();
  const rank = (source: string, code: string) => h.priorities.rank(source, code);

  expect(rank("sf_police_cad", "A")).toBe(1);
  expect(rank("sf_police_cad", "B")).toBe(2);
  expect(rank("sf_police_cad", "C")).toBe(4);
  // SFFD Code 3 is lights-and-sirens, so it outranks a police B.
  expect(rank("sf_fire_cad", "3")).toBe(2);
  expect(rank("sf_fire_cad", "2")).toBe(3);
  // An unmapped code stays unranked rather than landing mid-scale as an ordinary call.
  expect(rank("sf_police_cad", "Z")).toBeUndefined();
  expect(rank("chp", "A")).toBeUndefined();
  h.db.close();
});

test("an unmapped code lands as unknown and is counted", () => {
  const h = harness();
  insert(h.db, observation({ rawType: "ZZ9", subtype: "SOMETHING NEW" }));

  normalizeObservation(h, "obs_1");

  const row = h.db.query<{ type: string; type_confidence: number }, []>(
    "SELECT type, type_confidence FROM observations",
  ).get();
  expect(row?.type).toBe("unknown");
  expect(row?.type_confidence).toBe(0.2);
  expect(h.metrics.registry.render()).toContain('scantron_unmapped_codes_total{source="sf_police_cad"} 1');
  h.db.close();
});

test("unmapped codes are queryable by frequency, so mapping effort follows volume", () => {
  const h = harness();
  for (let i = 0; i < 5; i += 1) {
    insert(
      h.db,
      observation({
        id: `obs_${i}`,
        sourceRecordId: String(i),
        rawType: i < 3 ? "ZZ9" : "YY8",
        // A label that no pattern rescues, so these land as genuinely unmapped.
        subtype: "NEW CATEGORY",
      }),
    );
    normalizeObservation(h, `obs_${i}`);
  }

  const gaps = h.db
    .query<{ raw_type: string; n: number }, []>(
      `SELECT raw_type, count(*) AS n FROM observations
        WHERE type = 'unknown' GROUP BY raw_type ORDER BY n DESC`,
    )
    .all();
  expect(gaps).toEqual([
    { raw_type: "ZZ9", n: 3 },
    { raw_type: "YY8", n: 2 },
  ]);
  h.db.close();
});

test("normalization hands off to geocoding when there is a location to resolve", () => {
  const h = harness();
  insert(h.db, observation({ location: { raw: "19TH AVE \\ IRVING ST" } }));
  normalizeObservation(h, "obs_1");
  expect(listJobs(h.db).map((job) => job.type)).toContain("geocode_location");
  h.db.close();
});

test("an already-located observation goes straight to correlation", () => {
  const h = harness();
  insert(h.db, observation({ location: { latitude: 37.78, longitude: -122.41 } }));
  normalizeObservation(h, "obs_1");
  const types = listJobs(h.db).map((job) => job.type);
  expect(types).toContain("correlate_incident");
  expect(types).not.toContain("geocode_location");
  h.db.close();
});

test("re-running normalization is a no-op, and re-running it twice is too", () => {
  const h = harness();
  insert(h.db, observation());

  const first = normalizeObservation(h, "obs_1");
  const second = normalizeObservation(h, "obs_1");
  expect(first?.changed).toBe(true);
  expect(second?.changed).toBe(false);
  expect(h.db.query<{ type: string }, []>("SELECT type FROM observations").get()?.type).toBe("assault");
  h.db.close();
});

test("a taxonomy change re-normalizes in place and re-correlates live incidents", () => {
  const h = harness();
  insert(h.db, observation());
  normalizeObservation(h, "obs_1");

  h.db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, first_observed_at,
       last_updated_at, units, confidence, verification_classification)
     VALUES ('inc_1', 'assault', 'Assault', '["police"]', 'active', '2026-09-18T01:00:00.000Z',
       '2026-09-18T01:00:00.000Z', '[]', 0.5, 'reported')`,
  ).run();
  h.db.query(
    `INSERT INTO incident_observations (incident_id, observation_id, attached_at)
     VALUES ('inc_1', 'obs_1', '2026-09-18T01:00:00.000Z')`,
  ).run();

  // The operator decides 219 should be `weapon`, not `assault`.
  seedTaxonomy(h.db, [
    {
      version: "test.2",
      source: "sf_police_cad",
      mappings: [{ rawCode: "219", normalizedType: "weapon", typeConfidence: 0.95 }],
    },
  ]);
  h.taxonomy.reload();

  const result = renormalizeRange(h, { source: "sf_police_cad" });
  expect(result).toMatchObject({ examined: 1, changed: 1, recorrelated: 1 });
  expect(h.db.query<{ type: string }, []>("SELECT type FROM observations").get()?.type).toBe("weapon");

  const recorrelation = listJobs(h.db).filter(
    (job) => job.type === "correlate_incident" && job.dedupeKey?.endsWith(":taxonomy"),
  );
  expect(recorrelation).toHaveLength(1);
  h.db.close();
});

test("a resolved incident is not re-correlated by a taxonomy change", () => {
  const h = harness();
  insert(h.db, observation());
  normalizeObservation(h, "obs_1");
  h.db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, first_observed_at,
       last_updated_at, units, confidence, verification_classification)
     VALUES ('inc_old', 'assault', 'Assault', '["police"]', 'resolved', '2026-09-18T01:00:00.000Z',
       '2026-09-18T01:00:00.000Z', '[]', 0.5, 'reported')`,
  ).run();
  h.db.query(
    `INSERT INTO incident_observations (incident_id, observation_id, attached_at)
     VALUES ('inc_old', 'obs_1', '2026-09-18T01:00:00.000Z')`,
  ).run();

  seedTaxonomy(h.db, [
    {
      version: "test.2",
      source: "sf_police_cad",
      mappings: [{ rawCode: "219", normalizedType: "weapon", typeConfidence: 0.95 }],
    },
  ]);
  h.taxonomy.reload();

  expect(renormalizeRange(h, {}).recorrelated).toBe(0);
  h.db.close();
});

test("the backfill respects a date range", () => {
  const h = harness();
  insert(h.db, observation({ id: "old", sourceRecordId: "old", occurredAt: new Date("2026-09-01T00:00:00.000Z") }));
  insert(h.db, observation({ id: "new", sourceRecordId: "new", occurredAt: new Date("2026-09-18T00:00:00.000Z") }));

  const result = renormalizeRange(h, { from: "2026-09-10T00:00:00.000Z" });
  expect(result.examined).toBe(1);
  h.db.close();
});

test("the handler tolerates an observation that no longer exists", () => {
  const h = harness();
  const handler = createNormalizeHandler(h);
  enqueue(h.db, { type: "normalize_observation", payload: { observationId: "gone" } });
  expect(() =>
    handler({
      id: "job_1",
      type: "normalize_observation",
      payload: { observationId: "gone" },
      status: "running",
      runAfter: new Date(),
      attempts: 1,
      maxAttempts: 5,
    }),
  ).not.toThrow();
  h.db.close();
});
