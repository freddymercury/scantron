/** `bun run db:migrate` — apply pending migrations and say what happened. */

import { databasePath, migrate, openDatabase } from "@scantron/database";

const path = databasePath();
const db = openDatabase({ path });
const result = migrate(db);
db.close();

if (result.applied.length === 0) {
  console.log(`${path}: up to date (${result.alreadyApplied.length} applied)`);
} else {
  console.log(`${path}: applied ${result.applied.join(", ")}`);
}
