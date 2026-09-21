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
import { sweepStaleIncidents } from "@scantron/correlation";
import { createGeocoder } from "@scantron/location-normalizer/geocode";
import { createPriorityMapper, createTaxonomy, seedTaxonomy } from "@scantron/event-taxonomy";
import { createCorrelateHandler } from "./handlers/correlate.ts";
import { createGeocodeHandler } from "./handlers/geocode.ts";
import { createNormalizeHandler } from "./handlers/normalize.ts";
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

  // Seeding on boot means a fresh database is usable without a separate setup step, and an
  // already-seeded one is untouched apart from a version check.
  seedTaxonomy(db);
  const geocoder = createGeocoder(db);
  const taxonomy = createTaxonomy(db);
  const priorities = createPriorityMapper();
  log.info("normalization.ready", { count: taxonomy.size, result: `${geocoder.polygonCount} polygons` });

  const worker = createWorker({
    db,
    name: SERVICE,
    handlers: {
      normalize_observation: createNormalizeHandler({ db, taxonomy, priorities, metrics, log }) as never,
      geocode_location: createGeocodeHandler({ db, geocoder, metrics, log }) as never,
      correlate_incident: createCorrelateHandler({ db, metrics, log }) as never,
    },
    onEvent: (event) => {
      const fields = {
        job_id: event.job.id,
        job_type: event.job.type,
        attempt: event.job.attempts,
        ...(event.durationMs === undefined ? {} : { processing_time_ms: event.durationMs }),
      };
      if (event.event === "completed") {
        metrics.jobsProcessed.increment({ type: event.job.type, result: "completed" });
        // Debug, not info: a successful job is a metric, not news. At info this produced
        // 10,000 lines in one backlog drain and buried everything that mattered.
        log.debug("job.completed", { ...fields, result: "ok" });
      } else if (event.event === "failed" || event.event === "retrying") {
        metrics.jobsProcessed.increment({ type: event.job.type, result: event.event });
        log.warn(`job.${event.event}`, { ...fields, error: errorMessage(event.error) });
      }
    },
  });

  // The staleness sweep (S-D4): an incident nobody has said anything about for a while
  // becomes `unknown`, never `resolved` — the system does not get to invent an ending.
  const sweepMinutes = Number(process.env.STALE_SWEEP_MINUTES ?? 5);
  const sweep = setInterval(
    () => {
      try {
        const result = sweepStaleIncidents(db);
        if (result.movedToUnknown > 0) {
          log.info("incidents.went_quiet", {
            count: result.movedToUnknown,
            result: `${result.examined} open`,
          });
        }
      } catch (error) {
        log.error("sweep.failed", { error: errorMessage(error) });
      }
    },
    sweepMinutes * 60_000,
  );

  log.info("service.started", { result: `worker running, stale sweep every ${sweepMinutes} min` });

  const stop = (signal: string) => () => {
    log.info("service.stopping", { result: signal });
    clearInterval(sweep);
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
