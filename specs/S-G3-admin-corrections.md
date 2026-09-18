# S-G3 — Internal admin and correction tooling

**Epic:** G · Seams for later phases · **Phase:** 1.5 · **Depends on:** S-D9, S-B4 · **Size:** L

## Story
As an operator, I want to inspect and correct incidents, so that bad correlations and bad
locations do not sit in public view until the next deploy.

**Not required for the first demo (PRD §43), but the first thing needed after it.**

## Acceptance criteria
- [ ] Auth-gated internal area, separate from the public app, with every action written to an append-only audit log (actor, before, after, reason).
- [ ] Incident search and observation inspection, including the correlation score breakdown for each attachment (S-D2/S-D3).
- [ ] Manual merge of two incidents (reusing S-D9) and manual split of an observation out of an incident into a new one.
- [ ] Correct an incident's location or category by hand; the correction is marked as operator-sourced in the timeline and is not overwritten by later automatic normalization.
- [ ] Force a status change, and unpublish/restrict an incident immediately (a takedown path that beats the publication delay).
- [ ] Probable-match queue from S-D3 with accept/reject, and accepted decisions exportable as S-D10 fixtures.
- [ ] Source health and latency dashboard reusing the S-A6 metrics.

## Out of scope
Multi-role permissions, editorial workflow, public corrections notices.
