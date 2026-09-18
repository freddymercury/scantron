/**
 * sf-cad-ingest — polls the DataSF CAD feeds and writes raw observations.
 *
 * The poll loop arrives with S-B1. What exists now is the shape every service shares:
 * a structured logger, the metric registry, /metrics and /health, and a shutdown that
 * lets in-flight work finish.
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
  healthReport,
  serveObservability,
  type HealthReport,
} from "@scantron/observability";

const SERVICE = "sf-cad-ingest";
/** Silence beyond this means the feed stopped, not that the city went quiet. */
const DEFAULT_SILENCE_THRESHOLD_SECONDS = 30 * 60;

export function describeService(): { service: string; implementedBy: string } {
  return { service: SERVICE, implementedBy: "S-B1" };
}

export function main(): void {
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

  log.info("service.started", { result: "waiting for S-B1 poll loop" });

  const stop = (signal: string) => () => {
    log.info("service.stopping", { result: signal });
    observability.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));
}

if (import.meta.main) main();
