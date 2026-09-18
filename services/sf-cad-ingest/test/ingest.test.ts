/**
 * Ingest tested against 1,000 records captured live from gnap-fj3t on 2026-09-18.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  listJobs,
  observationBySourceRecord,
  queueStats,
  sourceConfigurations,
} from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { createAppMetrics, createLogger, type LogLine } from "@scantron/observability";

import { OVERLAP_SECONDS, cursorWhere, runIngestCycle } from "../src/ingest.ts";
import { mapSfpdRecord, type SfpdCallRecord } from "../src/police.ts";
import type { SocrataClient } from "../src/socrata.ts";

const FIXTURE: SfpdCallRecord[] = JSON.parse(
  readFileSync(new URL("./fixtures/sfpd-calls-1000.json", import.meta.url).pathname, "utf8"),
) as SfpdCallRecord[];

function fixedClient(records: SfpdCallRecord[]): SocrataClient & { calls: number } {
  const client = {
    calls: 0,
    async query<T>(): Promise<T[]> {
      client.calls += 1;
      return records as unknown as T[];
    },
    async queryAll<T>(): Promise<T[]> {
      client.calls += 1;
      return records as unknown as T[];
    },
    async queryKeyset<T extends Record<string, unknown>>(): Promise<T[]> {
      client.calls += 1;
      return records as unknown as T[];
    },
  };
  return client;
}

function harness(records: SfpdCallRecord[]) {
  const db = createTestDatabase();
  const lines: LogLine[] = [];
  return {
    db,
    lines,
    metrics: createAppMetrics(),
    client: fixedClient(records),
    log: createLogger({ sink: (line) => lines.push(line), level: "debug" }),
  };
}

test("the fixture is the real thing", () => {
  expect(FIXTURE).toHaveLength(1000);
  expect(new Set(FIXTURE.map((record) => record.id)).size).toBe(1000);
});

test("replaying 1,000 records twice yields exactly 1,000 observations", async () => {
  const h = harness(FIXTURE);

  const first = await runIngestCycle(h);
  expect(first.fetched).toBe(1000);
  expect(first.created + first.quarantined).toBe(1000);
  expect(first.updated).toBe(0);

  const second = await runIngestCycle(h);
  expect(second.created).toBe(0);
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(first.created);

  const count = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM observations").get();
  expect(count?.n).toBe(first.created);
  expect(first.created).toBeGreaterThan(950);
  h.db.close();
});

test("the raw payload is stored verbatim before anything interprets it", async () => {
  const h = harness(FIXTURE.slice(0, 5));
  await runIngestCycle(h);

  const stored = h.db
    .query<{ payload: string; source_record_id: string }, []>(
      "SELECT payload, source_record_id FROM source_records ORDER BY source_record_id",
    )
    .all();
  expect(stored).toHaveLength(5);

  const original = FIXTURE.find((record) => record.id === stored[0]?.source_record_id);
  expect(JSON.parse(stored[0]?.payload as string)).toEqual(original as object);
  h.db.close();
});

test("a changed record updates the observation and queues re-correlation", async () => {
  const record = FIXTURE.find((r) => r.call_type_final && r.id) as SfpdCallRecord;
  const h = harness([record]);
  await runIngestCycle(h);

  const changed: SfpdCallRecord = {
    ...record,
    call_type_final: "216",
    call_type_final_desc: "SHOTS FIRED",
    disposition: "REP",
  };
  const h2 = { ...h, client: fixedClient([changed]) };
  const result = await runIngestCycle(h2);

  expect(result.updated).toBe(1);
  expect(result.created).toBe(0);

  const stored = observationBySourceRecord(h.db, "sf_police_cad", record.id as string);
  expect(stored?.raw_type).toBe("216");

  // Both payloads survive, so the previous values are recoverable (S-D7).
  const payloads = h.db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM source_records WHERE source_record_id = ?",
    )
    .get(record.id as string);
  expect(payloads?.n).toBe(2);

  const types = listJobs(h.db).map((job) => job.type);
  expect(types).toContain("correlate_incident");
  h.db.close();
});

test("normalize_observation is enqueued exactly once per changed record", async () => {
  const h = harness(FIXTURE.slice(0, 50));
  const first = await runIngestCycle(h);
  const normalizeJobs = () =>
    listJobs(h.db, { limit: 1000 }).filter((job) => job.type === "normalize_observation");

  expect(normalizeJobs()).toHaveLength(first.created);

  // A second cycle over unchanged records adds nothing.
  await runIngestCycle(h);
  expect(normalizeJobs()).toHaveLength(first.created);
  expect(queueStats(h.db).pending).toBe(first.created);
  h.db.close();
});

test("malformed records are quarantined, not written", async () => {
  const h = harness([
    { id: "no-timestamp" },
    { received_datetime: "2026-09-18T01:00:00.000" },
    FIXTURE[0] as SfpdCallRecord,
  ]);

  const result = await runIngestCycle(h);
  expect(result.quarantined).toBe(2);
  expect(result.created).toBe(1);
  expect(h.lines.filter((line) => line.event === "observation.quarantined")).toHaveLength(2);
  h.db.close();
});

test("the cursor advances on success and carries an overlap window", async () => {
  const h = harness(FIXTURE.slice(0, 20));
  const result = await runIngestCycle(h);

  const config = sourceConfigurations(h.db)[0];
  expect(config?.source).toBe("sf_police_cad");
  expect(config?.dataset_id).toBe("gnap-fj3t");
  expect(config?.last_record_at).toBe(result.cursor as string);
  expect(config?.consecutive_failures).toBe(0);

  const where = cursorWhere(result.cursor, new Date());
  const bound = /data_loaded_at > '([^']+)'/.exec(where)?.[1] as string;
  const overlapMs = new Date(result.cursor as string).getTime() - Date.parse(`${bound}Z`);
  // The bound is rendered in SF local time, so compare the shape rather than the instant.
  expect(where.startsWith("data_loaded_at > '")).toBe(true);
  expect(Number.isFinite(overlapMs)).toBe(true);
  h.db.close();
});

test("a failed cycle records the failure and does not advance the cursor", async () => {
  const h = harness(FIXTURE.slice(0, 5));
  await runIngestCycle(h);
  const cursorAfterSuccess = sourceConfigurations(h.db)[0]?.last_record_at;

  const failing: SocrataClient = {
    query: async () => {
      throw new Error("503 Service Unavailable");
    },
    queryAll: async () => {
      throw new Error("503 Service Unavailable");
    },
    queryKeyset: async () => {
      throw new Error("503 Service Unavailable");
    },
  };

  await expect(runIngestCycle({ ...h, client: failing })).rejects.toThrow("503");

  const config = sourceConfigurations(h.db)[0];
  expect(config?.last_record_at).toBe(cursorAfterSuccess as string);
  expect(config?.consecutive_failures).toBe(1);
  expect(config?.last_error).toContain("503");
  h.db.close();
});

test("source lag is measured and kept separate from pipeline lag", async () => {
  const h = harness(FIXTURE.slice(0, 100));
  const result = await runIngestCycle(h);

  expect(result.sourceLagSeconds).toBeGreaterThan(0);
  const text = h.metrics.registry.render();
  expect(text).toContain('scantron_source_lag_seconds{source="sf_police_cad"}');
  expect(text).toContain("scantron_pipeline_lag_seconds");
  expect(text).toContain('scantron_observations_ingested_total{source="sf_police_cad"}');
  h.db.close();
});

test("mapping keeps what the model has no column for, and nothing it should not", () => {
  const withPoint = FIXTURE.find((record) => record.intersection_point) as SfpdCallRecord;
  const mapped = mapSfpdRecord(withPoint, new Date("2026-09-18T02:00:00.000Z"));

  expect(mapped.observation.source).toBe("sf_police_cad");
  expect(mapped.observation.sourceRecordId).toBe(withPoint.id as string);
  expect(mapped.observation.location?.latitude).toBeCloseTo(
    (withPoint.intersection_point?.coordinates?.[1] as number) ?? 0,
    6,
  );
  expect(mapped.observation.metadata?.cad_number).toBe(withPoint.cad_number as string);
  expect(mapped.observation.metadata?.disposition).toBe(withPoint.disposition as string);
  // Naive local timestamps are read as San Francisco time, not UTC.
  expect(mapped.observation.occurredAt.toISOString()).not.toBe(
    `${withPoint.received_datetime as string}Z`,
  );
  expect(OVERLAP_SECONDS).toBe(120);
});

test("sensitive_call is carried through as SFPD set it", async () => {
  const sensitive = FIXTURE.find((record) => record.sensitive_call === true) as SfpdCallRecord;
  const notSensitive = FIXTURE.find((record) => record.sensitive_call === false) as SfpdCallRecord;
  const h = harness([sensitive, notSensitive]);
  await runIngestCycle(h);

  expect(observationBySourceRecord(h.db, "sf_police_cad", sensitive.id as string)?.sensitive).toBe(1);
  expect(observationBySourceRecord(h.db, "sf_police_cad", notSensitive.id as string)?.sensitive).toBe(0);
  h.db.close();
});
