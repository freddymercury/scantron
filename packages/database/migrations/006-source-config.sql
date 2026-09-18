-- 006 — source behaviour as configuration (S-B3).
--
-- Everything a poller decides at runtime lives here, so tuning or disabling a feed is a
-- SQL statement rather than a deploy. The columns 001 created stay; these are the ones
-- S-B3 adds.
ALTER TABLE source_configuration ADD COLUMN endpoint TEXT;
ALTER TABLE source_configuration ADD COLUMN overlap_seconds INTEGER NOT NULL DEFAULT 120;
-- How long this source may be silent before /health calls it stale. Per source, because
-- the police feed is a ~30-minute batch and fire/EMS runs ~19 hours behind (docs/01).
ALTER TABLE source_configuration ADD COLUMN health_max_silence_seconds INTEGER NOT NULL DEFAULT 3600;
-- S-E1: the visibility an observation from this source starts with.
ALTER TABLE source_configuration ADD COLUMN default_visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (default_visibility IN ('public', 'delayed', 'restricted', 'discard'));
-- Failures past this many in a row back the interval off rather than hammering the API.
ALTER TABLE source_configuration ADD COLUMN backoff_after_failures INTEGER NOT NULL DEFAULT 3;
ALTER TABLE source_configuration ADD COLUMN max_poll_seconds INTEGER NOT NULL DEFAULT 1800;

-- Config changes are logged with before and after, so "why did this feed stop" has an
-- answer that does not depend on anyone remembering.
CREATE TABLE source_configuration_changes (
  id          TEXT NOT NULL PRIMARY KEY,
  source      TEXT NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT NOT NULL DEFAULT 'system'
) STRICT;

CREATE INDEX source_configuration_changes_idx ON source_configuration_changes (source, changed_at);
