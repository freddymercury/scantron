-- 014 — SFPD incident reports become a source (S-I2).
--
-- `observations.source` carries a CHECK constraint, and SQLite cannot alter one in place,
-- so this is the standard table rebuild: new table, copy, drop, rename, recreate the
-- indexes and the FTS triggers that went with the old table.
--
-- The rebuild is safe here for a reason worth writing down: `observations` is the widest
-- table in the schema but not the biggest (16.6 MB against `source_records`' 32.5 MB), and
-- the copy runs inside the migration's transaction, so a failure leaves the old table
-- exactly as it was.
--
-- `sf_police_report` is deliberately *not* a dispatch source. See DISPATCH_SOURCES in
-- @scantron/incident-schema: a written-up report is the same agency's paperwork for a call
-- we already hold, days later, so it must never be counted as another call.

CREATE TABLE observations_rebuilt (
  id                      TEXT NOT NULL PRIMARY KEY,
  source                  TEXT NOT NULL
    CHECK (source IN ('sf_police_cad', 'sf_fire_cad', 'sf_ems_cad', 'sf_police_report', 'radio', 'other')),
  source_record_id        TEXT,
  agency                  TEXT,
  occurred_at             TEXT NOT NULL,
  ingested_at             TEXT NOT NULL,
  type                    TEXT,
  subtype                 TEXT,
  raw_type                TEXT,
  priority                TEXT,
  location_raw            TEXT,
  location_normalized     TEXT,
  location_display_name   TEXT,
  address                 TEXT,
  intersection            TEXT,
  lat                     REAL,
  lng                     REAL,
  neighborhood            TEXT,
  units                   TEXT,
  text                    TEXT,
  audio                   TEXT,
  metadata                TEXT,
  confidence              REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  visibility              TEXT CHECK (visibility IN ('public', 'delayed', 'restricted', 'discard')),
  sensitive               INTEGER CHECK (sensitive IN (0, 1)),
  location_method         TEXT,
  location_confidence     REAL,
  type_confidence         REAL,
  severity                TEXT,
  priority_rank           INTEGER,
  normalized_at           TEXT,
  backfilled              INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
  UNIQUE (source, source_record_id)
) STRICT;

INSERT INTO observations_rebuilt (
  id, source, source_record_id, agency, occurred_at, ingested_at, type, subtype, raw_type,
  priority, location_raw, location_normalized, location_display_name, address, intersection,
  lat, lng, neighborhood, units, text, audio, metadata, confidence, visibility, sensitive,
  location_method, location_confidence, type_confidence, severity, priority_rank,
  normalized_at, backfilled
)
SELECT
  id, source, source_record_id, agency, occurred_at, ingested_at, type, subtype, raw_type,
  priority, location_raw, location_normalized, location_display_name, address, intersection,
  lat, lng, neighborhood, units, text, audio, metadata, confidence, visibility, sensitive,
  location_method, location_confidence, type_confidence, severity, priority_rank,
  normalized_at, backfilled
FROM observations;

-- `incident_observations` and `timeline_events` both reference `observations`, so this
-- drop-and-rename only works with foreign keys disabled — which the migration runner does
-- around every migration, and then verifies with `foreign_key_check`. `legacy_alter_table`
-- stops the rename from trying to repoint those references at a name that is about to
-- exist again: they are correct precisely because the name does not change.
PRAGMA legacy_alter_table = ON;
DROP TABLE observations;
ALTER TABLE observations_rebuilt RENAME TO observations;
PRAGMA legacy_alter_table = OFF;

-- The covering index ADR-003 measured at 0.009 ms against 10.039 ms without it. Recreating
-- it is the point of this half of the migration.
CREATE INDEX observations_time_loc_idx ON observations (occurred_at, lat, lng, id);
CREATE INDEX observations_ingested_at_idx ON observations (ingested_at);
CREATE INDEX observations_neighborhood_idx ON observations (neighborhood, occurred_at);
CREATE INDEX observations_type_idx ON observations (type, occurred_at);
CREATE INDEX observations_unmapped_idx ON observations (source, raw_type)
  WHERE type IS NULL OR type = 'unknown';

-- FTS triggers died with the old table. The index itself (`observations_fts`) is a separate
-- table and survived, so only the triggers come back.
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
