/**
 * sf-cad-ingest — polls the DataSF CAD feeds and writes raw observations.
 *
 * One process, three sources: police, fire and EMS each get their own adapter, cursor,
 * interval and health threshold. The intervals differ because the feeds do — docs/01
 * measured police at a ~30-minute batch and fire/EMS at ~19 hours behind — and a shared
 * threshold would make one of them permanently, meaninglessly "stale".
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
  type Logger,
} from "@scantron/observability";

import type { SourceAdapter } from "./adapter.ts";
import { emsAdapter, fireAdapter } from "./fire.ts";
import { runIngestCycle } from "./ingest.ts";
import { policeAdapter } from "./police.ts";
import { createSocrataClient, type SocrataClient } from "./socrata.ts";

const SERVICE = "sf-cad-ingest";

export const ADAPTERS: SourceAdapter<never>[] = [
  policeAdapter as unknown as SourceAdapter<never>,
  fireAdapter as unknown as SourceAdapter<never>,
  emsAdapter as unknown as SourceAdapter<never>,
];

export function describeService(): { service: string; implementedBy: string } {
  return { service: SERVICE, implementedBy: "S-B1" };
}

export function pollSeconds(source: string): number {
  const specific = Number(
    process.env[`INGEST_POLL_SECONDS_${source.toUpperCase()}`] ?? Number.NaN,
  );
  if (Number.isFinite(specific) && specific > 0) return specific;

  const configured = Number(process.env.INGEST_POLL_SECONDS ?? 60);
  const fallback = Number.isFinite(configured) && configured > 0 ? configured : 60;
  // Polling a feed that updates daily every minute is 1,440 wasted requests a day.
  return source === "sf_police_cad" ? fallback : Math.max(fallback, 600);
}

/** Polls one source forever, on its own schedule. */
async function pollLoop(options: {
  adapter: SourceAdapter<never>;
  db: ReturnType<typeof openDatabase>;
  client: SocrataClient;
  metrics: ReturnType<typeof createAppMetrics>;
  log: Logger;
  running: () => boolean;
}): Promise<void> {
  const { adapter, running } = options;
  const interval = pollSeconds(adapter.source);
  options.log.info("poller.started", { source: adapter.source, result: `every ${interval}s` });

  while (running()) {
    try {
      await runIngestCycle({
        db: options.db,
        adapter,
        client: options.client,
        metrics: options.metrics,
        log: options.log,
        pollSeconds: interval,
      });
    } catch (error) {
      // The cycle already recorded the failure and left the cursor where it was; the next
      // pass re-reads the same window rather than losing it.
      options.log.warn("cycle.failed", { source: adapter.source, error: errorMessage(error) });
    }
    await Bun.sleep(interval * 1000);
  }
}

export async function main(): Promise<void> {
  const log = createLogger({ context: { processor: SERVICE } });
  const metrics = createAppMetrics();

  const db = openDatabase({ path: databasePath() });
  migrate(db);

  const thresholds = new Map(ADAPTERS.map((adapter) => [adapter.source, adapter.silenceThresholdSeconds]));

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
        // Per source: the fire feed is ~19 h behind by nature and must not be judged
        // against the police feed's threshold.
        silenceThresholdSeconds: thresholds.get(row.source) ?? Math.max(1800, row.poll_seconds * 10),
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

  log.info("service.started", { count: ADAPTERS.length });

  await Promise.all(
    ADAPTERS.map((adapter) =>
      pollLoop({ adapter, db, client, metrics, log, running: () => running }),
    ),
  );
}

if (import.meta.main) await main();
