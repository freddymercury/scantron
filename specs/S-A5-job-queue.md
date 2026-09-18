# S-A5 — Postgres job queue

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** S-A2 · **Size:** M

## Story
As an engineer, I want a small durable job queue in Postgres, so that ingestion,
normalization, correlation and publication run as retryable, observable steps.

## Acceptance criteria
- [ ] `jobs` table with `type`, `payload jsonb`, `run_after`, `attempts`, `max_attempts`, `locked_by`, `locked_at`, `status`, `last_error`, `dedupe_key`.
- [ ] Claiming uses `FOR UPDATE SKIP LOCKED`; two concurrent workers never process the same job (covered by a concurrency test).
- [ ] Job types registered: `normalize_observation`, `geocode_location`, `correlate_incident`, `publish_incident`, `summarize_incident` (PRD §39). `transcribe_audio` is registered but unimplemented.
- [ ] Failures retry with exponential backoff and jitter; after `max_attempts` the job moves to `failed` and is visible in the internal viewer — never silently dropped.
- [ ] `dedupe_key` uniqueness prevents duplicate pending jobs for the same observation+type.
- [ ] Handlers are idempotent by contract; re-running a completed job produces no duplicate rows (asserted per handler).
- [ ] Worker shuts down gracefully: stops claiming, finishes in-flight jobs, releases locks.

## Out of scope
Priority lanes, cron scheduling beyond the pollers' own loop, Redis.
