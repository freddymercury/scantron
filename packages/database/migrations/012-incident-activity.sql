-- 012 — separate an incident's activity span from our processing time (S-D2/S-D3).
--
-- `last_updated_at` is when *we* last touched the row, which is what the feed orders by.
-- Scoring needs something different: when the event was last reported. Using the former
-- for the latter made every incident's activity window stretch to the present moment, so
-- any later observation scored a perfect 1.0 on time — a nine-minute-old unrelated call
-- looked simultaneous.
ALTER TABLE incidents ADD COLUMN last_observed_at TEXT;

UPDATE incidents SET last_observed_at = COALESCE(
  (SELECT max(o.occurred_at) FROM incident_observations io
     JOIN observations o ON o.id = io.observation_id
    WHERE io.incident_id = incidents.id),
  first_observed_at
);
