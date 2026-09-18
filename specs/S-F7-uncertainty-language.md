# S-F7 — Uncertainty language rules

**Epic:** F · Web · **Phase:** 1 · **Depends on:** S-D6, S-F4 · **Size:** S

## Story
As a reader, I want the interface to consistently distinguish what was reported from what
is confirmed response activity, so that I do not read a preliminary dispatch code as a
fact about the world.

**This story exists because PRD §56 names this the largest product risk.**

## Acceptance criteria
- [ ] A single shared module maps `verification` + `status` to user-facing phrasing; no component writes its own wording.
- [ ] `reported` → "Reported <type>"; `multi-source` → "<type> reported by multiple sources"; `official-response-confirmed` → "<agencies> responding to reported <type>".
- [ ] Copy never asserts an outcome, cause, injury, or that an allegation is true; a lint rule or test blocks banned phrasings ("confirmed shooting", "suspect arrested", etc.) in UI strings.
- [ ] Numeric confidence is never rendered publicly (S-D6).
- [ ] Every incident view carries a preliminary-information disclaimer and a 911 pointer.
- [ ] An `unfounded` correction renders as prominently as the original report, not as a footnote.
- [ ] Snapshot tests cover every (verification × status) combination.

## Out of scope
Editorial policy document — this story implements the rules; the policy text is a product deliverable.
