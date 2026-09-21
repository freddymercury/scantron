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

test("expansion reaches records that share no word with the question", async () => {
  const { expandQuery } = await import("../src/ask/expand.ts");
  const db = createTestDatabase();
  upsertObservation(
    db,
    observationToRow(
      observation({
        id: "obs_shots",
        sourceRecordId: "9",
        type: "weapon",
        rawType: "216",
        subtype: "SHOTS FIRED",
      }),
    ),
  );

  // The word "gunshots" appears nowhere in the record; a keyword search finds nothing.
  expect(searchObservations(db, "gunshots")).toHaveLength(0);

  const expansion = expandQuery(db, "gunshots");
  expect(expansion.types).toContain("weapon");
  expect(expansion.rawCodes).toContain("216");

  const hits = searchObservations(db, "gunshots", {
    types: expansion.types,
    rawCodes: expansion.rawCodes,
  });
  expect(hits).toHaveLength(1);
  expect(hits[0]?.row.id).toBe("obs_shots");
  // And it says how it got there, rather than appearing by magic.
  expect(hits[0]?.via).toBe("category");
  expect(expansion.matched).toContain("gunfire");
  db.close();
});

test("expansion uses the agency's own vocabulary, not a hand-written thesaurus", async () => {
  const { expandQuery } = await import("../src/ask/expand.ts");
  const { seedTaxonomy } = await import("@scantron/event-taxonomy");
  const db = createTestDatabase();
  seedTaxonomy(db);

  // Nobody wrote "knife" into a synonym list; event_taxonomy carries PERSON W/KNIFE.
  const expansion = expandQuery(db, "someone waving a knife around");
  expect(expansion.rawCodes).toContain("222");
  expect(expansion.matched.join(" ")).toContain("agency wording");
  db.close();
});

test("the retrieval plan keeps what the question is about, not everything plausible", async () => {
  const { planRetrieval, MAX_RETRIEVAL_TYPES, RETRIEVAL_SPREAD } = await import("../src/ask/rerank.ts");

  // The shape of a real answer: one strong type and a tail of plausible ones. A flat gate
  // would retrieve four categories for a question about one.
  const answer = (nouls: Record<string, number>) =>
    (async () =>
      new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: Object.fromEntries(
            Object.entries(nouls).map(([type, noul]) => [`type_${type}`, { type: "noul", noul }]),
          ),
        }),
      )) as unknown as typeof fetch;

  const types = ["weapon", "public_safety", "disturbance", "medical", "theft"];
  const plan = await planRetrieval(
    createJevClient({ apiKey: "test", fetchImpl: answer({ weapon: 0.98, public_safety: 0.66, disturbance: 0.62, medical: 0.61, theft: 0.1 }) }),
    "gunshots",
    types,
  );
  expect(plan.types).toEqual(["weapon"]);
  expect(plan.reason).toContain("weapon");

  // Genuinely close answers are all kept — "break-in" really is burglary and theft.
  const both = await planRetrieval(
    createJevClient({ apiKey: "test", fetchImpl: answer({ burglary: 0.93, theft: 0.9, weapon: 0.2 }) }),
    "someone broke into a car",
    ["burglary", "theft", "weapon"],
  );
  expect(both.types).toEqual(["burglary", "theft"]);

  // And the cap holds even when everything scores high.
  const many = await planRetrieval(
    createJevClient({ apiKey: "test", fetchImpl: answer({ a: 0.95, b: 0.94, c: 0.93, d: 0.92 }) }),
    "everything",
    ["a", "b", "c", "d"],
  );
  expect(many.types).toHaveLength(3);
  expect(MAX_RETRIEVAL_TYPES).toBe(3);
  expect(RETRIEVAL_SPREAD).toBe(0.15);
});

test("with no key, expansion alone still fixes the zero-result case", async () => {
  const { expandQuery } = await import("../src/ask/expand.ts");
  const { planRetrieval } = await import("../src/ask/rerank.ts");
  const db = createTestDatabase();
  upsertObservation(
    db,
    observationToRow(
      observation({ id: "obs_shots", sourceRecordId: "9", type: "weapon", rawType: "216", subtype: "SHOTS FIRED" }),
    ),
  );

  const client = createJevClient({ apiKey: undefined });
  const plan = await planRetrieval(client, "gunshots", ["weapon"]);
  expect(plan.types).toEqual([]);

  const expansion = expandQuery(db, "gunshots");
  const hits = searchObservations(db, "gunshots", {
    types: [...expansion.types, ...plan.types],
    rawCodes: expansion.rawCodes,
  });
  // The deterministic half carries it on its own.
  expect(hits).toHaveLength(1);
  db.close();
});

test("a catch-all type never widens a query alongside a specific one", async () => {
  const { planRetrieval, CATCH_ALL_TYPES } = await import("../src/ask/rerank.ts");
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          type_medical: { type: "noul", noul: 0.9 },
          type_public_safety: { type: "noul", noul: 0.83 },
        },
      }),
    )) as unknown as typeof fetch;

  // Measured behaviour: public_safety scores high on almost anything, and retrieving it
  // beside `medical` buried the medical calls under suspicious-person calls.
  const plan = await planRetrieval(createJevClient({ apiKey: "test", fetchImpl }), "person not breathing", [
    "medical",
    "public_safety",
  ]);
  expect(plan.types).toEqual(["medical"]);
  expect([...CATCH_ALL_TYPES]).toContain("public_safety");

  // With nothing specific judged, a catch-all is *worse* than nothing — corrected against
  // live data on 2026-09-21. "prostitution" judged only `public_safety` and the answer
  // became 2,069 public-safety calls in 90 days, none of which were what was asked about,
  // while the records that were ("Solicits For Act Of Prostitution") sat unreturned.
  // Returning no plan hands the question to keyword search, which finds them by their words.
  const onlyCatchAll = (async () =>
    new Response(
      JSON.stringify({ model: "jev-latest", answers: { type_public_safety: { type: "noul", noul: 0.8 } } }),
    )) as unknown as typeof fetch;
  const fallback = await planRetrieval(
    createJevClient({ apiKey: "test", fetchImpl: onlyCatchAll }),
    "prostitution",
    ["public_safety"],
  );
  expect(fallback.types).toEqual([]);
  expect(fallback.reason).toContain("no category in this taxonomy");
});

test("ranked codes put the kind that was asked about first", async () => {
  const { expandQuery } = await import("../src/ask/expand.ts");
  const { runAsk } = await import("../src/ask/answer.ts");
  const { parseQuestion } = await import("../src/ask/parse.ts");
  const db = createTestDatabase();

  // A vandalism call more recent than the car break-in: recency alone puts it first.
  upsertObservation(
    db,
    observationToRow(
      observation({ id: "obs_boost", sourceRecordId: "1", rawType: "852", subtype: "AUTO BOOST / STRIP", type: "theft", occurredAt: new Date(Date.now() - 60 * 60_000) }),
    ),
  );
  upsertObservation(
    db,
    observationToRow(
      observation({ id: "obs_vandal", sourceRecordId: "2", rawType: "594", subtype: "VANDALISM", type: "disturbance", occurredAt: new Date(Date.now() - 5 * 60_000) }),
    ),
  );

  const expansion = expandQuery(db, "someone smashed a car window");
  expect(expansion.codeOrder).toEqual(["852", "594"]);

  const query = parseQuestion("someone smashed a car window", { knownAreas: [] });
  query.rawCodes = expansion.rawCodes;
  const answer = runAsk(db, query, new Date(), { codeOrder: expansion.codeOrder });

  // The car break-in leads despite being older, because the code says what it is and the
  // record carries no narrative for anything else to read.
  expect(answer.rows.map((row) => row.id)).toEqual(["obs_boost", "obs_vandal"]);
  db.close();
});

test("the main answer is only reordered when the model actually separated the records", async () => {
  const { rerankAnswer, runAsk } = await import("../src/ask/answer.ts");
  const { parseQuestion } = await import("../src/ask/parse.ts");
  const db = createTestDatabase();
  // Inside the default 3-hour window, or the question finds nothing to rank.
  const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  upsertObservation(db, observationToRow(observation({ id: "obs_a", sourceRecordId: "1", occurredAt: recent(30) })));
  upsertObservation(db, observationToRow(observation({ id: "obs_b", sourceRecordId: "2", occurredAt: recent(60) })));

  const query = parseQuestion("car break ins", { knownAreas: [] });
  const clustered = runAsk(db, query);
  const order = clustered.rows.map((row) => row.id);

  // Every candidate scored the same band — which is what thin records actually produce.
  const flat = (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          rel_0: { type: "score", score: 2.3, confidence: 0.8, probabilities: {} },
          rel_1: { type: "score", score: 2.45, confidence: 0.8, probabilities: {} },
        },
      }),
    )) as unknown as typeof fetch;

  await rerankAnswer(clustered, createJevClient({ apiKey: "test", fetchImpl: flat }));
  expect(clustered.rows.map((row) => row.id)).toEqual(order);
  expect(clustered.ordering).toContain("too alike to rank further");
  // The labels are still shown, so the reader can see what the model made of each.
  expect(clustered.relevance?.size).toBe(2);

  // A real separation does reorder.
  const separated = runAsk(db, query);
  const sharp = (async () =>
    new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          rel_0: { type: "score", score: 0.4, confidence: 0.9, probabilities: {} },
          rel_1: { type: "score", score: 3.9, confidence: 0.9, probabilities: {} },
        },
      }),
    )) as unknown as typeof fetch;
  await rerankAnswer(separated, createJevClient({ apiKey: "test", fetchImpl: sharp }));
  expect(separated.rows[0]?.id).toBe(order[1] as string);
  expect(separated.ordering).toContain("how well each matches");
  db.close();
});
