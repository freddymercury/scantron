# S-D8 — Template incident summary

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D6 · **Size:** S

## Story
As a reader, I want a one-paragraph plain-language summary of each incident, so that I
understand it without reading the timeline.

**Deliberately template-based, not LLM.** See assumption A1.

## Acceptance criteria
- [ ] Summary generated from structured state only (type, agencies, units, location, first-reported time, status, verification) — PRD §21 ordering.
- [ ] Wording is bounded by the verification classification: a single-source incident says "reported"; a response-confirmed incident may say which agencies are responding, never what occurred.
- [ ] Regenerated on every incident update; stored on the incident with a `summary_generated_at`.
- [ ] Never states a cause, outcome, injury, or suspect information.
- [ ] Templates live in config with per-type variants and a safe generic fallback.
- [ ] Snapshot tests cover one example per normalized type and per verification level.
- [ ] `summarize_incident` is a queue job so an LLM implementation can replace the generator behind the same interface in Phase 3.

## Out of scope
LLM summarization (Phase 3), which must consume the same structured input.
