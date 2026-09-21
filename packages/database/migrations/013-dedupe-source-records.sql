-- 013 — reserve the migration slot; the collapse itself runs in `bun run prune:payloads`.
--
-- `payload_hash` used to cover the whole payload, including `data_as_of` and
-- `data_loaded_at`, which DataSF rewrites on *every* record each time it republishes the
-- window. The result was 2.5 million stored payloads for 14,000 observations — 354
-- identical copies of one call — and most of a 5.6 GB database.
--
-- The hash now ignores those two fields, so new polls stop duplicating. Collapsing the
-- rows already stored needs that same hash function, which lives in TypeScript, so it is a
-- command rather than a migration: it rewrites `payload_hash` and keeps the earliest row
-- per distinct content.
CREATE INDEX IF NOT EXISTS source_records_record_idx
  ON source_records (source, source_record_id, fetched_at);
