# S-C4 — Unit identifier parsing and registry

**Epic:** C · Normalization · **Phase:** 0 · **Depends on:** S-B2 · **Size:** S

## Story
As the system, I want responding units parsed into canonical identifiers, so that unit
overlap can act as a correlation signal and the UI can show who is responding.

## Acceptance criteria
- [ ] Unit strings normalized to a canonical form (`E07`, `T07`, `B02`, `MEDIC18`, `3A12`) with agency and unit-class (engine, truck, battalion, medic, patrol, rescue) inferred by pattern.
- [ ] `units` and `incident_units` populated; a unit appearing on several observations of one incident is recorded once, with first-seen time.
- [ ] Unrecognized unit strings are stored raw with `class: unknown` rather than discarded.
- [ ] Unit identifiers are treated as **non-sensitive** (they identify apparatus, not people); no officer names or badge numbers are ever stored even if present upstream — they are dropped at the adapter with a counter.
- [ ] Parser fixture suite covers each observed unit format per agency.

## Out of scope
Unit status tracking (en route / on scene) — dispatch data does not reliably provide it.
