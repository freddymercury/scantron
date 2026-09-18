/**
 * scantron lint — the rules this repo actually cares about, as code.
 *
 * ADR-002 targets zero runtime dependencies, so there is no ESLint. What matters here
 * is architectural, not stylistic, and tsc covers the rest:
 *
 *   1. No third-party runtime dependencies in any workspace (`workspace:*` is fine).
 *   2. No service imports another service (S-A1 technical notes).
 *   3. Cross-workspace imports use the `@scantron/*` aliases, never deep relative paths.
 *   4. Every `@scantron/*` alias resolves to a real package.
 *   5. Every `process.env` variable read anywhere is documented in `.env.example`.
 */

import { Glob } from "bun";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

interface Problem {
  file: string;
  message: string;
}

const problems: Problem[] = [];
const fail = (file: string, message: string) => problems.push({ file, message });

const rel = (path: string) => path.slice(ROOT.length + 1);

async function packageJsonPaths(): Promise<string[]> {
  const glob = new Glob("{apps,services,packages}/*/package.json");
  return (await Array.fromAsync(glob.scan({ cwd: ROOT, absolute: true }))).sort();
}

async function sourcePaths(): Promise<string[]> {
  const glob = new Glob("{apps,services,packages,scripts}/**/*.ts");
  return (await Array.fromAsync(glob.scan({ cwd: ROOT, absolute: true }))).sort();
}

const SERVICES = ["sf-cad-ingest", "incident-correlator"];

// Anchored to the start of a line so that import specifiers quoted inside strings
// (this file quotes several) are not mistaken for real imports.
const IMPORT_RE =
  /^\s*(?:import|export)\s+(?:[^'"]*\sfrom\s*)?["']([^"']+)["']/gm;

function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] as string);
}

async function main(): Promise<void> {
  const pkgPaths = await packageJsonPaths();
  const workspaceNames = new Set<string>();

  for (const path of pkgPaths) {
    const pkg = (await Bun.file(path).json()) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    if (!pkg.name) {
      fail(rel(path), "workspace package.json has no name");
      continue;
    }
    workspaceNames.add(pkg.name);

    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!dep.startsWith("@scantron/")) {
        fail(rel(path), `runtime dependency "${dep}" — ADR-002 targets zero runtime deps`);
      } else if (!range.startsWith("workspace:")) {
        fail(rel(path), `internal dependency "${dep}" must use "workspace:*", got "${range}"`);
      }
    }
  }

  const declaredEnv = new Set<string>();
  const envExample = Bun.file(`${ROOT}/.env.example`);
  if (!(await envExample.exists())) {
    fail(".env.example", "missing — S-A1 requires one root .env.example");
  } else {
    for (const line of (await envExample.text()).split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
      if (match) declaredEnv.add(match[1] as string);
    }
  }

  for (const path of await sourcePaths()) {
    const source = await Bun.file(path).text();
    const where = rel(path);
    const isService = where.startsWith("services/");
    const service = isService ? (where.split("/")[1] as string) : null;

    for (const specifier of importsOf(source)) {
      if (specifier.startsWith("@scantron/")) {
        const name = specifier.split("/").slice(0, 2).join("/");
        if (!workspaceNames.has(name)) {
          fail(where, `imports "${specifier}", which is not a workspace`);
        }
        const target = name.slice("@scantron/".length);
        if (service && target !== service && SERVICES.includes(target)) {
          fail(where, `imports "${specifier}" — services must not import each other`);
        }
        continue;
      }
      if (specifier.startsWith(".")) {
        if (specifier.includes("../../")) {
          fail(where, `deep relative import "${specifier}" — use an @scantron/* alias`);
        }
        continue;
      }
      if (specifier.startsWith("bun") || specifier.startsWith("node:")) continue;
      fail(where, `imports third-party module "${specifier}" — ADR-002 targets zero runtime deps`);
    }

    if (isService) {
      for (const other of SERVICES) {
        if (other !== service && source.includes(`services/${other}`)) {
          fail(where, `references services/${other} — services must not import each other`);
        }
      }
    }

    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = match[1] as string;
      if (!declaredEnv.has(name)) {
        fail(where, `reads process.env.${name}, which is not documented in .env.example`);
      }
    }
  }

  if (problems.length === 0) {
    console.log("lint: clean");
    return;
  }
  for (const { file, message } of problems) console.error(`${file}: ${message}`);
  console.error(`\nlint: ${problems.length} problem(s)`);
  process.exit(1);
}

await main();
