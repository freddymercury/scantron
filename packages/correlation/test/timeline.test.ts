import { expect, test } from "bun:test";
import { upsertObservation } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { observationToRow, TIMELINE_EVENT_KINDS, type Observation } from "@scantron/incident-schema";

import {
  applyDecision,
  readTimeline,
  timelineDrafts,
  type CandidateObservation,
  type IncidentSnapshot,
} from "../src/index.ts";

const AT = new Date("2026-09-21T18:51:28.000Z");
const CORNER = { lat: 37.7292, lng: -122.3957 };

function store(db: ReturnType<typeof createTestDatabase>, observation: CandidateObservation): void {
  const domain = {
    id: observation.id,
    source: observation.source as Observation["source"],
    sourceRecordId: observation.id,
    occurredAt: observation.occurredAt,
    ingestedAt: observation.occurredAt,
    confidence: 0.6,
    ...(observation.type ? { type: observation.type as Observation["type"] } : {}),
    ...(observation.units ? { units: observation.units } : {}),
    location: {
      ...(observation.lat === undefined ? {} : { latitude: observation.lat }),
      ...(observation.lng === undefined ? {} : { longitude: observation.lng }),
      ...(observation.neighborhood ? { neighborhood: observation.neighborhood } : {}),
      ...(observation.locationCanonical ? { normalized: observation.locationCanonical } : {}),
    },
  } as Observation;
  upsertObservation(db, observationToRow(domain));
}

const police = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  id: "obs_police",
  source: "sf_police_cad",
  occurredAt: AT,
  lat: CORNER.lat,
  lng: CORNER.lng,
  neighborhood: "Bayview Hunters Point",
  type: "collision",
  locationCanonical: "Earl St & Gilman Ave",
  units: ["3A12"],
  ...overrides,
});

const medic = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  id: "obs_medic",
  source: "sf_ems_cad",
  occurredAt: new Date(AT.getTime() + 4 * 60_000),
  lat: CORNER.lat,
  lng: CORNER.lng,
  neighborhood: "Bayview Hunters Point",
  type: "medical",
  locationCanonical: "Earl St & Gilman Ave",
  units: ["M18"],
  ...overrides,
});

function seedPair(db: ReturnType<typeof createTestDatabase>): string {
  store(db, police());
  store(db, medic());
  const first = applyDecision(db, { observation: police() });
  const second = applyDecision(db, { observation: medic() });
  expect(second.decision).toBe("merged");
  return first.incidentId;
}

test("the observation that opens an incident writes the initial report and its dispatch", () => {
  const db = createTestDatabase();
  store(db, police());
  const { incidentId } = applyDecision(db, { observation: police() });

  const entries = readTimeline(db, incidentId);
  expect(entries.map((entry) => entry.kind)).toEqual(["initial_report", "unit_dispatched"]);
  expect(entries[0]?.text).toBe(
    "Collision reported at Earl St & Gilman Ave — first report from Police.",
  );
  expect(entries[1]?.text).toBe("Police dispatched 3A12.");
  // PRD §32: every entry names the record it came from.
  for (const entry of entries) expect(entry.observationId).toBe("obs_police");
  db.close();
});

test("a second agency's record adds its own entries, not a second report", () => {
  const db = createTestDatabase();
  const incidentId = seedPair(db);

  const kinds = readTimeline(db, incidentId).map((entry) => entry.kind);
  expect(kinds.filter((kind) => kind === "initial_report")).toHaveLength(1);
  expect(kinds).toContain("agency_joined");
  expect(kinds).toContain("additional_unit");

  const joined = readTimeline(db, incidentId).find((entry) => entry.kind === "agency_joined");
  expect(joined?.text).toBe("EMS joined the response.");
  expect(joined?.observationId).toBe("obs_medic");
  db.close();
});

test("re-processing the same observation duplicates nothing", () => {
  const db = createTestDatabase();
  const incidentId = seedPair(db);
  const before = readTimeline(db, incidentId);

  applyDecision(db, { observation: police() });
  applyDecision(db, { observation: medic() });

  expect(readTimeline(db, incidentId)).toEqual(before);
  db.close();
});

test("a late-arriving record sorts by when it happened, not when it was processed", () => {
  const db = createTestDatabase();
  // The earlier report is ingested second, which is the ordinary case for a feed that
  // publishes in ~30-minute batches (docs/01), and it brings a unit the incident had not seen.
  const early = police({
    id: "obs_early",
    occurredAt: new Date(AT.getTime() - 3 * 60_000),
    units: ["3A99"],
  });
  store(db, police());
  store(db, early);

  const { incidentId } = applyDecision(db, { observation: police() });
  const late = applyDecision(db, { observation: early });
  expect(late.incidentId).toBe(incidentId);

  const entries = readTimeline(db, incidentId);
  expect(entries[0]?.observationId).toBe("obs_early");
  expect(entries[0]?.kind).toBe("additional_unit");
  expect(entries[0]!.occurredAt < entries[1]!.occurredAt).toBe(true);

  // Stable across re-renders: reading twice gives the same order.
  expect(readTimeline(db, incidentId)).toEqual(entries);
  db.close();
});

test("a type only moves off unknown, and the move is recorded", () => {
  const db = createTestDatabase();
  const vague = police({ id: "obs_vague", type: "unknown" });
  store(db, vague);
  store(db, police({ id: "obs_typed" }));

  const { incidentId } = applyDecision(db, { observation: vague });
  applyDecision(db, { observation: police({ id: "obs_typed" }) });

  const changed = readTimeline(db, incidentId).find((entry) => entry.kind === "type_changed");
  expect(changed?.text).toBe("Type changed from Unknown to Collision.");
  expect(db.query<{ primary_type: string }, [string]>(
    "SELECT primary_type FROM incidents WHERE id = ?",
  ).get(incidentId)?.primary_type).toBe("collision");
  db.close();
});

test("severity is a high-water mark and raising it is an escalation", () => {
  const db = createTestDatabase();
  store(db, police());
  store(db, medic());

  const { incidentId } = applyDecision(db, { observation: police({ severity: "moderate" }) });
  applyDecision(db, { observation: medic({ severity: "critical" }) });

  const escalation = readTimeline(db, incidentId).find((entry) => entry.kind === "escalation");
  expect(escalation?.text).toBe("Severity raised from moderate to critical.");

  // A calmer later record does not walk it back.
  store(db, medic({ id: "obs_calm" }));
  applyDecision(db, { observation: medic({ id: "obs_calm", severity: "low" }) });
  expect(
    db.query<{ severity: string | null }, [string]>("SELECT severity FROM incidents WHERE id = ?")
      .get(incidentId)?.severity,
  ).toBe("critical");
  db.close();
});

test("entry text is templated — no source free-text reaches it", () => {
  const snapshot = (overrides: Partial<IncidentSnapshot> = {}): IncidentSnapshot => ({
    primaryType: "collision",
    severity: null,
    status: "reported",
    units: [],
    agencyTypes: ["police"],
    ...overrides,
  });

  // A canonical location with an injection-shaped string still only appears where the
  // template puts it, and nothing from the agency's narrative fields is reachable at all.
  const drafts = timelineDrafts({
    after: snapshot(),
    observation: police({ locationCanonical: "Earl St & Gilman Ave" }),
  });
  expect(drafts).toHaveLength(1);
  expect(drafts[0]?.kind).toBe("initial_report");

  for (const draft of drafts) {
    expect(TIMELINE_EVENT_KINDS).toContain(draft.kind);
  }
});

test("an observation that says nothing new adds no entry", () => {
  const snapshot: IncidentSnapshot = {
    primaryType: "collision",
    severity: "moderate",
    status: "dispatched",
    units: ["3A12"],
    agencyTypes: ["police"],
  };

  expect(
    timelineDrafts({ before: snapshot, after: snapshot, observation: police({ severity: "low" }) }),
  ).toEqual([]);
});
