# S-A2 — Database schema and geospatial foundation

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** S-A1 · **Size:** M

## Story
As an engineer, I want the core tables and PostGIS geometry in place with migrations,
so that ingestion and correlation have a durable, queryable home.

## Acceptance criteria
- [ ] **Own migration runner** (~100 lines, no library — [ADR-002](../docs/03-dependency-policy.md)): forward-only `.sql` files from `packages/database/migrations`, applied in order, each in a transaction, tracked in `schema_migrations`. Run via `bun run db:migrate`.
- [ ] Database access via **`Bun.sql`** — no `pg`, no ORM, no query builder. Parameterized queries only; string-concatenated SQL fails review.
- [ ] **No PostGIS.** Coordinates are plain `double precision` `lat`/`lng` columns with a composite B-tree index, queried by bounding-box prefilter + haversine (see S-C2). Rationale and the revisit trigger are in [ADR-002](../docs/03-dependency-policy.md) §3 — this removes the hardest part of local setup (S-A7) at our data volume.
- [ ] Schema is written so `CREATE EXTENSION postgis` remains a purely additive future change.
- [ ] Tables created per PRD §37: `observations`, `incidents`, `incident_observations`, `timeline_events`, `locations`, `units`, `incident_units`, `source_records`, `event_taxonomy`, `source_configuration`. (`transcripts` created but unused until Phase 2.)
- [ ] `observations` has `UNIQUE (source, source_record_id)` — the idempotency key of the whole system.
- [ ] `incidents` has `status`, `primary_type`, `first_observed_at`, `last_updated_at`, `merged_into_id` (nullable self-FK), and partial index on active incidents ordered by `last_updated_at`.
- [ ] `timeline_events` carries a non-null `observation_id` FK — no timeline entry can exist without a source.
- [ ] A seeded local database can be created from scratch with one command and is used by tests.
- [ ] Neighborhood polygons stored as GeoJSON in a `neighborhoods` table, loaded from the DataSF Analysis Neighborhoods extract by a repeatable script; point-in-polygon is ray-casting in TypeScript (~40 lines) against ~40 polygons, cached in memory.

## Technical notes
All timestamps `timestamptz`, stored UTC. Enum-like columns are text + CHECK, not PG enums
(cheaper to evolve). Row-level deletes are never used; corrections are additive.

## Out of scope
Read replicas, partitioning, retention jobs (see S-E1 for delay, not retention).
