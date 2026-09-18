/**
 * Jev integration, tested against a stub — the point being that search must work
 * identically whether or not the service answers.
 */

import { expect, test } from "bun:test";
import { upsertObservation } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import {
  buildSearchRequest,
  createJevClient,
  RELEVANCE_LEVELS,
  toCandidateState,
  type JevResponse,
} from "../src/ask/jev.ts";
import { applyAnswers, GATE, rerank } from "../src/ask/rerank.ts";
import { searchObservations, toMatchQuery } from "../src/ask/search.ts";

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "1",
    occurredAt: new Date("2026-09-18T01:00:00.000Z"),
    ingestedAt: new Date("2026-09-18T01:30:00.000Z"),
    type: "theft",
    rawType: "852",
    subtype: "AUTO BOOST / STRIP",
    confidence: 0.6,
    location: { normalized: "16th St & Mission St", neighborhood: "Mission" },
    ...overrides,
  } as Observation;
}

function seeded() {
  const db = createTestDatabase();
  upsertObservation(db, observationToRow(observation()));
  upsertObservation(
    db,
    observationToRow(
      observation({
        id: "obs_2",
        sourceRecordId: "2",
        type: "traffic",
        rawType: "587",
        subtype: "TRAF VIOLATION CITE",
        location: { normalized: "Mission St & 24th St", neighborhood: "Mission" },
      }),
    ),
  );
  return db;
}

test("search finds records by what the agency called them", () => {
  const db = seeded();
  const hits = searchObservations(db, "auto boost");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.row.id).toBe("obs_1");
  db.close();
});

test("a query is turned into FTS syntax rather than handed to the reader to write", () => {
  expect(toMatchQuery("car break in near the mission")).toBe('"car"* OR "break"* OR "mission"*');
  expect(toMatchQuery("?!")).toBe("");
});

test("with no key, search works and says the ranking is lexical", async () => {
  const db = seeded();
  const client = createJevClient({ apiKey: undefined });
  expect(client.available).toBe(false);

  const result = await rerank(client, "car break in", searchObservations(db, "mission"));
  expect(result.reranked).toBe(false);
  expect(result.fallbackReason).toContain("no JEV_API_KEY");
  expect(result.hits.length).toBeGreaterThan(0);
  db.close();
});

test("what Jev is shown is what a published record would show, and no more", () => {
  const db = seeded();
  const hits = searchObservations(db, "mission");
  const request = buildSearchRequest("car break in", hits.map((hit) => hit.row));
  const serialized = JSON.stringify(request);

  // One question per candidate, plus the query-level ones.
  expect(Object.keys(request.questions).filter((id) => id.startsWith("rel_"))).toHaveLength(hits.length);
  expect(request.questions.activity_kind).toBeDefined();

  // No source free-text, no raw payload, no agency record ids.
  expect(serialized).not.toContain("source_record_id");
  expect(serialized).not.toContain("location_raw");
  const candidate = toCandidateState(hits[0]?.row as never);
  expect(Object.keys(candidate).sort()).toEqual([
    "agency_code",
    "dispatch_priority",
    "id",
    "neighborhood",
    "reported_as",
    "source",
    "type",
    "units",
    "when",
    "where",
  ]);
  db.close();
});

test("a confident relevance answer reorders; an unconfident one is ignored", () => {
  const db = seeded();
  const hits = searchObservations(db, "mission");
  expect(hits).toHaveLength(2);

  const response: JevResponse = {
    model: "jev-latest",
    answers: {
      // The traffic citation is lexically first but semantically wrong.
      rel_0: { type: "score", score: 0, confidence: 0.9, probabilities: {} },
      rel_1: { type: "score", score: 4, confidence: 0.9, probabilities: {} },
    },
  };
  const ranked = applyAnswers(hits, response).sort((a, b) => b.finalScore - a.finalScore);
  expect(ranked[0]?.row.id).toBe(hits[1]?.row.id);
  expect(ranked[0]?.relevanceLabel).toBe(RELEVANCE_LEVELS[4]);

  const unsure: JevResponse = {
    model: "jev-latest",
    answers: {
      rel_0: { type: "score", score: 4, confidence: GATE.relevance - 0.01, probabilities: {} },
      rel_1: { type: "score", score: 0, confidence: 0.9, probabilities: {} },
    },
  };
  // Below the gate the answer changes nothing, rather than being half-applied.
  expect(applyAnswers(hits, unsure)[0]?.relevance).toBeUndefined();
  db.close();
});

test("a slow answer is dropped rather than waited for", async () => {
  const db = seeded();
  const fetchImpl = (async () => {
    await Bun.sleep(50);
    return new Response(JSON.stringify({ model: "jev-latest", answers: {} }));
  }) as unknown as typeof fetch;

  const client = createJevClient({ apiKey: "test", fetchImpl, timeoutMs: 10 });
  const result = await rerank(client, "car break in", searchObservations(db, "mission"));

  expect(result.reranked).toBe(false);
  expect(result.fallbackReason).toContain("latency budget");
  expect(client.stats.timeouts).toBe(1);
  // Search still returned results.
  expect(result.hits.length).toBe(2);
  db.close();
});

test("an upstream failure falls back instead of failing the search", async () => {
  const db = seeded();
  const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const client = createJevClient({ apiKey: "test", fetchImpl });

  const result = await rerank(client, "car break in", searchObservations(db, "mission"));
  expect(result.reranked).toBe(false);
  expect(result.hits).toHaveLength(2);
  expect(client.stats.failures).toBe(1);
  db.close();
});

test("cost and latency are counted, because this one is billed per token", async () => {
  const db = seeded();
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: { rel_0: { type: "score", score: 3, confidence: 0.8, probabilities: {} } },
        usage: { input_tokens: 7800, output_tokens: 0 },
      }),
    )) as unknown as typeof fetch;

  const client = createJevClient({ apiKey: "test", fetchImpl });
  await rerank(client, "car break in", searchObservations(db, "mission"));

  expect(client.stats.requests).toBe(1);
  expect(client.stats.inputTokens).toBe(7800);
  // $0.042 per million input tokens.
  expect(client.stats.costUsd).toBeCloseTo(7800 * 0.042e-6, 10);
  expect(client.stats.lastMs).toBeGreaterThanOrEqual(0);
  db.close();
});

test("query-level judgements are gated too", async () => {
  const db = seeded();
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          activity_kind: { type: "choice", choice: "property", confidence: 0.9, probabilities: {} },
          wants_recent: { type: "noul", noul: 0.95 },
          wants_place: { type: "noul", noul: 0.2 },
        },
      }),
    )) as unknown as typeof fetch;

  const result = await rerank(
    createJevClient({ apiKey: "test", fetchImpl }),
    "car break ins right now",
    searchObservations(db, "mission"),
  );

  expect(result.activityKind).toBe("property");
  expect(result.wantsRecent).toBe(true);
  // 0.2 is well under the 0.6 gate, so it is simply not believed.
  expect(result.wantsPlace).toBeUndefined();
  db.close();
});
