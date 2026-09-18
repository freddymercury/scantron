# S-B1 — SFPD calls-for-service ingest

**Epic:** B · Ingestion · **Phase:** 0 · **Depends on:** S-A2, S-A3, S-A5 · **Size:** L

## Story
As the system, I want to poll San Francisco's real-time law-enforcement dispatched-calls
dataset and persist each record as an Observation, so that police activity enters the
pipeline as soon as the source publishes it, and never duplicates.

**Note on freshness:** the source is a ~30-minute batch feed, not a stream (measured
2026-09-17: median 36.7 min from `received_datetime` to first visibility, 0 of 24 records
under 30 s — see [`01-data-source-findings.md`](../docs/01-data-source-findings.md) §5).
Our polling interval determines how quickly we see a *published* record, not how fresh that
record is. PRD §41's <30 s end-to-end target is not achievable from this source.

## Acceptance criteria
- [ ] Poller runs every 15 s (configurable per source) using a cursor on the dataset's update timestamp, with a 2-minute overlap window to tolerate late-arriving rows.
- [ ] Each fetched record is upserted on `(source='sf_police_cad', source_record_id)`; re-fetching the same record updates it and does not create a second observation (PRD §38).
- [ ] The raw payload is stored verbatim in `source_records` before any transformation.
- [ ] A changed record (e.g. new call type, new disposition) produces an observation update *and* enqueues re-correlation; the prior values remain recoverable from `source_records`.
- [ ] Mapping to the Observation model fills `occurredAt`, `ingestedAt`, `agency`, raw type/subtype, priority, raw location text, source coordinates where present, and unit identifiers.
- [ ] On upsert, `normalize_observation` is enqueued exactly once per changed record.
- [ ] Transient HTTP/5xx/429 failures retry with backoff; the cursor does not advance past unprocessed records; a poll cycle failure never loses a window.
- [ ] Ingestion lag is recorded as **two separate metrics**, because conflating them hides where time goes: **source lag** (`first_seen_at - received_datetime`, upstream, ~24+ min, not ours to fix) and **pipeline lag** (`published_at - first_seen_at`, ours, should be seconds). Records-per-cycle is also recorded.
- [ ] Poll interval is configurable and defaults to 60 s, not 15 s: the source republishes in batches roughly every several minutes, so a 15 s interval mostly re-fetches an unchanged snapshot and spends rate limit for nothing.
- [ ] Replaying a recorded fixture of 1,000 records twice yields exactly 1,000 observations.

## Technical notes
Socrata SODA with app token from env. Page with `$limit`/`$offset` guarded by an ordered
cursor, not offset alone. Clock skew: trust source timestamps, record ours separately.

## Out of scope
Normalization, geocoding, correlation — all downstream jobs.
