# S-E1 — Visibility policy and publication delay

**Epic:** E · Publication & API · **Phase:** 1 · **Depends on:** S-D4 · **Size:** M

## Story
As the operator of a public feed, I want ingestion and publication decoupled by policy, so
that sensitive or tactically live information is withheld, delayed, or never shown.

**Nothing reaches the public API before this story ships.**

## Acceptance criteria
- [ ] **`sensitive_call` from the SFPD feed (100% fill, ~35% True — verified 2026-09-17) is treated as authoritative:** a sensitive call is `restricted` by default and may only be relaxed by an explicit, reviewed config rule. This is SFPD's own flag and it is the single strongest input to this story.
- [ ] Every observation is assigned `visibility: public | delayed | restricted | discard` (PRD §30) at normalization time by configurable rules over source, raw code, normalized type and keywords.
- [ ] `discard` observations are not persisted beyond a hashed audit record; `restricted` are persisted but never published; `delayed` publish after their configured delay.
- [ ] Global default publication delay (3 min) with per-source and per-type overrides; an incident's effective delay is the maximum among its contributing observations.
- [ ] An incident becomes publicly visible only once its earliest publishable observation has cleared the delay; a restricted observation can update internal state without making the incident public.
- [ ] Blocklisted raw codes (sensitive call types) map to `restricted` by default, from a reviewed config file.
- [ ] Published payloads contain no source free-text, no unit-level street address below block precision, and no person-identifying fields.
- [ ] `publish_incident` is a scheduled queue job; delay changes take effect for not-yet-published incidents without a deploy.
- [ ] Tests assert that a restricted-source incident never appears in any API response or SSE event.

## Out of scope
Legal review of the blocklist contents (open question, docs/00).
