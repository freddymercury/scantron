# S-D9 — Incident-to-incident merge and tombstoning

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-D3 · **Size:** M

## Story
As the correlator, I want two incidents that turn out to be one event to merge without
breaking links or losing history, so that duplicates created by early uncertainty
self-heal.

## Acceptance criteria
- [ ] When a new observation scores ≥ the merge threshold against two separate incidents, the incidents merge: the older (by `first_observed_at`) survives.
- [ ] The losing incident is tombstoned with `merged_into_id` set — never deleted; its observations, units and timeline entries re-point to the survivor with no duplicates.
- [ ] `GET /incidents/:id` for a tombstoned ID returns the survivor with a `merged_from` field (301-equivalent semantics documented).
- [ ] The survivor's timeline gains a merge entry; verification, confidence and status recompute afterwards.
- [ ] An `incident.merged` SSE event is emitted with both IDs so clients can collapse the feed entry.
- [ ] Merge runs in one transaction and is idempotent if replayed.
- [ ] Merge rate is a tracked metric; a merge rate above a configured level is a signal the threshold is too high.

## Out of scope
Manual merge/split (S-G3).
