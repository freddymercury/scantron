import { afterEach, beforeEach, expect, test } from "bun:test";
import { enqueue, claim, fail as failJob, upsertObservation, ensureSourceConfiguration, recordSourcePayload, recordGap } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { observationToRow, type Observation } from "@scantron/incident-schema";

import { evaluateGate, handleInternal, isAuthorized, parseFilter } from "../src/internal/viewer.ts";
import { windowCounters, failedJobs, requeueJob } from "../src/internal/queries.ts";

const KEY = "test-internal-key";
let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = KEY;
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = previousKey;
});

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "262600914",
    occurredAt: new Date("2026-09-18T01:00:00.000Z"),
    ingestedAt: new Date("2026-09-18T01:30:00.000Z"),
    rawType: "219",
    subtype: "STABBING",
    type: "assault",
    location: { raw: "MISSION ST \\ 24TH ST", normalized: "24th St & Mission St", latitude: 37.75, longitude: -122.41, neighborhood: "Mission" },
    confidence: 0.6,
    ...overrides,
  } as Observation;
}

function seeded() {
  const db = createTestDatabase();
  ensureSourceConfiguration(db, { source: "sf_police_cad", datasetId: "gnap-fj3t" });
  upsertObservation(db, observationToRow(observation()));
  recordSourcePayload(db, {
    source: "sf_police_cad",
    sourceRecordId: "262600914",
    payload: { cad_number: "262600914", call_type_final: "219" },
    fetchedAt: new Date("2026-09-18T01:30:00.000Z"),
  });
  return db;
}

const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init);

test("without a key configured the internal route does not exist", async () => {
  delete process.env.INTERNAL_API_KEY;
  const db = seeded();
  const response = await handleInternal(request("/internal"), { db });
  expect(response?.status).toBe(404);
  db.close();
});

test("an unauthenticated request is challenged, not served", async () => {
  const db = seeded();
  const response = await handleInternal(request("/internal"), { db });
  expect(response?.status).toBe(401);
  expect(response?.headers.get("www-authenticate")).toContain("Basic");
  expect(await response?.text()).not.toContain("observations");
  db.close();
});

test("either a header secret or basic auth gets in; a wrong one does not", () => {
  expect(isAuthorized(request("/internal", { headers: { "x-scantron-internal-key": KEY } }), KEY)).toBe(true);
  expect(
    isAuthorized(request("/internal", { headers: { authorization: `Basic ${btoa(`ops:${KEY}`)}` } }), KEY),
  ).toBe(true);
  expect(isAuthorized(request("/internal", { headers: { "x-scantron-internal-key": "wrong" } }), KEY)).toBe(false);
  expect(isAuthorized(request("/internal"), KEY)).toBe(false);
  // Length differences must not be distinguishable by the comparison itself.
  expect(isAuthorized(request("/internal", { headers: { "x-scantron-internal-key": `${KEY}x` } }), KEY)).toBe(false);
});

test("the page shows raw payload beside the normalized observation", async () => {
  const db = seeded();
  const response = await handleInternal(
    request("/internal", { headers: { "x-scantron-internal-key": KEY } }),
    { db },
  );
  const html = (await response?.text()) ?? "";

  expect(response?.status).toBe(200);
  expect(html).toContain("source payload");
  expect(html).toContain("normalized observation");
  expect(html).toContain("262600914");
  expect(html).toContain("24th St &amp; Mission St");
  // Internal pages are not for indexing, and not for caching.
  expect(html).toContain('name="robots" content="noindex,nofollow"');
  expect(response?.headers.get("cache-control")).toBe("no-store");
  // Inline style still runs under the nonce CSP, like everything else.
  const policy = response?.headers.get("content-security-policy") ?? "";
  const nonce = /style-src 'nonce-([^']+)'/.exec(policy)?.[1];
  expect(html).toContain(`<style nonce="${nonce}">`);
  db.close();
});

test("filters are parsed from the query string", () => {
  const url = new URL("http://localhost/internal?source=sf_fire_cad&type=fire&geocoded=no&unmapped=1&from=2026-09-18T00:00:00Z");
  expect(parseFilter(url)).toMatchObject({
    source: "sf_fire_cad",
    type: "fire",
    geocoded: "no",
    unmappedOnly: true,
    from: "2026-09-18T00:00:00Z",
  });
  expect(parseFilter(new URL("http://localhost/internal"))).toEqual({ limit: 50 });
});

test("counters report what would expose a failure, not what flatters", () => {
  const db = seeded();
  upsertObservation(
    db,
    observationToRow(
      observation({
        id: "obs_2",
        sourceRecordId: "2",
        type: "unknown",
        location: { raw: "Not Available" },
        sensitive: true,
      }),
    ),
  );

  const counters = windowCounters(db);
  expect(counters.total).toBe(2);
  expect(counters.geocodedPercent).toBe(50);
  // The sensitive call has no location upstream (docs/01 §8), so the honest denominator
  // for our own work excludes it.
  expect(counters.locatablePercent).toBe(100);
  expect(counters.typedPercent).toBe(50);
  expect(counters.duplicateUpserts).toBe(0);
  db.close();
});

test("the Phase 0 gate is evaluated from the same numbers, and fails loudly", () => {
  const now = new Date("2026-09-18T02:00:00.000Z");
  const counters = {
    total: 100,
    bySource: [],
    geocoded: 90,
    geocodedPercent: 90,
    locatablePercent: 98,
    typed: 95,
    typedPercent: 95,
    duplicateUpserts: 0,
    failedJobs: 0,
    pendingJobs: 0,
    quarantined: 0,
    openGaps: 0,
    unrecoverableGaps: 0,
    backfilled: 0,
    coverageHours: 12,
    newest: "2026-09-18T01:30:00.000Z",
  };

  const notYet = evaluateGate(counters, now);
  expect(notYet.passes).toBe(false);
  expect(notYet.reasons[0]).toContain("12.0 h of coverage, needs 72 h");

  // Ingesting without normalizing is not a working pipeline.
  const unnormalized = evaluateGate({ ...counters, typed: 0, coverageHours: 80 }, now);
  expect(unnormalized.reasons.join(" ")).toContain("nothing has been normalized");

  const passing = evaluateGate({
    total: 10_000,
    bySource: [],
    geocoded: 9_000,
    geocodedPercent: 90,
    locatablePercent: 98,
    typed: 9_500,
    typedPercent: 95,
    duplicateUpserts: 0,
    failedJobs: 0,
    pendingJobs: 0,
    quarantined: 0,
    openGaps: 0,
    unrecoverableGaps: 0,
    backfilled: 0,
    coverageHours: 80,
    newest: "2026-09-18T01:30:00.000Z",
  }, now);
  expect(passing.passes).toBe(true);

  // A long span means nothing if ingestion has since stopped.
  const stalled = evaluateGate({ ...passing, newest: "2026-09-17T00:00:00.000Z" } as never, now);
  expect(stalled.passes).toBe(false);
  expect(stalled.reasons.join(" ")).toContain("not current");

  // Duplicates and unrecoverable gaps fail the gate even with plenty of coverage.
  const duplicated = evaluateGate({ ...passing, duplicateUpserts: 3 } as never, now);
  expect(duplicated.passes).toBe(false);
});

test("a failed job is listed and can be requeued in one click", async () => {
  const db = seeded();
  const { job } = enqueue(db, { type: "geocode_location", payload: { observationId: "obs_1" }, maxAttempts: 1 });
  const claimed = claim(db, { worker: "w" })[0]!;
  failJob(db, claimed, new Error("geocoder exploded"));

  expect(failedJobs(db)).toHaveLength(1);
  expect(failedJobs(db)[0]?.last_error).toBe("geocoder exploded");

  const form = new FormData();
  form.set("id", job.id);
  const response = await handleInternal(
    request("/internal/jobs/requeue", {
      method: "POST",
      headers: { "x-scantron-internal-key": KEY },
      body: form,
    }),
    { db },
  );

  expect(response?.status).toBe(303);
  expect(failedJobs(db)).toHaveLength(0);
  // Requeuing something that is not failed is a no-op, not an error.
  expect(requeueJob(db, job.id)).toBe(false);
  db.close();
});

test("gaps and quarantine show up in the counters", () => {
  const db = seeded();
  recordGap(db, {
    source: "sf_police_cad",
    from: new Date("2026-09-10T00:00:00.000Z"),
    to: new Date("2026-09-11T00:00:00.000Z"),
  });
  const counters = windowCounters(db);
  expect(counters.openGaps).toBe(1);
  expect(evaluateGate(counters).passes).toBe(false);
  db.close();
});
