# S-E2 — Public incident REST API

**Epic:** E · Publication & API · **Phase:** 1 · **Depends on:** S-E1 · **Size:** L

## Story
As the web app (and, later, an API consumer), I want read endpoints over published
incidents, so that the feed, map, detail page and history all read from one contract.

## Acceptance criteria
- [ ] `GET /api/incidents` — filterable, cursor-paginated, reverse-chronological by `last_updated_at`.
- [ ] `GET /api/incidents/:id` — full public incident with timeline, units, agencies; tombstoned IDs resolve to the survivor (S-D9).
- [ ] `GET /api/incidents/nearby?lat&lng&radius` — PostGIS radius query, radius capped at a configured maximum; returns distance per incident.
- [ ] `GET /api/incidents/active` and `GET /api/incidents/history?from&to` (PRD §51).
- [ ] All responses validated against the `PublicIncident` schema before send; a validation failure is a 500 and an alert, never a leaked field.
- [ ] Unpublished, restricted and tombstoned-losing incidents are absent from every list endpoint.
- [ ] `ETag`/`Cache-Control` on list endpoints; p95 latency <200 ms for a 200-item page.
- [ ] Rate limiting per IP with documented limits; 429 carries `Retry-After`.
- [ ] Every response includes `generated_at` and a data-freshness field per source.
- [ ] OpenAPI document generated from the Zod schemas and served at `/api/openapi.json`.

## Out of scope
API keys, billing, webhooks (Phase 4+).
