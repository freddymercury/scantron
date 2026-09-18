-- 005 — what normalization writes back onto an observation (S-C3).
--
-- The raw agency code and label stay exactly where they were: normalization adds a second,
-- normalized reading of the same fact, it never overwrites the first (PRD §10).
ALTER TABLE observations ADD COLUMN type_confidence REAL;
ALTER TABLE observations ADD COLUMN severity TEXT;
-- 1 (most urgent) … 5, so that two agencies' letter and number scales can be compared.
ALTER TABLE observations ADD COLUMN priority_rank INTEGER;
ALTER TABLE observations ADD COLUMN normalized_at TEXT;

CREATE INDEX observations_unmapped_idx ON observations (source, raw_type)
  WHERE type IS NULL OR type = 'unknown';
