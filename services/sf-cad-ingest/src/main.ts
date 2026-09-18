/**
 * sf-cad-ingest — polls the DataSF CAD feeds and writes raw observations.
 *
 * One process, three sources: police, fire and EMS each get their own adapter, cursor,
 * interval and health threshold. The intervals differ because the feeds do — docs/01
 * measured police at a ~30-minute batch and fire/EMS at ~19 hours behind — and a shared
 * threshold would make one of them permanently, meaninglessly "stale".
 */

import {
  createConfigCache,
  databasePath,
  effectivePollSeconds,
  migrate,
  openDatabase,
  queueStats,
  sourceConfigurations,
  type ConfigCache,
  type SourceConfig,
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

/**
 * Polls one source forever, on the schedule its *configuration* says — re-read each pass,
 * so `UPDATE source_configuration SET enabled = 0` stops a feed within a minute and no
 * deploy is involved. A source past its failure threshold backs off instead of hammering
 * the endpoint, and says so at error level.
 */
async function pollLoop(options: {
  adapter: SourceAdapter<never>;
  db: ReturnType<typeof openDatabase>;
  client: SocrataClient;
  metrics: ReturnType<typeof createAppMetrics>;
  log: Logger;
  config: ConfigCache;
  running: () => boolean;
}): Promise<void> {
  const { adapter, running, log } = options;
  let wasEnabled: boolean | undefined;
  let announcedInterval: number | undefined;

  while (running()) {
    const config: SourceConfig | undefined = options.config.get(adapter.source);
    const enabled = config?.enabled ?? true;
    const interval = config ? effectivePollSeconds(config) : pollSeconds(adapter.source);

    if (enabled !== wasEnabled) {
      log.info(enabled ? "poller.enabled" : "poller.disabled", {
        source: adapter.source,
        result: `every ${interval}s`,
      });
      wasEnabled = enabled;
    }
    if (enabled && interval !== announcedInterval) {
      if (announcedInterval !== undefined) {
        log.warn("poller.interval_changed", {
          source: adapter.source,
          result: `${announcedInterval}s -> ${interval}s`,
          attempt: config?.consecutiveFailures ?? 0,
        });
      }
      announcedInterval = interval;
    }

    if (!enabled) {
      // Checked often enough that toggling a source feels immediate, cheap enough that
      // doing so costs nothing.
      await Bun.sleep(Math.min(interval, 30) * 1000);
      continue;
    }

    try {
      await runIngestCycle({
        db: options.db,
        adapter,
        client: options.client,
        metrics: options.metrics,
        log: options.log,
        pollSeconds: config?.pollSeconds ?? interval,
      });
    } catch (error) {
      const failures = (config?.consecutiveFailures ?? 0) + 1;
      const level = failures >= (config?.backoffAfterFailures ?? 3) ? "error" : "warn";
      // The cycle already recorded the failure and left the cursor where it was; the next
      // pass re-reads the same window rather than losing it.
      log[level]("cycle.failed", {
        source: adapter.source,
        error: errorMessage(error),
        attempt: failures,
      });
      // Re-read immediately so the next sleep already reflects the backoff.
      options.config.reload();
    }
    await Bun.sleep(interval * 1000);
  }
}

export async function main(): Promise<void> {
  const log = createLogger({ context: { processor: SERVICE } });
  const metrics = createAppMetrics();

  const db = openDatabase({ path: databasePath() });
  migrate(db);

  const config = createConfigCache(db);

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
        // Configuration, per source: the fire feed is ~19 h behind by nature and must not
        // be judged against the police feed's threshold.
        silenceThresholdSeconds: row.health_max_silence_seconds,
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
      pollLoop({ adapter, db, client, metrics, log, config, running: () => running }),
    ),
  );
}

if (import.meta.main) await main();
