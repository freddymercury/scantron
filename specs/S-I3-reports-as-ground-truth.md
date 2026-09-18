# S-I3 — Incident reports as correlation ground truth

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-I2, S-D10 · **Size:** M

## Story
As an engineer, I want published incident reports used as labelled data, so that
correlation and taxonomy accuracy are measured against the city's own record instead of
our hand-labelling.

**This is the highest-value story in the epic and it ships nothing to users.**
Confirmed viable 2026-09-17: the CAD join exists, so the corpus is real. With ~1,169
distinct CAD-joined calls per 2,000 report rows sampled, a month of history is on the order
of tens of thousands of labels.

## Acceptance criteria
- [ ] Every deterministic report↔dispatch join becomes a labelled case in the S-D10 fixture corpus, automatically — free ground truth at whatever volume the join produces.
- [ ] Two dispatch observations joining to one report number is a **labelled positive** for correlation (they were one event); joining to different report numbers is a labelled negative.
- [ ] Taxonomy accuracy measured per raw code: how often our normalized type matches the eventual report classification, reported as a per-code table ordered by volume.
- [ ] The S-A4 mapping file is reviewed against that table on a schedule; codes with poor agreement are surfaced for remapping.
- [ ] Correlation eval (`bun run eval:correlation`) reports metrics against this corpus separately from the hand-labelled one, so a regression names which corpus moved.
- [ ] Ground-truth corpus is versioned alongside `pipeline_version` (S-H6).

## Why this matters
S-D10 is the guard on the project's biggest technical risk, and it is starved of labels —
hand-labelling 100 cases is a day of work and it does not scale. A CAD-joined report corpus
is thousands of labels the city produces for free. If the CAD number exists, this alone
justifies the epic; if it does not, most of this epic's value evaporates.
