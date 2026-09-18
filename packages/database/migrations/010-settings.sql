-- 010 — runtime settings (S-D1, S-D2).
--
-- Correlation's radius, time window, grace period and feature weights are all things an
-- operator needs to change without a deploy, and things a tuning run needs to change
-- programmatically. One key/value table with JSON values, read through a cache that
-- re-reads on an interval — the same shape as source_configuration, for the same reason.
CREATE TABLE settings (
  key         TEXT NOT NULL PRIMARY KEY,
  value       TEXT NOT NULL,              -- JSON
  updated_at  TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'system'
) STRICT;

CREATE TABLE settings_changes (
  id          TEXT NOT NULL PRIMARY KEY,
  key         TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT NOT NULL,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT NOT NULL DEFAULT 'system'
) STRICT;

CREATE INDEX settings_changes_idx ON settings_changes (key, changed_at);
