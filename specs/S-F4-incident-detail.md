# S-F4 — Incident detail view

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-F2 · **Size:** M

## Story
As a reader, I want one page per incident showing what is known, when, and from whom, so
that I can understand the event and judge how solid the information is.

## Acceptance criteria
- [ ] Renders PRD §25: title, location, neighborhood, first reported, last updated, status, responding agencies, units, timeline, summary, source indicators, mini-map, last-update timestamp.
- [ ] Timeline entries show source-reported times in local time; each entry's source is available (label in public view, observation ID in internal view).
- [ ] The machine-generated summary is labelled as such and as not an official statement.
- [ ] Verification classification is rendered in words, not numbers (S-F7).
- [ ] Corrections are visibly marked in the timeline with both old and new classification (S-D7).
- [ ] Route `/i/[id]` is server-rendered, shareable, has Open Graph metadata, and follows tombstoned IDs to the survivor with a note that two reports were merged.
- [ ] Live updates arrive without navigation; changed fields highlight briefly.
- [ ] A stale or removed incident renders a clear explanation rather than a 404 blank.

## Out of scope
Radio audio/transcripts (Phase 2); comments; sharing integrations beyond a copyable URL.
