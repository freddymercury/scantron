# S-D6 — Verification classification and confidence

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D3 · **Size:** M

## Story
As a reader, I want to know how well-supported an incident is, so that I do not mistake a
single preliminary dispatch record for an established fact.

## Acceptance criteria
- [ ] `sourceCount` (distinct observations) and `independentSourceCount` (distinct `source` values, per the documented fire/EMS independence rule) computed on every update.
- [ ] Classification per PRD §23: one source → `reported`; ≥2 independent sources describing the same event → `multi-source`; response activity visible across ≥2 agencies (units dispatched by each) → `official-response-confirmed`.
- [ ] Classification is explicitly documented and tested as a statement about *response activity*, not about the truth of the underlying allegation.
- [ ] Per-dimension confidences stored: `locationConfidence`, `typeConfidence`, `correlationConfidence`, `statusConfidence`; overall `confidence` is a documented function of them.
- [ ] Confidence and per-dimension scores are internal — excluded from `PublicIncident` (S-A3); the UI receives only the classification label.
- [ ] Downgrade is possible: if a merge is undone (S-D9), classification recomputes downward.

## Out of scope
UI wording rules (S-F7).
