import { expect, test } from "bun:test";
import { migrate, openDatabase, IN_MEMORY, upsertObservation } from "@scantron/database";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import {
  applyDecision,
  applyDecisionJudged,
  applyVerdict,
  buildJudgeRequest,
  judgePair,
  JUDGE_CONFIDENCE_GATE,
  JUDGE_MERGE_LEVEL,
  SAME_EVENT_LEVELS,
  type CandidateObservation,
  type IncidentCandidate,
  type JudgeClient,
  type JudgeResponse,
} from "../src/index.ts";

const AT = new Date("2026-09-18T18:51:28.000Z");
const CORNER = { lat: 37.7292, lng: -122.3957 };

const observation = (overrides: Partial<CandidateObservation> = {}): CandidateObservation => ({
  id: "obs_police",
  source: "sf_police_cad",
  occurredAt: AT,
  lat: CORNER.lat,
  lng: CORNER.lng,
  neighborhood: "Bayview Hunters Point",
  type: "disturbance",
  rawType: "FIGHT NO WEAPON",
  locationCanonical: "Earl St & Gilman Ave",
  units: ["3A12"],
  ...overrides,
});

const candidate = (overrides: Partial<IncidentCandidate> = {}): IncidentCandidate => ({
  id: "inc_1",
  primaryType: "medical",
  rawType: "Medical Incident",
  status: "active",
  lat: CORNER.lat,
  lng: CORNER.lng,
  neighborhood: "Bayview Hunters Point",
  locationDisplayName: "Earl St & Gilman Ave",
  firstObservedAt: new Date(AT.getTime() - 6 * 60_000).toISOString(),
  lastObservedAt: new Date(AT.getTime() - 6 * 60_000).toISOString(),
  lastUpdatedAt: new Date(AT.getTime() - 6 * 60_000).toISOString(),
  resolvedAt: null,
  units: ["M18"],
  agencyTypes: ["ems"],
  matchedBy: "proximity",
  distanceMeters: 0,
  ...overrides,
});

function stubJudge(score: number, confidence: number): JudgeClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    available: true,
    async ask(request): Promise<JudgeResponse> {
      requests.push(request);
      return {
        model: "jev-test",
        answers: { same_event: { type: "score", score, confidence } },
        usage: { input_tokens: 400, cost: 0.00002 },
      };
    },
  };
}

test("the judge is shown what a published record shows, and nothing else", () => {
  const request = buildJudgeRequest(observation(), candidate());
  const serialized = JSON.stringify(request.state);

  expect(serialized).toContain("FIGHT NO WEAPON");
  expect(serialized).toContain("Medical Incident");
  expect(serialized).toContain("minutes_apart");
  // No identifiers, no free text, no internal ids.
  expect(serialized).not.toContain("obs_police");
  expect(serialized).not.toContain("inc_1");
  expect(serialized).not.toContain("source_record");

  // One typed question, so prose is not in its output alphabet.
  expect(Object.keys(request.questions)).toEqual(["same_event"]);
  expect(request.questions.same_event?.criteria).toEqual(SAME_EVENT_LEVELS);
});

test("an unsure judge is ignored — measured: the wrong answers came back unconfident", () => {
  const sure = applyVerdict("probable", {
    sameEvent: 2.9,
    confidence: 0.7,
    label: "",
    actionable: true,
    latencyMs: 1,
  });
  expect(sure.decision).toBe("merged");

  // Score high, confidence low: exactly the shape of the wrong answers in the sweep.
  const unsure = applyVerdict("probable", {
    sameEvent: 2.85,
    confidence: 0.37,
    label: "",
    actionable: false,
    latencyMs: 1,
  });
  expect(unsure.decision).toBe("probable");
  expect(JUDGE_CONFIDENCE_GATE).toBe(0.6);
  expect(JUDGE_MERGE_LEVEL).toBe(2.4);
});

test("the judge may not overturn a decision the scorer was confident about", () => {
  const confident = { sameEvent: 0, confidence: 0.99, label: "", actionable: true, latencyMs: 1 };
  // It is only consulted in the probable band, and only moves within it.
  expect(applyVerdict("merged", confident).decision).toBe("merged");
  expect(applyVerdict("created", { ...confident, sameEvent: 4 }).decision).toBe("created");
});

test("a confident 'different' pushes a probable pair to its own incident", () => {
  const verdict = { sameEvent: 0.9, confidence: 0.8, label: "", actionable: true, latencyMs: 1 };
  expect(applyVerdict("probable", verdict).decision).toBe("created");
});

function seed(db: ReturnType<typeof openDatabase>, obs: CandidateObservation): void {
  upsertObservation(
    db,
    observationToRow({
      id: obs.id,
      source: obs.source as Observation["source"],
      sourceRecordId: obs.id,
      occurredAt: obs.occurredAt,
      ingestedAt: obs.occurredAt,
      confidence: 0.6,
      ...(obs.type ? { type: obs.type as Observation["type"] } : {}),
      ...(obs.rawType ? { rawType: obs.rawType } : {}),
      ...(obs.units ? { units: obs.units } : {}),
      location: {
        ...(obs.lat === undefined ? {} : { latitude: obs.lat }),
        ...(obs.lng === undefined ? {} : { longitude: obs.lng }),
        ...(obs.neighborhood ? { neighborhood: obs.neighborhood } : {}),
        ...(obs.locationCanonical ? { normalized: obs.locationCanonical } : {}),
      },
    } as Observation),
  );
}

function withPair() {
  const db = openDatabase({ path: IN_MEMORY });
  migrate(db);
  const medic = observation({
    id: "obs_medic",
    source: "sf_ems_cad",
    type: "medical",
    rawType: "Medical Incident",
    units: ["M18"],
    occurredAt: new Date(AT.getTime() - 6 * 60_000),
  });
  const police = observation();
  seed(db, medic);
  seed(db, police);
  applyDecision(db, { observation: medic, title: "Medical Incident" });
  return { db, police };
}

test("a confident judge promotes a probable pair, and says it did", async () => {
  const { db, police } = withPair();
  const judge = stubJudge(2.9, 0.7);

  const result = await applyDecisionJudged(db, { observation: police, judge });
  expect(result.decision).toBe("merged");
  expect(result.judgedBy).toContain("judge:");
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(1);
  expect(judge.requests).toHaveLength(1);
  db.close();
});

test("with no judge available, the decision is exactly what it would have been", async () => {
  const { db, police } = withPair();
  const offline: JudgeClient = { available: false, ask: async () => undefined };

  const judged = await applyDecisionJudged(db, { observation: police, judge: offline });
  expect(judged.decision).toBe("probable");
  expect(judged.judgedBy).toBeUndefined();
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(2);
  db.close();
});

test("a judge that fails leaves the scorer's decision standing", async () => {
  const { db, police } = withPair();
  const broken: JudgeClient = { available: true, ask: async () => undefined };

  const result = await applyDecisionJudged(db, { observation: police, judge: broken });
  expect(result.decision).toBe("probable");
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n).toBe(2);
  db.close();
});

test("judgePair reports the ladder label and what it cost", async () => {
  const verdict = await judgePair(stubJudge(2.7, 0.65), observation(), candidate());
  expect(verdict?.label).toBe(SAME_EVENT_LEVELS[3]);
  expect(verdict?.actionable).toBe(true);
  expect(verdict?.costUsd).toBe(0.00002);
  expect(verdict?.model).toBe("jev-test");
});
