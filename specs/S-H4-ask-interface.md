# S-H4 — Ask interface (bounded natural language)

**Epic:** H · Ask & neighborhood answers · **Phase:** 1.5 · **Depends on:** S-H3, S-E4 · **Size:** L

## Story
As a reader, I want to type a question like "what's happening in the Mission?" and get an
answer, so that I don't have to learn the filter controls.

**This supersedes the Phase 3 deferral of natural-language search in S-E4.**

## Acceptance criteria
- [ ] The ask field parses a question into a **structured query** — `{ area, window, categories, status }` — and then runs the existing S-H2 / S-E2 / S-E4 endpoints. The parser chooses the query; it never writes the answer.
- [ ] Tier 1 is a deterministic grammar covering the expected volume of real questions: neighborhood and alias names ("the Mission", "SoMa", "Outer Sunset"), "near me" / "my neighborhood" / "around here", time phrases ("right now", "today", "last night", "this week"), and category words ("fires", "police activity", "medical", "crashes").
- [ ] Tier 2 (optional, behind a flag) sends an unmatched question to an LLM constrained to emit **only** the structured query JSON, validated against a Zod schema. A response that fails validation falls back to Tier 1's best guess or the unmatched state. The LLM never sees incident data and never produces user-facing text.
- [ ] The answer itself is always rendered from the structured digest by S-H3's templates. **No free-text model output is ever shown to a reader** — this is the same constraint as PRD §21 and it is the point of the design.
- [ ] Every answer states its interpretation ("Inner Sunset, last 3 hours") with one-click controls to correct the area or window; a misparse is visible and fixable, never silent.
- [ ] An unmatched question returns a helpful state naming what it could not resolve, plus example questions — not zero results.
- [ ] Questions the data cannot answer ("was anyone hurt?", "who was arrested?", "is it safe to walk home?") are detected and answered honestly: the system reports dispatch activity, not outcomes or safety advice, and points to 911 for emergencies.
- [ ] Parsed questions are logged (query text, resolved structure, matched tier, whether the user corrected it) to drive grammar coverage; a coverage metric tracks Tier 1 hit rate.
- [ ] A fixture suite of ≥100 real-shaped questions asserts the parse; CI fails on a coverage regression.

## Technical notes
Tier 1 first is deliberate: it is testable, free, instant, and it keeps working when the
model endpoint is down. Tier 2 exists to catch the tail, and is a query parser only.

## Out of scope
Conversational follow-ups, multi-turn context, voice input.
