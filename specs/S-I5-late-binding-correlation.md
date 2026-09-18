# S-I5 — Late-binding correlation

**Epic:** I · Outcome sources · **Phase:** 3 · **Depends on:** S-D2, S-D9 · **Size:** L

## Story
As the correlator, I want a second correlation path for sources that arrive hours or days
after the event, so that outcome sources can attach to incidents that are long closed.

## Acceptance criteria
- [ ] A distinct pipeline from S-D1/S-D3: candidate retrieval over **closed and archived** incidents, with a configurable lookback (default 14 days) instead of the −10/+15 minute window.
- [ ] Time similarity is rescored for this path — a 6-hour gap is unremarkable for an article and disqualifying for a CAD record. The scorer config is per-source-class, not global.
- [ ] Attaching a late observation does **not** reopen the incident, change its status, or move it up the feed by `last_updated_at`; a separate `last_enriched_at` tracks it.
- [ ] Late attachments never trigger incident merges (S-D9) — an article is not evidence that two incidents are one.
- [ ] Rollups (S-H6) and baselines (S-H5) are unaffected by late attachments, so historical counts never shift under a reader.
- [ ] Runs as a low-priority queue lane that cannot starve real-time correlation; real-time correlation is never blocked by this path.
- [ ] Its own eval fixtures and metrics, separate from S-D10's real-time corpus.

## Risk note
This is a second correlation domain layered on an unproven first one. Do not start it until
the real-time correlator has a stable committed baseline in S-D10 and has run for months.
Two unvalidated correlation systems cannot be debugged at once.
