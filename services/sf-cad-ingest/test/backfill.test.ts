import { expect, test } from "bun:test";
import {
  classifyGap,
  detectGap,
  ensureSourceConfiguration,
  openGaps,
  quarantinedRecords,
  recordGap,
  recordPollSuccess,
  type GapRow,
} from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { createAppMetrics, createLogger, type LogLine } from "@scantron/observability";

import { backfillRange, fillOpenGaps, validationFailure } from "../src/backfill.ts";
import type { SfpdCallRecord } from "../src/police.ts";
import type { SocrataClient } from "../src/socrata.ts";

/** The real export-footer row from 2zdj-bwza, verified live on 2026-09-18. */
const EXPORT_FOOTER: SfpdCallRecord = {
  cad_number: "Completion time: 2025-03-11T11:42:36.8650337-07:00",
  data_as_of: "2026-01-11T05:25:04.849",
};

const GOOD: SfpdCallRecord = {
  id: "41004773",
  cad_number: "262600914",
  received_datetime: "2026-09-17T09:02:03.000",
  call_type_final: "587",
  call_type_final_desc: "TRAF VIOLATION CITE",
  intersection_name: "BOYLSTON ST \\ HALE ST",
  data_loaded_at: "2026-09-17T23:15:37.544",
};

function client(records: SfpdCallRecord[]): SocrataClient {
  const all = async <T>(): Promise<T[]> => records as unknown as T[];
  return { query: all, queryAll: all, queryKeyset: all as never };
}

function harness(records: SfpdCallRecord[] = [GOOD]) {
  const db = createTestDatabase();
  ensureSourceConfiguration(db, { source: "sf_police_cad", datasetId: "gnap-fj3t", pollSeconds: 60 });
  const lines: LogLine[] = [];
  return {
    db,
    lines,
    client: client(records),
    metrics: createAppMetrics(),
    log: createLogger({ sink: (line) => lines.push(line), level: "debug" }),
  };
}

test("silence longer than a few intervals is recorded as a gap", () => {
  const h = harness();
  recordPollSuccess(h.db, "sf_police_cad", undefined, new Date("2026-09-18T00:00:00.000Z"));

  // Two minutes on a 60 s interval is late, not a gap.
  expect(detectGap(h.db, "sf_police_cad", new Date("2026-09-18T00:02:00.000Z"))).toBeUndefined();

  const gap = detectGap(h.db, "sf_police_cad", new Date("2026-09-18T04:00:00.000Z"));
  expect(gap?.gap_start).toBe("2026-09-18T00:00:00.000Z");
  expect(gap?.status).toBe("open");
  // Detecting the same silence twice does not create a second gap.
  detectGap(h.db, "sf_police_cad", new Date("2026-09-18T04:00:00.000Z"));
  expect(openGaps(h.db)).toHaveLength(1);
  h.db.close();
});

test("a gap is classified by what can still serve it", () => {
  const gap = (start: string, end: string): GapRow => ({
    id: "g",
    source: "sf_police_cad",
    gap_start: start,
    gap_end: end,
    detected_at: end,
    status: "open",
    records_filled: 0,
    attempts: 0,
    last_attempt_at: null,
    filled_at: null,
    note: null,
  });
  const now = new Date("2026-09-18T12:00:00.000Z");

  // An hour ago: the real-time feed still has it, the historical set does not yet.
  const fresh = classifyGap(gap("2026-09-18T10:00:00.000Z", "2026-09-18T11:00:00.000Z"), now);
  expect(fresh.liveFillable).toBe(true);
  expect(fresh.historicallyFillable).toBe(false);
  expect(fresh.unrecoverable).toBe(false);

  // Three days ago: past the ~48 h retention, but the historical set has published it.
  const old = classifyGap(gap("2026-09-15T10:00:00.000Z", "2026-09-15T11:00:00.000Z"), now);
  expect(old.liveFillable).toBe(false);
  expect(old.historicallyFillable).toBe(true);
  expect(old.unrecoverable).toBe(false);
});

test("the export footer row is quarantined, not inserted", async () => {
  const h = harness([EXPORT_FOOTER, GOOD]);
  const result = await backfillRange(h, {
    source: "sf_police_cad",
    from: new Date("2026-09-17T00:00:00.000Z"),
    to: new Date("2026-09-18T00:00:00.000Z"),
  });

  expect(result.quarantined).toBe(1);
  expect(result.created).toBe(1);

  const quarantined = quarantinedRecords(h.db, "sf_police_cad");
  expect(quarantined).toHaveLength(1);
  expect(quarantined[0]?.reason).toContain("export footer");
  // Kept, not dropped: the payload is still there to look at.
  expect(JSON.parse(quarantined[0]?.payload as string)).toEqual(EXPORT_FOOTER as object);
  expect(h.metrics.registry.render()).toContain('reason="validation"');
  h.db.close();
});

test("validation names what is wrong with a row", () => {
  expect(validationFailure(GOOD)).toBeUndefined();
  expect(validationFailure(EXPORT_FOOTER)).toContain("export footer");
  expect(validationFailure({ id: "1" })).toContain("received_datetime");
  expect(validationFailure({ received_datetime: "2026-09-18T00:00:00.000" })).toContain("cad_number");
  // Historical rows have no row id and are still valid.
  expect(validationFailure({ cad_number: "262600914", received_datetime: "2026-09-18T00:00:00.000" })).toBeUndefined();
  expect(validationFailure({ ...GOOD, cad_number: "not-a-number" })).toContain("not numeric");
});

test("backfill is idempotent on the same key as live ingest", async () => {
  const h = harness([GOOD]);
  const range = {
    source: "sf_police_cad",
    from: new Date("2026-09-17T00:00:00.000Z"),
    to: new Date("2026-09-18T00:00:00.000Z"),
  };

  const first = await backfillRange(h, range);
  const second = await backfillRange(h, range);

  expect(first.created).toBe(1);
  expect(second.created).toBe(0);
  expect(second.unchanged).toBe(1);
  expect(h.db.query<{ n: number }, []>("SELECT count(*) AS n FROM observations").get()?.n).toBe(1);
  h.db.close();
});

test("backfilled rows are flagged, so they do not pollute latency metrics", async () => {
  const h = harness([GOOD]);
  await backfillRange(h, {
    source: "sf_police_cad",
    from: new Date("2026-09-17T00:00:00.000Z"),
    to: new Date("2026-09-18T00:00:00.000Z"),
  });
  const row = h.db.query<{ backfilled: number }, []>("SELECT backfilled FROM observations").get();
  expect(row?.backfilled).toBe(1);
  h.db.close();
});

test("a gap too fresh for the historical dataset waits rather than failing", async () => {
  const h = harness([]);
  const now = new Date("2026-09-18T12:00:00.000Z");
  recordGap(
    h.db,
    {
      source: "sf_police_cad",
      from: new Date("2026-09-18T10:00:00.000Z"),
      to: new Date("2026-09-18T11:00:00.000Z"),
    },
    now,
  );

  const summary = await fillOpenGaps({ ...h, now: () => now });
  expect(summary).toEqual({ filled: 0, pending: 1, unrecoverable: 0 });
  expect(openGaps(h.db)[0]?.note).toContain("waiting");
  h.db.close();
});

test("a gap the historical dataset can serve is filled", async () => {
  const h = harness([GOOD]);
  const now = new Date("2026-09-20T12:00:00.000Z");
  recordGap(
    h.db,
    {
      source: "sf_police_cad",
      from: new Date("2026-09-17T08:00:00.000Z"),
      to: new Date("2026-09-17T10:00:00.000Z"),
    },
    now,
  );

  const summary = await fillOpenGaps({ ...h, now: () => now });
  expect(summary.filled).toBe(1);

  const gap = h.db.query<GapRow, []>("SELECT * FROM ingestion_gaps").get();
  expect(gap?.status).toBe("filled");
  expect(gap?.records_filled).toBe(1);
  expect(gap?.filled_at).toBeTruthy();
  h.db.close();
});

test("a gap neither source can serve is a distinct, louder failure", async () => {
  const h = harness([]);
  const now = new Date("2026-09-25T12:00:00.000Z");
  recordGap(
    h.db,
    {
      source: "sf_police_cad",
      from: new Date("2026-09-17T00:00:00.000Z"),
      to: new Date("2026-09-25T11:00:00.000Z"),
    },
    now,
  );

  const summary = await fillOpenGaps({ ...h, now: () => now }, { retentionHours: 40 });
  expect(summary.unrecoverable).toBe(1);

  expect(h.db.query<GapRow, []>("SELECT * FROM ingestion_gaps").get()?.status).toBe("unrecoverable");
  // Louder than ordinary source-health degradation, and distinguishable in the logs.
  expect(h.lines.some((line) => line.event === "gap.unrecoverable" && line.level === "error")).toBe(true);
  h.db.close();
});

test("backfill produces the same observation as live ingest for the same record", async () => {
  const backfilled = harness([GOOD]);
  await backfillRange(backfilled, {
    source: "sf_police_cad",
    from: new Date("2026-09-17T00:00:00.000Z"),
    to: new Date("2026-09-18T00:00:00.000Z"),
  });

  const { runIngestCycle } = await import("../src/ingest.ts");
  const { policeAdapter } = await import("../src/police.ts");
  const live = harness([GOOD]);
  await runIngestCycle({ ...live, adapter: policeAdapter, client: client([GOOD]) });

  const columns =
    "id, source, source_record_id, occurred_at, raw_type, subtype, priority, lat, lng, neighborhood, intersection";
  const fromBackfill = backfilled.db.query(`SELECT ${columns} FROM observations`).get();
  const fromLive = live.db.query(`SELECT ${columns} FROM observations`).get();

  expect(fromBackfill).toEqual(fromLive as object);
  backfilled.db.close();
  live.db.close();
});
