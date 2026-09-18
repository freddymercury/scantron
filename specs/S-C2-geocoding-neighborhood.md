# S-C2 — Geocoding and neighborhood assignment

**Epic:** C · Normalization · **Phase:** 0 · **Depends on:** S-C1, S-A2 · **Size:** L

## Story
As the system, I want every observation resolved to coordinates and a neighborhood, so
that map display and proximity-based correlation are possible.

## Acceptance criteria
- [ ] SF street centerline and intersection data loaded into plain Postgres by a repeatable script; intersections pre-computed and indexed by normalized street pair (a text lookup, not a spatial one).
- [ ] Radius queries use a **bounding-box prefilter on indexed lat/lng, then haversine** in SQL or TypeScript — ~150 lines of owned geo math, no PostGIS ([ADR-002](../docs/03-dependency-policy.md)).
- [ ] Resolution order: (1) coordinates supplied by the source, (2) intersection lookup, (3) block-range interpolation on the centerline, (4) unresolved.
- [ ] Each result carries `locationConfidence` and the method used, both persisted.
- [ ] **Use the source's own `analysis_neighborhood` when present (63% of records, verified)**; only the remainder needs computing. Ray-casting point-in-polygon against the Analysis Neighborhoods GeoJSON; a point outside all polygons yields `null`, not a nearest guess.
- [ ] Coordinates are snapped to block-level precision (≈4 decimal places) for anything published, per the coarse-location assumption.
- [ ] `geocode_location` is a queue job; failures retry and never block correlation of other observations.
- [ ] ≥90% of a one-day sample resolves to coordinates; the shortfall is reported by source and reason.
- [ ] Geocoding for a batch of 1,000 observations completes in under 60 s locally (indexes are doing their job).

## Out of scope
External paid geocoder (documented fallback, not built).
