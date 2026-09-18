/**
 * A test database is a file — or, cheaper, no file at all. ADR-003 §6.
 */

import type { Database } from "bun:sqlite";
import { migrate, openDatabase, IN_MEMORY } from "./index.ts";

/** A fresh, fully migrated, in-memory database. Close it when the test is done. */
export function createTestDatabase(): Database {
  const db = openDatabase({ path: IN_MEMORY });
  migrate(db);
  return db;
}
