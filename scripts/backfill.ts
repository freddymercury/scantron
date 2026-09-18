/**
 * `bun run backfill --source sf_police_cad --from <ts> --to <ts>` — refill a window from
 * the historical dataset. With no range, works whatever gaps have been detected (S-B5).
 */

import { databasePath, migrate, openDatabase } from "@scantron/database";
import { createAppMetrics, createLogger } from "@scantron/observability";

import { backfillRange, fillOpenGaps } from "../services/sf-cad-ingest/src/backfill.ts";
import { createSocrataClient } from "../services/sf-cad-ingest/src/socrata.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const db = openDatabase({ path: databasePath() });
migrate(db);

const deps = {
  db,
  client: createSocrataClient(),
  metrics: createAppMetrics(),
  log: createLogger({ context: { processor: "backfill" } }),
};

const from = flag("from");
const to = flag("to");
const source = flag("source") ?? "sf_police_cad";

if (from && to) {
  const result = await backfillRange(deps, { source, from: new Date(from), to: new Date(to) });
  console.log(
    `backfilled ${source} ${from} → ${to}: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged, ${result.quarantined} quarantined`,
  );
} else {
  const summary = await fillOpenGaps(deps, { source });
  console.log(
    `gaps: ${summary.filled} filled, ${summary.pending} waiting for the historical dataset, ${summary.unrecoverable} unrecoverable`,
  );
}

db.close();
