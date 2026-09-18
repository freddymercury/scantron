# S-D10 — Correlation evaluation harness

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D3 · **Size:** M

## Story
As an engineer, I want a labelled fixture set and an offline evaluation run, so that
changing correlation weights is a measured decision rather than a guess.

**This is the guard on PRD §55, the system's biggest technical risk.**

## Acceptance criteria
- [ ] A fixture set of ≥100 hand-labelled real observation groups ("these N records are one event"), captured from live ingestion and stored as JSON in the repo.
- [ ] `bun run eval:correlation` replays fixtures through the real correlator against a throwaway database and reports precision, recall, F1 on grouping, plus false-merge and duplicate counts.
- [ ] Output includes a per-case diff so regressions name the exact cases that broke.
- [ ] A weight/threshold sweep mode reports the metric surface across candidate configurations.
- [ ] CI runs the eval and fails if F1 drops more than a configured delta from the committed baseline.
- [ ] Baseline metrics are committed and updated deliberately, with the reason in the commit message.
- [ ] Probable-match log rows (S-D3) can be exported into new fixture cases with one command.

## Out of scope
Any learned model.
