/**
 * Fire/EMS ingest, tested against 1,000 unit rows captured live from nuek-vuh3 on
 * 2026-09-18. Those 1,000 rows describe 550 calls — which is the whole point of this
 * adapter.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { observationBySourceRecord, sourceConfigurations } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { rowToObservation, type Observation } from "@scantron/incident-schema";
import { createAppMetrics, createLogger, type LogLine } from "@scantron/observability";

import type { SourceAdapter } from "../src/adapter.ts";
import {
  EMS_SOURCE,
  FIRE_SOURCE,
  emsAdapter,
  fireAdapter,
  isEmsRecord,
  mergeUnitRow,
  sourceFor,
  type SffdCallRecord,
} from "../src/fire.ts";
import { runIngestCycle } from "../src/ingest.ts";
import type { SocrataClient } from "../src/socrata.ts";

const FIXTURE: SffdCallRecord[] = JSON.parse(
  readFileSync(new URL("./fixtures/sffd-calls-1000.json", import.meta.url).pathname, "utf8"),
) as SffdCallRecord[];

function client(records: SffdCallRecord[]): SocrataClient {
  const all = async <T>(): Promise<T[]> => records as unknown as T[];
  return { query: all, queryAll: all, queryKeyset: all as never };
}

function harness(adapter: SourceAdapter<SffdCallRecord>, records = FIXTURE) {
  const db = createTestDatabase();
  const lines: LogLine[] = [];
  return {
    db,
    lines,
    adapter,
    client: client(records),
    metrics: createAppMetrics(),
    log: createLogger({ sink: (line) => lines.push(line), level: "debug" }),
  };
}

test("the fixture really is one row per unit", () => {
  expect(FIXTURE).toHaveLength(1000);
  const calls = new Set(FIXTURE.map((record) => record.call_number));
  expect(calls.size).toBe(550);
  expect(new Set(FIXTURE.map((record) => record.rowid)).size).toBe(1000);
});

test("fire ingest writes one observation per call, with every unit on it", async () => {
  const h = harness(fireAdapter);
  const result = await runIngestCycle(h);

  const fireCalls = new Set(
    FIXTURE.filter((record) => sourceFor(record) === FIRE_SOURCE).map((record) => record.call_number),
  );
  expect(result.created).toBe(fireCalls.size);
  expect(result.skipped).toBe(FIXTURE.filter((record) => sourceFor(record) === EMS_SOURCE).length);

  const stored = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM observations").get();
  expect(stored?.n).toBe(fireCalls.size);

  // The call with 11 unit rows is one observation carrying all of its units.
  const busiest = "262592820";
  const row = observationBySourceRecord(h.db, FIRE_SOURCE, busiest);
  if (row) {
    const observation = rowToObservation(row);
    const fireUnitRows = FIXTURE.filter(
      (record) => record.call_number === busiest && sourceFor(record) === FIRE_SOURCE,
    );
    expect(observation.units?.length).toBe(new Set(fireUnitRows.map((r) => r.unit_id)).size);
  }
  h.db.close();
});

test("replaying the same rows twice changes nothing", async () => {
  const h = harness(fireAdapter);
  const first = await runIngestCycle(h);
  const second = await runIngestCycle(h);

  expect(second.created).toBe(0);
  expect(second.updated).toBe(0);
  expect(second.unchanged).toBe(first.created);
  const stored = h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM observations").get();
  expect(stored?.n).toBe(first.created);
  h.db.close();
});

test("fire and EMS are separate sources, so independent-source counts mean something", async () => {
  const fire = harness(fireAdapter);
  const ems = harness(emsAdapter);
  const fireResult = await runIngestCycle(fire);
  const emsResult = await runIngestCycle(ems);

  expect(fireResult.created).toBeGreaterThan(0);
  expect(emsResult.created).toBeGreaterThan(0);
  expect(fireResult.skipped + fireResult.created + fireResult.quarantined).toBeLessThanOrEqual(1000);

  expect(sourceConfigurations(fire.db)[0]?.source).toBe(FIRE_SOURCE);
  expect(sourceConfigurations(ems.db)[0]?.source).toBe(EMS_SOURCE);
  fire.db.close();
  ems.db.close();
});

test("the EMS rule is about the unit and the call type, and is stated once", () => {
  expect(isEmsRecord({ unit_type: "MEDIC" })).toBe(true);
  expect(isEmsRecord({ unit_type: "PRIVATE" })).toBe(true);
  expect(isEmsRecord({ unit_type: "ENGINE", call_type: "Medical Incident" })).toBe(true);
  expect(isEmsRecord({ unit_type: "ENGINE", call_type: "Structure Fire / Smoke in Building" })).toBe(false);
  expect(isEmsRecord({ unit_type: "TRUCK" })).toBe(false);
  expect(sourceFor({ unit_type: "CHIEF" })).toBe(FIRE_SOURCE);
});

test("a call answered by both agencies produces one observation each, not a duplicate", async () => {
  const shared: SffdCallRecord[] = [
    {
      call_number: "999",
      rowid: "999-E01",
      unit_id: "E01",
      unit_type: "ENGINE",
      call_type: "Traffic Collision",
      received_dttm: "2026-09-18T01:00:00.000",
      data_loaded_at: "2026-09-18T02:00:00.000",
      address: "MISSION ST/24TH ST",
    },
    {
      call_number: "999",
      rowid: "999-M12",
      unit_id: "M12",
      unit_type: "MEDIC",
      call_type: "Traffic Collision",
      received_dttm: "2026-09-18T01:00:00.000",
      data_loaded_at: "2026-09-18T02:00:00.000",
      address: "MISSION ST/24TH ST",
    },
  ];

  const fire = harness(fireAdapter, shared);
  const ems = harness(emsAdapter, shared);
  await runIngestCycle(fire);
  await runIngestCycle(ems);

  expect(rowToObservation(observationBySourceRecord(fire.db, FIRE_SOURCE, "999")!).units).toEqual(["E01"]);
  expect(rowToObservation(observationBySourceRecord(ems.db, EMS_SOURCE, "999")!).units).toEqual(["M12"]);
  fire.db.close();
  ems.db.close();
});

test("merging keeps the earliest call time and accumulates units", () => {
  const base = {
    id: "obs_1",
    source: FIRE_SOURCE,
    sourceRecordId: "1",
    occurredAt: new Date("2026-09-18T01:00:00.000Z"),
    ingestedAt: new Date("2026-09-18T02:00:00.000Z"),
    confidence: 0.6,
    units: ["E01"],
    metadata: { unit_timestamps: { E01: { dispatch: "a" } } },
  } satisfies Observation;

  const merged = mergeUnitRow(base, {
    ...base,
    occurredAt: new Date("2026-09-18T01:05:00.000Z"),
    ingestedAt: new Date("2026-09-18T02:05:00.000Z"),
    units: ["T07"],
    metadata: { unit_timestamps: { T07: { dispatch: "b" } } },
  });

  expect(merged.units).toEqual(["E01", "T07"]);
  expect(merged.occurredAt.toISOString()).toBe("2026-09-18T01:00:00.000Z");
  expect(merged.metadata?.unit_timestamps).toEqual({ E01: { dispatch: "a" }, T07: { dispatch: "b" } });
  expect(merged.metadata?.unit_count).toBe(2);
});

test("unit identifiers survive into the observation", async () => {
  const h = harness(fireAdapter);
  await runIngestCycle(h);

  const withUnits = h.db
    .query<{ units: string }, []>("SELECT units FROM observations WHERE units IS NOT NULL LIMIT 20")
    .all()
    .map((row) => JSON.parse(row.units) as string[]);

  expect(withUnits.length).toBeGreaterThan(0);
  for (const units of withUnits) {
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) expect(unit).toMatch(/^[A-Z0-9]+$/);
  }
  h.db.close();
});

test("the fire feed's higher latency has its own threshold", () => {
  // ~19 h behind by nature (docs/01): judged against the police threshold it would be
  // permanently stale, and the alert would stop meaning anything.
  expect(fireAdapter.silenceThresholdSeconds).toBeGreaterThan(19 * 3600);
  expect(emsAdapter.silenceThresholdSeconds).toBe(fireAdapter.silenceThresholdSeconds);
});

test("mapping leaks no source-specific columns past the adapter", async () => {
  const h = harness(fireAdapter, FIXTURE.slice(0, 5));
  await runIngestCycle(h);

  const columns = h.db
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('observations')")
    .all()
    .map((row) => row.name);
  for (const fireOnly of ["battalion", "station_area", "als_unit", "box"]) {
    expect(columns).not.toContain(fireOnly);
  }
  // They survive in metadata, where downstream stories can still reach them.
  const row = h.db.query<{ metadata: string }, []>("SELECT metadata FROM observations LIMIT 1").get();
  expect(Object.keys(JSON.parse(row?.metadata ?? "{}") as object)).toContain("call_number");
  h.db.close();
});
