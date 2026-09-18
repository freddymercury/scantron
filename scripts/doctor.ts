/**
 * `bun run doctor` — is this machine able to run scantron? Prints actionable failures,
 * never a stack trace. Exit code 1 if anything is broken.
 */

import { appliedMigrations, databasePath, loadMigrations, openDatabase } from "@scantron/database";
import { ENV_VARS, checkEnv } from "./env.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MIN_BUN = [1, 4, 0] as const;

type Status = "ok" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail: string;
  fix?: string;
}

const checks: Check[] = [];
const add = (check: Check) => checks.push(check);

function checkBunVersion(): void {
  const parts = Bun.version.split(/[.-]/).map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  const ok =
    major > MIN_BUN[0] ||
    (major === MIN_BUN[0] && (minor > MIN_BUN[1] || (minor === MIN_BUN[1] && patch >= MIN_BUN[2])));
  add({
    label: "bun",
    status: ok ? "ok" : "fail",
    detail: Bun.version,
    ...(ok ? {} : { fix: `scantron needs Bun >= ${MIN_BUN.join(".")}. Run: bun upgrade` }),
  });
}

async function checkEnvFile(): Promise<void> {
  const exists = await Bun.file(`${ROOT}/.env`).exists();
  add({
    label: ".env",
    status: exists ? "ok" : "warn",
    detail: exists ? "present" : "missing — defaults will be used",
    ...(exists ? {} : { fix: "Run: bun run setup (copies .env.example)" }),
  });
}

function checkEnvVars(): void {
  const problems = checkEnv();
  if (problems.length === 0) {
    add({ label: "env vars", status: "ok", detail: `${ENV_VARS.length} documented, all usable` });
    return;
  }
  for (const problem of problems) {
    add({ label: `env ${problem.name}`, status: "fail", detail: problem.message });
  }
}

function checkDatabase(): void {
  const path = databasePath();
  try {
    const db = openDatabase({ path });
    db.query("SELECT 1").get();

    const journal = String(
      Object.values(db.query("PRAGMA journal_mode").get() as Record<string, unknown>)[0],
    ).toLowerCase();
    add({
      label: "database",
      status: "ok",
      detail: `${path} (journal_mode=${journal})`,
    });

    const available = loadMigrations().map((m) => m.name);
    const applied = new Set(appliedMigrations(db));
    const pending = available.filter((name) => !applied.has(name));
    add({
      label: "migrations",
      status: pending.length === 0 ? "ok" : "warn",
      detail:
        available.length === 0
          ? "none defined yet (S-A2)"
          : `${applied.size}/${available.length} applied`,
      ...(pending.length > 0 ? { fix: `Pending: ${pending.join(", ")}. Run: bun run setup` } : {}),
    });
    db.close();
  } catch (error) {
    add({
      label: "database",
      status: "fail",
      detail: `${path}: ${(error as Error).message}`,
      fix: "Check DATABASE_URL and that its directory is writable. Run: bun run setup",
    });
  }
}

const ICON: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

async function main(): Promise<void> {
  checkBunVersion();
  await checkEnvFile();
  checkEnvVars();
  checkDatabase();

  const width = Math.max(...checks.map((c) => c.label.length));
  for (const check of checks) {
    console.log(`${ICON[check.status]} ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.fix) console.log(`  ${" ".repeat(width)}→ ${check.fix}`);
  }

  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length > 0) {
    console.log(`\ndoctor: ${failed.length} problem(s) to fix above.`);
    process.exit(1);
  }
  console.log("\ndoctor: ready.");
}

await main();
