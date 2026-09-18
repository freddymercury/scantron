-- 009 — full-text search over observations (S-E4).
--
-- FTS5 is built into SQLite, so the retrieval half of search costs nothing in
-- dependencies (ADR-003 §5 measured it: 200k rows indexed in 0.36 s, queries at 3.4 ms).
-- The indexed text is deliberately narrow: what the agency called it, where it happened,
-- which units went. Source free-text is *not* indexed — S-E1 forbids publishing it, and an
-- index is a publication surface.
CREATE VIRTUAL TABLE observations_fts USING fts5(
  id UNINDEXED,
  raw_type,
  subtype,
  location,
  neighborhood,
  units,
  type,
  tokenize = 'porter unicode61'
);

-- Kept in step by trigger rather than by application code, so a write path that forgets
-- to index cannot exist.
CREATE TRIGGER observations_fts_insert AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts (id, raw_type, subtype, location, neighborhood, units, type)
  VALUES (
    new.id,
    COALESCE(new.raw_type, ''),
    COALESCE(new.subtype, ''),
    COALESCE(new.location_normalized, new.location_raw, ''),
    COALESCE(new.neighborhood, ''),
    COALESCE(new.units, ''),
    COALESCE(new.type, '')
  );
END;

CREATE TRIGGER observations_fts_update AFTER UPDATE ON observations BEGIN
  DELETE FROM observations_fts WHERE id = old.id;
  INSERT INTO observations_fts (id, raw_type, subtype, location, neighborhood, units, type)
  VALUES (
    new.id,
    COALESCE(new.raw_type, ''),
    COALESCE(new.subtype, ''),
    COALESCE(new.location_normalized, new.location_raw, ''),
    COALESCE(new.neighborhood, ''),
    COALESCE(new.units, ''),
    COALESCE(new.type, '')
  );
END;

CREATE TRIGGER observations_fts_delete AFTER DELETE ON observations BEGIN
  DELETE FROM observations_fts WHERE id = old.id;
END;

-- Backfill whatever is already here.
INSERT INTO observations_fts (id, raw_type, subtype, location, neighborhood, units, type)
SELECT id,
       COALESCE(raw_type, ''),
       COALESCE(subtype, ''),
       COALESCE(location_normalized, location_raw, ''),
       COALESCE(neighborhood, ''),
       COALESCE(units, ''),
       COALESCE(type, '')
  FROM observations;
