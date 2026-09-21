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

## Decision (recorded 2026-09-21)

Built in `packages/correlation/src/timeline.ts`, written from `applyDecision` as the
*difference an observation made* to the incident row: snapshot before the fold, snapshot
after, and one entry per thing that actually changed. An observation that repeats what is
already known adds nothing.

Two rules are enforced structurally rather than by convention:

- **Templates only.** Every line is rendered here from enumerated fields — type labels,
  agency labels, unit identifiers, statuses. No source free-text and no model output can
  reach a timeline entry, because no code path carries them in.
- **Insert-only.** Writing is `INSERT … ON CONFLICT (incident_id, observation_id, kind) DO
  NOTHING`, with a deterministic id. There is no `UPDATE`, which is what makes replay a
  no-op and makes a correction a new entry (S-D7).

Reads sort by `occurred_at, recorded_at, id` — source-reported time first, ingest order as
the tiebreak, id to make the order total — so a record that arrives late but happened early
lands in its true position.

Two incident fields had to start moving for the entries to have anything to say:

- `primary_type` now moves **off** `unknown` when a later observation classifies the call,
  and never off a known type: a second agency disagreeing is not evidence the first was
  wrong, and reclassification is a correction (S-D7).
- `severity` is a high-water mark across the incident's observations.

### Measured (48 h replay, 4,485 observations → 4,310 incidents)

```
timeline    9,642 entries — 2.2 per incident
kinds       4,310 initial_report · 3,067 closed · 1,260 status_changed
            851 unit_dispatched · 108 agency_joined · 42 additional_unit · 4 escalation
```

`escalation` is rare because severity is set on only 4% of observations (576 of 14,249),
and `type_changed` did not fire at all in 48 hours: it needs an incident opened by an
unknown-typed record that a typed record later merges into, and 335 unknown-typed
observations produced no such pair. Both are real numbers about the feed, not missing code.

### A bug this surfaced

Writing the first test caught `nextStatus` moving a known status to `unknown` whenever a
record carried no lifecycle timestamps — absence of evidence read as evidence. Fixed in
`lifecycle.ts`: only the staleness sweep may move a known status to `unknown`, and it does
so on elapsed time. The replay's status distribution changed from mostly-`unknown` to
3,067 resolved / 756 active / 487 dispatched.
