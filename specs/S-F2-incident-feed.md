# S-F2 — Incident feed

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-F1 · **Size:** M

## Story
As a reader, I want a reverse-chronological stream of incidents, so that I can see what is
happening in San Francisco right now at a glance.

## Acceptance criteria
- [ ] Each card shows: category icon, title, intersection/block, neighborhood, status badge, verification badge, responding agencies, relative time since last update (PRD §24).
- [ ] Ordered by `last_updated_at` desc; an updated incident moves to the top with a brief highlight, and the movement is announced to screen readers.
- [ ] Infinite scroll via cursor pagination; scroll position is preserved when new items arrive above (no content jump).
- [ ] Resolved incidents render visibly de-emphasized, with resolution reason when it is `unfounded` or `cancelled`.
- [ ] Empty and error states are explicit ("no incidents match these filters" vs "can't reach the feed"), never a blank pane.
- [ ] Clicking a card selects it in the map and detail panes and updates the URL.
- [ ] A count line states the signal-reduction ratio (e.g. "24 incidents from 611 observations in the last hour") — PRD §54.

## Out of scope
Grouping, clustering, or ranking by importance (Phase 3).
