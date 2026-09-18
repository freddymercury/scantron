# S-C3 — Observation type classification

**Epic:** C · Normalization · **Phase:** 0 · **Depends on:** S-A4 · **Size:** S

## Story
As the system, I want each observation assigned a normalized incident type and severity
hint from its raw agency code, so that downstream correlation and UI speak one vocabulary.

## Acceptance criteria
- [ ] `normalize_observation` applies the taxonomy from S-A4, writing `normalized_type`, `type_confidence`, `default_severity`, while retaining `raw_type`/`raw_subtype`.
- [ ] Priority codes from each agency map to a normalized 1–5 priority scale via config.
- [ ] Re-running normalization after a taxonomy change updates existing observations in place and enqueues re-correlation for affected active incidents.
- [ ] A backfill command re-normalizes a date range on demand.
- [ ] Unmapped codes surface in the S-B4 viewer with counts, ordered by frequency, so mapping effort goes where the volume is.

## Out of scope
Changing an incident's type (S-D7 corrections).
