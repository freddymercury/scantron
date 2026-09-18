-- 004 — the geocoding gazetteer (S-C2).
--
-- No PostGIS and no spatial index: an intersection lookup is a *text* lookup on the
-- canonical street pair (S-C1 is what makes that work), and block interpolation walks a
-- street segment's own line. Bounding boxes are stored so a radius query can prefilter on
-- plain indexed columns before haversine (ADR-002 §3).

-- Canonical street pair → point, derived from the city's own dispatch records: every
-- historical call that carried both an intersection_name and an intersection_point.
CREATE TABLE intersections (
  canonical   TEXT NOT NULL PRIMARY KEY,   -- e.g. "19th Ave & Irving St"
  street_a    TEXT NOT NULL,
  street_b    TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  observations INTEGER NOT NULL DEFAULT 1, -- how many records agreed on this point
  source      TEXT NOT NULL,
  loaded_at   TEXT NOT NULL
) STRICT;

CREATE INDEX intersections_street_a_idx ON intersections (street_a);
CREATE INDEX intersections_street_b_idx ON intersections (street_b);
CREATE INDEX intersections_point_idx ON intersections (lat, lng);

-- Street centerline segments with their address ranges, for block interpolation.
CREATE TABLE street_segments (
  cnn            TEXT NOT NULL PRIMARY KEY,
  street         TEXT NOT NULL,            -- canonical, e.g. "Mission St"
  left_from      INTEGER,
  left_to        INTEGER,
  right_from     INTEGER,
  right_to       INTEGER,
  min_lat        REAL NOT NULL,
  min_lng        REAL NOT NULL,
  max_lat        REAL NOT NULL,
  max_lng        REAL NOT NULL,
  line           TEXT NOT NULL,            -- GeoJSON LineString
  neighborhood   TEXT,
  source         TEXT NOT NULL,
  loaded_at      TEXT NOT NULL
) STRICT;

-- The lookup is "segments of this street whose address range covers N".
CREATE INDEX street_segments_street_idx ON street_segments (street, left_from, left_to);
CREATE INDEX street_segments_street_right_idx ON street_segments (street, right_from, right_to);

-- How a location was resolved, kept with the resolved location itself (S-C2).
ALTER TABLE locations ADD COLUMN method TEXT;
ALTER TABLE locations ADD COLUMN kind TEXT;

-- Same, on the observation, so the viewer and correlation can see it without a join.
ALTER TABLE observations ADD COLUMN location_method TEXT;
ALTER TABLE observations ADD COLUMN location_confidence REAL;
