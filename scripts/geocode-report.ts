/**
 * `bun run report:geocoding` — how much of the data resolves to coordinates, and where the
 * shortfall is (S-C2 asks for >=90%, reported by source and reason).
 */

import { databasePath, openDatabase } from "@scantron/database";

const hours = Number(process.argv[2] ?? 24);
const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
const db = openDatabase({ path: databasePath(), readonly: true });

interface Row {
  source: string;
  method: string | null;
  n: number;
  located: number;
}

const rows = db
  .query<Row, [string]>(
    `SELECT source,
            location_method AS method,
            count(*) AS n,
            sum(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS located
       FROM observations
      WHERE occurred_at >= ?
      GROUP BY source, location_method
      ORDER BY source, n DESC`,
  )
  .all(since);

const totals = new Map<string, { n: number; located: number }>();
for (const row of rows) {
  const total = totals.get(row.source) ?? { n: 0, located: 0 };
  total.n += row.n;
  total.located += row.located;
  totals.set(row.source, total);
}

console.log(`geocoding report — observations since ${since} (${hours}h)\n`);
for (const [source, total] of totals) {
  const rate = total.n === 0 ? 0 : (total.located / total.n) * 100;
  const verdict = rate >= 90 ? "ok" : "BELOW TARGET";
  console.log(`${source}: ${total.located}/${total.n} located (${rate.toFixed(1)}%) — ${verdict}`);
  for (const row of rows.filter((candidate) => candidate.source === source)) {
    console.log(`  ${(row.method ?? "not yet geocoded").padEnd(22)} ${row.n}`);
  }
  console.log();
}

// The shortfall is dominated by one upstream fact (docs/01 §8): SFPD publishes no
// location at all for `sensitive_call` records, so those can never be located by us. The
// rate that measures *our* work is the one over records that came with a location.
const locatable = db
  .query<{ n: number; located: number }, [string]>(
    `SELECT count(*) AS n,
            sum(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS located
       FROM observations
      WHERE occurred_at >= ? AND (sensitive IS NULL OR sensitive = 0)`,
  )
  .get(since);
if (locatable && locatable.n > 0) {
  const rate = (locatable.located / locatable.n) * 100;
  console.log(
    `excluding location-suppressed sensitive calls: ${locatable.located}/${locatable.n} located (${rate.toFixed(1)}%) — ${rate >= 90 ? "ok" : "BELOW TARGET"}\n`,
  );
}

const suppressed = db
  .query<{ n: number }, [string]>(
    `SELECT count(*) AS n FROM observations
      WHERE occurred_at >= ? AND sensitive = 1 AND location_raw IS NULL`,
  )
  .get(since);
if (suppressed && suppressed.n > 0) {
  console.log(`location suppressed upstream (sensitive_call): ${suppressed.n}\n`);
}

const unresolved = db
  .query<{ source: string; neighborhood: string | null; n: number }, [string]>(
    `SELECT source, neighborhood, count(*) AS n
       FROM observations
      WHERE occurred_at >= ? AND (lat IS NULL OR lng IS NULL)
      GROUP BY source, neighborhood ORDER BY n DESC LIMIT 10`,
  )
  .all(since);

if (unresolved.length > 0) {
  console.log("unresolved, by source:");
  for (const row of unresolved) {
    console.log(`  ${row.source} ${row.n}`);
  }
}

const neighborhoods = db
  .query<{ n: number; with_hood: number }, [string]>(
    `SELECT count(*) AS n, sum(CASE WHEN neighborhood IS NOT NULL THEN 1 ELSE 0 END) AS with_hood
       FROM observations WHERE occurred_at >= ?`,
  )
  .get(since);
if (neighborhoods) {
  const rate = neighborhoods.n === 0 ? 0 : (neighborhoods.with_hood / neighborhoods.n) * 100;
  console.log(`\nneighborhood assigned: ${neighborhoods.with_hood}/${neighborhoods.n} (${rate.toFixed(1)}%)`);
}

db.close();
