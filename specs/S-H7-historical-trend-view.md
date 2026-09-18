# S-H7 — Historical trend answer (7 / 30 / 90 days)

**Epic:** H · Ask & neighborhood answers · **Phase:** 1.5 · **Depends on:** S-H6, S-H3 · **Size:** M

## Story
As a reader, I want to ask about the last 7, 30 or 90 days in my neighborhood and get
totals and a trend, so that I can see the pattern rather than scroll a feed I cannot read.

**Reference:** the long-window answer card in `mockups/index.html` (pick 7/30/90 days).

## Acceptance criteria
- [ ] For windows ≥7d the answer card renders: total, average per day, busiest day, category breakdown, a per-day bar series (per-week above 30 days), and the change vs the immediately prior period of equal length.
- [ ] The change is shown as both a percentage **and** the two raw counts — a percentage alone on small counts is misleading.
- [ ] The sentence is template-generated from the S-H2 digest (same constraints as S-D8/S-F7) and describes *reported dispatch activity*, never crime, danger, or a trend in safety.
- [ ] A comparison spanning a `pipeline_version` boundary (S-H6) renders an explicit caveat that part of the change may be ours, not the city's, and suppresses the headline percentage when the boundary covers more than a configurable share of the window.
- [ ] Windows longer than the available history state `history_starts_at` rather than showing a false decline.
- [ ] Hovering a bar shows that day's count and date; clicking it scopes the feed to that day.
- [ ] The incident feed below the card is relabelled "most recent" and remains capped — a long window never attempts to render 90 days of cards.
- [ ] The view is server-rendered and shareable at `/n/[slug]?window=30d`.
- [ ] Charts degrade to an accessible table; series data is exposed to screen readers.

## Out of scope
Comparing neighborhoods to each other, forecasting, CSV export (a Newsroom/API feature).
