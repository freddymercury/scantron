/**
 * scantron web — server-rendered HTML from Bun.serve.
 *
 * ADR-002 amends PRD §34 and S-A1: no Next.js, React or MUI. The app shell arrives with
 * S-F1; this proves the server boots, serves a page under a nonce-based CSP, and reports
 * itself through the same /metrics and /health the workers expose (S-A6).
 */

import type { Database } from "bun:sqlite";
import {
  databasePath,
  migrate,
  openDatabase,
  queueStats,
  sourceConfigurations,
} from "@scantron/database";
import {
  createAppMetrics,
  createLogger,
  healthReport,
  healthResponse,
  metricsResponse,
  type AppMetrics,
  type HealthReport,
} from "@scantron/observability";
import { SF_BBOX, SF_TIMEZONE } from "@scantron/sf-domain";

import { handleInternal } from "./internal/viewer.ts";
import { createNonce, escapeHtml, securityHeaders } from "./security.ts";

const PORT = Number(process.env.WEB_PORT ?? 3000);
const DEFAULT_SILENCE_THRESHOLD_SECONDS = 30 * 60;

function page(nonce: string): string {
  const bbox = `${SF_BBOX.west},${SF_BBOX.south} → ${SF_BBOX.east},${SF_BBOX.north}`;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>scantron</title>
<h1>scantron</h1>
<p>San Francisco incident intelligence. Scaffold only — the app shell arrives with S-F1.</p>
<p>Timezone ${escapeHtml(SF_TIMEZONE)}; bbox ${escapeHtml(bbox)}.</p>
<script nonce="${nonce}">
  // Inline because the client runtime is ours and server-rendered; it runs only because
  // this nonce matches the one in this response's Content-Security-Policy.
  document.documentElement.dataset.ready = "true";
</script>
`;
}

export interface AppContext {
  db?: Database;
  metrics: AppMetrics;
}

export function buildHealth(context: AppContext, now: Date = new Date()): HealthReport {
  const stats = context.db
    ? queueStats(context.db, now)
    : { pending: 0, running: 0, completed: 0, failed: 0, oldestPendingAgeSeconds: 0 };

  context.metrics.queueDepth.set(stats.pending, { status: "pending" });
  context.metrics.queueDepth.set(stats.running, { status: "running" });
  context.metrics.queueDepth.set(stats.failed, { status: "failed" });

  const sources = context.db ? sourceConfigurations(context.db) : [];
  return healthReport({
    now,
    queue: stats,
    sources: sources.map((row) => ({
      source: row.source,
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at) : undefined,
      silenceThresholdSeconds: Math.max(DEFAULT_SILENCE_THRESHOLD_SECONDS, row.poll_seconds * 10),
      enabled: row.enabled === 1,
      consecutiveFailures: row.consecutive_failures,
    })),
  });
}

function withSecurityHeaders(response: Response): Response {
  for (const [header, value] of Object.entries(securityHeaders())) {
    response.headers.set(header, value);
  }
  return response;
}

export function createHandler(context: AppContext): (request: Request) => Response | Promise<Response> {
  return function handle(request: Request): Response | Promise<Response> {
    const path = new URL(request.url).pathname;
    const startedAt = performance.now();

    try {
      // Internal surfaces first, and they fail closed: without INTERNAL_API_KEY the
      // viewer does not exist at all (S-B4).
      if (path.startsWith("/internal")) {
        const internal = handleInternal(
          request,
          context.db ? { db: context.db, metrics: context.metrics } : { metrics: context.metrics },
        );
        return internal.then((response) => response ?? new Response("not found", { status: 404 }));
      }

      if (path === "/") {
        const nonce = createNonce();
        return new Response(page(nonce), {
          headers: { "content-type": "text/html; charset=utf-8", ...securityHeaders(nonce) },
        });
      }
      if (path === "/healthz") {
        return Response.json({ status: "ok", service: "web" }, { headers: securityHeaders() });
      }
      if (path === "/health") {
        return withSecurityHeaders(healthResponse(buildHealth(context)));
      }
      if (path === "/metrics") {
        return withSecurityHeaders(metricsResponse(context.metrics.registry));
      }
      return new Response("not found", { status: 404, headers: securityHeaders() });
    } finally {
      context.metrics.stepDurationSeconds.observe((performance.now() - startedAt) / 1000, {
        processor: "web",
      });
    }
  };
}

/** The default handler, for tests and for `main()`. No database unless one is given. */
export const handle = createHandler({ metrics: createAppMetrics() });

export function main(): void {
  const log = createLogger({ context: { processor: "web" } });
  const db = openDatabase({ path: databasePath() });
  migrate(db);

  const server = Bun.serve({
    port: PORT,
    fetch: createHandler({ db, metrics: createAppMetrics() }),
  });
  log.info("service.started", { result: server.url.toString() });
}

if (import.meta.main) main();
