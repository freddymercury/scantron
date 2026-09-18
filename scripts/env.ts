/**
 * The environment contract, in one place: `.env.example` documents these for humans,
 * this file is what `setup` and `doctor` check. Keep the two in step — `bun run lint`
 * fails if code reads a variable `.env.example` does not document.
 */

export interface EnvVar {
  name: string;
  required: boolean;
  description: string;
  /** Used when the variable is absent; also what `.env.example` should show. */
  fallback?: string;
}

export const ENV_VARS: readonly EnvVar[] = [
  {
    name: "DATABASE_URL",
    required: false,
    fallback: "./data/scantron.db",
    description: "SQLite file path (ADR-003)",
  },
  { name: "WEB_PORT", required: false, fallback: "3000", description: "Port for apps/web" },
  {
    name: "DATASF_HOST",
    required: false,
    fallback: "https://data.sf.gov",
    description: "DataSF host; data.sfgov.org 301-redirects here",
  },
  {
    name: "DATASF_APP_TOKEN",
    required: false,
    description: "Socrata app token; unauthenticated requests are throttled harder",
  },
  {
    name: "INGEST_POLL_SECONDS",
    required: false,
    fallback: "60",
    description: "Poll interval; the feed is a ~30 min batch, so 15s only wastes quota",
  },
  {
    name: "INGEST_POLL_SECONDS_SF_POLICE_CAD",
    required: false,
    fallback: "60",
    description: "Per-source poll interval override",
  },
  {
    name: "INGEST_POLL_SECONDS_SF_FIRE_CAD",
    required: false,
    fallback: "900",
    description: "Per-source poll interval override; this feed runs ~19 h behind",
  },
  {
    name: "INGEST_POLL_SECONDS_SF_EMS_CAD",
    required: false,
    fallback: "900",
    description: "Per-source poll interval override; shares the SFFD dataset",
  },
  {
    name: "INGEST_HEALTH_PORT",
    required: false,
    fallback: "3101",
    description: "Port for sf-cad-ingest /metrics and /health",
  },
  {
    name: "CORRELATOR_HEALTH_PORT",
    required: false,
    fallback: "3102",
    description: "Port for incident-correlator /metrics and /health",
  },
  { name: "LOG_LEVEL", required: false, fallback: "info", description: "debug | info | warn | error" },
] as const;

export interface EnvProblem {
  name: string;
  message: string;
}

export function checkEnv(
  env: Record<string, string | undefined> = process.env,
  vars: readonly EnvVar[] = ENV_VARS,
): EnvProblem[] {
  const problems: EnvProblem[] = [];
  for (const spec of vars) {
    const value = env[spec.name];
    if (spec.required && !value?.trim()) {
      problems.push({
        name: spec.name,
        message: `${spec.name} is required and unset — ${spec.description}. Set it in .env (see .env.example).`,
      });
    }
  }
  const port = env.WEB_PORT;
  if (port && !/^\d+$/.test(port)) {
    problems.push({ name: "WEB_PORT", message: `WEB_PORT must be a number, got "${port}"` });
  }
  const poll = env.INGEST_POLL_SECONDS;
  if (poll && (!/^\d+$/.test(poll) || Number(poll) < 1)) {
    problems.push({
      name: "INGEST_POLL_SECONDS",
      message: `INGEST_POLL_SECONDS must be a positive integer, got "${poll}"`,
    });
  }
  return problems;
}
