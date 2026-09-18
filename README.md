# Scantron

**A real-time structured feed of what is happening in San Francisco.**

Public-safety dispatch data from many agencies, correlated into one evolving object per
real-world event — not a scanner feed.

```
raw public signals → normalized observations → correlated incidents → real-time intelligence
```

## Read in this order

| | |
|---|---|
| [`prd.md`](prd.md) | The product requirements document |
| [`docs/00-assumptions.md`](docs/00-assumptions.md) | Every assumption made to render the PRD buildable, with corrections marked |
| [`docs/01-data-source-findings.md`](docs/01-data-source-findings.md) | **What the real DataSF feeds actually contain** — verified live, not from memory |
| [`docs/02-stack-decision.md`](docs/02-stack-decision.md) | ADR-001 — TypeScript/Bun; Rust reserved for Phase 2 radio DSP |
| [`docs/03-dependency-policy.md`](docs/03-dependency-policy.md) | ADR-002 — zero runtime dependencies; amends PRD §34 |
| [`docs/04-database-decision.md`](docs/04-database-decision.md) | ADR-003 — SQLite via `bun:sqlite`, with benchmarks |
| [`specs/README.md`](specs/README.md) | **55 work items**, one story each, with dependencies and build order |

## Mockups

Open in a browser — no build step, no dependencies.

- [`mockups/index.html`](mockups/index.html) — design mockup: feed, map, incident detail, neighborhood answers, historical windows
- [`mockups/live.html`](mockups/live.html) — **the same UI running on real San Francisco dispatch data**: 4,484 incidents correlated from 5,110 raw source rows

Regenerate the live mockup from current data:

```bash
python3 mockups/build/fetch_and_correlate.py && python3 mockups/build/render.py
```

## What the real data showed

Findings that changed the design, all measured against the live APIs on 2026-09-17:

- **The "Real-Time" dispatch feed is a ~30 minute batch feed.** Median 36.7 min from call received to first visibility; 0 of 24 sampled records under 30 seconds. PRD §41's "<30 second" target is not achievable from this source.
- **The PRD's own correlation weights make cross-agency auto-merge mathematically impossible** — the best possible cross-agency score is 0.79 against a 0.85 threshold. Flat scoring produced 0 merges from 812 observations; renormalizing over applicable features produced 8, of which 3 were correct cross-agency merges.
- **`sensitive_call` is a first-class field**, flagged by SFPD on ~35% of calls — a ready-made input to the visibility policy.
- **Incident reports join to dispatch records on `cad_number`** (~100% coverage for dispatched calls), which turns the city's own records into thousands of free correlation labels.
- **The real-time feed retains only ~48 hours**, but a historical dataset going back to 2014 shares its schema — so gaps are recoverable and history is available from day one.

## Status

Specification and design. No implementation yet — see the issues, which are filed in build order.
