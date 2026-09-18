/**
 * The metrics PRD §40 asks for, named once so every service reports the same series.
 *
 * Note the two lag metrics, which docs/01 found are different things: **source lag** is
 * how long the city took to publish (median 36.7 min — not ours to fix), **pipeline lag**
 * is how long we took after that (ours entirely). Collapsing them into one number would
 * hide the only one we can act on.
 */

import { Registry, type Counter, type Gauge, type Histogram } from "./metrics.ts";

export interface AppMetrics {
  registry: Registry;
  sourceLagSeconds: Gauge;
  pipelineLagSeconds: Histogram;
  stepDurationSeconds: Histogram;
  correlationDurationSeconds: Histogram;
  observationsIngested: Counter;
  observationsFailed: Counter;
  duplicateSourceRecords: Counter;
  incidentsCreated: Counter;
  incidentMerges: Counter;
  probableMatches: Counter;
  unmappedCodes: Counter;
  jobsProcessed: Counter;
  queueDepth: Gauge;
  sourceLastSuccessAgeSeconds: Gauge;
  searchRerankSeconds: Histogram;
  searchRerankOutcomes: Counter;
  searchRerankCostUsd: Counter;
}

export function createAppMetrics(): AppMetrics {
  const registry = new Registry();
  return {
    registry,
    sourceLagSeconds: registry.gauge(
      "scantron_source_lag_seconds",
      "Age of the newest record a source has published — the city's latency, not ours",
    ),
    pipelineLagSeconds: registry.histogram(
      "scantron_pipeline_lag_seconds",
      "Seconds from fetching a source record to publishing the incident update — ours",
    ),
    stepDurationSeconds: registry.histogram(
      "scantron_step_duration_seconds",
      "Per-processor step duration",
    ),
    correlationDurationSeconds: registry.histogram(
      "scantron_correlation_duration_seconds",
      "Time to correlate one observation against its candidates",
    ),
    observationsIngested: registry.counter(
      "scantron_observations_ingested_total",
      "Observations written, by source",
    ),
    observationsFailed: registry.counter(
      "scantron_observations_failed_total",
      "Observations that could not be processed, by source and reason",
    ),
    duplicateSourceRecords: registry.counter(
      "scantron_duplicate_source_records_total",
      "Source records seen again with no change, by source",
    ),
    incidentsCreated: registry.counter("scantron_incidents_created_total", "Incidents created"),
    incidentMerges: registry.counter(
      "scantron_incident_merges_total",
      "Observation-into-incident merges — the signal-reduction hypothesis, measured",
    ),
    probableMatches: registry.counter(
      "scantron_probable_matches_total",
      "Correlations in the probable band that were logged rather than merged",
    ),
    unmappedCodes: registry.counter(
      "scantron_unmapped_codes_total",
      "Raw agency codes with no taxonomy entry, by source",
    ),
    jobsProcessed: registry.counter(
      "scantron_jobs_processed_total",
      "Queue jobs finished, by type and result",
    ),
    queueDepth: registry.gauge("scantron_queue_depth", "Jobs in the queue, by status"),
    sourceLastSuccessAgeSeconds: registry.gauge(
      "scantron_source_last_success_age_seconds",
      "Seconds since a source last polled successfully",
    ),
    searchRerankSeconds: registry.histogram(
      "scantron_search_rerank_seconds",
      "Time for the semantic search re-rank to answer",
      [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 5],
    ),
    searchRerankOutcomes: registry.counter(
      "scantron_search_rerank_total",
      "Search re-ranks by outcome: answered, timeout, failed, or skipped",
    ),
    searchRerankCostUsd: registry.counter(
      "scantron_search_rerank_cost_usd",
      "Money spent on semantic re-ranking — this model is billed per input token",
    ),
  };
}
