# S-F6 — Filter and search UI

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-E4, S-E5 · **Size:** M

## Story
As a reader, I want to filter and search from the interface, so that I can focus on an
agency, neighborhood, category or time window.

## Acceptance criteria
- [ ] Filter chips for Police / Fire / EMS / Active / Recently resolved, plus selects for neighborhood, category and time range (PRD §28).
- [ ] Filter state lives in the URL query string — shareable, back-button correct, survives reload.
- [ ] Filters apply to feed, map and the SSE subscription simultaneously and consistently.
- [ ] Search field queries `/api/search`, shows the server's interpretation of the query, and offers neighborhood/intersection suggestions.
- [ ] Selecting a neighborhood result fits the map to that polygon and filters the feed to it.
- [ ] An active filter set is always visibly summarized with a one-click clear.
- [ ] Zero-result state names which filter is responsible and offers to relax it.

## Out of scope
Saved searches, alert creation.
