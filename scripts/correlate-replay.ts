/**
 * `bun run replay:correlation` — run correlation over stored observations in time order
 * and report what it produced.
 *
 * This measures the product's central hypothesis (PRD §54, docs/05): that thousands of
 * observations are dozens of incidents. It is a *replay*, not a migration: it writes into a
 * copy of the database so the numbers can be produced repeatedly without consequence.
 */

import { copyFileSync } from "node:fs";
import {
  applyDecision,
  applyDecisionJudged,
  correlationConfig,
  countDecisions,
  createJevJudge,
  type CandidateObservation,
} from "@scantron/correlation";
import { databasePath, migrate, openDatabase } from "@scantron/database";

const hours = Number(process.argv[2] ?? 24);
const source = `${databasePath()}`;
const replayPath = `${source}.replay`;

copyFileSync(source, replayPath);
const db = openDatabase({ path: replayPath });
migrate(db);

// A replay starts from no incidents: the point is what correlation produces, not what it
// produced last time.
db.query("DELETE FROM incident_observations").run();
db.query("DELETE FROM probable_matches").run();
db.query("DELETE FROM incidents").run();

const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
const rows = db
  .query<
    {
      id: string;
      source: string;
      occurred_at: string;
      lat: number | null;
      lng: number | null;
      neighborhood: string | null;
      type: string | null;
      units: string | null;
      location_normalized: string | null;
      subtype: string | null;
    },
    [string]
  >(
    `SELECT id, source, occurred_at, lat, lng, neighborhood, type, units, location_normalized, subtype
       FROM observations WHERE occurred_at >= ? ORDER BY occurred_at`,
  )
  .all(since);

const config = correlationConfig(db).get();
// `--judge` consults the decision model on the probable band only (~6% of pairs).
const useJudge = process.argv.includes("--judge");
const judge = createJevJudge();
if (useJudge && !judge.available) console.log("(--judge given but no JEV_API_KEY; running without)");

const startedAt = performance.now();
let merged = 0;
let probable = 0;
let created = 0;
const crossAgency: string[] = [];
const judged: string[] = [];

for (const row of rows) {
  const observation: CandidateObservation = {
    id: row.id,
    source: row.source,
    occurredAt: new Date(row.occurred_at),
    ...(row.lat === null ? {} : { lat: row.lat }),
    ...(row.lng === null ? {} : { lng: row.lng }),
    ...(row.neighborhood === null ? {} : { neighborhood: row.neighborhood }),
    ...(row.type === null ? {} : { type: row.type }),
    ...(row.subtype === null ? {} : { rawType: row.subtype }),
    ...(row.units === null ? {} : { units: JSON.parse(row.units) as string[] }),
    ...(row.location_normalized === null ? {} : { locationCanonical: row.location_normalized }),
  };

  const result =
    useJudge && judge.available
      ? await applyDecisionJudged(db, {
          observation,
          config,
          judge,
          title: row.subtype ?? row.type ?? "Incident",
        })
      : applyDecision(db, { observation, config, title: row.subtype ?? row.type ?? "Incident" });
  if (result.judgedBy) judged.push(`${row.subtype ?? row.type} — ${result.judgedBy}`);

  if (result.decision === "merged" && !result.alreadyAttached) {
    merged += 1;
    const best = result.best;
    if (best && !best.candidate.agencyTypes.includes(agencyOf(row.source))) {
      crossAgency.push(
        `${row.occurred_at.slice(11, 19)} ${row.source.padEnd(14)} ${(row.subtype ?? "").slice(0, 26).padEnd(26)} → ${best.candidate.primaryType} @ ${best.candidate.locationDisplayName ?? "?"} (${best.score.score.toFixed(3)})`,
      );
    }
  } else if (result.decision === "probable") probable += 1;
  else if (result.decision === "created") created += 1;
}

function agencyOf(source: string): string {
  return source === "sf_police_cad" ? "police" : source === "sf_fire_cad" ? "fire" : source === "sf_ems_cad" ? "ems" : "other";
}

const elapsed = (performance.now() - startedAt) / 1000;
const incidents = db.query<{ n: number }, []>("SELECT count(*) AS n FROM incidents").get()?.n ?? 0;
const multi = db
  .query<{ n: number }, []>("SELECT count(*) AS n FROM incidents WHERE source_count > 1")
  .get()?.n ?? 0;
const crossAgencyIncidents = db
  .query<{ n: number }, []>(
    "SELECT count(*) AS n FROM incidents WHERE json_array_length(agency_types) > 1",
  )
  .get()?.n ?? 0;

console.log(`\ncorrelation replay — ${hours}h, ${rows.length} observations, ${elapsed.toFixed(1)}s\n`);
console.log(`  observations   ${rows.length}`);
console.log(`  incidents      ${incidents}`);
console.log(`  reduction      ${rows.length === 0 ? 0 : (100 * (1 - incidents / rows.length)).toFixed(1)}%`);
console.log(`  merged         ${merged}`);
console.log(`  probable       ${probable}   (logged for review, not merged)`);
console.log(`  created        ${created}`);
console.log(`  multi-source   ${multi} incidents`);
console.log(`  cross-agency   ${crossAgencyIncidents} incidents`);
console.log(`  decisions      ${JSON.stringify(countDecisions(db))}`);

if (useJudge && judge.available) {
  console.log(
    `\n  judge: ${judge.stats.requests} requests, ${judge.stats.failures} failed, ${judge.stats.timeouts} timed out, $${judge.stats.costUsd.toFixed(5)}, ${judged.length} decisions moved`,
  );
  for (const line of judged.slice(0, 8)) console.log(`    ${line.slice(0, 120)}`);
}

if (crossAgency.length > 0) {
  console.log(`\n  cross-agency merges (first 10):`);
  for (const line of crossAgency.slice(0, 10)) console.log(`    ${line}`);
}

db.close();
