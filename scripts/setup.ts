/**
 * `bun run setup` — everything needed to go from a fresh clone to a working database,
 * idempotently. Running it twice is safe and applies nothing the second time.
 *
 * ADR-003 shrank this story: with SQLite there is no server to install, no database to
 * create, no extension to enable. What is left is "make the file and run the migrations".
 */

import { migrate, openDatabase, databasePath, loadMigrations } from "@scantron/database";
import { checkEnv } from "./env.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function step(message: string): void {
  console.log(`  ${message}`);
}

async function ensureEnvFile(): Promise<void> {
  const envFile = Bun.file(`${ROOT}/.env`);
  if (await envFile.exists()) {
    step(".env exists");
    return;
  }
  await Bun.write(envFile, await Bun.file(`${ROOT}/.env.example`).text());
  step(".env created from .env.example");
}

async function main(): Promise<void> {
  console.log("scantron setup");

  const problems = checkEnv();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem.message}`);
    console.error("\nsetup failed: fix the environment above and re-run.");
    process.exit(1);
  }

  await ensureEnvFile();

  const path = databasePath();
  const db = openDatabase({ path });
  step(`database ${path}`);

  const pending = loadMigrations();
  if (pending.length === 0) {
    step("no migrations yet (S-A2 adds migrations/*.sql)");
  } else {
    const result = migrate(db);
    step(
      result.applied.length > 0
        ? `migrations applied: ${result.applied.join(", ")}`
        : `migrations up to date (${result.alreadyApplied.length})`,
    );
  }

  // Seed steps land with the stories that own their data:
  //   neighborhood polygons  → S-C2
  //   event taxonomy         → S-A4
  // Each will be a function called from here, skipped when already present.

  db.close();
  console.log("\nsetup complete. Next: bun run dev");
}

await main();
