-- 011 — the correlation decision trail (S-D3).
--
-- Every attachment records why it happened and every near miss records why it did not.
-- The thresholds in this system are guesses until they are measured, and they cannot be
-- measured from incidents alone: the rejected pairs are half the evidence.
ALTER TABLE incident_observations ADD COLUMN decision TEXT;
ALTER TABLE incident_observations ADD COLUMN breakdown TEXT;   -- JSON, per-feature
ALTER TABLE incident_observations ADD COLUMN applied_features TEXT;

-- Pairs that scored in the probable band: a new incident was created, and this row says
-- which existing incident it nearly joined. S-G3 reviews these; S-D10 tunes on them.
CREATE TABLE probable_matches (
  id                TEXT NOT NULL PRIMARY KEY,
  observation_id    TEXT NOT NULL REFERENCES observations (id),
  incident_id       TEXT NOT NULL REFERENCES incidents (id),
  created_incident_id TEXT REFERENCES incidents (id),
  score             REAL NOT NULL,
  breakdown         TEXT NOT NULL,
  applied_features  TEXT NOT NULL,
  decision          TEXT NOT NULL,
  reviewed          INTEGER NOT NULL DEFAULT 0 CHECK (reviewed IN (0, 1)),
  review_verdict    TEXT CHECK (review_verdict IN ('same', 'different', 'unsure')),
  reviewed_by       TEXT,
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (observation_id, incident_id)
) STRICT;

CREATE INDEX probable_matches_score_idx ON probable_matches (score DESC);
CREATE INDEX probable_matches_review_idx ON probable_matches (reviewed, created_at);
