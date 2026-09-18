-- 003 — event_taxonomy reshaped to the row S-A4 specifies.
--
-- 001 created this table before the mapping rules were written; the story asks for
-- `raw_label_pattern`, `normalized_type`, `default_severity` and `type_confidence`, and for
-- pattern rows that carry no code at all. Migrations are forward-only, so this drops and
-- recreates rather than patching: the table has never held data outside a test.
DROP TABLE event_taxonomy;

CREATE TABLE event_taxonomy (
  id                TEXT NOT NULL PRIMARY KEY,
  source            TEXT NOT NULL,
  raw_code          TEXT,
  -- A regular expression over the source's own label, used only when no code matches.
  raw_label_pattern TEXT,
  raw_label         TEXT,
  normalized_type   TEXT NOT NULL CHECK (normalized_type IN (
    'fire', 'medical', 'collision', 'assault', 'weapon', 'robbery', 'burglary', 'theft',
    'disturbance', 'missing_person', 'hazard', 'rescue', 'traffic', 'public_safety',
    'police_activity', 'unknown'
  )),
  subtype           TEXT,
  default_severity  TEXT CHECK (default_severity IN ('low', 'moderate', 'high', 'critical')),
  type_confidence   REAL NOT NULL CHECK (type_confidence >= 0 AND type_confidence <= 1),
  version           TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  -- A row with neither a code nor a pattern could never match anything.
  CHECK (raw_code IS NOT NULL OR raw_label_pattern IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX event_taxonomy_code_idx
  ON event_taxonomy (source, raw_code) WHERE raw_code IS NOT NULL;
CREATE UNIQUE INDEX event_taxonomy_pattern_idx
  ON event_taxonomy (source, raw_label_pattern) WHERE raw_label_pattern IS NOT NULL;
CREATE INDEX event_taxonomy_source_idx ON event_taxonomy (source, updated_at);
