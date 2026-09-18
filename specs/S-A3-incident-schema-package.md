# S-A3 — `incident-schema` package

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** S-A1 · **Size:** S

## Story
As an engineer, I want one canonical, runtime-validated definition of `Observation`,
`Incident`, `TimelineEvent` and the event payloads, so that every service and the web app
agree on shape without duplicating types.

## Acceptance criteria
- [ ] **Hand-rolled validators (no Zod — see [ADR-002](../docs/03-dependency-policy.md))**, ~200 lines, as the source of truth for `Observation`, `Incident`, `TimelineEvent`, `NormalizedLocation`, `IncidentType`, `IncidentStatus`, `VerificationClassification`, with TypeScript types declared alongside and a test asserting they stay in sync.
- [ ] Validators are **allowlist-by-default**: a field not explicitly declared is stripped, not passed through. This is the point of owning them — an undeclared field can never reach a public payload.
- [ ] Shapes match PRD §8 and §9, including `confidence`, `verification { sourceCount, independentSourceCount, classification }`, and `observationIds`.
- [ ] Separate `PublicIncident` schema representing exactly what the API may return — it omits internal fields (raw text, per-dimension confidence, correlation debug, visibility). Built by **explicit field allowlist**, so adding an internal field to `Incident` cannot silently widen the public surface.
- [ ] A test adds a hostile extra field (`ssn`, `officer_name`, `sensitive_call`) to an `Incident` and asserts it is absent from the serialized `PublicIncident`.
- [ ] SSE payload schemas for `incident.created | updated | resolved | merged`.
- [ ] Row↔domain mappers (`toDomain`, `toRow`) with round-trip tests.
- [ ] Any schema change without a mapper/test update fails CI.
- [ ] Zero runtime dependencies in this package.

## Out of scope
Persistence logic, API routing.
