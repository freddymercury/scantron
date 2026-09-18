# S-D7 — Corrections without erasure

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D4, S-D5 · **Size:** M

## Story
As a reader, I want an incident to reflect the latest agency information while still
showing what was originally reported, so that "shots fired → fireworks/unfounded" is
visible as a correction rather than a silent rewrite.

## Acceptance criteria
- [ ] A source record whose call type changes updates `incidents.primary_type`, `title` and severity, and appends a timeline entry naming both the old and new classification (PRD §33).
- [ ] The original report remains in the timeline and in `source_records`; nothing is deleted or overwritten in place.
- [ ] Corrections marked unfounded/cancelled set status to `resolved` with a distinct `resolution_reason` of `unfounded` or `cancelled`, and the UI is given a flag to say so.
- [ ] `incidents.title` and type are always derived from current state, so a corrected incident re-renders correctly everywhere without special-casing.
- [ ] A correction emits `incident.updated` over SSE with a `correction: true` marker.
- [ ] Test: a shots-fired incident corrected to fireworks ends with the correct current type, four timeline entries, and the original entry intact.

## Out of scope
Editorial/manual corrections by staff (S-G3).
