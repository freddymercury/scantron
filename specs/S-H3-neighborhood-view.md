# S-H3 — Neighborhood answer view

**Epic:** H · Ask & neighborhood answers · **Phase:** 1 · **Depends on:** S-H2, S-F2, S-F3 · **Size:** M

## Story
As a reader, I want a neighborhood-scoped view that opens with a direct answer, so that I
learn what's going on in a sentence and can drill in only if I want to.

**Reference:** the answer card and 📍 Near me control in `mockups/index.html`.

## Acceptance criteria
- [ ] An answer card sits above the feed when a neighborhood scope is active: one plain-language sentence, then counts (active / police / fire / medical), then the busier-or-typical line.
- [ ] The sentence is composed from the S-H2 digest by templates (same approach and constraints as S-D8) — it never asserts causes or outcomes, and it says "reported" per the S-F7 language rules.
- [ ] Scoping filters the feed to that neighborhood and dims (does not hide) out-of-scope map markers, so the surrounding context stays visible.
- [ ] The map fits to the neighborhood polygon and outlines it.
- [ ] Scope is URL-addressable and shareable (`/n/[slug]`), server-rendered, with the answer in the page source.
- [ ] Window selector (3h / 24h / 7d / 30d / 90d) re-runs the digest and updates the sentence. **3h is the default on every entry to the view**; the selected window lives in the URL so a long-window view is shareable but never the default.
- [ ] Windows ≥7d switch the card to the historical shape (S-H7) instead of the now-shape, and the feed below is relabelled "most recent in <neighborhood>" so a 90-day total is never mistaken for 90 days of feed.
- [ ] Live updates revise the answer card in place when an incident in scope is created, updated or resolved.
- [ ] A quiet neighborhood renders an explicit "nothing reported" answer, which is a valid and useful result, not an empty state.
- [ ] The card always carries the preliminary-information disclaimer.

## Out of scope
Notifications for the scoped area — that is Phase 4 and depends on this story's scope model.
