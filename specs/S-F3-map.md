# S-F3 — Incident map

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-F1 · **Size:** L

## Story
As a reader, I want incidents plotted on a map of San Francisco, so that I can see where
things are happening and what is near me.

## Acceptance criteria
- [ ] **Own SVG/canvas map, no MapLibre** ([ADR-002](../docs/03-dependency-policy.md) §2). San Francisco is a fixed bounding box, so lat/lng → screen is a linear projection (four lines, already working in `mockups/live.html`). Static basemap: neighborhood polygons and major street lines rendered from GeoJSON we already load.
- [ ] **Revisit trigger:** adopt MapLibre when panning/zooming over a real tiled basemap becomes a product requirement. We do not hand-roll a general slippy map.
- [ ] Markers encode category (colour/icon), status (active markers ringed, resolved muted) and age (halo shrinking with time) — PRD §24.
- [ ] Selecting a marker opens the detail pane and syncs the feed selection and URL; selection is bidirectional with the feed.
- [ ] Density handling: fixed zoom levels with marker de-overlap, not general clustering. Canvas rendering above a configurable marker count (SVG proved fine at ~4,500).
- [ ] Viewport changes refetch via `/api/incidents/nearby` or a bbox query, debounced; the SSE subscription uses the same bbox.
- [ ] "Near me" uses browser geolocation only on explicit user action, and the location never leaves the client except as a rounded radius query.
- [ ] A visible note states that locations are approximate and that tactical positions are not shown.
- [ ] Smooth at 300 visible markers on a mid-range laptop; markers render from GeoJSON sources, not DOM nodes.

## Out of scope
Heatmaps, historical playback, routing.
