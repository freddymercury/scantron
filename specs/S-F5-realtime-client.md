# S-F5 — Real-time client updates

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-E3, S-F2 · **Size:** M

## Story
As a reader, I want the feed, map and open incident to update themselves, so that I never
have to refresh to learn what changed.

## Acceptance criteria
- [ ] A single shared SSE connection per tab feeds the whole app; panes subscribe to a client-side store rather than opening their own connections.
- [ ] `incident.created` inserts, `incident.updated` patches in place, `incident.resolved` restyles, `incident.merged` collapses the losing card into the survivor.
- [ ] Reconnect with exponential backoff and `Last-Event-ID`; on a gap beyond the server buffer the client refetches the current view and says it resynced.
- [ ] Connection state is visible in the header (live / reconnecting / offline) and honest about which it is.
- [ ] Events that do not match the active filters are discarded client-side, and the same filters are sent to the server.
- [ ] A background tab throttles rendering but does not drop the connection; returning to the tab reconciles state.
- [ ] Updates never reorder the list under the user's cursor mid-interaction; pending updates apply on scroll-to-top or an explicit "N new incidents" affordance.

## Out of scope
Push notifications (Phase 4).
