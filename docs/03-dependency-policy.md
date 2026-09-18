# ADR-002 — Dependency policy: build our own, minimally

**Status:** Decided · **Date:** 2026-09-17 · **Amends:** PRD §34 · **Relates to:** [ADR-001](02-stack-decision.md)

## Decision

**Target zero runtime dependencies.** Every capability the product needs is either built into
Bun, small enough to own outright, or genuinely not worth owning — and the third category is
deliberately tiny and enumerated below.

This **amends PRD §34**, which names Next.js, React, Material UI and MapLibre/Mapbox. None of
those survive the policy. Reasoning per item below.

## What Bun already gives us (no dependency required)

| Need | Bun built-in | Replaces |
|---|---|---|
| Postgres client | `Bun.sql` / `SQL` | `pg`, `postgres.js` |
| HTTP server + routing | `Bun.serve({ routes })` | express, hono, fastify |
| SSE | `Bun.serve` streaming response | sse libraries |
| Test runner + coverage | `bun:test` | vitest, jest |
| HTTP client | `fetch` | axios, node-fetch |
| Bundler / TS transpile | `Bun.build`, native TS | webpack, esbuild, tsx |
| Hot reload | `bun --hot` | nodemon |
| Env loading | automatic `.env` | dotenv |
| SQLite (fixtures/tests) | `bun:sqlite` | better-sqlite3 |
| Hashing / crypto | `Bun.password`, WebCrypto | bcrypt, crypto libs |
| Timezone-correct formatting | `Intl.DateTimeFormat` | date-fns, luxon, dayjs |

## What we build ourselves, and the honest size estimate

| Tool | Est. | Why it is worth owning |
|---|---|---|
| Schema validator | ~200 lines | **Allowlist-by-default**, which is safer here than Zod's opt-out posture. `PublicIncident` must emit *only* named fields — an allowlist makes an accidental leak structurally impossible rather than merely tested for (S-E1, S-A3). |
| Migration runner | ~100 lines | Read `migrations/*.sql` in order, track in `schema_migrations`, wrap each in a transaction. That is the entire feature. |
| Job queue | ~150 lines | Already specced as `FOR UPDATE SKIP LOCKED` (S-A5). A library would add more than it removes. |
| Logger + metrics | ~120 lines | `JSON.stringify` to stdout; Prometheus text format is a string join (S-A6). |
| Geo math | ~150 lines | Haversine + bounding-box prefilter + ray-casting point-in-polygon. See the PostGIS note below. |
| Location normalizer | (S-C1) | Always was ours — it is the domain asset (PRD §57). |
| HTML rendering | ~200 lines | Template literals returning strings. Server-rendered, no VDOM. |
| Client runtime | ~400 lines | Fetch, render, SSE, URL state. **The mockups already prove this** — `live.html` renders 4,484 real incidents, a projected map, filters and a historical view in vanilla JS with zero dependencies. |

## The three that need a real argument

**1. Next.js + React + MUI — dropped.**
The UI is a list, a map, a detail panel, and a live updating stream. `mockups/live.html` is
the existence proof: it already does all of that, with real data, in one file with no build
step. Server-render HTML from `Bun.serve`, hydrate with a small client. *Risk, stated
plainly:* hand-rolled state management gets unpleasant as filters, URL state and map
interactions compound. Revisit if the client runtime passes ~1,500 lines — that is the signal
we chose wrong, and adopting a view library later is a contained change because the server
already emits HTML.

**2. MapLibre GL — dropped for now, and this is the closest call.**
A general slippy map (vector tiles, pan/zoom, label placement, projection) is weeks of work
and we should never hand-roll one. But **we do not need a general map.** San Francisco is a
fixed, small bounding box; the mockup projects real lat/lng to SVG in four lines and plots
thousands of points acceptably. Ship that. Adopt MapLibre only when panning over a real
basemap becomes a requirement — at which point it is a genuine dependency earning its keep,
not a default.

**3. PostGIS — dropped, and it buys back the S-A7 blocker.**
Non-obvious consequence: at our volume (4,556 observations per 48 h), radius queries are a
bounding-box index scan plus haversine, and neighborhood assignment is ray-casting against
~40 polygons — **and 63% of records arrive with `analysis_neighborhood` already populated**
(verified, `01-data-source-findings.md`). Dropping the PostGIS requirement means plain
Postgres, which removes the hardest part of the local-environment setup. If clustering or
complex spatial joins later justify it, `CREATE EXTENSION postgis` is additive and no schema
we write today prevents it.

## Where we explicitly do NOT build our own

Non-negotiable, because getting these wrong is a security incident, not a bug:

- **TLS, HTTP parsing, WebSocket framing** → Bun's.
- **Password hashing, crypto primitives, random** → `Bun.password`, WebCrypto.
- **Postgres wire protocol** → `Bun.sql`.
- **Timezone/DST arithmetic** → `Intl`. DST is a swamp; SF observes it and rollup day-bucketing (S-H6) crosses it twice a year.

Owning a parser is fine. Owning a security boundary is not.

## Enforcement

- [ ] `package.json` `dependencies` stays **empty**. `devDependencies` limited to `typescript` and `@types/*`.
- [ ] A CI check fails the build if any runtime dependency is added without a matching ADR amendment in this file.
- [ ] Any proposed dependency must state: what it replaces, the line count we avoid, and why the built-in path is insufficient.

## Honest cost

More code we own is more code we maintain, and "minimal dependencies" erodes quietly under
deadline pressure. The enforcement check above exists because the policy will otherwise decay.
The bet is that this product's hard parts — correlation, location normalization, event
taxonomy, verification — are **all** domain logic we were always going to write ourselves
(PRD §57), and the framework layer around them is thin enough that owning it is cheaper than
integrating it.
