# S-I1 — `outcome-reported` verification tier

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-D6, S-D7 · **Size:** S

## Story
As a reader, I want to see when an incident's actual outcome is known, so that the product
can say what happened and not only what was dispatched.

## Acceptance criteria
- [ ] Fourth verification classification `outcome-reported`, ranking above `official-response-confirmed`, set only by a source that describes a *result* (incident report disposition, news account), never by dispatch data.
- [ ] An outcome never silently rewrites the incident: it appends a timeline entry, may change `primary_type` and status via the S-D7 correction path, and retains the original dispatch classification.
- [ ] Outcome source and retrieval time are recorded per outcome; the UI can always name where an outcome came from.
- [ ] Outcomes that contradict dispatch (unfounded, no merit, gone on arrival) are first-class and rendered as prominently as the original report — see the risk note below.
- [ ] `PublicIncident` exposes the tier label only, never an outcome narrative or free text.
- [ ] Downgrade path: if an outcome attachment is later rejected (S-I6), the tier recomputes downward.

## Risk note
The base rate of dispatch calls is heavily weighted toward unfounded, report-only, and
gone-on-arrival. Faithfully attaching outcomes means a large share of incidents resolve to
"nothing happened." That is the honest result and it is the right thing to show. It is also
likely bad for engagement. Decide that deliberately, at the product level, before building
this epic — see assumption 39.
