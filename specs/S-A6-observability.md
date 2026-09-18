# S-A6 — Structured logging, tracing IDs and metrics

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** S-A5 · **Size:** M

## Story
As an operator, I want every processing step traceable from source record to published
incident, so that I can debug correlation and prove the latency targets.

## Acceptance criteria
- [ ] `packages/observability` exports a JSON logger carrying PRD §40 fields: `request_id`, `observation_id`, `incident_id`, `source`, `processor`, `processing_time_ms`, `result`, `error`.
- [ ] A `request_id` generated at ingest propagates through every downstream job for that record (asserted end-to-end in a test).
- [ ] Counters/histograms exported: source ingestion lag, per-step processing latency, correlation latency, failed observations, duplicate source records, incident merge rate, probable-match rate, unmapped codes.
- [ ] Metrics exposed on a `/metrics` endpoint in Prometheus text format from the worker and the web app.
- [ ] A `/health` endpoint reports per-source last-successful-poll age and queue depth, and returns non-200 when any source has been silent beyond its configured threshold.
- [ ] No log line contains raw source free-text or address detail below block level.

## Out of scope
Dashboards, alerting/paging configuration, distributed tracing backend.
