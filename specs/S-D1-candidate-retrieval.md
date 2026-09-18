# S-D1 — Correlation candidate retrieval

**Epic:** D · Incident intelligence · **Phase:** 1 · **Depends on:** S-C2 · **Size:** M

## Story
As the correlator, I want a cheap, bounded set of candidate incidents for a new
observation, so that scoring runs on a handful of rows rather than the whole table.

## Acceptance criteria
- [ ] Given a normalized observation, returns incidents whose location is within a configurable radius (default 400 m) **and** whose activity window overlaps −10/+15 minutes of the observation time.
- [ ] Query uses the PostGIS GiST index plus the active-incident partial index; p95 under 50 ms with 100k incidents (measured with seeded data).
- [ ] Incidents in status `resolved` older than a configurable grace period (default 20 min) are excluded; tombstoned/merged incidents are never candidates.
- [ ] An observation with no coordinates falls back to a neighborhood + time window search, with a flag that degrades the location score in S-D2.
- [ ] Radius, time window and grace period all come from config, hot-reloaded.
- [ ] Candidate count per observation is a metric; a runaway (>50) logs a warning with the observation ID.

## Out of scope
Scoring and the merge decision.
