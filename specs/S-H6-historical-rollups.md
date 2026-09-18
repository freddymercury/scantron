# S-H6 — Historical rollups and comparability

**Epic:** H · Ask & neighborhood answers · **Phase:** 1.5 · **Depends on:** S-H2, S-D9 · **Size:** M

## Story
As the system, I want pre-aggregated daily counts with a recorded pipeline version, so
that 7/30/90-day questions are fast to answer and honest about what they are comparing.

## Acceptance criteria
- [ ] `incident_rollups_daily` keyed by `(day, neighborhood, primary_type, agency)` with an incident count, populated by a scheduled job and idempotent on re-run.
- [ ] A day is rolled up only once it is **closed and settled** (after the longest publication delay and the staleness sweep), so late-arriving and merged incidents are counted correctly.
- [ ] Merges (S-D9) and corrections (S-D7) trigger recomputation of the affected days; a merged-away incident is never double-counted.
- [ ] Each rollup row records `pipeline_version` (taxonomy version + correlation config version). A query spanning a version change returns a `comparability: partial` flag naming the boundary date.
- [ ] Backfill command computes rollups over an arbitrary date range; running it twice produces identical results.
- [ ] 90-day aggregate for one neighborhood answers in <400 ms at full data volume.
- [ ] Rollups are derived, never authoritative — dropping and rebuilding the table changes no user-visible truth.

## Technical notes
Counts before the first stable correlation config are not comparable to counts after it:
the duplicate rate changed, so the numbers moved without the city changing. `pipeline_version`
is what keeps us from presenting our own tuning as a trend. See assumption 34.

## Out of scope
Per-block statistics, demographic joins, any export framed as crime data.
