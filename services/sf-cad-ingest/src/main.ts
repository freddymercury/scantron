/**
 * sf-cad-ingest — polls the DataSF CAD feeds and writes raw observations.
 *
 * The poll interval defaults to 60 s, not the 15 s S-B1 first asked for: docs/01 measured
 * the source as a ~30-minute batch, so a 15 s cycle mostly re-fetches an unchanged
 * snapshot and spends rate limit for nothing.
 */

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
  errorMessage,
  healthReport,
  serveObservability,
  type HealthReport,
} from "@scantron/observability";

import { runIngestCycle } from "./ingest.ts";
import { createSocrataClient } from "./socrata.ts";

const SERVICE = "sf-cad-ingest";
const DEFAULT_SILENCE_THRESHOLD_SECONDS = 30 * 60;

export function describeService(): { service: string; implementedBy: string } {
  return { service: SERVICE, implementedBy: "S-B1" };
}

export function pollSeconds(): number {
  const configured = Number(process.env.INGEST_POLL_SECONDS ?? 60);
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

export async function main(): Promise<void> {
  const log = createLogger({ context: { processor: SERVICE } });
  const metrics = createAppMetrics();

  const db = openDatabase({ path: databasePath() });
  migrate(db);

  const health = (): HealthReport => {
    const stats = queueStats(db);
    metrics.queueDepth.set(stats.pending, { status: "pending" });
    metrics.queueDepth.set(stats.running, { status: "running" });
    metrics.queueDepth.set(stats.failed, { status: "failed" });

    return healthReport({
      queue: stats,
      sources: sourceConfigurations(db).map((row) => ({
        source: row.source,
        lastSuccessAt: row.last_success_at ? new Date(row.last_success_at) : undefined,
        silenceThresholdSeconds: Math.max(
          DEFAULT_SILENCE_THRESHOLD_SECONDS,
          row.poll_seconds * 10,
        ),
        enabled: row.enabled === 1,
        consecutiveFailures: row.consecutive_failures,
      })),
    });
  };

  const observability = serveObservability({
    service: SERVICE,
    port: Number(process.env.INGEST_HEALTH_PORT ?? 3101),
    registry: metrics.registry,
    health,
    onListening: (url) => log.info("observability.listening", { result: url }),
  });

  const client = createSocrataClient();
  let running = true;

  const stop = (signal: string) => () => {
    log.info("service.stopping", { result: signal });
    running = false;
    observability.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));

  log.info("service.started", { result: `polling every ${pollSeconds()}s` });

  while (running) {
    try {
      await runIngestCycle({ db, client, metrics, log });
    } catch (error) {
      // The cycle already recorded the failure and left the cursor where it was; the next
      // pass re-reads the same window rather than losing it.
      log.warn("cycle.failed", { source: "sf_police_cad", error: errorMessage(error) });
    }
    await Bun.sleep(pollSeconds() * 1000);
  }
}

if (import.meta.main) await main();
