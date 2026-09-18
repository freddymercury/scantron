/**
 * `/health` (S-A6). Answers one question honestly: is data still arriving?
 *
 * A source silent beyond its threshold makes the endpoint non-200, because a feed that
 * stopped is indistinguishable from a quiet city unless something says so out loud.
 */

export interface SourceHealthInput {
  source: string;
  /** Last time a poll succeeded, whatever it returned. */
  lastSuccessAt?: Date | undefined;
  /** How long this source may be silent before it counts as unhealthy. */
  silenceThresholdSeconds: number;
  enabled?: boolean;
  consecutiveFailures?: number;
}

export interface SourceHealth {
  source: string;
  status: "ok" | "stale" | "never";
  lastSuccessAt?: string;
  ageSeconds?: number;
  silenceThresholdSeconds: number;
  consecutiveFailures: number;
}

export interface QueueHealthInput {
  pending: number;
  running: number;
  failed: number;
  oldestPendingAgeSeconds: number;
}

export interface HealthReport {
  status: "ok" | "degraded";
  checkedAt: string;
  sources: SourceHealth[];
  queue: QueueHealthInput;
}

export interface HealthInput {
  sources: readonly SourceHealthInput[];
  queue: QueueHealthInput;
  now?: Date;
}

export function healthReport(input: HealthInput): HealthReport {
  const now = input.now ?? new Date();
  const sources: SourceHealth[] = [];

  for (const source of input.sources) {
    if (source.enabled === false) continue;
    const health: SourceHealth = {
      source: source.source,
      status: "never",
      silenceThresholdSeconds: source.silenceThresholdSeconds,
      consecutiveFailures: source.consecutiveFailures ?? 0,
    };
    if (source.lastSuccessAt) {
      const ageSeconds = (now.getTime() - source.lastSuccessAt.getTime()) / 1000;
      health.lastSuccessAt = source.lastSuccessAt.toISOString();
      health.ageSeconds = ageSeconds;
      health.status = ageSeconds > source.silenceThresholdSeconds ? "stale" : "ok";
    }
    sources.push(health);
  }

  const degraded = sources.some((source) => source.status !== "ok");
  return {
    status: degraded ? "degraded" : "ok",
    checkedAt: now.toISOString(),
    sources,
    queue: input.queue,
  };
}

/** 200 while every enabled source is current; 503 the moment one is not. */
export function healthHttpStatus(report: HealthReport): number {
  return report.status === "ok" ? 200 : 503;
}
