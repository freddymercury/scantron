# S-E5 — Server-side filters

**Epic:** E · Publication & API · **Phase:** 1 · **Depends on:** S-E2 · **Size:** S

## Story
As a reader, I want to narrow the feed and map by agency, status, area, category and time,
so that I see only what I care about.

## Acceptance criteria
- [ ] Filter params on list, nearby, active, history and stream endpoints: `agency` (police|fire|ems), `status` (active|recently_resolved), `neighborhood`, `category`, `from`/`to` (PRD §28).
- [ ] Filters combine as AND across dimensions, OR within a dimension; the semantics are documented in the OpenAPI description.
- [ ] `recently_resolved` is a configurable window (default 2 h) and is applied consistently everywhere.
- [ ] Invalid values return 400 with the accepted set, never a silent empty result.
- [ ] Every filtered query is index-backed; a filter combination that would table-scan is covered by an explicit index and a performance test.
- [ ] Applied filters are echoed in the response so the UI can render state from the server's interpretation.

## Out of scope
Saved filters (requires accounts).
