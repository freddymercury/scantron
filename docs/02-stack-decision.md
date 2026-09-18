# ADR-001 — Language and runtime split

**Status:** Decided · **Date:** 2026-09-17 · **Supersedes:** nothing · **Relates to:** PRD §34

## Question

Rust, TypeScript/Bun, or both?

## Decision

**TypeScript on Bun for everything in Phase 0 and Phase 1. No Rust yet.**
**A Rust seam is reserved for Phase 2 radio DSP**, where it is the right tool and where the
boundary is naturally clean (process-level, audio in / transmissions out).

## Why not Rust now — the volume math

This is the whole argument. Measured from the real feeds, 2026-09-17:

```
48 h of live data:  3,959 police rows + 1,151 fire unit-rows
                 =  4,556 observations
                 =  0.026 observations per second
```

Peak day observed: 2,095 police rows — **0.024/sec**. Correlation runs against a candidate
set capped at ~50 incidents (S-D1), scoring five arithmetic features. The entire per-event
CPU cost is microseconds of float math and one PostGIS index lookup.

And the ceiling is lower than that: **the upstream source republishes in batches roughly
every 15–30 minutes** (§5 of `01-data-source-findings.md`). The pipeline is idle the
overwhelming majority of the time. There is no throughput problem to solve.

Rust optimizes a constraint this system does not have. At 100× San Francisco's volume —
every large city in California at once — this workload still fits comfortably in one Bun
process.

## Why TypeScript specifically

1. **The shared schema is the single biggest productivity lever here.** `packages/incident-schema` (S-A3) defines Zod schemas that are the source of truth for the ingester, the correlator, the API, the SSE payloads, *and* the React components. One definition, validated at every boundary, inferred types everywhere. A Rust/TS split means maintaining that contract twice and hand-syncing it — the exact class of bug this product cannot absorb, because a silent field mismatch is how restricted data leaks into a public payload (S-E1).
2. **Correlation is config and iteration, not computation.** The work in S-D2/S-D3/S-D10 is tuning weights and replaying fixtures. Iteration speed matters far more than execution speed; `bun test` on a fixture corpus is the inner loop.
3. **One runtime, one dependency graph, one test command.** Bun runs the services, the test suite, and the Next.js app.

## Where Rust genuinely earns its place — Phase 2

Radio is a different workload class, and TypeScript is the wrong tool for it:

| Task | Why it is CPU-bound |
|---|---|
| SDR I/Q capture | continuous 2.4 MS/s sample stream |
| Channelization / demodulation | per-sample DSP across many talkgroups |
| Voice activity detection | continuous analysis to segment transmissions |
| Resampling / encoding | per-transmission audio conversion |

That is real signal processing at real sample rates, running continuously — the opposite of
the bursty, tiny, I/O-bound CAD workload. When Phase 2 starts (`S-G2`, gated on legal
review), the Rust component is a **separate process with a narrow interface**: raw radio in,
discrete transmission files + metadata out. It never touches the incident model. It emits
Observations over the same queue as everything else, so the schema stays single-sourced in
TypeScript. Note the incumbent (`trunk-recorder`) is C++ and may be adopted outright rather
than written.

## Consequences

- One language, one toolchain, for the entire first build. No FFI, no codegen, no schema duplication.
- `cargo` stays installed and unused until Phase 2. The reserved seam is documented, not built (`S-G2`).
- If a genuine hot spot ever appears, the escape hatch is cheap and local: a single Bun FFI call or a sidecar process behind an existing interface. We are not architecturally trapped.
- **Revisit this ADR if** any of these become true: sustained ingest exceeds ~500 obs/sec, correlation p95 exceeds 100 ms under production volume, or Phase 2 radio work begins.

## Verified toolchain (this machine, 2026-09-17)

```
bun    1.4.1   ✅ meets PRD §34 (>= 1.4)
node   24.3.0  ✅ (tooling only)
rustc  1.84.0  ✅ present, unused until Phase 2
git    2.50.1  ✅
psql   — not installed   ⚠ blocks S-A2
docker — not installed   ⚠ blocks the usual local-Postgres path
```

**The database is the actual blocker to starting, not the language choice.** See `S-A7`.
