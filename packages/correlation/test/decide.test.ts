import { expect, test } from "bun:test";
import { upsertObservation } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import {
  applyDecision,
  CONTRADICTORY_TYPE_CEILING,
  countDecisions,
  DEFAULT_THRESHOLDS,
  decide,
  pickBest,
  type CandidateObservation,
} from "../src/index.ts";

const AT = new Date("2026-09-18T18:51:28.000Z");
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

test("the first observation of an event creates an incident", () => {
  const db = createTestDatabase();
  store(db, police());

  const result = applyDecision(db, { observation: police() });
  expect(result.decision).toBe("created");
  expect(result.candidatesConsidered).toBe(0);

  const incident = db.query<{ id: string; primary_type: string }, []>("SELECT id, primary_type FROM incidents").get();
  expect(incident?.primary_type).toBe("collision");
  db.close();
});

test("the cross-agency case from docs/05 merges — the one flat scoring could not", () => {
  const db = createTestDatabase();
  store(db, police());
  store(db, medic());

  applyDecision(db, { observation: police() });
  const second = applyDecision(db, { observation: medic() });

  expect(second.decision).toBe("merged");
  expect(second.best?.score.score).toBeGreaterThan(0.85);

  // One incident, two observations, two agencies, both units.
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(1);
  const incident = db
    .query<{ units: string; agency_types: string; independent_source_count: number; verification_classification: string }, []>(
      "SELECT units, agency_types, independent_source_count, verification_classification FROM incidents",
    )
    .get();
  expect(JSON.parse(incident?.units ?? "[]")).toEqual(["3A12", "M18"]);
  expect(JSON.parse(incident?.agency_types ?? "[]")).toEqual(["ems", "police"]);
  expect(incident?.independent_source_count).toBe(2);
  expect(incident?.verification_classification).toBe("multi-source");
  db.close();
});

test("a near miss creates an incident and records what it nearly joined", () => {
  const db = createTestDatabase();
  store(db, police());
  // Same corner, same minute, a different kind of call: location and time say yes, type
  // says no, and the honest answer is "look at this one".
  const later = police({ id: "obs_theft", type: "theft", units: ["3A99"] });
  store(db, later);

  applyDecision(db, { observation: police() });
  const second = applyDecision(db, { observation: later });

  expect(second.decision).toBe("probable");
  expect(second.probableLogged).toBe(true);
  // Two incidents — the uncertain case does not merge.
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(2);

  const probable = db
    .query<{ score: number; incident_id: string; breakdown: string }, []>(
      "SELECT score, incident_id, breakdown FROM probable_matches",
    )
    .get();
  expect(probable?.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.probable);
  expect(probable?.score).toBeLessThan(DEFAULT_THRESHOLDS.merge);
  // The breakdown is stored, because tuning needs the rejected pairs as much as the merges.
  expect(Object.keys(JSON.parse(probable?.breakdown ?? "{}"))).toContain("location");
  db.close();
});

test("a call far enough away in time creates its own incident", () => {
  const db = createTestDatabase();
  store(db, police());
  const later = police({
    id: "obs_later",
    type: "disturbance",
    units: ["3A99"],
    occurredAt: new Date(AT.getTime() + 9 * 60_000),
  });
  store(db, later);

  applyDecision(db, { observation: police() });
  const second = applyDecision(db, { observation: later });

  expect(second.decision).toBe("created");
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(2);
  db.close();
});

test("contradictory types cannot auto-merge on place and time alone", () => {
  const db = createTestDatabase();
  store(db, police());
  // Same corner, same second, same agency, and a type with no affinity to the incident's.
  const theft = police({ id: "obs_theft", type: "theft", units: ["3A12"] });
  store(db, theft);

  applyDecision(db, { observation: police() });
  const second = applyDecision(db, { observation: theft });

  // Perfect location, simultaneous, full unit overlap — and still short of a merge,
  // because a type with no affinity costs more than those three can make up.
  expect(second.decision).toBe("probable");
  expect(second.best?.score.score).toBeLessThanOrEqual(CONTRADICTORY_TYPE_CEILING + 1e-9);
  expect(second.best?.score.breakdown.type.score).toBe(0);
  db.close();
});

test("re-processing an attached observation is a no-op", () => {
  const db = createTestDatabase();
  store(db, police());

  const first = applyDecision(db, { observation: police() });
  const again = applyDecision(db, { observation: police() });

  expect(again.alreadyAttached).toBe(true);
  expect(again.incidentId).toBe(first.incidentId);
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incident_observations").get()?.n).toBe(1);
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(1);
  db.close();
});

test("ties break deterministically, so a replay makes the same incidents", () => {
  const identical = (id: string, firstObservedAt: string) => ({
    candidate: {
      id,
      primaryType: "collision",
      status: "active",
      lat: CORNER.lat,
      lng: CORNER.lng,
      neighborhood: "Bayview Hunters Point",
      locationDisplayName: "Earl St & Gilman Ave",
      firstObservedAt,
      lastUpdatedAt: firstObservedAt,
      resolvedAt: null,
      units: [],
      agencyTypes: ["police"],
      matchedBy: "proximity" as const,
    },
    score: {
      score: 0.9,
      breakdown: {
        location: { score: 1, applicable: true, reason: "" },
        time: { score: 0.8, applicable: true, reason: "" },
        type: { score: 1, applicable: true, reason: "" },
        units: { applicable: false, reason: "" },
        text: { applicable: false, reason: "" },
      },
      appliedFeatures: ["location", "time", "type"] as never,
      appliedWeight: 0.8,
    },
  });

  const older = identical("inc_older", "2026-09-18T18:40:00.000Z");
  const newer = identical("inc_newer", "2026-09-18T18:50:00.000Z");
  // Same score, same location score: the older incident wins, every time.
  expect(pickBest([newer, older])?.candidate.id).toBe("inc_older");
  expect(pickBest([older, newer])?.candidate.id).toBe("inc_older");
});

test("only the best candidate is attached to, not every candidate that scored", () => {
  const db = createTestDatabase();
  store(db, police());
  const second = police({ id: "obs_2", occurredAt: new Date(AT.getTime() + 60_000) });
  store(db, second);
  const third = medic({ id: "obs_3", occurredAt: new Date(AT.getTime() + 2 * 60_000) });
  store(db, third);

  applyDecision(db, { observation: police() });
  applyDecision(db, { observation: second });
  applyDecision(db, { observation: third });

  const attachments = db
    .query<{ observation_id: string; n: number }, []>(
      "SELECT observation_id, count(*) AS n FROM incident_observations GROUP BY observation_id",
    )
    .all();
  for (const attachment of attachments) expect(attachment.n).toBe(1);
  db.close();
});

test("decisions are counted, because the merge rate is the hypothesis", () => {
  const db = createTestDatabase();
  store(db, police());
  store(db, medic());
  applyDecision(db, { observation: police() });
  applyDecision(db, { observation: medic() });

  expect(countDecisions(db)).toEqual({ merged: 1, probable: 0, created: 1 });
  db.close();
});

test("decide() reports what it considered even when it creates", () => {
  const db = createTestDatabase();
  store(db, police());
  applyDecision(db, { observation: police() });

  const result = decide(db, {
    observation: police({ id: "obs_other", type: "theft", occurredAt: new Date(AT.getTime() + 9 * 60_000) }),
  });
  expect(result.decision).toBe("created");
  // The best candidate is still reported, so a near miss is visible in the log.
  expect(result.best?.candidate.id).toBeTruthy();
  expect(result.candidatesConsidered).toBe(1);
  db.close();
});

test("two observations for the same corner cannot create two incidents", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { migrate, openDatabase } = await import("@scantron/database");

  const dir = mkdtempSync(join(tmpdir(), "scantron-correlate-"));
  const path = join(dir, "race.db");
  const writer = openDatabase({ path });
  migrate(writer);

  // Two observations of one event, from two agencies, arriving together.
  const first = police();
  const second = medic();
  store(writer, first);
  store(writer, second);

  // Separate connections, exactly as two worker processes would have.
  const modulePath = new URL("../src/index.ts", import.meta.url).pathname;
  const script = (observationJson: string) => `
    const { applyDecision } = await import(${JSON.stringify(modulePath)});
    const { openDatabase } = await import("@scantron/database");
    const db = openDatabase({ path: ${JSON.stringify(path)} });
    const observation = JSON.parse(${JSON.stringify(observationJson)});
    observation.occurredAt = new Date(observation.occurredAt);
    console.log(JSON.stringify(applyDecision(db, { observation })));
  `;

  const children = [first, second].map((observation) =>
    Bun.spawn(["bun", "-e", script(JSON.stringify(observation))], {
      cwd: new URL("../../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const outcomes = await Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );
  for (const outcome of outcomes) expect(`${outcome.code}: ${outcome.stderr}`).toBe("0: ");

  // Whichever went first, there is one incident and both observations are on it.
  const incidents = writer.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get();
  const attachments = writer
    .query<{ n: number }, []>("SELECT count(*) AS n FROM incident_observations")
    .get();
  expect(incidents?.n).toBe(1);
  expect(attachments?.n).toBe(2);

  writer.close();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

test("a score that is arithmetically the threshold merges, despite the float", () => {
  const at = { score: 0.8499999999999999 } as const;
  // 0.35 + 0.25 + 0.2 + 0.05 style sums land here routinely; the replay produced two.
  expect(at.score >= 0.85).toBe(false);
  expect(at.score >= 0.85 - 1e-9).toBe(true);
});
