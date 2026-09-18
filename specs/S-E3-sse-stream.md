# S-E3 — SSE real-time stream

**Epic:** E · Publication & API · **Phase:** 1 · **Depends on:** S-E2 · **Size:** M

## Story
As a client, I want incident changes pushed to me, so that the feed and map stay current
without polling or refresh.

## Acceptance criteria
- [ ] `GET /api/stream` emits `incident.created`, `incident.updated`, `incident.resolved`, `incident.merged` (PRD §26/§52) as SSE.
- [ ] Event payloads validate against the S-A3 SSE schemas and carry the full public incident (not just an ID) to avoid a refetch storm.
- [ ] Fan-out via Postgres `LISTEN/NOTIFY` from `publish_incident`; the payload is fetched by the web process, so NOTIFY size limits never bite.
- [ ] Optional `?bbox=` and filter params server-side, so a map client receives only relevant events.
- [ ] Heartbeat comment every 15 s keeps proxies from closing the connection.
- [ ] `Last-Event-ID` reconnection replays missed events from a bounded (e.g. 5-minute) buffer; beyond the buffer the client is told to resync and refetch.
- [ ] Only published incidents are ever emitted (asserted by test, including the restricted case).
- [ ] Connection count and events/sec are metrics; a documented cap sheds new connections rather than degrading existing ones.
- [ ] Scale-out path documented: every web instance listens to the same channel, so N instances work without sticky sessions.

## Out of scope
WebSocket, client-to-server messaging.
