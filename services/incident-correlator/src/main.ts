/**
 * incident-correlator — turns observations into incidents.
 *
 * The handlers arrive with Epic D; this is the worker loop they will plug into, already
 * shutting down gracefully and already reporting itself.
 */

import {
  createWorker,
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

const SERVICE = "incident-correlator";
const DEFAULT_SILENCE_THRESHOLD_SECONDS = 30 * 60;

export function describeService(): { service: string; implementedBy: string } {
  return { service: SERVICE, implementedBy: "S-D1" };
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
        silenceThresholdSeconds: Math.max(DEFAULT_SILENCE_THRESHOLD_SECONDS, row.poll_seconds * 10),
        enabled: row.enabled === 1,
        consecutiveFailures: row.consecutive_failures,
      })),
    });
  };

  const observability = serveObservability({
    service: SERVICE,
    port: Number(process.env.CORRELATOR_HEALTH_PORT ?? 3102),
    registry: metrics.registry,
    health,
    onListening: (url) => log.info("observability.listening", { result: url }),
  });

  // No handlers are registered yet (Epic D). The loop runs so the seam is real: a job
  // arriving before its handler exists fails loudly and stays visible, rather than
  // being silently consumed.
  const worker = createWorker({
    db,
    name: SERVICE,
    handlers: {},
    onEvent: (event) => {
      const fields = {
        job_id: event.job.id,
        job_type: event.job.type,
        attempt: event.job.attempts,
        ...(event.durationMs === undefined ? {} : { processing_time_ms: event.durationMs }),
      };
      if (event.event === "completed") {
        metrics.jobsProcessed.increment({ type: event.job.type, result: "completed" });
        log.info("job.completed", { ...fields, result: "ok" });
      } else if (event.event === "failed" || event.event === "retrying") {
        metrics.jobsProcessed.increment({ type: event.job.type, result: event.event });
        log.warn(`job.${event.event}`, { ...fields, error: errorMessage(event.error) });
      }
    },
  });

  log.info("service.started", { result: "worker loop running, no handlers until Epic D" });

  const stop = (signal: string) => () => {
    log.info("service.stopping", { result: signal });
    void worker.stop().then(() => {
      observability.stop();
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop("SIGINT"));
  process.on("SIGTERM", stop("SIGTERM"));

  await worker.start();
}

if (import.meta.main) await main();
