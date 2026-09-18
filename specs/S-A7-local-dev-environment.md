# S-A7 — Local development environment

**Epic:** A · Foundation · **Phase:** 0 · **Depends on:** S-A1 · **Size:** S

## Story
As an engineer, I want a working Postgres + PostGIS and a one-command bootstrap, so that
the first line of real code has somewhere to run.

**This is the actual blocker to starting.** Verified on the target machine 2026-09-17:
`bun 1.4.1` ✅, `rustc 1.84.0` ✅, `git 2.50.1` ✅ — but **no `psql`, no `pg_config`, and no
Docker daemon.** Nothing in Epic A beyond S-A1/S-A3 can run until this is resolved.

## Acceptance criteria
- [ ] A documented path to **plain Postgres 16 — no PostGIS required** ([ADR-002](../docs/03-dependency-policy.md) §3 removed that requirement, which was the hardest part of this story): (a) Postgres.app or `brew install postgresql@16`, (b) Docker, or (c) a hosted dev branch. **Decision recorded in this file once made.**
- [ ] `bun run setup` is idempotent and does everything: install deps, create the database, enable `postgis`, run migrations, load neighborhood polygons, seed taxonomy. Running it twice is safe.
- [ ] `bun run dev` starts the worker and the web app together with one command.
- [ ] `.env.example` lists every variable with a working local default; `bun run setup` fails loudly and specifically on a missing required variable, naming it.
- [ ] A `bun run doctor` command checks the environment (Bun version, Postgres reachable, required env vars) and prints actionable failures rather than a stack trace.
- [ ] Tests run against a disposable test database that is created and dropped per run, never the dev database.
- [ ] README documents the setup path in under ten lines, verified by following it on a clean machine.

## Note
Every command here is a Bun script in the repo — no `make`, no task runner, no `docker
compose` requirement.

## Recommendation
Option (c), a hosted Postgres with PostGIS, for the first week — it removes a local
install from the critical path and the dataset is small (4,556 observations per 48 h). Move
to local once the schema stabilises, since the correlation inner loop (S-D10) wants fast
local iteration and a network round-trip per query will hurt there.

## Out of scope
Production deployment, CI database provisioning (covered in S-A1's CI criterion).
