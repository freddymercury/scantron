import { expect, test } from "bun:test";
import {
  observationToRow,
  rowToObservation,
  type ObservationRow,
} from "@scantron/incident-schema";
import { createTestDatabase } from "../src/testing.ts";
import { neighborhoodRows, replaceNeighborhoods, upsertObservation } from "../src/index.ts";

const PRD_37_TABLES = [
  "observations",
  "incidents",
  "incident_observations",
  "timeline_events",
  "locations",
  "units",
  "incident_units",
  "source_records",
  "transcripts",
  "event_taxonomy",
  "source_configuration",
  "neighborhoods",
];

function tables(db: ReturnType<typeof createTestDatabase>): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

const anObservationRow = (overrides: Partial<ObservationRow> = {}): ObservationRow => ({
  ...observationToRow({
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "260918001",
    occurredAt: new Date("2026-09-18T01:02:03.000Z"),
    ingestedAt: new Date("2026-09-18T01:39:00.000Z"),
    type: "collision",
    location: { latitude: 37.7817, longitude: -122.4103, neighborhood: "Tenderloin" },
    units: ["3A12"],
    confidence: 0.8,
  }),
  ...overrides,
});

function insertObservation(
  db: ReturnType<typeof createTestDatabase>,
  row: ObservationRow,
): void {
  const columns = Object.keys(row);
  db.query(
    `INSERT INTO observations (${columns.join(", ")}) VALUES (${columns.map((c) => `$${c}`).join(", ")})`,
  ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])) as never);
}

test("the migration creates every table PRD §37 asks for", () => {
  const db = createTestDatabase();
  const present = tables(db);
  for (const table of PRD_37_TABLES) expect(present).toContain(table);
  db.close();
});

test("all tables are STRICT, so declared types are enforced", () => {
  const db = createTestDatabase();
  const definitions = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL",
    )
    .all();
  for (const { name, sql } of definitions) {
    expect(`${name}: ${sql.includes("STRICT")}`).toBe(`${name}: true`);
  }
  db.close();
});

test("(source, source_record_id) is the idempotency key", () => {
  const db = createTestDatabase();
  insertObservation(db, anObservationRow());
  expect(() => insertObservation(db, anObservationRow({ id: "obs_2" }))).toThrow();
  // A different source with the same record id is a different observation.
  insertObservation(db, anObservationRow({ id: "obs_3", source: "sf_fire_cad" }));
  expect(db.query("SELECT count(*) AS n FROM observations").get()).toEqual({ n: 2 });
  db.close();
});

test("an observation row survives a round trip through the database", () => {
  const db = createTestDatabase();
  const row = anObservationRow();
  insertObservation(db, row);
  const stored = db.query<ObservationRow, []>("SELECT * FROM observations").get();
  expect(stored).toEqual(row);
  expect(rowToObservation(stored as ObservationRow).location?.neighborhood).toBe("Tenderloin");
  db.close();
});

test("CHECK constraints reject values outside the documented vocabularies", () => {
  const db = createTestDatabase();
  expect(() => insertObservation(db, anObservationRow({ source: "twitter" }))).toThrow();
  expect(() => insertObservation(db, anObservationRow({ confidence: 1.5 }))).toThrow();
  expect(() => insertObservation(db, anObservationRow({ visibility: "maybe" }))).toThrow();
  expect(() => insertObservation(db, anObservationRow({ sensitive: 2 }))).toThrow();
  db.close();
});

test("a timeline event cannot exist without its source observation", () => {
  const db = createTestDatabase();
  insertObservation(db, anObservationRow());
  db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, first_observed_at,
       last_updated_at, units, confidence, verification_classification)
     VALUES ('inc_1', 'collision', 'Collision', '["police"]', 'active', '2026-09-18T01:02:03.000Z',
       '2026-09-18T01:02:03.000Z', '[]', 0.5, 'reported')`,
  ).run();

  const insertEvent = (observationId: string) =>
    db
      .query(
        `INSERT INTO timeline_events (id, incident_id, occurred_at, recorded_at, kind, text, observation_id)
         VALUES (?, 'inc_1', '2026-09-18T01:02:03.000Z', '2026-09-18T01:39:00.000Z', 'initial_report', 'Initial report', ?)`,
      )
      .run(`tl_${observationId}`, observationId);

  expect(() => insertEvent("obs_does_not_exist")).toThrow();
  insertEvent("obs_1");
  // S-D5: reprocessing the same observation must not duplicate the entry.
  expect(() =>
    db
      .query(
        `INSERT INTO timeline_events (id, incident_id, occurred_at, recorded_at, kind, text, observation_id)
         VALUES ('tl_dup', 'inc_1', '2026-09-18T01:02:03.000Z', '2026-09-18T01:39:00.000Z', 'initial_report', 'Initial report', 'obs_1')`,
      )
      .run(),
  ).toThrow();
  db.close();
});

test("an incident cannot be merged into itself", () => {
  const db = createTestDatabase();
  expect(() =>
    db
      .query(
        `INSERT INTO incidents (id, primary_type, title, agency_types, status, first_observed_at,
           last_updated_at, units, confidence, verification_classification, merged_into_id)
         VALUES ('inc_1', 'fire', 'Fire', '["fire"]', 'active', '2026-09-18T01:02:03.000Z',
           '2026-09-18T01:02:03.000Z', '[]', 0.5, 'reported', 'inc_1')`,
      )
      .run(),
  ).toThrow();
  db.close();
});

test("candidate retrieval uses the (occurred_at, lat, lng) index", () => {
  const db = createTestDatabase();
  const plan = db
    .query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN
       SELECT id FROM observations
        WHERE occurred_at BETWEEN '2026-09-18T00:00:00.000Z' AND '2026-09-18T01:00:00.000Z'
          AND lat BETWEEN 37.77 AND 37.79
          AND lng BETWEEN -122.42 AND -122.40`,
    )
    .all()
    .map((row) => row.detail)
    .join(" ");
  // ADR-003 measured 10.039 ms → 0.009 ms on this index, and covering is why.
  expect(plan).toContain("observations_time_loc_idx");
  expect(plan).toContain("COVERING INDEX");
  db.close();
});

test("the active-incident feed query uses the partial index", () => {
  const db = createTestDatabase();
  const plan = db
    .query<{ detail: string }, []>(
      `EXPLAIN QUERY PLAN
       SELECT id FROM incidents
        WHERE status <> 'resolved' AND merged_into_id IS NULL
        ORDER BY last_updated_at DESC`,
    )
    .all()
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("incidents_active_idx");
  db.close();
});

test("loading neighborhoods twice replaces rather than duplicates", () => {
  const db = createTestDatabase();
  const row = {
    name: "Tenderloin",
    geometry: JSON.stringify({ type: "Polygon", coordinates: [] }),
    min_lat: 37.78,
    min_lng: -122.42,
    max_lat: 37.79,
    max_lng: -122.4,
    source: "ajp5-b2md",
    loaded_at: "2026-09-18T00:00:00.000Z",
  };
  replaceNeighborhoods(db, [row]);
  replaceNeighborhoods(db, [{ ...row, loaded_at: "2026-09-19T00:00:00.000Z" }]);

  const rows = neighborhoodRows(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.loaded_at).toBe("2026-09-19T00:00:00.000Z");
  db.close();
});

test("a re-poll of an unchanged record does not wipe what normalization added", () => {
  const db = createTestDatabase();
  insertObservation(db, anObservationRow());

  // Normalization and geocoding fill in their own columns.
  db.query(
    `UPDATE observations
        SET type = 'collision', type_confidence = 0.9, location_normalized = '19th Ave & Irving St',
            location_method = 'source_coordinates', normalized_at = '2026-09-18T02:00:00.000Z'
      WHERE id = 'obs_1'`,
  ).run();

  // The next poll re-reads the same source record, which knows nothing about any of that.
  const outcome = upsertObservation(db, anObservationRow({ id: "obs_ignored" }));

  expect(outcome).toBe("unchanged");
  const stored = db
    .query<{ type: string; location_normalized: string; location_method: string }, []>(
      "SELECT type, location_normalized, location_method FROM observations",
    )
    .get();
  expect(stored?.type).toBe("collision");
  expect(stored?.location_normalized).toBe("19th Ave & Irving St");
  expect(stored?.location_method).toBe("source_coordinates");
  db.close();
});

test("a genuine source change still updates, without touching derived columns", () => {
  const db = createTestDatabase();
  insertObservation(db, anObservationRow());
  db.query("UPDATE observations SET type = 'collision', location_method = 'intersection_lookup'").run();

  const outcome = upsertObservation(db, anObservationRow({ raw_type: "216", subtype: "SHOTS FIRED" }));

  expect(outcome).toBe("updated");
  const stored = db
    .query<{ raw_type: string; type: string; location_method: string }, []>(
      "SELECT raw_type, type, location_method FROM observations",
    )
    .get();
  expect(stored?.raw_type).toBe("216");
  // The new type is normalization's job, not ingest's — it is re-enqueued, not guessed.
  expect(stored?.type).toBe("collision");
  expect(stored?.location_method).toBe("intersection_lookup");
  db.close();
});

test("a later poll may add a point it previously lacked, but never blanks one", () => {
  const db = createTestDatabase();
  insertObservation(db, anObservationRow({ lat: null, lng: null }));

  expect(upsertObservation(db, anObservationRow({ lat: 37.78, lng: -122.41 }))).toBe("updated");
  expect(db.query<{ lat: number }, []>("SELECT lat FROM observations").get()?.lat).toBe(37.78);

  // The feed drops the point on a later poll; ours stays.
  expect(upsertObservation(db, anObservationRow({ lat: null, lng: null }))).toBe("unchanged");
  expect(db.query<{ lat: number }, []>("SELECT lat FROM observations").get()?.lat).toBe(37.78);
  db.close();
});
