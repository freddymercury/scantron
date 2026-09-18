import { expect, test } from "bun:test";
import {
  CONTENT_TYPE_PROMETHEUS,
  createAppMetrics,
  healthReport,
  healthResponse,
  metricsResponse,
  Registry,
} from "../src/index.ts";

test("counters, gauges and histograms render as Prometheus text", async () => {
  const registry = new Registry();
  const requests = registry.counter("scantron_requests_total", "Requests");
  const depth = registry.gauge("scantron_queue_depth", "Queue depth");
  const latency = registry.histogram("scantron_latency_seconds", "Latency", [0.1, 1]);

  requests.increment({ route: "/api/incidents" });
  requests.increment({ route: "/api/incidents" });
  requests.increment({ route: "/healthz" });
  depth.set(7, { status: "pending" });
  latency.observe(0.05);
  latency.observe(2);

  const text = registry.render();
  expect(text).toContain("# TYPE scantron_requests_total counter");
  expect(text).toContain('scantron_requests_total{route="/api/incidents"} 2');
  expect(text).toContain('scantron_queue_depth{status="pending"} 7');
  expect(text).toContain('scantron_latency_seconds_bucket{le="0.1"} 1');
  expect(text).toContain('scantron_latency_seconds_bucket{le="+Inf"} 2');
  expect(text).toContain("scantron_latency_seconds_sum 2.05");
  expect(text).toContain("scantron_latency_seconds_count 2");

  const response = metricsResponse(registry);
  expect(response.headers.get("content-type")).toBe(CONTENT_TYPE_PROMETHEUS);
  expect(await response.text()).toBe(text);
});

test("label values are escaped, so a quote cannot break the exposition format", () => {
  const registry = new Registry();
  registry.counter("scantron_weird_total", "Weird").increment({ label: 'a "quoted" \\ value' });
  expect(registry.render()).toContain('scantron_weird_total{label="a \\"quoted\\" \\\\ value"} 1');
});

test("every metric PRD §40 names exists, with source and pipeline lag kept apart", () => {
  const metrics = createAppMetrics();
  metrics.sourceLagSeconds.set(2202, { source: "sf_police_cad" });
  metrics.pipelineLagSeconds.observe(1.4, { source: "sf_police_cad" });
  metrics.observationsFailed.increment({ source: "sf_police_cad", reason: "malformed" });
  metrics.duplicateSourceRecords.increment({ source: "sf_police_cad" });
  metrics.incidentMerges.increment();
  metrics.probableMatches.increment();
  metrics.unmappedCodes.increment({ source: "sf_fire_cad" });
  metrics.correlationDurationSeconds.observe(0.009);
  metrics.queueDepth.set(3, { status: "pending" });

  const text = metrics.registry.render();
  for (const name of [
    "scantron_source_lag_seconds",
    "scantron_pipeline_lag_seconds",
    "scantron_step_duration_seconds",
    "scantron_correlation_duration_seconds",
    "scantron_observations_failed_total",
    "scantron_duplicate_source_records_total",
    "scantron_incident_merges_total",
    "scantron_probable_matches_total",
    "scantron_unmapped_codes_total",
    "scantron_queue_depth",
  ]) {
    expect(text).toContain(name);
  }
});

const queue = { pending: 2, running: 1, failed: 0, oldestPendingAgeSeconds: 12 };
const now = new Date("2026-09-18T02:00:00.000Z");

test("health is ok while every source is current", () => {
  const report = healthReport({
    now,
    queue,
    sources: [
      {
        source: "sf_police_cad",
        lastSuccessAt: new Date("2026-09-18T01:59:00.000Z"),
        silenceThresholdSeconds: 600,
      },
    ],
  });
  expect(report.status).toBe("ok");
  expect(report.sources[0]?.ageSeconds).toBe(60);
  expect(healthResponse(report).status).toBe(200);
});

test("a silent source makes health non-200", () => {
  const report = healthReport({
    now,
    queue,
    sources: [
      {
        source: "sf_police_cad",
        lastSuccessAt: new Date("2026-09-18T01:00:00.000Z"),
        silenceThresholdSeconds: 600,
        consecutiveFailures: 4,
      },
      {
        source: "sf_fire_cad",
        lastSuccessAt: new Date("2026-09-18T01:59:00.000Z"),
        silenceThresholdSeconds: 600,
      },
    ],
  });
  expect(report.status).toBe("degraded");
  expect(report.sources[0]?.status).toBe("stale");
  expect(report.sources[1]?.status).toBe("ok");
  expect(healthResponse(report).status).toBe(503);
});

test("a source that has never succeeded is not quietly healthy", () => {
  const report = healthReport({
    now,
    queue,
    sources: [{ source: "sf_ems_cad", silenceThresholdSeconds: 600 }],
  });
  expect(report.sources[0]?.status).toBe("never");
  expect(report.status).toBe("degraded");
});

test("a disabled source does not drag health down", () => {
  const report = healthReport({
    now,
    queue,
    sources: [{ source: "radio", silenceThresholdSeconds: 600, enabled: false }],
  });
  expect(report.sources).toHaveLength(0);
  expect(report.status).toBe("ok");
});

test("the health payload carries queue depth", async () => {
  const report = healthReport({ now, queue, sources: [] });
  expect(await healthResponse(report).json()).toMatchObject({ queue });
});
