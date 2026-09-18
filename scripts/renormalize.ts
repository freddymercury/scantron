/**
 * `bun run renormalize [--from ISO] [--to ISO] [--source s]` — re-apply the taxonomy to a
 * date range after a mapping change (S-C3).
 */

import { databasePath, migrate, openDatabase } from "@scantron/database";
import { createPriorityMapper, createTaxonomy } from "@scantron/event-taxonomy";
import { createAppMetrics, createLogger } from "@scantron/observability";

import { renormalizeRange } from "../services/incident-correlator/src/handlers/normalize.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const db = openDatabase({ path: databasePath() });
migrate(db);

const deps = {
  db,
  taxonomy: createTaxonomy(db),
  priorities: createPriorityMapper(),
  metrics: createAppMetrics(),
  log: createLogger({ context: { processor: "renormalize" } }),
};

const range = {
  ...(flag("from") ? { from: flag("from") as string } : {}),
  ...(flag("to") ? { to: flag("to") as string } : {}),
  ...(flag("source") ? { source: flag("source") as string } : {}),
};

const result = renormalizeRange(deps, range);
console.log(
  `renormalized ${result.examined} observations: ${result.changed} changed type, ${result.recorrelated} incidents queued for re-correlation`,
);
db.close();
