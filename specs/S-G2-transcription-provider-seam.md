# S-G2 — Transcription provider seam (Phase 2 prep)

**Epic:** G · Seams for later phases · **Phase:** 1 (prep for 2) · **Depends on:** S-A3 · **Size:** S

## Story
As an engineer, I want the transcription interface and domain vocabulary defined before
radio work starts, so that Phase 2 plugs in rather than redesigns.

**Blocked for implementation until the radio legality review completes (docs/00, open questions).**

## Acceptance criteria
- [ ] `TranscriptionProvider { transcribe(audio, context?): Promise<Transcript> }` defined in `packages/transcription-provider` (PRD §14), with `Transcript` carrying text, per-segment timings and per-segment confidence.
- [ ] `TranscriptionContext` accepts a contextual vocabulary: SF street names, unit identifiers, district names, agency codes (PRD §15), sourced from `sf-domain` data files.
- [ ] Two stub implementations (hosted-API shape and local-model shape) plus an in-memory fake for tests; no provider credentials required to run the suite.
- [ ] `Observation.source = "radio"` and the audio/talkgroup fields already validate through the S-A3 schema.
- [ ] `transcribe_audio` job type registered and documented as not yet implemented.
- [ ] Documented: encrypted communications are out of scope and no decryption capability may be added.

## Out of scope
Radio capture, SDR, actual transcription, CAD/radio correlation — Phase 2.
