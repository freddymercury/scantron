# S-D2 — Correlation scoring model

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D1 · **Size:** L

## Story
As the correlator, I want a configurable weighted score for (observation, incident) pairs,
so that the "same event?" decision is explainable and tunable.

## Acceptance criteria
- [ ] Feature scorers, each returning 0–1: location similarity, time similarity, event-type similarity, unit overlap, text/entity similarity.
- [ ] Default weights per PRD §17 — location .35, time .25, event .20, units .10, text .10 — read from config and validated to sum to 1.
- [ ] **Scores are renormalized over the features that can actually fire for a given pair.** A feature is *inapplicable* (not zero) when it cannot produce signal: unit overlap when the two records come from different agencies, text similarity when neither side has a transcript. The score is `Σ(wᵢ·sᵢ) / Σ(wᵢ)` over applicable features only. **Verified necessary against real data 2026-09-17 — see the note below.**
- [ ] Which features were applied is persisted with the score, so a breakdown is never misread as "units scored 0".
- [ ] Location score is distance-decayed (1.0 at 0 m, ~0 at the candidate radius) and *boosted to 1.0* on exact canonical intersection match regardless of coordinate jitter.
- [ ] Time score decays over the candidate window and is asymmetric: an observation arriving *after* the incident started scores higher than one arriving before it.
- [ ] Event-type similarity uses a configurable cross-type affinity matrix (Assault↔Medical high, Fire↔Medical high, Theft↔Fire ~0) rather than exact-match only.
- [ ] Unit overlap uses Jaccard over canonical unit IDs; no shared units yields 0, never a penalty.
- [ ] `score(observation, incident)` returns the total **and the per-feature breakdown**, persisted with the decision for debugging (as shown in the mockup's internal view).
- [ ] Pure functions, no I/O, fully unit-tested per feature.

## Why renormalization is mandatory, not a refinement

Measured on 812 real observations (647 SFPD rows + 335 SFFD unit-rows, 2026-09-16 18:00 →
2026-09-17 03:20). Under the PRD §17 weights applied flat, the **best possible score for a
cross-agency pair** is:

```
location 1.00 × .35 = .350   exact same intersection
time     1.00 × .25 = .250   simultaneous
type     0.80 × .20 = .160   Assault↔Medical, best affinity in the matrix
units    0.00 × .10 = .000   police units never overlap fire units
text     0.30 × .10 = .030   no transcripts exist in Phase 1
                     ------
                      0.790  < 0.85 auto-merge threshold
```

**Cross-agency auto-merge is mathematically impossible under the flat weights** — 20% of the
weight is dead in exactly the case correlation exists to handle. Flat scoring on the real
sample produced **0 merges from 812 observations**. With renormalization: 8 merges, 3 of them
cross-agency, 49 probable matches. The three cross-agency merges are all correct, e.g.:

```
18:51:28  sf_police_cad  INJURY VEH ACCIDENT   EARL ST \ GILMAN AVE
18:55:34  sf_ems_cad     Medical Incident      EARL ST \ GILMAN AVE
score 0.877  (loc 1.0, time 0.73, type 0.85, 0 m apart)
```

## Out of scope
The threshold decision (S-D3); learned weights.
