/**
 * S-D1's performance criterion, measured rather than assumed: p95 under 50 ms against
 * 100,000 incidents. This is the hottest query in the system — every observation runs it —
 * and ADR-003 chose the `(occurred_at, lat, lng)` index specifically for it.
 */

import { expect, test } from "bun:test";
import { createTestDatabase } from "@scantron/database/testing";

import { findCandidates, type CandidateObservation } from "../src/index.ts";

const SF = { south: 37.705, north: 37.812, west: -122.517, east: -122.357 };
const DAYS = 30;

function seed(db: ReturnType<typeof createTestDatabase>, count: number): void {
  const insert = db.query(
    `INSERT INTO incidents (id, primary_type, title, agency_types, status, lat, lng, neighborhood,
       first_observed_at, last_updated_at, units, confidence, verification_classification)
     VALUES (?, 'collision', 'x', '["police"]', 'active', ?, ?, 'Mission', ?, ?, '[]', 0.5, 'reported')`,
  );
  const start = Date.parse("2026-08-19T00:00:00.000Z");
  const spanMs = DAYS * 24 * 3600 * 1000;

  const run = db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const at = new Date(start + Math.random() * spanMs).toISOString();
      insert.run(
        `inc_${i}`,
        SF.south + Math.random() * (SF.north - SF.south),
        SF.west + Math.random() * (SF.east - SF.west),
        at,
        at,
      );
    }
  });
  run();
}

test(
  "candidate retrieval stays under 50 ms at p95 with 100k incidents",
  () => {
    const db = createTestDatabase();
    seed(db, 100_000);

    const observations: CandidateObservation[] = Array.from({ length: 200 }, (_, i) => ({
      id: `obs_${i}`,
      source: "sf_fire_cad",
      occurredAt: new Date(Date.parse("2026-08-19T00:00:00.000Z") + Math.random() * DAYS * 24 * 3600 * 1000),
      lat: SF.south + Math.random() * (SF.north - SF.south),
      lng: SF.west + Math.random() * (SF.east - SF.west),
      neighborhood: "Mission",
    }));

    const timings: number[] = [];
    let found = 0;
    for (const observation of observations) {
      const startedAt = performance.now();
      found += findCandidates(db, observation).candidates.length;
      timings.push(performance.now() - startedAt);
    }
    timings.sort((a, b) => a - b);

    const p50 = timings[Math.floor(timings.length * 0.5)] as number;
    const p95 = timings[Math.floor(timings.length * 0.95)] as number;
    console.log(
      `100k incidents · 200 lookups · p50 ${p50.toFixed(3)} ms · p95 ${p95.toFixed(3)} ms · ${found} candidates found`,
    );

    expect(p95).toBeLessThan(50);

    // The index is what makes that true, so a plan change should fail here rather than
    // quietly cost 1,100x (ADR-003).
    const plan = db
      .query<{ detail: string }, []>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM incidents
          WHERE first_observed_at BETWEEN '2026-08-20T00:00:00.000Z' AND '2026-08-20T00:30:00.000Z'
            AND lat BETWEEN 37.77 AND 37.79 AND lng BETWEEN -122.42 AND -122.40
            AND merged_into_id IS NULL`,
      )
      .all()
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("incidents_time_loc_idx");
    db.close();
  },
  { timeout: 120_000 },
);
