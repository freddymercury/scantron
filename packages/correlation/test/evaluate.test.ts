import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { migrate, openDatabase, IN_MEMORY } from "@scantron/database";

import { evaluate, runCase, type FixtureSet } from "../src/index.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/correlation-cases.json", import.meta.url).pathname, "utf8"),
) as FixtureSet;

const baseline = JSON.parse(
  readFileSync(new URL("../fixtures/baseline.json", import.meta.url).pathname, "utf8"),
) as { f1: number; cases: number };

function harness() {
  const db = openDatabase({ path: IN_MEMORY });
  migrate(db);
  return db;
}

test("the fixture set is real, labelled and big enough to mean something", () => {
  expect(fixtures.cases.length).toBeGreaterThanOrEqual(100);

  const groundTruth = fixtures.cases.filter((c) => c.labelSource === "agency_call_number");
  // The labels that depend on nothing this system computes.
  expect(groundTruth.length).toBeGreaterThanOrEqual(40);

  const same = fixtures.cases.filter((c) => c.label === "same").length;
  const different = fixtures.cases.length - same;
  // Both sides represented: a set of only positives measures nothing about false merges.
  expect(same).toBeGreaterThan(30);
  expect(different).toBeGreaterThan(30);

  for (const testCase of fixtures.cases) {
    expect(testCase.observations.length).toBeGreaterThanOrEqual(2);
    expect(testCase.note.length).toBeGreaterThan(10);
  }
});

test("ground-truth cases group correctly — one SFFD call is one incident", () => {
  const db = harness();
  const groundTruth = fixtures.cases.filter((c) => c.labelSource === "agency_call_number");
  const wrong = groundTruth
    .map((testCase) => runCase(db, testCase))
    .filter((outcome) => !outcome.correct)
    .map((outcome) => `${outcome.id}: ${outcome.note}`);

  expect(wrong).toEqual([]);
  db.close();
});

test("evaluation meets the committed baseline", () => {
  const db = harness();
  const result = evaluate(db, fixtures);

  expect(result.metrics.cases).toBe(fixtures.cases.length);
  expect(result.metrics.f1).toBeGreaterThanOrEqual(baseline.f1 - 0.02);
  // False merges are the failure a reader sees, so they are asserted separately.
  expect(result.metrics.falseMerges).toBeLessThanOrEqual(2);
  db.close();
});

test("a deliberately bad configuration scores worse — the harness can actually fail", () => {
  const db = harness();
  const good = evaluate(db, fixtures);
  // Everything on location: a busy corner becomes one incident.
  const bad = evaluate(db, fixtures, {
    weights: { location: 1, time: 0, type: 0, units: 0, text: 0 },
    thresholds: { merge: 0.5, probable: 0.3 },
  });

  expect(bad.metrics.falseMerges).toBeGreaterThan(good.metrics.falseMerges);
  expect(bad.metrics.f1).toBeLessThan(good.metrics.f1);
  db.close();
});
