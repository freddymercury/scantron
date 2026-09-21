/**
 * `bun run rejoin:reports` — rebuild the SFPD report joins from the observations (S-I2).
 *
 * Timeline entries are immutable by design (S-D5), which is right: a correction is a new
 * entry, not an edit. That rule is about *facts changing*, though, and a fix to the
 * template that renders them is not a fact changing — so the repair is to drop the derived
 * rows and derive them again.
 *
 * This is only safe because the derivation is total: every report attachment and every
 * `report_filed` entry is a pure function of an observation we still hold. Nothing else in
 * the database is touched.
 */

import { openDatabase } from "@scantron/database";
import { joinReport } from "@scantron/correlation";

const db = openDatabase();

const reports = db
  .query<{ id: string; source: string; occurred_at: string; metadata: string | null }, []>(
    `SELECT id, source, occurred_at, metadata FROM observations
      WHERE source = 'sf_police_report' ORDER BY occurred_at`,
  )
  .all();

const before = db
  .query<{ n: number }, []>("SELECT count(*) AS n FROM timeline_events WHERE kind = 'report_filed'")
  .get();

const clear = db.transaction(() => {
  db.query("DELETE FROM timeline_events WHERE kind = 'report_filed'").run();
  db.query(
    `DELETE FROM incident_observations WHERE observation_id IN
       (SELECT id FROM observations WHERE source = 'sf_police_report')`,
  ).run();
});
clear.immediate();

const counts = { joined: 0, unjoinable: 0, no_matching_call: 0, already_attached: 0 };
for (const row of reports) {
  const result = joinReport(db, {
    id: row.id,
    source: row.source,
    occurredAt: new Date(row.occurred_at),
    ...(row.metadata ? { metadata: JSON.parse(row.metadata) as Record<string, unknown> } : {}),
  });
  counts[result.outcome] += 1;
}

const after = db
  .query<{ n: number }, []>("SELECT count(*) AS n FROM timeline_events WHERE kind = 'report_filed'")
  .get();

console.log(`${reports.length} reports · ${JSON.stringify(counts)}`);
console.log(`timeline entries ${before?.n ?? 0} → ${after?.n ?? 0}`);
console.log(
  `join rate ${((100 * counts.joined) / Math.max(1, reports.length)).toFixed(1)}% of all reports`,
);
db.close();
