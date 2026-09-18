/**
 * `bun run fixtures:correlation` — build the labelled evaluation set (S-D10).
 *
 * Labels come from two places, and the difference between them matters:
 *
 * 1. **The agency's own key.** When SFFD dispatches both an engine and a medic to one
 *    call, both rows carry the same `call_number`. Those are ground truth, free, and
 *    independent of anything this system computes.
 * 2. **Hand judgement of the pair shape.** Cross-agency pairs have no shared key, so a
 *    human decides: an assault and a medical call at one corner four minutes apart is one
 *    event; a burglary and a medical call is two. The decisions are a table in this file
 *    rather than scattered opinions, so they can be argued with.
 *
 * The honest caveat, stated here and in the eval output: hand labels lean on type
 * compatibility, and the scorer has a type-affinity feature, so the two are not fully
 * independent. The agency-key cases are, and they are reported separately for that reason.
 */

import { openDatabase, databasePath } from "@scantron/database";
import type { FixtureCase, FixtureObservation, FixtureSet } from "@scantron/correlation";

/** Pair shapes a reviewer reads as one event, with how long the gap may be. */
const SAME_SHAPES: readonly { a: RegExp; b: RegExp; maxGapMinutes: number; why: string }[] = [
  { a: /ASSAULT|FIGHT|STABBING|BATTERY|PERSON W\/(KNIFE|GUN)/i, b: /^Medical Incident$/i, maxGapMinutes: 15, why: "a medic responding to a reported assault" },
  { a: /^Medical Incident$/i, b: /ASSAULT|FIGHT|STABBING|BATTERY/i, maxGapMinutes: 15, why: "police following a medical call that turned out to be an assault" },
  { a: /ACCIDENT|COLLISION/i, b: /ACCIDENT|COLLISION/i, maxGapMinutes: 10, why: "both agencies on one collision" },
  { a: /ACCIDENT|COLLISION/i, b: /^Medical Incident$/i, maxGapMinutes: 10, why: "a medic at a collision" },
  { a: /^Medical Incident$/i, b: /ACCIDENT|COLLISION/i, maxGapMinutes: 10, why: "a collision reported first as a medical call" },
  { a: /^(FIRE|Outside Fire|Structure Fire.*|Vehicle Fire|Smoke Investigation.*)$/i, b: /^(FIRE|Outside Fire|Structure Fire.*|Vehicle Fire|Smoke Investigation.*)$/i, maxGapMinutes: 12, why: "one fire, reported to both agencies" },
  { a: /AIDED CASE|MENTALLY DISTURBED|SUICIDE|INTOXICATED|OVERDOSE/i, b: /^Medical Incident$/i, maxGapMinutes: 12, why: "a police welfare call and the ambulance for it" },
  { a: /^Medical Incident$/i, b: /AIDED CASE|MENTALLY DISTURBED|SUICIDE|INTOXICATED/i, maxGapMinutes: 12, why: "the same person, both agencies" },
  { a: /WELL BEING CHECK/i, b: /^Medical Incident$/i, maxGapMinutes: 8, why: "a welfare check that became a medical call" },
];

/** Shapes a reviewer reads as two different events at one busy corner. */
const DIFFERENT_SHAPES: readonly { a: RegExp; b: RegExp; why: string }[] = [
  { a: /BURGLARY|FRAUD|THEFT|SHOPLIFT|AUTO BOOST/i, b: /^Medical Incident$/i, why: "a property crime and a medical call are not one event" },
  { a: /VANDALISM|GRAFFITI/i, b: /^Medical Incident$/i, why: "vandalism and a medical call" },
  { a: /TRAF VIOLATION|TRAFFIC STOP|SIT\/LIE|PARKING/i, b: /^Medical Incident$/i, why: "a traffic citation and a medical call" },
  { a: /^Medical Incident$/i, b: /TRAF VIOLATION|TRAFFIC STOP|SIT\/LIE/i, why: "a medical call and a traffic citation" },
  { a: /SUSPICIOUS (PERSON|VEHICLE)|PROWLER/i, b: /^(Outside Fire|Alarms|Structure Fire.*)$/i, why: "a suspicious-person call and a fire call" },
  { a: /^Alarms$/i, b: /SUSPICIOUS PERSON|NOISE|PERSON W\/KNIFE/i, why: "an alarm and an unrelated police call" },
  { a: /NOISE NUISANCE/i, b: /^Alarms$/i, why: "a noise complaint and a fire alarm" },
  { a: /SHOT SPOTTER|SHOTS FIRED/i, b: /^Alarms$/i, why: "gunfire detection and a fire alarm" },
  { a: /MISSING (ADULT|JUVENILE)/i, b: /^Medical Incident$/i, why: "a missing person report and a medical call" },
  { a: /^Medical Incident$/i, b: /BURGLARY|VANDALISM|FRAUD|THEFT/i, why: "a medical call and a property crime" },
];

interface Row {
  id: string;
  source: string;
  occurred_at: string;
  type: string | null;
  subtype: string | null;
  raw_type: string | null;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
  location_normalized: string | null;
  units: string | null;
}

const COLUMNS =
  "id, source, occurred_at, type, subtype, raw_type, lat, lng, neighborhood, location_normalized, units";

function toFixture(row: Row): FixtureObservation {
  return {
    id: row.id,
    source: row.source,
    occurredAt: row.occurred_at,
    ...(row.type ? { type: row.type } : {}),
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(row.raw_type ? { rawType: row.raw_type } : {}),
    ...(row.lat === null ? {} : { lat: row.lat }),
    ...(row.lng === null ? {} : { lng: row.lng }),
    ...(row.neighborhood ? { neighborhood: row.neighborhood } : {}),
    ...(row.location_normalized ? { locationCanonical: row.location_normalized } : {}),
    ...(row.units ? { units: JSON.parse(row.units) as string[] } : {}),
  };
}

const db = openDatabase({ path: databasePath(), readonly: true });
const cases: FixtureCase[] = [];

// 1. Ground truth: one SFFD call dispatched to both a fire unit and a medic.
const keyed = db
  .query<{ fire: string; ems: string }, []>(
    `SELECT f.id AS fire, e.id AS ems
       FROM observations f JOIN observations e ON e.source_record_id = f.source_record_id
      WHERE f.source = 'sf_fire_cad' AND e.source = 'sf_ems_cad'
      ORDER BY f.occurred_at DESC LIMIT 45`,
  )
  .all();

for (const pair of keyed) {
  const a = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.fire);
  const b = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.ems);
  if (!a || !b) continue;
  cases.push({
    id: `key_${cases.length + 1}`,
    label: "same",
    labelSource: "agency_call_number",
    note: `SFFD call ${a.id.split("_").pop()} dispatched to both a fire unit and a medic`,
    observations: [toFixture(a), toFixture(b)],
  });
}

// 2. Hand-judged cross-agency pairs at one canonical location within 20 minutes.
const pairs = db
  .query<{ aid: string; bid: string; asub: string | null; bsub: string | null; gap: number }, []>(
    `SELECT a.id AS aid, b.id AS bid, a.subtype AS asub, b.subtype AS bsub,
            (julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60 AS gap
       FROM observations a JOIN observations b
         ON b.location_normalized = a.location_normalized
        AND b.source <> a.source
        AND b.occurred_at > a.occurred_at
        AND (julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60 <= 20
      WHERE a.location_normalized IS NOT NULL AND a.location_normalized <> 'Not Available'
      ORDER BY a.occurred_at DESC LIMIT 600`,
  )
  .all();

const usedShapes = new Map<string, number>();
for (const pair of pairs) {
  const asub = pair.asub ?? "";
  const bsub = pair.bsub ?? "";
  const shape = `${asub}|${bsub}`;
  // Cap repeats so one common shape cannot dominate the metric.
  if ((usedShapes.get(shape) ?? 0) >= 3) continue;

  const same = SAME_SHAPES.find(
    (rule) => rule.a.test(asub) && rule.b.test(bsub) && pair.gap <= rule.maxGapMinutes,
  );
  const different = DIFFERENT_SHAPES.find((rule) => rule.a.test(asub) && rule.b.test(bsub));
  if (!same && !different) continue;

  const a = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.aid);
  const b = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.bid);
  if (!a || !b) continue;

  usedShapes.set(shape, (usedShapes.get(shape) ?? 0) + 1);
  cases.push({
    id: `hand_${cases.length + 1}`,
    label: same ? "same" : "different",
    labelSource: "hand",
    note: `${asub} + ${bsub}, ${pair.gap.toFixed(1)} min apart — ${(same ?? different)?.why}`,
    observations: [toFixture(a), toFixture(b)],
  });
}

// 3. Negatives that need no judgement at all: one corner, far enough apart in time that
//    no dispatch pattern connects them.
const distant = db
  .query<{ aid: string; bid: string; gap: number }, []>(
    `SELECT a.id AS aid, b.id AS bid,
            (julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60 AS gap
       FROM observations a JOIN observations b
         ON b.location_normalized = a.location_normalized
        AND b.source <> a.source
        AND (julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60 BETWEEN 45 AND 240
      WHERE a.location_normalized IS NOT NULL AND a.location_normalized <> 'Not Available'
      ORDER BY a.occurred_at DESC LIMIT 20`,
  )
  .all();

for (const pair of distant) {
  const a = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.aid);
  const b = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.bid);
  if (!a || !b) continue;
  cases.push({
    id: `apart_${cases.length + 1}`,
    label: "different",
    labelSource: "hand",
    note: `same corner, ${pair.gap.toFixed(0)} min apart — too far apart in time to be one dispatch`,
    observations: [toFixture(a), toFixture(b)],
  });
}

// 3b. The *hard* negatives, and the ones that decide how wide the time window may be:
//     one corner, compatible types, but far enough apart that dispatch would have closed
//     the first call before the second arrived. Without these, widening the time tolerance
//     looks free — the metric cannot see the risk it creates.
const hardNegatives = db
  .query<{ aid: string; bid: string; gap: number }, []>(
    `SELECT a.id AS aid, b.id AS bid,
            (julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60 AS gap
       FROM observations a JOIN observations b
         ON b.location_normalized = a.location_normalized
        AND b.source <> a.source
        AND (julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60 BETWEEN 25 AND 44
      WHERE a.location_normalized IS NOT NULL AND a.location_normalized <> 'Not Available'
        AND a.type IS NOT NULL AND b.type IS NOT NULL
      ORDER BY a.occurred_at DESC LIMIT 16`,
  )
  .all();

for (const pair of hardNegatives) {
  const a = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.aid);
  const b = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.bid);
  if (!a || !b) continue;
  cases.push({
    id: `hard_${cases.length + 1}`,
    label: "different",
    labelSource: "hand",
    note: `${a.subtype} + ${b.subtype} at one corner, ${pair.gap.toFixed(0)} min apart — a separate dispatch, however compatible the types look`,
    observations: [toFixture(a), toFixture(b)],
  });
}

// 4. And the other easy negative: near-simultaneous calls in different neighborhoods.
const elsewhere = db
  .query<{ aid: string; bid: string }, []>(
    `SELECT a.id AS aid, b.id AS bid
       FROM observations a JOIN observations b
         ON b.source <> a.source
        AND abs((julianday(b.occurred_at) - julianday(a.occurred_at)) * 24 * 60) <= 3
        AND b.neighborhood <> a.neighborhood
      WHERE a.neighborhood IS NOT NULL AND b.neighborhood IS NOT NULL
        AND a.lat IS NOT NULL AND b.lat IS NOT NULL
      ORDER BY a.occurred_at DESC LIMIT 18`,
  )
  .all();

for (const pair of elsewhere) {
  const a = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.aid);
  const b = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(pair.bid);
  if (!a || !b) continue;
  cases.push({
    id: `far_${cases.length + 1}`,
    label: "different",
    labelSource: "hand",
    note: `simultaneous calls in ${a.neighborhood} and ${b.neighborhood} — different places entirely`,
    observations: [toFixture(a), toFixture(b)],
  });
}

// 5. `--from-probable` pulls the correlator's own near misses into new cases, unlabelled
//    but noted, so a reviewer can judge them and grow the set where it is weakest.
if (process.argv.includes("--from-probable")) {
  const probable = db
    .query<{ observation_id: string; incident_id: string; score: number }, []>(
      `SELECT observation_id, incident_id, score FROM probable_matches ORDER BY score DESC LIMIT 25`,
    )
    .all();

  for (const row of probable) {
    const a = db.query<Row, [string]>(`SELECT ${COLUMNS} FROM observations WHERE id = ?`).get(row.observation_id);
    const seed = db
      .query<Row, [string]>(
        `SELECT ${COLUMNS} FROM observations
          WHERE id = (SELECT observation_id FROM incident_observations WHERE incident_id = ? ORDER BY attached_at LIMIT 1)`,
      )
      .get(row.incident_id);
    if (!a || !seed) continue;
    cases.push({
      id: `probable_${cases.length + 1}`,
      label: "different",
      labelSource: "hand",
      note: `NEEDS REVIEW — correlator scored ${row.score.toFixed(3)}, in the probable band: ${seed.subtype} + ${a.subtype}`,
      observations: [toFixture(seed), toFixture(a)],
    });
  }
}

const fixtures: FixtureSet = {
  version: new Date().toISOString().slice(0, 10),
  generatedAt: new Date().toISOString(),
  note:
    "Real observations from live SF dispatch feeds. `agency_call_number` cases are ground " +
    "truth — one SFFD call dispatched to two unit types. `hand` cases are a reviewer's " +
    "judgement of the pair shape, and lean partly on type compatibility, which the scorer " +
    "also uses; the eval reports the two label sources separately for that reason.",
  cases,
};

const path = new URL("../packages/correlation/fixtures/correlation-cases.json", import.meta.url).pathname;
await Bun.write(path, `${JSON.stringify(fixtures, null, 1)}\n`);

const same = cases.filter((testCase) => testCase.label === "same").length;
console.log(
  `wrote ${cases.length} cases (${same} same, ${cases.length - same} different) to ${path}`,
);
db.close();
