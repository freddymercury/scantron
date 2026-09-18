# S-B4 — Internal raw observation viewer

**Epic:** B · Ingestion · **Phase:** 0 · **Depends on:** S-B2, S-C3 · **Size:** M

## Story
As an engineer, I want to browse raw and normalized observations, so that I can judge
whether CAD data can actually drive an incident feed before building correlation.

**This story is the Phase 0 success gate.**

## Acceptance criteria
- [ ] Internal-only route (shared-secret header or basic auth, not linked publicly) listing observations newest-first.
- [ ] Filter by source, normalized type, time range, geocode status, and "unmapped code only".
- [ ] Row expands to show raw source payload side by side with the normalized Observation.
- [ ] Counters for the selected window: total observations, per-source, % geocoded, % mapped to a non-`Unknown` type, duplicate upserts, failed jobs.
- [ ] Failed jobs list with error and a one-click requeue.
- [ ] Phase 0 exit is evaluated from this page: ≥72 h continuous ingestion, no duplicate explosion, no unexplained gaps (PRD §44).

## Out of scope
Merge/split/correction tooling — that is S-G3.
