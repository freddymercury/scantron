/**
 * S-A6: a request_id generated at ingest must reach every downstream job for that record.
 * This is that assertion, end to end over the real queue rather than by inspection.
 */

import { expect, test } from "bun:test";
import { createWorker, enqueue, type Job } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { createLogger, newRequestId, type LogLine } from "../src/index.ts";

interface Payload {
  requestId: string;
  observationId: string;
  incidentId?: string;
}

test("a request_id generated at ingest reaches every downstream job", async () => {
  const db = createTestDatabase();
  const lines: LogLine[] = [];
  const log = createLogger({ sink: (line) => lines.push(line), context: { processor: "test" } });

  // 1. Ingest: one record arrives, one trace id is minted.
  const requestId = newRequestId();
  const observationId = "obs_1";
  const ingestLog = log.child({ request_id: requestId, source: "sf_police_cad" });
  ingestLog.info("observation.ingested", { observation_id: observationId });

  enqueue(db, {
    type: "normalize_observation",
    payload: { requestId, observationId } satisfies Payload,
  });

  // 2. Each handler logs with the trace id from its payload and passes it on.
  const worker = createWorker({
    db,
    name: "test",
    handlers: {
      normalize_observation: (job: Job<Payload>) => {
        log.child({ request_id: job.payload.requestId }).info("observation.normalized", {
          observation_id: job.payload.observationId,
          result: "ok",
        });
        enqueue(db, { type: "correlate_incident", payload: job.payload });
      },
      correlate_incident: (job: Job<Payload>) => {
        log.child({ request_id: job.payload.requestId }).info("incident.correlated", {
          observation_id: job.payload.observationId,
          incident_id: "inc_1",
        });
        enqueue(db, {
          type: "publish_incident",
          payload: { ...job.payload, incidentId: "inc_1" } satisfies Payload,
        });
      },
      publish_incident: (job: Job<Payload>) => {
        log.child({ request_id: job.payload.requestId }).info("incident.published", {
          incident_id: job.payload.incidentId,
          result: "ok",
        });
      },
    },
  });

  while ((await worker.tick()) > 0) {
    // drain
  }

  const events = lines.map((line) => line.event);
  expect(events).toEqual([
    "observation.ingested",
    "observation.normalized",
    "incident.correlated",
    "incident.published",
  ]);
  // The point of the test: one trace id, every step.
  expect(new Set(lines.map((line) => line.request_id))).toEqual(new Set([requestId]));
  expect(lines.at(-1)?.incident_id).toBe("inc_1");
  db.close();
});
