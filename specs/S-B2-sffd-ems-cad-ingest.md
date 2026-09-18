# S-B2 — SFFD / EMS calls-for-service ingest

**Epic:** B · Ingestion · **Phase:** 0 · **Depends on:** S-B1 · **Size:** M

## Story
As the system, I want fire and EMS dispatch records ingested into the same Observation
model, so that cross-agency correlation has something to correlate.

## Acceptance criteria
- [ ] Separate poller instances for `sf_fire_cad` and `sf_ems_cad` (distinct `source` values even if one upstream dataset serves both), each with independent cursor and interval.
- [ ] Fire/EMS schema mapped into the identical Observation shape — no source-specific columns leak past the adapter.
- [ ] An EMS-flagged record from a shared fire dataset is tagged `sf_ems_cad` by a documented, configurable rule, so "independent source count" is meaningful.
- [ ] Same idempotency guarantee as S-B1, enforced by the same unique constraint.
- [ ] Known higher latency of this feed is recorded as its own lag metric and does not trip the police-source health threshold.
- [ ] Unit identifiers (`E07`, `T07`, `B02`, `Medic 84`) are parsed into the units array.
- [ ] Fixture-replay test proves the adapter is idempotent and schema-complete.

## Out of scope
Deciding whether fire and EMS count as independent sources for verification — that rule
lives in S-D6.
