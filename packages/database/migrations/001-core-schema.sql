-- 001 — core schema (S-A2, PRD §37).
--
-- SQLite per ADR-003. Constraints that ADR sets, applied throughout:
--   * STRICT tables, so a column's declared type is enforced.
--   * Enum-like columns are TEXT + CHECK, never a separate type — cheaper to evolve.
--   * Timestamps are ISO-8601 UTC TEXT: sortable, comparable, readable in a debugger,
--     and the reason the (occurred_at, lat, lng) index below can be covering.
--   * Coordinates are plain REAL lat/lng. No PostGIS, no geometry type; bounding-box
--     prefilter plus haversine does the work (ADR-002 §3).
--   * Rows are never deleted. Corrections are additive (S-D7); merges tombstone (S-D9).
--
-- Written to port: no SQLite-only syntax beyond STRICT, so a future Postgres migration is
-- a type swap rather than a rewrite.

-- Raw source payloads, exactly as fetched, before any interpretation. Keeping these makes
-- reprocessing possible without re-fetching, which matters on a feed with ~48 h retention.
CREATE TABLE source_records (
  id              TEXT NOT NULL PRIMARY KEY,
  source          TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  fetched_at      TEXT NOT NULL,
  payload         TEXT NOT NULL,          -- JSON as returned by the source
  payload_hash    TEXT NOT NULL,          -- change detection without comparing blobs
  UNIQUE (source, source_record_id, payload_hash)
) STRICT;

CREATE INDEX source_records_fetched_at_idx ON source_records (fetched_at);

-- One incoming record, normalized (PRD §8).
CREATE TABLE observations (
  id                      TEXT NOT NULL PRIMARY KEY,
  source                  TEXT NOT NULL
    CHECK (source IN ('sf_police_cad', 'sf_fire_cad', 'sf_ems_cad', 'radio', 'other')),
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
  units                   TEXT,           -- JSON array
  text                    TEXT,           -- source free-text; never published (S-E1)
  audio                   TEXT,           -- JSON
  metadata                TEXT,           -- JSON
  confidence              REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  visibility              TEXT CHECK (visibility IN ('public', 'delayed', 'restricted', 'discard')),
  sensitive               INTEGER CHECK (sensitive IN (0, 1)),
  -- The idempotency key of the whole system: re-reading a source updates, never duplicates.
  UNIQUE (source, source_record_id)
) STRICT;

-- ADR-003's measured result: (occurred_at, lat, lng) in that order took S-D1 candidate
-- retrieval from 10.039 ms to 0.009 ms, because the time window is far more selective than
-- the bounding box and the index becomes covering. Column order here is load-bearing.
-- `id` is appended, not reordered: the leading three columns are what ADR-003 measured,
-- and the trailing key is what lets a candidate-id lookup stay inside the index.
CREATE INDEX observations_time_loc_idx ON observations (occurred_at, lat, lng, id);
CREATE INDEX observations_ingested_at_idx ON observations (ingested_at);
CREATE INDEX observations_type_idx ON observations (type, occurred_at);
CREATE INDEX observations_neighborhood_idx ON observations (neighborhood, occurred_at);

-- The product object (PRD §9).
CREATE TABLE incidents (
  id                          TEXT NOT NULL PRIMARY KEY,
  primary_type                TEXT NOT NULL,
  title                       TEXT NOT NULL,
  agency_types                TEXT NOT NULL,   -- JSON array
  priority                    TEXT,
  severity                    TEXT CHECK (severity IN ('low', 'moderate', 'high', 'critical')),
  status                      TEXT NOT NULL
    CHECK (status IN ('reported', 'dispatched', 'active', 'contained', 'resolved', 'unknown')),
  location_display_name       TEXT,
  address                     TEXT,
  intersection                TEXT,
  lat                         REAL,
  lng                         REAL,
  neighborhood                TEXT,
  first_observed_at           TEXT NOT NULL,
  last_updated_at             TEXT NOT NULL,
  resolved_at                 TEXT,
  units                       TEXT NOT NULL,   -- JSON array
  summary                     TEXT,
  confidence                  REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_count                INTEGER NOT NULL DEFAULT 0,
  independent_source_count    INTEGER NOT NULL DEFAULT 0,
  verification_classification TEXT NOT NULL
    CHECK (verification_classification IN ('reported', 'multi-source', 'official-response-confirmed')),
  confidence_location         REAL,
  confidence_type             REAL,
  confidence_correlation      REAL,
  confidence_status           REAL,
  visibility                  TEXT CHECK (visibility IN ('public', 'delayed', 'restricted', 'discard')),
  published_at                TEXT,
  -- Tombstone: set when this incident was absorbed by another (S-D9).
  merged_into_id              TEXT REFERENCES incidents (id),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
) STRICT;

-- The feed's own query: open incidents, most recently updated first.
CREATE INDEX incidents_active_idx ON incidents (last_updated_at DESC)
  WHERE status <> 'resolved' AND merged_into_id IS NULL;
CREATE INDEX incidents_time_loc_idx ON incidents (first_observed_at, lat, lng);
CREATE INDEX incidents_type_idx ON incidents (primary_type, first_observed_at);
CREATE INDEX incidents_neighborhood_idx ON incidents (neighborhood, first_observed_at);
CREATE INDEX incidents_published_idx ON incidents (published_at) WHERE published_at IS NOT NULL;
CREATE INDEX incidents_merged_into_idx ON incidents (merged_into_id) WHERE merged_into_id IS NOT NULL;

CREATE TABLE incident_observations (
  incident_id    TEXT NOT NULL REFERENCES incidents (id),
  observation_id TEXT NOT NULL REFERENCES observations (id),
  -- How this observation came to be attached: score and decision live in the log (S-D3).
  attached_at    TEXT NOT NULL,
  score          REAL,
  PRIMARY KEY (incident_id, observation_id)
) STRICT;

CREATE INDEX incident_observations_observation_idx ON incident_observations (observation_id);

-- PRD §20/§32: every timeline entry keeps its source. The FK is NOT NULL for that reason.
CREATE TABLE timeline_events (
  id             TEXT NOT NULL PRIMARY KEY,
  incident_id    TEXT NOT NULL REFERENCES incidents (id),
  occurred_at    TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  kind           TEXT NOT NULL,
  text           TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES observations (id),
  -- S-D5: re-processing an observation must not duplicate an entry.
  UNIQUE (incident_id, observation_id, kind)
) STRICT;

CREATE INDEX timeline_events_incident_idx ON timeline_events (incident_id, occurred_at, recorded_at);

-- Resolved locations, so geocoding is done once per distinct string (S-C2).
CREATE TABLE locations (
  id             TEXT NOT NULL PRIMARY KEY,
  normalized     TEXT NOT NULL UNIQUE,
  display_name   TEXT,
  address        TEXT,
  intersection   TEXT,
  lat            REAL,
  lng            REAL,
  neighborhood   TEXT,
  geocoder       TEXT,
  confidence     REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  resolved_at    TEXT NOT NULL
) STRICT;

CREATE INDEX locations_neighborhood_idx ON locations (neighborhood);

-- Analysis Neighborhoods as GeoJSON (S-A2/S-C2). ~40 polygons, cached in memory and tested
-- by ray-casting in TypeScript — no PostGIS, no spatial index needed at this size.
CREATE TABLE neighborhoods (
  name        TEXT NOT NULL PRIMARY KEY,
  geometry    TEXT NOT NULL,              -- GeoJSON geometry
  min_lat     REAL NOT NULL,              -- bounding box, for the cheap prefilter
  min_lng     REAL NOT NULL,
  max_lat     REAL NOT NULL,
  max_lng     REAL NOT NULL,
  source      TEXT NOT NULL,
  loaded_at   TEXT NOT NULL
) STRICT;

CREATE TABLE units (
  id            TEXT NOT NULL PRIMARY KEY,
  designator    TEXT NOT NULL UNIQUE,     -- e.g. 3A12, E01, M18
  agency_type   TEXT CHECK (agency_type IN ('police', 'fire', 'ems', 'other')),
  kind          TEXT,                     -- parsed unit kind (S-C4)
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
) STRICT;

CREATE TABLE incident_units (
  incident_id   TEXT NOT NULL REFERENCES incidents (id),
  unit_id       TEXT NOT NULL REFERENCES units (id),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (incident_id, unit_id)
) STRICT;

CREATE INDEX incident_units_unit_idx ON incident_units (unit_id);

-- Raw agency code → product type, configurable rather than hardcoded (PRD §10, S-A4).
CREATE TABLE event_taxonomy (
  id             TEXT NOT NULL PRIMARY KEY,
  source         TEXT NOT NULL,
  raw_code       TEXT NOT NULL,
  raw_label      TEXT,
  incident_type  TEXT NOT NULL,
  subtype        TEXT,
  severity       TEXT CHECK (severity IN ('low', 'moderate', 'high', 'critical')),
  confidence     REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  updated_at     TEXT NOT NULL,
  UNIQUE (source, raw_code)
) STRICT;

-- One row per feed: where it is, how often to poll, and what it last did (S-B3).
CREATE TABLE source_configuration (
  source            TEXT NOT NULL PRIMARY KEY,
  dataset_id        TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  poll_seconds      INTEGER NOT NULL DEFAULT 60,
  publication_delay_seconds INTEGER NOT NULL DEFAULT 180,
  last_polled_at    TEXT,
  last_success_at   TEXT,
  last_record_at    TEXT,
  last_error        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
) STRICT;

-- Phase 2 (radio). Created now so the seam exists; unused until then.
CREATE TABLE transcripts (
  id             TEXT NOT NULL PRIMARY KEY,
  observation_id TEXT REFERENCES observations (id),
  talkgroup      TEXT,
  started_at     TEXT NOT NULL,
  duration       REAL,
  text           TEXT NOT NULL,
  engine         TEXT,
  confidence     REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at     TEXT NOT NULL
) STRICT;
