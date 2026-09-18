# Implementation handoff

Everything needed to start writing code. Written at the end of specification, before the
first line of implementation.

## Start here

```bash
git clone https://github.com/freddymercury/scantron && cd scantron
open mockups/live.html          # the target UI, on real data
```

Work the issues in **title order** (`[1]`…`[55]`), not issue-number order — see
[`specs/README.md`](../specs/README.md) §Sequence.

**First five:**

| # | Story | Note |
|---|---|---|
| 1 | S-A1 Monorepo scaffold | Needs nothing. Start now. |
| 2 | S-A7 Local dev environment | **The blocker.** No Postgres/Docker on the dev machine — but ADR-003 chose SQLite, so this is now "run the migrations". |
| 3 | S-A3 `incident-schema` | Hand-rolled validators, allowlist-by-default. No Zod. |
| 4 | S-A2 Database schema | SQLite, `STRICT` tables, ISO-8601 UTC TEXT timestamps. |
| 5 | S-A5 Job queue | Postgres-style `SKIP LOCKED` becomes a SQLite transaction + status column. |

## Decisions already made — do not relitigate

| | Decision | Where |
|---|---|---|
| Language | TypeScript on Bun 1.4. Rust reserved for Phase 2 radio DSP only. | [ADR-001](02-stack-decision.md) |
| Dependencies | **Zero runtime dependencies.** No Next.js, React, MUI, MapLibre, Zod, ORM. | [ADR-002](03-dependency-policy.md) |
| Database | SQLite via `bun:sqlite`. No PostGIS. | [ADR-003](04-database-decision.md) |
| Map | Own SVG/canvas linear projection; SF is a fixed bbox. | ADR-002 §2 |
| UI | Server-rendered HTML from `Bun.serve`, ~400-line client runtime. | S-F1 |

Each ADR carries an explicit **revisit trigger**. Hitting one is a reason to change course;
preference is not.

## Five things that will bite you in week one

1. **Index `(occurred_at, lat, lng)` — in that order.** Measured: 10.039 ms → 0.009 ms, a
   1,100× difference on the correlation inner loop, because the time window is more selective
   than the bbox and the index becomes covering. This is the single highest-leverage line of
   SQL in the project.
2. **Renormalize correlation scores over *applicable* features.** The PRD's flat weights make
   cross-agency auto-merge mathematically impossible (best possible score 0.79 vs a 0.85
   threshold, because unit overlap can never fire across agencies). Flat scoring produced
   **0 merges from 812 real observations**. See S-D2.
3. **The source is a ~30-minute batch feed, not real-time.** Median 36.7 min, 0 of 24 records
   under 30 s. Poll every 60 s, not 15 s. Track **source lag** and **pipeline lag** as separate
   metrics — only the second one is yours.
4. **`sensitive_call` is true on ~35% of calls.** Treat as authoritative and restrictive by
   default (S-E1). Nothing reaches a public endpoint before E1 exists.
5. **Fire/EMS data is one row per *unit*, not per call.** Group by `call_number` or your
   incident counts inflate. Police incident reports are likewise one row per *offence* —
   dedupe on `cad_number` or inflate ~70%.

## Verified data sources

| Source | ID | Retention | Freshness |
|---|---|---|---|
| Police dispatch (live) | `gnap-fj3t` | **~48 h rolling** | ~30 min batch |
| Police dispatch (historical) | `2zdj-bwza` | since 2014, 7.9M rows | ~1 day |
| Fire/EMS calls | `nuek-vuh3` | since 2000, 7.4M rows | ~19 h |
| Police incident reports | `wg3w-h783` | full | ~2 days |

Host is `data.sf.gov` (`data.sfgov.org` 301-redirects). All join on `cad_number`.
Feeds contain malformed rows — validate on insert, quarantine failures.

Full detail: [`01-data-source-findings.md`](01-data-source-findings.md).

## Phase 0 exit gate

**S-B4** (issue 16). 72 hours of continuous ingestion viewed through the raw observation
viewer: no duplicate explosion, no unexplained gaps, geocode and taxonomy coverage visible.
**Do not start Epic D until this passes** — correlation on unvalidated data is unfalsifiable.

## Then: the front door

Positions 35–37 are H1→H2→H3, the neighborhood answer, deliberately ahead of incident detail
and filters. The first end-to-end demo should be *a question getting answered*, not a list of
dispatch calls. It is also the more honest demo, since a digest makes no claim to be live.

## Open questions that need a human, not a commit

- Should 90-day windows ship publicly at all, or stay Newsroom/API-tier? The longer the
  window, the more it reads like crime statistics we are not producing.
- Should the "busier than usual" baseline (S-H5) ship at all? It is one bad label away from
  reading as a neighborhood danger score.
- Terms-of-use review for redistributing DataSF data through our own API (S-E2).
- Legal review of radio capture — **must** precede any Phase 2 work.
- The sensitive-call blocklist contents (S-E1) need human review, not just the mechanism.

## Known-weak signal to watch

The whole product premise is signal reduction (PRD §54): thousands of observations becoming
dozens of incidents. **Measured on 48 h of real data: 5,110 raw rows → 4,556 observations →
4,484 incidents.** Almost no reduction. The only real compression came from grouping fire
unit-rows. With police + fire CAD alone there is little cross-agency overlap to exploit.

This is the central hypothesis, and it is currently unproven. Watch the merge rate as
correlation is tuned (S-D10 measures it). If it stays near zero after tuning, the product
needs either more sources or a different framing — better to learn that at issue 20 than at
issue 50.
