-- 002 — durable job queue (S-A5, PRD §39).
--
-- The spec asks for `FOR UPDATE SKIP LOCKED`. ADR-003 chose SQLite, where the equivalent
-- is a BEGIN IMMEDIATE transaction that selects and marks in one atomic step: the writer
-- lock is exclusive, so two workers cannot claim the same row. Assumption 21 already gave
-- us a single writer process, so this is the design rather than a compromise.
CREATE TABLE jobs (
  id            TEXT NOT NULL PRIMARY KEY,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,                 -- JSON
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  run_after     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  locked_by     TEXT,
  locked_at     TEXT,
  last_error    TEXT,
  -- Prevents a duplicate *pending* job for the same observation+type. Cleared on
  -- completion so the same work can legitimately be scheduled again later.
  dedupe_key    TEXT UNIQUE,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT
) STRICT;

-- The claim query: pending work that is due, oldest first.
CREATE INDEX jobs_claimable_idx ON jobs (run_after, id) WHERE status = 'pending';
CREATE INDEX jobs_status_idx ON jobs (status, updated_at);
CREATE INDEX jobs_type_idx ON jobs (type, status);
