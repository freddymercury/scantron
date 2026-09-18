# S-A4 — Configurable event taxonomy

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** S-A3 · **Size:** M

## Story
As an operator, I want raw agency call-type codes mapped to the normalized taxonomy
through configuration, so that classification can change without a code deploy.

## Acceptance criteria
- [ ] Normalized top-level types are exactly PRD §10: Fire, Medical, Collision, Assault, Weapon, Robbery, Burglary, Theft, Disturbance, Missing Person, Hazard, Rescue, Traffic, Public Safety, Police Activity, Unknown.
- [ ] Mappings live in the `event_taxonomy` table, seeded from a versioned YAML/JSON file per source (`sf_police_cad`, `sf_fire_cad`, `sf_ems_cad`), and are hot-reloaded at most 60 s after change.
- [ ] Each mapping row: `source`, `raw_code`, `raw_label_pattern?`, `normalized_type`, `default_severity`, `type_confidence`.
- [ ] Raw code and raw label are always persisted on the observation alongside the normalized type (PRD §10).
- [ ] Unmapped codes resolve to `Unknown` with `type_confidence = 0.2`, and are counted in an `unmapped_code` metric with the raw value, so gaps are visible.
- [ ] Given a raw code with both an exact and a pattern match, the exact match wins (documented precedence, covered by test).

## Out of scope
LLM-based classification; severity modelling beyond the per-mapping default (see S-D6).
