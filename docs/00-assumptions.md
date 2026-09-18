# Assumptions & Decisions

Everything here is a decision I made to make the PRD buildable. Each one is a place to
push back — changing an assumption changes specific stories, noted inline.

## A. Scope

1. **Build scope = PRD §59 "Recommended First Build"** — Phase 0 (data feasibility) +
   Phase 1 (incident intelligence). Radio (Phase 2), summaries-as-product (Phase 3) and
   alerts (Phase 4) are specced only as far as the seams they require. Exception: a
   template-based (non-LLM) summary line ships in Phase 1 because the feed is unreadable
   without one — see `S-D8`.
2. **One city, hardcoded config, but behind the `CityAdapter` seam** (PRD §50). We do not
   build a second city; we do keep SF specifics in `packages/sf-domain`.
3. **Single-tenant, no accounts, no auth on the public web app.** Saved locations and
   alerts (which imply accounts) are out of scope. Internal/admin views are protected by a
   shared secret header, not a user system.

## B. Data sources

4. **SFPD source = DataSF "Law Enforcement Dispatched Calls for Service: Real-Time",
   dataset `gnap-fj3t` on `data.sf.gov`** (`data.sfgov.org` 301-redirects). **Verified
   2026-09-17.** Polled, not pushed. Keyed by `cad_number`. *If the dataset is retired or rate-limited, `S-B1` and
   `S-B3` change; the Observation model does not.*
5. **SFFD/EMS source = "Fire Department Calls for Service" / active-calls feed,** same
   Socrata mechanism, different schema and a **materially worse latency profile** (minutes,
   not seconds). We assume fire/EMS data lags police data by up to several minutes, which
   is why correlation windows are generous (§C11).
6. ~~**No source provides a reliable "this call is now closed" signal.**~~ **CORRECTED
   2026-09-17 — this was wrong.** The dispatch feed carries `close_datetime` (83.3%),
   `disposition` (75.1%), `onscene_datetime` (84%) and `enroute_datetime` (100%). Staleness
   inference is the *fallback* for the unclosed remainder, not the mechanism. See
   [`01-data-source-findings.md`](01-data-source-findings.md) §2.
7. **Socrata gives us a modification-ordered cursor** (`:updated_at` or
   `received_datetime`). Polling is cursor-based with overlap, not full-table.
8. **Rate limit:** one app token, ~1 req/sec sustained. A 15s poll per source is safely
   inside that. *If we need <10s freshness we need a second token or a push feed.*
8d. **CORRECTED 2026-09-17 — the "Real-Time" feed is a ~30-minute batch feed.** Measured:
    median 36.7 min from `received_datetime` to first visibility, min 23.9 min, p90 128 min,
    **0 of 24 records under 30 seconds**. PRD §41's <30 s target is unachievable from this
    source. See `01-data-source-findings.md` §5. The claim below about second-level freshness
    was wrong and is kept only for the record:
8a. ~~**The real-time feed is genuinely real-time**~~, and its 48-hour retention is the
    *source's* limit, not ours.** We poll every 15 s and persist to our own Postgres
    indefinitely — retention is a constraint on **backfill and pre-launch history only**,
    never on what we can accumulate going forward. Verified 2026-09-17: `gnap-fj3t` holds
    ~2 days (Sep 17: 1,786 rows; Sep 16: 2,095; Sep 15: 183 and aging out).
8b. **Two police datasets, one schema.** `gnap-fj3t` (real-time, ~48 h retention) for live
    ingest; `2zdj-bwza` (7.9M rows since 2014-12-31, ~1 day lag, same fields and
    `cad_number`) for gap backfill and pre-launch history. This makes an outage recoverable
    and removes the "we can never have history before launch" limit — see `S-B5`.
8c. **Source data contains malformed rows.** `2zdj-bwza` includes an export footer row with
    `cad_number = "Completion time: 2025-03-11T11:42:36…"`. Validate on insert and quarantine
    failures; do not trust the feed's shape.

## C. Correlation

9. **Correlation is deterministic and configurable, not ML.** Weighted feature scoring
   (PRD §17) with thresholds from config. No training data exists yet; the probable-match
   log (`S-D3`) is what creates it.
10. **Candidate window: 400 m radius and −10/+15 minutes** around the observation. Wider
    than it sounds necessary because cross-agency records for one event are commonly
    offset by both geocoding error and dispatch lag.
11. **Merge is one-directional and append-only.** An observation joins an incident; two
    incidents can merge (`S-D9`) but the losing incident is tombstoned, never deleted, and
    its ID keeps resolving via a 301-style redirect.
12. **Auto-merge at ≥0.85, probable at 0.65–0.84, new below.** Probable matches **create a
    new incident** and log the pair for review. Rationale: a wrong merge is less
    recoverable in the UI than a duplicate, and duplicate rate is a measured metric
    (<10%) we can tune toward.

## D. Location

13. **Geocoding is local-first:** SF street centerline + intersection table loaded into
    PostGIS from DataSF, plus neighborhood polygons (Analysis Neighborhoods). No paid
    geocoder in MVP. *If centerline coverage proves insufficient, `S-C2` grows an external
    geocoder fallback behind the same interface.*
14. **~63% of CAD records arrive with `intersection_point` and `analysis_neighborhood`
    pre-populated (verified).** `S-C1`/`S-C2` handle the remaining 37%.
    Previously assumed "most"; the normalizer's real job is intersection
    text parsing, block-address ranges (`2300 BLOCK OF MISSION ST`), and neighborhood
    assignment. Coordinates from the source are trusted over our own geocode.
15. **Displayed locations are intentionally coarse** — intersection or block, never a
    specific residential unit number.

## E. Safety / publication

16. **Default visibility is `public` with a global +3 minute publication delay**, and
    category-level overrides in config (e.g. `Police Activity`, `Weapon` → +10 min;
    anything matching the sensitive-keyword list → `restricted`). Delay is applied at
    publication, not ingestion (PRD §31).
17. **A blocklist of raw CAD type codes never surfaces publicly** (e.g. welfare checks at
    residences, mental-health holds, sexual-assault calls, juvenile calls). Blocklist is
    config, reviewed by a human, and is a *product* artifact — `S-E1` builds the mechanism,
    not the final list.
18. **No free-text from sources is rendered verbatim** in MVP. Only normalized, enumerated
    fields reach the UI. This removes most PII risk without a redaction pipeline.

## F. Technical

19. **Bun workspaces monorepo**, TypeScript everywhere, per PRD §34/§35. Next.js App
    Router for `apps/web`; services are long-running Bun processes.
20. **Postgres 16 + PostGIS**, managed (Supabase or equivalent). **The job queue is a
    Postgres table** with `SELECT … FOR UPDATE SKIP LOCKED` (PRD §39). No Redis, no Kafka.
21. **The services are separate processes but one deployable** in MVP — a single worker
    binary that runs ingest pollers and queue consumers, scaled to one instance. Splitting
    is a config change, not a rewrite. *Rationale: correlation correctness is easier to
    reason about with a single writer.*
22. **SSE, not WebSocket** (PRD §26). Fan-out via Postgres `LISTEN/NOTIFY` → SSE endpoint
    in the Next.js app. Assumes a single web instance or sticky-free broadcast; `S-E3`
    notes the scale-out path.
23. **Map = MapLibre GL + a free vector tile source.** No Mapbox account assumed.
24. **All timestamps stored UTC, `timestamptz`; all display in America/Los_Angeles.**
25. **Testing:** `bun test`, with recorded source fixtures for ingest and a hand-labelled
    correlation fixture set (`S-D10`) as the regression gate. Correlation changes without
    a fixture-set run are not mergeable.

## H. "What's happening in my neighborhood?" (Epic H)

26. **Neighborhood, not radius, is the default scope.** Analysis Neighborhoods are named,
    shareable, cacheable and already in the database (§13). A radius scope needs a
    per-user centroid and defeats caching. *If users consistently ask about "within N
    blocks", `S-H2` grows a radius mode behind the same digest contract.*
27. **The answer is a template over a structured digest, never model-written prose.** Same
    rule as PRD §21 and `S-D8`. An LLM may appear in `S-H4` **only** as a query parser
    emitting validated JSON — it never sees incident data and never writes a sentence a
    reader sees.
28. **Natural language is a bounded grammar first, LLM second.** Tier 1 handles
    neighborhood names, aliases, time phrases and category words deterministically;
    Tier 2 is an optional flagged fallback. *This moves NL search forward from PRD §27's
    "future" bucket — it is the feature, not a nicety.*
29. **The user's coordinates never reach the server.** Geolocation resolves to a
    neighborhood slug client-side or via an endpoint that does not log the point. A
    real-time incident product that also stores where its readers live is a liability.
30. **The baseline is "reported dispatch activity", never a safety or crime score.**
    `S-H5` is the story most likely to be misread; the naming constraint is enforced by
    the `S-F7` banned-phrasing test. We will not ship a number that reads as "how
    dangerous is my neighborhood".
31. **The system answers activity questions, not outcome questions.** "Was anyone hurt?",
    "who was arrested?" and "is it safe to walk home?" are detected and declined honestly
    in `S-H4` — dispatch data cannot answer them, and guessing is the §56 failure mode.

### Historical windows (7 / 30 / 90 days)

32. **3 hours is the default window; 24 hours is the one-click widening.** An unqualified
    "what's happening in my neighborhood" is a question about *now*. Long windows are only
    ever entered explicitly — by chip or by an explicit time phrase in the question.
33. **Windows ≥7 days are a different answer shape, not a longer feed** (`S-H7`): totals,
    per-day series, category mix, prior-period change. Nobody reads 90 days of cards.
34. **Counts are not comparable across pipeline versions.** When we retune correlation, the
    duplicate rate moves and so do the counts — without the city changing at all. Every
    rollup row records a `pipeline_version` (`S-H6`) and any comparison crossing a boundary
    is caveated, with the headline percentage suppressed when the boundary dominates the
    window. *This is the single most likely way this product tells a confident lie.*
35. **REVISED 2026-09-17 — history is available from day one via backfill.** The original
    claim assumed the real-time feed was our only source. `2zdj-bwza` goes back to 2014, so
    90-day windows can be populated at launch by a one-off import (real numbers already
    demonstrated in `mockups/live.html`: 158,270 calls over 90 days). What remains true:
    long windows must still state `history_starts_at`, and a short history is never
    rendered as a decline. *Original claim: we have no 90-day history until 90 days after
    ingestion starts.*
36. **Historical counts are reported dispatch activity, not crime statistics**, and are
    never framed, exported, or charted as such. Enforced by the `S-F7` phrasing test.

## I. Outcome sources — news and incident reports (Epic I)

37. **The highest value of outcome data is internal, not user-facing.** A CAD-joined
    incident-report corpus is thousands of free correlation and taxonomy labels — exactly
    what `S-D10` is starving for. `S-I3` ships nothing to users and is the best story in
    the epic. Sequence accordingly.
38. **Expect a ~0.5% news attachment rate.** ~1,500–2,500 dispatch calls/day against
    5–15 incidents/day of local coverage. The feature is blank on almost every incident by
    design, so "absent" is the default UI state (`S-I7`), not an empty state.
39. **REVISED 2026-09-17 — outcomes are already in the Phase 0 feed.** `disposition`
    arrives on 75% of dispatch records in real time, so basic outcomes need no report join
    at all. ~20% resolve to explicitly-nothing-found (GOA/UTL/NOM/ND) — real, but not
    "mostly". The original claim, kept for the record:
    **Outcome data will mostly reveal that nothing happened.** Dispatch calls skew heavily
    to unfounded, report-only and gone-on-arrival. Attaching outcomes faithfully is the most
    ethically defensible feature in this PRD and is probably bad for engagement. That
    trade-off is a product decision to make consciously, not a detail to discover later.
40. **Article attachment must not become person-identification by reference.** Articles name
    victims and suspects; our non-goals (PRD §5, §30) forbid identifying private individuals.
    We link headline + outlet + time, never extract or display the person, and never let
    article contents populate an incident field.
41. **A wrong article attachment is categorically worse than a duplicate incident.** One is
    a cosmetic bug; the other is a false public statement about a real event involving real
    people. Hence two thresholds, a review queue for the first 90 days, and "attach nothing"
    as the default under uncertainty (`S-I6`).
42. **Narrative police reports are not a data source.** They are per-incident CPRA requests:
    slow, often denied, heavily redacted. Do not design for them. The public incident-report
    dataset is the obtainable thing.

## G. Open questions (do not block the build)

- Terms of use of each DataSF dataset for redistribution via our own API (`S-E2`).
- Whether resolved incidents should stay on the map at all, and for how long.
- Whether "probable match" pairs need a human in the loop before launch, or whether the
  metric is good enough to auto-tune the threshold.
- ~~Does the incident report dataset carry a CAD number?~~ **ANSWERED 2026-09-17: yes.**
  `wg3w-h783.cad_number`, 88.7% fill, ~100% for dispatched (non-online, non-supplement)
  reports, joins to `gnap-fj3t.cad_number`. One-to-many: dedupe on `cad_number`. See
  [`01-data-source-findings.md`](01-data-source-findings.md).
- Radio legality review for Phase 2 — must precede any `radio-ingest` work.
- Whether outcome attachment should be a consumer feature at all, or Newsroom/API-tier
  only — outcomes arrive days to weeks late and nobody returns to an old incident page.
- Whether 90-day windows should ship publicly at all, or stay a Newsroom/API feature —
  the longer the window, the more it reads like crime statistics we are not producing.
- Whether the "busier than usual" comparison should ship at all, or whether any baseline
  invites the safety-score misreading we are trying to avoid (`S-H5`).
