# S-D5 — Timeline construction

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D3 · **Size:** M

## Story
As a reader, I want a chronological, human-readable timeline of an incident, so that I can
see how it developed and where each fact came from.

## Acceptance criteria
- [ ] Each meaningful change appends a `timeline_events` row: initial report, unit dispatched, additional units, agency joined, type change, escalation, status change, closure.
- [ ] Every entry has `occurred_at`, a rendered text string, an event kind, and a non-null source `observation_id` (PRD §32).
- [ ] Entries sort by source-reported time, not ingest time; ties break by ingest order; the ordering is stable across re-renders.
- [ ] Re-processing the same observation does not duplicate entries (dedupe on `(incident_id, observation_id, kind)`).
- [ ] Entry text is generated from templates over structured fields — never raw source free-text, never LLM output.
- [ ] Late-arriving observations insert into the correct chronological position rather than appending at the end.
- [ ] Timeline entries are immutable; a correction adds a new entry (S-D7).

## Out of scope
Transcript snippets (Phase 2).
