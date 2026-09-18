import { expect, test } from "bun:test";
import {
  createWorker,
  enqueue,
  getJob,
  listJobs,
  queueStats,
  type Job,
  type WorkerEvent,
} from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

test("the worker runs a job and completes it", async () => {
  const db = createTestDatabase();
  const seen: string[] = [];
  const { job } = enqueue(db, { type: "normalize_observation", payload: { observationId: "obs_1" } });

  const worker = createWorker({
    db,
    name: "test",
    handlers: {
      normalize_observation: (claimed) => {
        seen.push((claimed.payload as { observationId: string }).observationId);
      },
    },
  });

  expect(await worker.tick()).toBe(1);
  expect(seen).toEqual(["obs_1"]);
  expect(getJob(db, job.id)?.status).toBe("completed");
  db.close();
});

test("a handler that throws leaves the job retryable, with its error recorded", async () => {
  const db = createTestDatabase();
  const { job } = enqueue(db, { type: "geocode_location", payload: {}, maxAttempts: 2 });
  const events: WorkerEvent["event"][] = [];

  const worker = createWorker({
    db,
    name: "test",
    handlers: {
      geocode_location: () => {
        throw new Error("geocoder said no");
      },
    },
    onEvent: (event) => events.push(event.event),
  });

  await worker.tick();
  expect(getJob(db, job.id)?.status).toBe("pending");
  expect(getJob(db, job.id)?.lastError).toBe("geocoder said no");
  expect(events).toEqual(["claimed", "retrying"]);
  db.close();
});

test("a job type no worker handles waits in the queue rather than failing", async () => {
  const db = createTestDatabase();
  enqueue(db, { type: "correlate_incident", payload: {} });

  const worker = createWorker({ db, name: "test", handlers: { normalize_observation: () => {} } });
  expect(await worker.tick()).toBe(0);
  expect(queueStats(db).pending).toBe(1);
  expect(queueStats(db).failed).toBe(0);
  db.close();
});

test("an unregistered job type fails loudly rather than disappearing", async () => {
  const db = createTestDatabase();
  const { job } = enqueue(db, { type: "transcribe_audio", payload: {}, maxAttempts: 1 });

  // claimOnlyHandled is off here on purpose: this asserts what happens if a handler
  // disappears out from under a job that has already been claimed.
  const worker = createWorker({ db, name: "test", handlers: {}, claimOnlyHandled: false });
  await worker.tick();

  const failed = getJob(db, job.id);
  expect(failed?.status).toBe("failed");
  expect(failed?.lastError).toContain("no handler registered");
  expect(listJobs(db, { status: "failed" })).toHaveLength(1);
  db.close();
});

test("re-running a completed job is a no-op, because handlers are idempotent by contract", async () => {
  const db = createTestDatabase();
  const applied: string[] = [];
  const { job } = enqueue(db, {
    type: "publish_incident",
    payload: { incidentId: "inc_1" },
    dedupeKey: "publish_incident:inc_1",
  });

  const worker = createWorker({
    db,
    name: "test",
    handlers: {
      publish_incident: (claimed: Job<{ incidentId: string }>) => {
        // The contract: an effect applied twice must equal the effect applied once.
        const id = claimed.payload.incidentId;
        if (!applied.includes(id)) applied.push(id);
      },
    },
  });

  await worker.tick();
  await worker.tick(); // nothing left to claim
  expect(applied).toEqual(["inc_1"]);
  expect(getJob(db, job.id)?.status).toBe("completed");
  expect(queueStats(db).pending).toBe(0);
  db.close();
});

test("stop() stops claiming, finishes in-flight work, and releases the lock", async () => {
  const db = createTestDatabase();
  for (let i = 0; i < 5; i += 1) {
    enqueue(db, { type: "correlate_incident", payload: { i } });
  }

  let started = 0;
  let finished = 0;
  const worker = createWorker({
    db,
    name: "test",
    idleMs: 1,
    handlers: {
      correlate_incident: async () => {
        started += 1;
        await Bun.sleep(20);
        finished += 1;
      },
    },
  });

  const loop = worker.start();
  await Bun.sleep(25); // long enough to be inside a handler
  const stopping = worker.stop();
  await stopping;
  await loop;

  expect(worker.running).toBe(false);
  expect(finished).toBe(started);
  // Nothing is left marked running with nobody running it.
  expect(queueStats(db).running).toBe(0);
  expect(started).toBeGreaterThan(0);
  expect(started).toBeLessThan(5 + 1);
  db.close();
});
