/**
 * `bun run setup` — everything needed to go from a fresh clone to a working database,
 * idempotently. Running it twice is safe and applies nothing the second time.
 *
 * ADR-003 shrank this story: with SQLite there is no server to install, no database to
 * create, no extension to enable. What is left is "make the file and run the migrations".
 */

import { migrate, openDatabase, databasePath, loadMigrations } from "@scantron/database";
import type { Database } from "bun:sqlite";
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

/**
 * Neighborhood polygons need the network, and setup must still work offline, so a failure
 * here is a warning rather than an error: everything except neighborhood backfill (S-C2)
 * works without them.
 */
async function ensureNeighborhoods(db: Database): Promise<void> {
  const existing = db.query<{ n: number }, []>("SELECT count(*) AS n FROM neighborhoods").get();
  if ((existing?.n ?? 0) > 0) {
    step(`${existing?.n} neighborhood polygons already loaded`);
    return;
  }
  const loader = Bun.spawnSync(["bun", "run", `${ROOT}/scripts/load-neighborhoods.ts`], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (loader.exitCode === 0) {
    step(loader.stdout.toString().trim());
  } else {
    step("! neighborhood polygons not loaded (offline?) — run: bun run load:neighborhoods");
  }
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

  await ensureNeighborhoods(db);

  // Remaining seed step: the event taxonomy (S-A4), which lands with that story.

  db.close();
  console.log("\nsetup complete. Next: bun run dev");
}

await main();
