# S-H1 — "My neighborhood" resolution

**Epic:** H · Ask & neighborhood answers · **Phase:** 1 · **Depends on:** S-C2 · **Size:** S

## Story
As a reader, I want the app to know which neighborhood is mine, so that I can ask about
"my neighborhood" without naming it every time.

## Acceptance criteria
- [ ] Neighborhood can be set three ways: browser geolocation (only on explicit user action), picking from a list, or dropping a pin on the map.
- [ ] A geolocated point resolves to an Analysis Neighborhood by point-in-polygon (reusing S-C2); a point outside San Francisco returns a clear "you're outside our coverage" state and offers the picker.
- [ ] The chosen neighborhood persists in `localStorage` and is reflected in the URL when shared (`?hood=inner-sunset`), so a shared link carries the scope but not the user's coordinates.
- [ ] **Raw coordinates never leave the client.** Geolocation resolves to a neighborhood client-side against a simplified polygon set, or server-side via a neighborhood-only endpoint that does not log the point.
- [ ] Neighborhood slugs are stable identifiers, versioned with the polygon dataset; a renamed neighborhood keeps resolving via an alias table.
- [ ] Changing the neighborhood is one click and always visible; the app never silently re-geolocates.

## Out of scope
Accounts, multiple saved locations, radius-based ("within 2 miles") scopes — see S-H2 out-of-scope.
