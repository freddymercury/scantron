/**
 * `bun run prune:payloads` — collapse stored payload versions that differ only by the feed's
 * batch bookkeeping, and re-hash the survivors.
 *
 * One-off repair for data written before the hash ignored `data_as_of`/`data_loaded_at`.
 * Safe to re-run: on a clean database it finds nothing.
 */

import { databasePath, openDatabase, payloadHash } from "@scantron/database";

const db = openDatabase({ path: databasePath() });
const before = db.query<{ n: number }, []>("SELECT count(*) AS n FROM source_records").get()?.n ?? 0;

let examined = 0;
let removed = 0;
let rehashed = 0;

const records = db
  .query<{ source: string; source_record_id: string }, []>(
    "SELECT source, source_record_id FROM source_records GROUP BY source, source_record_id HAVING count(*) > 1",
  )
  .all();

console.log(`${before} payloads, ${records.length} records with more than one version`);

for (const record of records) {
  const versions = db
    .query<{ id: string; payload: string; fetched_at: string }, [string, string]>(
      "SELECT id, payload, fetched_at FROM source_records WHERE source = ? AND source_record_id = ? ORDER BY fetched_at",
    )
    .all(record.source, record.source_record_id);

  const keep = new Map<string, string>();
  const drop: string[] = [];
  for (const version of versions) {
    examined += 1;
    const hash = payloadHash(JSON.parse(version.payload) as unknown);
    // Earliest wins: its fetched_at is when this content first appeared.
    if (keep.has(hash)) drop.push(version.id);
    else keep.set(hash, version.id);
  }

  const run = db.transaction(() => {
    for (const id of drop) {
      db.query("DELETE FROM source_records WHERE id = ?").run(id);
      removed += 1;
    }
    for (const [hash, id] of keep) {
      db.query("UPDATE source_records SET payload_hash = ? WHERE id = ? AND payload_hash <> ?").run(hash, id, hash);
      rehashed += 1;
    }
  });
  run();
}

const after = db.query<{ n: number }, []>("SELECT count(*) AS n FROM source_records").get()?.n ?? 0;
console.log(
  `examined ${examined}, removed ${removed}, rehashed ${rehashed} — ${before} → ${after} payloads`,
);
db.close();
