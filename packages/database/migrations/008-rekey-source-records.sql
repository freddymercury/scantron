-- 008 — re-key police source payloads onto cad_number.
--
-- Police observations are keyed on `cad_number` (S-B5: the historical dataset has no row
-- `id`), but payloads were briefly stored under the feed's row `id`. The rows were fine;
-- they were simply unfindable from the record they belonged to — the detail page reported
-- "0 versions" for a call whose payload was sitting right here.
--
-- The payload carries its own cad_number, so the fix is a rewrite rather than a re-fetch.
UPDATE source_records
   SET source_record_id = json_extract(payload, '$.cad_number')
 WHERE source = 'sf_police_cad'
   AND json_extract(payload, '$.cad_number') IS NOT NULL
   AND source_record_id <> json_extract(payload, '$.cad_number');
