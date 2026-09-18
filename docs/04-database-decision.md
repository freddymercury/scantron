# ADR-003 — Database: SQLite (`bun:sqlite`)

**Status:** Decided · **Date:** 2026-09-17 · **Amends:** PRD §34, §36 · **Relates to:** [ADR-002](03-dependency-policy.md)

## Decision

**SQLite via `bun:sqlite`.** One file, zero dependencies, zero install. This amends PRD §34/§36
(Supabase/PostgreSQL + PostGIS).

## Measured, not assumed

Benchmarked on this machine, 1,000,000 rows (~1.2 years of SF at the observed rate of
2,278 observations/day):

```
insert 1,000,000 rows                3.90 s
database size                        243 MB   (~202 MB/year at SF volume)
feed page (100 rows)                 0.049 ms
FTS5 index 200k rows                 0.36 s
FTS5 query                           3.368 ms
S-D1 candidate retrieval             0.009 ms   ← with the right index
```

That last line is the one that matters, and it needed a fix worth recording:

```
(lat, lng) index                    10.039 ms
(occurred_at, lat, lng) index        0.009 ms   ← 1,100× faster, covering index
```

**Put `occurred_at` first.** The time window is far more selective than the bounding box, and
the three-column index becomes covering, so the query never touches the table. This is a
required index in S-A2, not an optimization to find later.

## Why SQLite wins here

1. **It deletes the only thing currently blocking the build.** No `psql`, no Docker, no hosted provisioning — S-A7 shrinks to "run the migrations."
2. **Zero dependencies**, exactly per [ADR-002](03-dependency-policy.md). `bun:sqlite` is in the runtime.
3. **In-process, so correlation gets microseconds instead of a network round-trip.** The S-D10 eval harness replays thousands of fixtures in a loop; at 0.009 ms per candidate lookup a full sweep is seconds, which is what makes weight tuning practical.
4. **Our architecture already assumes a single writer** (assumption 21 — one correlator process, deliberately). SQLite's one-writer model is not a compromise here; it is the design we chose independently.
5. **FTS5 and JSON are built in**, covering S-E4 search and raw payload storage with no extensions.
6. **A test database is a file.** `:memory:` for unit tests, a fixture file for S-D10, `cp` for a snapshot. The correlation corpus becomes trivially versionable.
7. **Backups are a file copy**, and [S-B5](../specs/S-B5-gap-detection-and-backfill.md) means a lost window is refillable from `2zdj-bwza` anyway — durability risk is bounded by a story we already wrote.

## What we give up, stated plainly

- **Single machine.** SQLite forces the worker and web app onto one host (WAL gives concurrent readers + one writer, same filesystem). This is fine now and is the main thing that would force a migration.
- **No `LISTEN/NOTIFY`.** S-E3 fan-out becomes an in-process event emitter — simpler and faster, but it means SSE does not survive multi-instance scale-out without change.
- **No PostGIS.** Already dropped in ADR-002 §3; bbox + haversine is what the benchmark measures.
- **Weak typing.** Mitigated with `STRICT` tables, `CHECK` constraints, and ISO-8601 UTC `TEXT` timestamps (lexicographically sortable, which is why the covering index works).

## Alternatives considered

| Option | Verdict |
|---|---|
| **Postgres** | The right answer *later*. Buys multi-host, `LISTEN/NOTIFY`, PostGIS, real types — none of which we need at 0.026 writes/sec. Today it costs a provisioning step that is currently blocking us. |
| **DuckDB** | Genuinely better for S-H6/S-H7 analytics (columnar, 90-day aggregates over 10M rows). But it is a dependency, it is poor at the row-level upserts that dominate ingestion, and running two stores doubles the schema. Revisit only if rollups become slow — they will not at 202 MB/year. |
| **Turso / libSQL** | SQLite with replication. Solves the single-machine limit, adds a hosted dependency. The natural escape hatch *if* multi-host arrives before a Postgres migration is warranted. |
| **Supabase (PRD default)** | Bundles Postgres + auth + realtime. We use none of the extras (no accounts — assumption 3), so it is a hosted dependency for a database we do not yet need. |

## Migration triggers — move to Postgres when any is true

- Web and worker must run on separate hosts, or the web tier must scale beyond one instance.
- Sustained write volume exceeds ~100/sec (≈4,000× current).
- A second city lands and per-city isolation or cross-city queries are needed.
- Analytical queries over rollups exceed ~1 s.

**Keep the migration cheap:** all access goes through `packages/database` — plain parameterized
SQL, no SQLite-specific syntax where standard SQL will do, no ORM to unpick. The schema in S-A2
is written to port.

## Required design constraints

- [ ] `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000` set on every connection.
- [ ] `STRICT` tables everywhere; enum-like columns get `CHECK` constraints.
- [ ] Timestamps are ISO-8601 UTC `TEXT` (sortable, comparable, index-friendly). Never local time, never epoch ints — they defeat readable debugging for no gain here.
- [ ] Coordinates are `REAL` lat/lng with the `(occurred_at, lat, lng)` covering index.
- [ ] One writer process, enforced by an advisory lock file; readers unrestricted.
- [ ] Nightly `VACUUM`/`ANALYZE` and a timestamped file snapshot.
