import { expect, test } from "bun:test";
import { attachUnitsToIncident, knownUnits, recordUnits, unitsForIncident } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

const seenAt = new Date("2026-09-18T01:00:00.000Z");

function withIncident(db: ReturnType<typeof createTestDatabase>): void {
  db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, first_observed_at,
       last_updated_at, units, confidence, verification_classification)
     VALUES ('inc_1', 'fire', 'Fire', '["fire"]', 'active', '2026-09-18T01:00:00.000Z',
       '2026-09-18T01:00:00.000Z', '[]', 0.5, 'reported')`,
  ).run();
}

test("units are registered once, with first and last sighting", () => {
  const db = createTestDatabase();
  recordUnits(db, ["E07", "T07"], seenAt, { source: "sf_fire_cad" });
  recordUnits(db, ["E07"], new Date("2026-09-18T03:00:00.000Z"), { source: "sf_fire_cad" });

  const units = knownUnits(db);
  expect(units.map((unit) => unit.designator)).toEqual(["E07", "T07"]);
  expect(units[0]?.kind).toBe("engine");
  expect(units[0]?.first_seen_at).toBe("2026-09-18T01:00:00.000Z");
  expect(units[0]?.last_seen_at).toBe("2026-09-18T03:00:00.000Z");
  db.close();
});

test("a later parse can upgrade an unknown class but never downgrade a known one", () => {
  const db = createTestDatabase();
  recordUnits(db, ["ZQ9"], seenAt);
  expect(knownUnits(db)[0]?.kind).toBe("unknown");

  recordUnits(db, ["ZQ9"], seenAt, { unitTypes: { ZQ9: "MEDIC" } });
  expect(knownUnits(db)[0]?.kind).toBe("medic");

  // An ambiguous later sighting does not undo that.
  recordUnits(db, ["ZQ9"], seenAt);
  expect(knownUnits(db)[0]?.kind).toBe("medic");
  db.close();
});

test("a unit on several observations of one incident is recorded once", () => {
  const db = createTestDatabase();
  withIncident(db);
  recordUnits(db, ["E07", "M18"], seenAt);

  attachUnitsToIncident(db, "inc_1", ["E07"], seenAt);
  attachUnitsToIncident(db, "inc_1", ["E07", "M18"], new Date("2026-09-18T01:30:00.000Z"));

  const units = unitsForIncident(db, "inc_1");
  expect(units.map((unit) => unit.designator)).toEqual(["E07", "M18"]);
  // The earliest sighting is the one that is kept.
  expect(units[0]?.first_seen_at).toBe("2026-09-18T01:00:00.000Z");
  expect(units[0]?.last_seen_at).toBe("2026-09-18T01:30:00.000Z");
  db.close();
});
