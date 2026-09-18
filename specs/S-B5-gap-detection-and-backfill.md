# S-B5 — Gap detection and historical backfill

**Epic:** B · Ingestion · **Phase:** 0 · **Depends on:** S-B1, S-B3 · **Size:** M

## Story
As an operator, I want ingestion gaps detected automatically and refilled from the
historical dataset, so that an outage costs us nothing permanent.

**This story exists because of a source constraint verified 2026-09-17: the real-time
police feed retains only ~48 hours.** Anything we fail to poll ages out of it for good.
Our own database is the only durable copy, so a gap that outlives the retention window is
unrecoverable from the real-time source.

| Source | ID | Retention | Lag |
|---|---|---|---|
| Dispatched Calls, **Real-Time** | `gnap-fj3t` | **~48 h rolling** | seconds |
| Dispatched Calls, **Historical** | `2zdj-bwza` | since 2014-12-31, 7.9M rows | ~1 day |
| Fire/EMS Calls | `nuek-vuh3` | since 2000, 7.4M rows | ~19 h |

Both police datasets share a schema and `cad_number`, so backfill is a same-shape upsert.

## Acceptance criteria
- [ ] A continuous gap detector compares observed `received_datetime` coverage against wall-clock time per source and records any interval with no successful poll.
- [ ] A gap older than the real-time retention window (configurable, default 40 h to leave margin) raises an alert distinct from ordinary source-health degradation — this is the unrecoverable case.
- [ ] `backfill --source sf_police_cad --from <ts> --to <ts>` refills from `2zdj-bwza` through the same normalization and correlation path as live ingest; it is idempotent on `(source, source_record_id)` and never creates duplicates.
- [ ] Backfilled observations are flagged as such, so latency metrics are not polluted by records that were never going to be timely.
- [ ] Gap detection runs on startup too: a deploy or crash that spans hours triggers backfill automatically without an operator noticing.
- [ ] Backfill respects the ~1 day publication lag of the historical dataset — a gap in the last 24 h is retried against it until the rows appear, rather than being declared unfillable.
- [ ] Source records are validated before insert: the historical dataset contains at least one malformed row (`cad_number = "Completion time: 2025-03-11T11:42:36…"`, an export footer). Rows failing schema validation are rejected to a quarantine table with a counter, never dropped silently and never inserted.
- [ ] A backfill of a known window reproduces the same incident set as live ingestion over that window, within the documented correlation tolerance (asserted by test against a recorded fixture).

## Why this is Phase 0, not later
Phase 0's exit criterion is "reliable continuous ingestion for several days without
duplicate explosions or meaningful data loss" (PRD §44). Without gap detection you cannot
demonstrate the absence of data loss, and without backfill an early-development outage
permanently punches a hole in the history that every later trend feature (S-H6, S-H7)
reads from.

## Out of scope
Bulk historical import of years of data (a separate, deliberate, one-off operation).
