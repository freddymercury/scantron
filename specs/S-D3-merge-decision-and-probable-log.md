# S-D3 — Merge/create decision and probable-match log

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D2 · **Size:** M

## Story
As the correlator, I want thresholded decisions with every uncertain case logged, so that
incidents form correctly today and the thresholds can be tuned with evidence tomorrow.

## Acceptance criteria
- [ ] Score ≥ 0.85 (config) → attach the observation to the best-scoring incident and update it.
- [ ] Score 0.65–0.84 → create a new incident **and** write a `probable_matches` row (observation, candidate incident, total, per-feature breakdown, decision) for review.
- [ ] Score < 0.65 → create a new incident.
- [ ] Only the single best candidate is considered for attachment; ties break deterministically (higher location score, then earlier `first_observed_at`).
- [ ] Decision and breakdown are persisted on `incident_observations` for every attachment.
- [ ] The whole decision runs in one transaction; two concurrent observations for the same corner cannot create two incidents (enforced by advisory lock on a spatial-temporal key, covered by a concurrency test).
- [ ] Re-processing an already-correlated observation is a no-op unless its normalized fields changed.
- [ ] Metrics: merge rate, new-incident rate, probable-match rate, correlation latency.

## Out of scope
UI for reviewing probable matches (S-G3); incident-to-incident merge (S-D9).
