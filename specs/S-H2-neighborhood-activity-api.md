# S-H2 — Neighborhood activity digest API

**Epic:** H · Ask & neighborhood answers · **Phase:** 1 · **Depends on:** S-E2, S-H1 · **Size:** M

## Story
As a reader, I want a single answer describing activity in an area over a window, so that
"what's happening in my neighborhood" is one response rather than a list I have to read.

## Acceptance criteria
- [ ] `GET /api/activity?neighborhood=<slug>&window=3h` (also accepts `lat`/`lng`/`radius`) returns a structured digest, not prose: total count, active count, counts by category and by agency, the most recent incident, the most significant incident, and window bounds.
- [ ] "Most significant" is a documented deterministic rule (severity, then responding-unit count, then recency) — not a model judgement.
- [ ] Digest includes `baseline` from S-H5 and a `comparison` of `quieter | typical | busier` with the numbers behind it.
- [ ] Windows supported: 1h, **3h (default)**, 12h, 24h, 7d, 30d, 90d; anything else is a 400 with the accepted set.
- [ ] **The default window is 3h when the caller does not specify one**, and 24h is the one-click widening. The long windows are always explicit — an unqualified "what's happening in my neighborhood" is a question about *now*, and answering it with a 90-day total would be wrong.
- [ ] Windows ≥7d are served from the S-H6 rollups, not from a live scan of the incident table; the response says which it used.
- [ ] Windows ≥7d additionally return a per-day (or per-week above 30d) series and a `prior_period` comparison.
- [ ] Only published incidents are counted (S-E1); restricted observations affect nothing in the digest, including counts.
- [ ] Response includes `as_of` and per-source freshness, so a stale fire feed can be disclosed rather than silently undercounted.
- [ ] A zero-activity area returns a well-formed digest with zeros — never a 404, never an empty body.
- [ ] Cached per (area, window) with a short TTL; p95 <200 ms for windows ≤24h and <400 ms for 90d.
- [ ] A window extending past the available history is answered over the history that exists, with `history_starts_at` stated — never silently under-reported as a real decline.

## Technical notes
One PostGIS aggregate query over the published-incident index. The digest is the contract
the UI (S-H3) and the question interface (S-H4) both render — neither computes its own.

## Out of scope
Arbitrary radius scopes beyond the capped `nearby` radius; cross-neighborhood comparison.
