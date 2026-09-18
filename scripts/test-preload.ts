/**
 * Loaded before every test file (`bunfig.toml`). Points DATABASE_URL at a disposable
 * per-run database so a test that reaches for the default connection can never touch the
 * development database. Removed when the run ends.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scantron-test-"));
process.env.DATABASE_URL = join(dir, "test.db");

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
