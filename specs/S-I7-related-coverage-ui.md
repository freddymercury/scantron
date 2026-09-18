# S-I7 — Related coverage and outcome UI

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-I6, S-F4, S-F7 · **Size:** S

## Story
As a reader, I want outcomes and coverage shown on an incident without mistaking them for
the incident's own record, so that I can tell reporting from dispatch data.

## Acceptance criteria
- [ ] **Designed for absent.** The default state on an incident page is no coverage section at all — not an empty box, not "no coverage found." It appears on ~0.5% of incidents (S-I4) and must not read as missing data on the other 99.5%.
- [ ] Coverage renders as headline, outlet, timestamp, and outbound link only. Visually distinct from timeline and summary; never inside the timeline.
- [ ] `confirmed` and `possible` matches are labelled differently in plain language; "possibly related coverage" is never abbreviated away.
- [ ] An outcome from an incident report renders as a timeline entry citing the report, with an explicit "this is what was later written up" framing, and the original dispatch classification stays visible.
- [ ] Phrasing routes through the S-F7 module and its banned-phrasing test; an outcome may state the classification a source reported, never adjudicate guilt, cause, or blame.
- [ ] An incident corrected to unfounded by an outcome source is as visually prominent as the original report.
- [ ] Outlet links are `rel="nofollow noopener"` and clearly external.

## Out of scope
Article summarization, excerpts beyond a headline, in-app reading, any framing that implies
we endorse or verify an outlet's reporting.
