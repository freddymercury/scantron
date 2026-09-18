# S-E4 — Incident search

**Epic:** E · Publication & API · **Phase:** 1 · **Depends on:** S-E2 · **Size:** M

## Story
As a reader, I want to find incidents by place, type or ID, so that I can answer "what
happened near here" without scrolling the feed.

## Acceptance criteria
- [ ] `GET /api/search?q=` matches address, intersection, neighborhood, normalized type, and incident ID (PRD §27).
- [ ] The query string is run through the S-C1 normalizer, so `19th and irving` matches `19th Ave & Irving St`.
- [ ] A neighborhood name query returns incidents within that polygon, ranked by recency.
- [ ] An exact incident ID returns that incident directly (including via a tombstoned ID).
- [ ] Postgres full-text index over a generated searchable document per incident; p95 <300 ms.
- [ ] Results are scoped to published incidents and respect the active filter/time-range params.
- [ ] Empty results return a structured "no match" with the interpreted query echoed back, so the UI can explain what it searched for.

## Out of scope
Natural-language query ("fires in the Sunset yesterday") — Phase 3.
