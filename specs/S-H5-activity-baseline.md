# S-H5 — Neighborhood activity baseline

**Epic:** H · Ask & neighborhood answers · **Phase:** 1.5 · **Depends on:** S-H2 · **Size:** M

## Story
As a reader, I want to know whether the activity I'm seeing is normal, so that three
incidents means something different in the Mission than in the Outer Sunset.

## Acceptance criteria
- [ ] A rolling baseline per (neighborhood, category, hour-of-week) computed from published incident history, refreshed on a schedule.
- [ ] `comparison` returned by S-H2 is one of `quieter | typical | busier`, with the thresholds documented and configurable (e.g. outside ±1 standard deviation), plus the raw expected count.
- [ ] Baselines require a configurable minimum history (default 28 days) before being shown; below that the UI says "not enough history yet" rather than comparing against noise.
- [ ] Quiet neighborhoods with low counts do not produce alarming comparisons from a single incident — small-count areas use a documented smoothing rule.
- [ ] Baseline is stated as **reported dispatch activity**, never as crime rate, danger, or safety, in both the API field naming and the UI copy. Copy is covered by the S-F7 banned-phrasing test.
- [ ] Backfill command computes baselines over an arbitrary history range.
- [ ] The comparison never appears without its underlying numbers.

## Technical notes
This is the story most likely to be misread by users as a safety score. The naming
constraint above is load-bearing, not decoration.

## Out of scope
Trend forecasting, anomaly alerting, any per-block or per-address statistic.
