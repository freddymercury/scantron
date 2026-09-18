import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appliedMigrations,
  IN_MEMORY,
  loadMigrations,
  migrate,
  openDatabase,
} from "../src/index.ts";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scantron-db-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop() as string, { recursive: true, force: true });
});

test("a writable connection sets the pragmas ADR-003 requires", () => {
  const db = openDatabase({ path: join(tempDir(), "test.db") });
  // The column name a PRAGMA returns is not always the pragma's own name
  // (`busy_timeout` comes back as `timeout`), so read the single value positionally.
  const pragma = (name: string): unknown =>
    Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];

  expect(String(pragma("journal_mode")).toLowerCase()).toBe("wal");
  expect(pragma("synchronous")).toBe(1); // NORMAL
  expect(pragma("foreign_keys")).toBe(1);
  expect(pragma("busy_timeout")).toBe(5000);
  db.close();
});

test("openDatabase creates missing parent directories", () => {
  const path = join(tempDir(), "nested", "deeper", "scantron.db");
  const db = openDatabase({ path });
  db.exec("CREATE TABLE t (a INTEGER) STRICT");
  db.close();
});

test("migrations apply in filename order and only once", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "002-second.sql"), "CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT;");
  writeFileSync(join(dir, "001-first.sql"), "CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT;");
  writeFileSync(join(dir, "notes.md"), "not a migration");

  expect(loadMigrations(dir).map((m) => m.name)).toEqual(["001-first.sql", "002-second.sql"]);

  const db = openDatabase({ path: IN_MEMORY });
  const first = migrate(db, dir);
  expect(first.applied).toEqual(["001-first.sql", "002-second.sql"]);

  const second = migrate(db, dir);
  expect(second.applied).toEqual([]);
  expect(second.alreadyApplied).toEqual(["001-first.sql", "002-second.sql"]);
  expect(appliedMigrations(db)).toEqual(["001-first.sql", "002-second.sql"]);
  db.close();
});

test("a failing migration rolls back and is not recorded", () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "001-bad.sql"),
    "CREATE TABLE ok (id INTEGER PRIMARY KEY) STRICT; THIS IS NOT SQL;",
  );

  const db = openDatabase({ path: IN_MEMORY });
  expect(() => migrate(db, dir)).toThrow();
  expect(appliedMigrations(db)).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'ok'").all()).toEqual([]);
  db.close();
});

test("a missing migrations directory is not an error", () => {
  expect(loadMigrations(join(tempDir(), "absent"))).toEqual([]);
});

test("two processes migrating at once do not collide", async () => {
  const path = join(tempDir(), "race.db");
  const modulePath = new URL("../src/index.ts", import.meta.url).pathname;
  const script = `
    const { migrate, openDatabase } = await import(${JSON.stringify(modulePath)});
    const db = openDatabase({ path: ${JSON.stringify(path)} });
    const result = migrate(db);
    console.log(JSON.stringify(result));
  `;

  const runners = Array.from({ length: 4 }, () =>
    Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }),
  );
  const outcomes = await Promise.all(
    runners.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })),
  );

  for (const outcome of outcomes) {
    expect(`${outcome.code}: ${outcome.stderr}`).toBe("0: ");
  }
  // Each migration is applied exactly once across all processes. Which process wins which
  // migration is a race and does not matter — that no migration runs twice does.
  const applied = outcomes.flatMap(
    (outcome) => (JSON.parse(outcome.stdout) as { applied: string[] }).applied,
  );
  expect(applied.length).toBe(new Set(applied).size);
  expect(applied.length).toBeGreaterThan(0);
});
