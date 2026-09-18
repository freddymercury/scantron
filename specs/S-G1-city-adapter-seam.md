# S-G1 — City adapter seam

**Epic:** G · Seams for later phases · **Phase:** 1 · **Depends on:** S-B2, S-C2 · **Size:** S

## Story
As an engineer, I want SF-specific integration behind a `CityAdapter` interface, so that a
second city is an implementation rather than a refactor.

## Acceptance criteria
- [ ] `CityAdapter` interface per PRD §50: `ingest()`, `normalizeLocation(raw)`, `classify(observation)`, plus `neighborhoodFor(point)` and a city config (bounds, timezone, sources).
- [ ] `cities/san-francisco` implements it; ingestion, normalization and classification call only through the interface.
- [ ] A lint/dependency rule prevents core packages and services from importing `sf-domain` directly.
- [ ] A trivial fake city adapter used in tests proves the core runs without SF data.
- [ ] Documentation lists exactly what a new city must supply.

## Out of scope
Any second city.
