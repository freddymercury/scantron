# S-B3 — Source configuration and source health

**Epic:** B · Ingestion · **Phase:** 0 · **Depends on:** S-B1, S-A6 · **Size:** S

## Story
As an operator, I want each source's polling behaviour and health thresholds to be
configuration, so that I can tune or disable a feed without deploying.

## Acceptance criteria
- [ ] `source_configuration` rows hold: `source`, `enabled`, `poll_interval_seconds`, `overlap_seconds`, `endpoint`, `health_max_silence_seconds`, `default_visibility`, `publication_delay_seconds`.
- [ ] Pollers read config at startup and re-read at most every 60 s; disabling a source stops polling within that window without a restart.
- [ ] Per-source state persisted: `last_poll_at`, `last_success_at`, `cursor`, `consecutive_failures`.
- [ ] `/health` degrades when `now - last_success_at > health_max_silence_seconds` for any enabled source, naming the source.
- [ ] Config changes are logged with before/after values.
- [ ] A source with `consecutive_failures` past a threshold backs off its interval and logs at error level rather than hammering the endpoint.

## Out of scope
A UI for editing config (SQL is fine for MVP).
