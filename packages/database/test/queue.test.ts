import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claim,
  complete,
  createWorker,
  enqueue,
  fail,
  getJob,
  JOB_TYPES,
  listJobs,
  migrate,
  openDatabase,
  queueStats,
  reclaimStale,
  release,
  retryDelaySeconds,
  type Job,
} from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
});

function fileDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scantron-queue-"));
  temps.push(dir);
  return join(dir, "queue.db");
}

test("every job type PRD §39 names is registered", () => {
  expect([...JOB_TYPES]).toEqual([
    "normalize_observation",
    "geocode_location",
    "correlate_incident",
    "publish_incident",
    "summarize_incident",
    "backfill_gap",
    "transcribe_audio",
  ]);
});

test("a job round-trips its payload", () => {
  const db = createTestDatabase();
  const { job, created } = enqueue(db, {
    type: "normalize_observation",
    payload: { observationId: "obs_1", requestId: "req_1" },
  });
  expect(created).toBe(true);
  expect(getJob(db, job.id)?.payload).toEqual({ observationId: "obs_1", requestId: "req_1" });
  db.close();
});

test("dedupe_key prevents a second pending job for the same work", () => {
  const db = createTestDatabase();
  const first = enqueue(db, {
    type: "normalize_observation",
    payload: { observationId: "obs_1" },
    dedupeKey: "normalize_observation:obs_1",
  });
  const second = enqueue(db, {
    type: "normalize_observation",
    payload: { observationId: "obs_1" },
    dedupeKey: "normalize_observation:obs_1",
  });

  expect(second.created).toBe(false);
  expect(second.job.id).toBe(first.job.id);
  expect(queueStats(db).pending).toBe(1);

  // Once completed, the same work may legitimately be scheduled again.
  const [claimed] = claim(db, { worker: "w1" });
  complete(db, (claimed as Job).id);
  const third = enqueue(db, {
    type: "normalize_observation",
    payload: { observationId: "obs_1" },
    dedupeKey: "normalize_observation:obs_1",
  });
  expect(third.created).toBe(true);
  db.close();
});

test("two workers on the same database never claim the same job", () => {
  const path = fileDatabasePath();
  const writer = openDatabase({ path });
  migrate(writer);
  for (let i = 0; i < 50; i += 1) {
    enqueue(writer, { type: "correlate_incident", payload: { i } });
  }

  const a = openDatabase({ path });
  const b = openDatabase({ path });
  const claimedIds: string[] = [];
  for (let round = 0; round < 25; round += 1) {
    claimedIds.push(...claim(a, { worker: "a", limit: 1 }).map((job) => job.id));
    claimedIds.push(...claim(b, { worker: "b", limit: 1 }).map((job) => job.id));
  }

  expect(claimedIds).toHaveLength(50);
  expect(new Set(claimedIds).size).toBe(50);
  expect(queueStats(writer).pending).toBe(0);
  a.close();
  b.close();
  writer.close();
});

test("claiming respects run_after and the type filter", () => {
  const db = createTestDatabase();
  const now = new Date("2026-09-18T00:00:00.000Z");
  enqueue(db, { type: "publish_incident", payload: {}, runAfter: new Date("2026-09-18T00:05:00.000Z") }, now);
  enqueue(db, { type: "geocode_location", payload: {} }, now);

  expect(claim(db, { worker: "w1", types: ["publish_incident"] }, now)).toHaveLength(0);
  expect(claim(db, { worker: "w1", types: ["geocode_location"] }, now)).toHaveLength(1);
  expect(
    claim(db, { worker: "w1" }, new Date("2026-09-18T00:06:00.000Z")).map((job) => job.type),
  ).toEqual(["publish_incident"]);
  db.close();
});

test("failures back off exponentially with jitter, then park as failed", () => {
  const db = createTestDatabase();
  const now = new Date("2026-09-18T00:00:00.000Z");
  const { job } = enqueue(db, { type: "geocode_location", payload: {}, maxAttempts: 3 }, now);

  const first = claim(db, { worker: "w1" }, now)[0] as Job;
  const afterFirst = fail(db, first, new Error("geocoder timeout"), { now, random: () => 0.5 });
  expect(afterFirst.status).toBe("pending");
  expect(afterFirst.runAfter.getTime() - now.getTime()).toBe(5000);
  expect(getJob(db, job.id)?.lastError).toBe("geocoder timeout");

  const second = claim(db, { worker: "w1" }, afterFirst.runAfter)[0] as Job;
  const afterSecond = fail(db, second, new Error("again"), { now, random: () => 0.5 });
  expect(afterSecond.runAfter.getTime() - now.getTime()).toBe(10_000);

  const third = claim(db, { worker: "w1" }, afterSecond.runAfter)[0] as Job;
  expect(third.attempts).toBe(3);
  const afterThird = fail(db, third, new Error("still broken"), { now });
  expect(afterThird.status).toBe("failed");

  // Never silently dropped: it stays queryable, with its last error.
  const failed = listJobs(db, { status: "failed" });
  expect(failed).toHaveLength(1);
  expect(failed[0]?.lastError).toBe("still broken");
  expect(claim(db, { worker: "w1" }, new Date("2026-09-19T00:00:00.000Z"))).toHaveLength(0);
  db.close();
});

test("jitter stays inside the configured band", () => {
  for (const random of [() => 0, () => 0.5, () => 1]) {
    const delay = retryDelaySeconds(3, { baseSeconds: 5, maxSeconds: 900, jitter: 0.2 }, random);
    expect(delay).toBeGreaterThanOrEqual(16);
    expect(delay).toBeLessThanOrEqual(24);
  }
  // The ceiling holds no matter how many attempts have accumulated.
  for (let i = 0; i < 50; i += 1) expect(retryDelaySeconds(20)).toBeLessThanOrEqual(900);
  expect(retryDelaySeconds(20, undefined, () => 1)).toBe(900);
});

test("release hands a job back without burning an attempt", () => {
  const db = createTestDatabase();
  enqueue(db, { type: "summarize_incident", payload: {} });
  const job = claim(db, { worker: "w1" })[0] as Job;
  expect(job.attempts).toBe(1);

  release(db, job.id);
  const released = getJob(db, job.id);
  expect(released?.status).toBe("pending");
  expect(released?.attempts).toBe(0);
  expect(released?.lockedBy).toBeUndefined();
  db.close();
});

test("a job whose worker died is reclaimed by age", () => {
  const db = createTestDatabase();
  const at = new Date("2026-09-18T00:00:00.000Z");
  enqueue(db, { type: "correlate_incident", payload: {} }, at);
  claim(db, { worker: "crashed" }, at);

  expect(reclaimStale(db, 300, new Date("2026-09-18T00:02:00.000Z"))).toBe(0);
  expect(reclaimStale(db, 300, new Date("2026-09-18T00:10:00.000Z"))).toBe(1);
  expect(claim(db, { worker: "w2" }, new Date("2026-09-18T00:10:00.000Z"))).toHaveLength(1);
  db.close();
});

test("queue stats report depth and how far behind we are", () => {
  const db = createTestDatabase();
  const now = new Date("2026-09-18T00:10:00.000Z");
  enqueue(db, { type: "publish_incident", payload: { a: 1 } }, new Date("2026-09-18T00:00:00.000Z"));
  enqueue(db, { type: "publish_incident", payload: { b: 2 } }, new Date("2026-09-18T00:09:00.000Z"));

  const stats = queueStats(db, now);
  expect(stats.pending).toBe(2);
  expect(stats.oldestPendingAgeSeconds).toBe(600);
  db.close();
});
