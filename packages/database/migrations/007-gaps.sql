-- 007 — ingestion gaps and quarantine (S-B5).
--
-- The real-time police feed retains ~48 hours. Anything we fail to poll ages out of it for
-- good, so a gap is not an inconvenience — past the retention window it is permanent data
-- loss, and it needs to be visible as a different kind of problem from "the feed is slow".
CREATE TABLE ingestion_gaps (
  id             TEXT NOT NULL PRIMARY KEY,
  source         TEXT NOT NULL,
  gap_start      TEXT NOT NULL,           -- last successful poll
  gap_end        TEXT NOT NULL,           -- first poll after the gap
  detected_at    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'filling', 'filled', 'unrecoverable')),
  records_filled INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  filled_at      TEXT,
  note           TEXT,
  UNIQUE (source, gap_start, gap_end)
) STRICT;

CREATE INDEX ingestion_gaps_status_idx ON ingestion_gaps (status, gap_end);

-- Rows that failed validation. Never dropped silently, never inserted: the historical
-- dataset really does contain an export footer row whose cad_number reads
-- "Completion time: 2025-03-11T11:42:36…" (verified live).
CREATE TABLE quarantined_records (
  id           TEXT NOT NULL PRIMARY KEY,
  source       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  payload      TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  UNIQUE (source, payload_hash)
) STRICT;

CREATE INDEX quarantined_records_idx ON quarantined_records (source, quarantined_at);

-- Backfilled rows were never going to be timely; flagging them keeps them out of the
-- latency metrics they would otherwise ruin.
ALTER TABLE observations ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0
  CHECK (backfilled IN (0, 1));
