# Lescan — Specs

One story per work item. 55 stories. Each file is independently implementable and independently
reviewable; every acceptance criterion is meant to be checkable without asking the author
what they meant.

Read first: [`../docs/00-assumptions.md`](../docs/00-assumptions.md),
then [ADR-001 stack](../docs/02-stack-decision.md) and
[ADR-002 dependency policy](../docs/03-dependency-policy.md) — ADR-002 **amends PRD §34**
(no Next.js, React, MUI, MapLibre or PostGIS).
Look at first: [`../mockups/index.html`](../mockups/index.html) — open it in a browser.

Scope is PRD §59: Phase 0 + Phase 1, no radio. Phase 2–4 appear only as seams (Epic G).

## Epic A — Foundation (Phase 0)
| Story | Depends on |
|---|---|
| [S-A1 Monorepo scaffold](S-A1-monorepo-scaffold.md) | — |
| [S-A2 Database schema and PostGIS](S-A2-database-schema-postgis.md) | A1 |
| [S-A3 `incident-schema` package](S-A3-incident-schema-package.md) | A1 |
| [S-A4 Configurable event taxonomy](S-A4-event-taxonomy.md) | A3 |
| [S-A5 Postgres job queue](S-A5-job-queue.md) | A2 |
| [S-A6 Observability](S-A6-observability.md) | A5 |
| [S-A7 Local dev environment](S-A7-local-dev-environment.md) | A1 |

## Epic B — Ingestion (Phase 0)
| Story | Depends on |
|---|---|
| [S-B1 SFPD CAD ingest](S-B1-sfpd-cad-ingest.md) | A2, A3, A5 |
| [S-B2 SFFD/EMS CAD ingest](S-B2-sffd-ems-cad-ingest.md) | B1 |
| [S-B3 Source config and health](S-B3-source-config-health.md) | B1, A6 |
| [S-B4 Raw observation viewer](S-B4-raw-observation-viewer.md) | B2, C3 |
| [S-B5 Gap detection and backfill](S-B5-gap-detection-and-backfill.md) | B1, B3 |

## Epic C — Normalization (Phase 0)
| Story | Depends on |
|---|---|
| [S-C1 Location text normalization](S-C1-location-text-normalization.md) | A3 |
| [S-C2 Geocoding and neighborhoods](S-C2-geocoding-neighborhood.md) | C1, A2 |
| [S-C3 Type classification](S-C3-type-classification.md) | A4 |
| [S-C4 Unit parsing](S-C4-unit-parsing.md) | B2 |

## Epic D — Incident intelligence (Phase 1)
| Story | Depends on |
|---|---|
| [S-D1 Candidate retrieval](S-D1-candidate-retrieval.md) | C2 |
| [S-D2 Correlation scoring](S-D2-correlation-scoring.md) | D1 |
| [S-D3 Merge decision + probable log](S-D3-merge-decision-and-probable-log.md) | D2 |
| [S-D4 Incident lifecycle](S-D4-incident-lifecycle.md) | D3 |
| [S-D5 Timeline construction](S-D5-timeline-construction.md) | D3 |
| [S-D6 Verification and confidence](S-D6-verification-and-confidence.md) | D3 |
| [S-D7 Corrections](S-D7-corrections.md) | D4, D5 |
| [S-D8 Template summary](S-D8-incident-summary-line.md) | D6 |
| [S-D9 Incident merge and tombstone](S-D9-incident-merge-and-tombstone.md) | D3 |
| [S-D10 Correlation eval harness](S-D10-correlation-fixture-harness.md) | D3 |

## Epic E — Publication and API (Phase 1)
| Story | Depends on |
|---|---|
| [S-E1 Visibility and publication delay](S-E1-visibility-and-publication-delay.md) | D4 |
| [S-E2 REST API](S-E2-rest-api.md) | E1 |
| [S-E3 SSE stream](S-E3-sse-stream.md) | E2 |
| [S-E4 Search](S-E4-search.md) | E2 |
| [S-E5 Server-side filters](S-E5-filters.md) | E2 |

## Epic F — Web (Phase 1)
| Story | Depends on |
|---|---|
| [S-F1 App shell](S-F1-web-app-shell.md) | E2 |
| [S-F2 Feed](S-F2-incident-feed.md) | F1 |
| [S-F3 Map](S-F3-map.md) | F1 |
| [S-F4 Incident detail](S-F4-incident-detail.md) | F2 |
| [S-F5 Real-time client](S-F5-realtime-client.md) | E3, F2 |
| [S-F6 Filter and search UI](S-F6-filters-search-ui.md) | E4, E5 |
| [S-F7 Uncertainty language](S-F7-uncertainty-language.md) | D6, F4 |

## Epic H — Ask & neighborhood answers (Phase 1 / 1.5)
"What activity is there in my neighborhood?" as a first-class product surface.

| Story | Depends on |
|---|---|
| [S-H1 "My neighborhood" resolution](S-H1-neighborhood-resolution.md) | C2 |
| [S-H2 Neighborhood activity digest API](S-H2-neighborhood-activity-api.md) | E2, H1 |
| [S-H3 Neighborhood answer view](S-H3-neighborhood-view.md) | H2, F2, F3 |
| [S-H4 Ask interface (bounded NL)](S-H4-ask-interface.md) | H3, E4 |
| [S-H5 Neighborhood activity baseline](S-H5-activity-baseline.md) | H2 |
| [S-H6 Historical rollups and comparability](S-H6-historical-rollups.md) | H2, D9 |
| [S-H7 Historical trend answer (7/30/90d)](S-H7-historical-trend-view.md) | H6, H3 |

## Epic I — Outcome sources (Phase 3)
News coverage and published incident reports, attached to the incidents they describe.
**Read the risk notes in S-I5 and S-I6 before scheduling any of this.**

| Story | Depends on |
|---|---|
| [S-I1 `outcome-reported` tier](S-I1-outcome-tier.md) | D6, D7 |
| [S-I2 SFPD incident report ingest + CAD join](S-I2-sfpd-incident-report-ingest.md) | I1, B1 |
| [S-I3 Reports as correlation ground truth](S-I3-reports-as-ground-truth.md) | I2, D10 |
| [S-I4 News source adapter](S-I4-news-source-adapter.md) | I1 |
| [S-I5 Late-binding correlation](S-I5-late-binding-correlation.md) | D2, D9 |
| [S-I6 Article-to-incident matching](S-I6-article-matching.md) | I4, I5 |
| [S-I7 Related coverage and outcome UI](S-I7-related-coverage-ui.md) | I6, F4, F7 |

## Epic G — Seams for later phases
| Story | Depends on |
|---|---|
| [S-G1 City adapter seam](S-G1-city-adapter-seam.md) | B2, C2 |
| [S-G2 Transcription provider seam](S-G2-transcription-provider-seam.md) | A3 |
| [S-G3 Admin and corrections](S-G3-admin-corrections.md) | D9, B4 |

## Suggested build order

0. **A7 first — it is the blocker.** No Postgres and no Docker on the target machine as of 2026-09-17; nothing in Epic A past A1/A3 can run until that is fixed. Stack decision is settled in [ADR-001](../docs/02-stack-decision.md): **TypeScript/Bun throughout, Rust reserved for Phase 2 radio DSP only.**
1. **A1 → A2 → A3 → A5 → A4 → A6** — nothing works before the schema and queue.
2. **B1 → C1 → C2 → C3 → B2 → C4 → B3 → B5 → B4** — then run it for 72 hours. **B4 is the Phase 0 gate.** Do not start Epic D until the data has proven itself.
3. **D1 → D2 → D3 → D10** early — the eval harness comes right after the first correlator, not at the end. **D10 is the guard on the project's biggest technical risk.**
4. **D4, D5, D6 → D9 → D7 → D8** — incident state, then history, then self-healing.
5. **E1 first in Epic E.** Nothing is public until visibility and delay exist.
6. **E2 → E3/E4/E5 → F1 → F2/F3 → F4 → F5 → F6 → F7.** F7 can be written alongside F4; it is small and it is the one that keeps the product honest.
7. **H1 → H2 → H3** right after F3 — this is the first thing that makes the product answer a question instead of presenting a feed. **H6 → H7 → H5 → H4** follow once there is history: rollups before trends, trends before baselines (a baseline is a rollup with statistics on it), and the ask grammar last, built from real logged questions. Note that H5 and H7 cannot be *evaluated* until ~90 days after continuous ingestion begins — build them late, or build them early and accept that the numbers are not yet meaningful.
8. **Epic I is Phase 3 and should not start until the real-time correlator has a stable committed S-D10 baseline.** Within it the order is inverted from the obvious one: **I2 → I3 first** (ground truth, ships nothing to users, highest value), then **I1**, then **I4 → I5 → I6 → I7** only if the consumer case survives the reality checks.
9. **G1** folds in during Epic C; **G2** any time; **G3** immediately after the first demo.

## Definition of done (every story)
Typechecks, tests pass, metrics/logs emitted where relevant, config documented in
`.env.example` or the config file, and no new public field bypasses the `PublicIncident`
schema.
