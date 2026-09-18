/**
 * SFPD Law Enforcement Dispatched Calls (`gnap-fj3t`) → Observation.
 *
 * Field names and fill rates verified live (docs/01). Three things worth knowing here:
 *   * Timestamps are naive San Francisco local time, not UTC (see parseSfTimestamp).
 *   * `intersection_point` and `analysis_neighborhood` arrive on ~63% of calls, so
 *     geocoding (S-C2) is a backfill for the rest rather than the main path.
 *   * This feed carries no unit identifiers at all; units come from the fire/EMS feed.
 */

import type { Observation } from "@scantron/incident-schema";
import { parseSfTimestamp } from "@scantron/sf-domain";

import { MalformedRecordError, type MappedRecord, type SourceAdapter } from "./adapter.ts";

export const SFPD_SOURCE = "sf_police_cad" as const;
export const SFPD_DATASET_ID = "gnap-fj3t";
/** The column the cursor walks: when DataSF published the row, not when the call happened. */
export const SFPD_CURSOR_FIELD = "data_loaded_at";

export interface SfpdCallRecord extends Record<string, unknown> {
  id?: string;
  cad_number?: string;
  received_datetime?: string;
  entry_datetime?: string;
  dispatch_datetime?: string;
  enroute_datetime?: string;
  onscene_datetime?: string;
  close_datetime?: string;
  call_type_original?: string;
  call_type_original_desc?: string;
  call_type_final?: string;
  call_type_final_desc?: string;
  call_type_final_notes?: string;
  priority_original?: string;
  priority_final?: string;
  agency?: string;
  disposition?: string;
  onview_flag?: string;
  sensitive_call?: boolean | string;
  intersection_name?: string;
  intersection_id?: string;
  intersection_point?: { type?: string; coordinates?: number[] };
  supervisor_district?: string;
  analysis_neighborhood?: string;
  police_district?: string;
  call_last_updated_at?: string;
  data_as_of?: string;
  data_loaded_at?: string;
}

function isSensitive(value: SfpdCallRecord["sensitive_call"]): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  return value.toLowerCase() === "true";
}

/**
 * Map one feed row. Throws `MalformedRecordError` for rows that cannot be trusted — the
 * feed does contain them, and quarantining beats writing a record with a NaN timestamp.
 */
export function mapSfpdRecord(record: SfpdCallRecord, ingestedAt: Date): MappedRecord {
  // Keyed on `cad_number`, not the feed's row `id`: the historical dataset (2zdj-bwza)
  // has no `id` column at all, so keying on it would make every backfilled row a
  // duplicate of the live row for the same call. `cad_number` is present and unique on
  // both — verified across 1,000 live rows on 2026-09-18 — and is the same key the
  // incident-report join uses (docs/01 §1).
  const sourceRecordId = record.cad_number?.trim() || record.id?.trim();
  if (!sourceRecordId) {
    throw new MalformedRecordError("record has neither cad_number nor id", record.id);
  }

  const receivedAt = parseSfTimestamp(record.received_datetime);
  if (!receivedAt) {
    throw new MalformedRecordError("received_datetime missing or unparseable", sourceRecordId);
  }

  const coordinates = record.intersection_point?.coordinates;
  const [lng, lat] = Array.isArray(coordinates) ? coordinates : [undefined, undefined];
  const hasPoint = typeof lat === "number" && typeof lng === "number";

  const observation: Observation = {
    id: `obs_${SFPD_SOURCE}_${sourceRecordId}`,
    source: SFPD_SOURCE,
    sourceRecordId,
    occurredAt: receivedAt,
    ingestedAt,
    confidence: 0.6,
  };

  if (record.agency) observation.agency = record.agency;
  // The final call type is what SFPD settled on; the original is kept in metadata so
  // corrections (S-D7) can see the change that was made, which happens on ~4% of calls.
  const rawType = record.call_type_final ?? record.call_type_original;
  if (rawType) observation.rawType = rawType;
  const label = record.call_type_final_desc ?? record.call_type_original_desc;
  if (label) observation.subtype = label;
  const priority = record.priority_final ?? record.priority_original;
  if (priority) observation.priority = priority;

  const location: NonNullable<Observation["location"]> = {};
  if (record.intersection_name) {
    location.raw = record.intersection_name;
    location.intersection = record.intersection_name;
  }
  if (record.analysis_neighborhood) location.neighborhood = record.analysis_neighborhood;
  if (hasPoint) {
    location.latitude = lat;
    location.longitude = lng;
  }
  if (Object.keys(location).length > 0) observation.location = location;

  const sensitive = isSensitive(record.sensitive_call);
  if (sensitive !== undefined) observation.sensitive = sensitive;

  // Everything the feed gave us that the domain model has no column for. Kept because
  // downstream stories need it: lifecycle timestamps (S-D4/S-D5), disposition (S-D4),
  // the original/final split (S-D7), districts (S-H*).
  const metadata: Record<string, unknown> = { cad_number: record.cad_number };
  for (const [key, value] of Object.entries({
    entry_datetime: record.entry_datetime,
    dispatch_datetime: record.dispatch_datetime,
    enroute_datetime: record.enroute_datetime,
    onscene_datetime: record.onscene_datetime,
    close_datetime: record.close_datetime,
    call_type_original: record.call_type_original,
    call_type_original_desc: record.call_type_original_desc,
    call_type_final: record.call_type_final,
    call_type_final_desc: record.call_type_final_desc,
    call_type_final_notes: record.call_type_final_notes,
    priority_original: record.priority_original,
    priority_final: record.priority_final,
    disposition: record.disposition,
    onview_flag: record.onview_flag,
    supervisor_district: record.supervisor_district,
    police_district: record.police_district,
    intersection_id: record.intersection_id,
    call_last_updated_at: record.call_last_updated_at,
    data_as_of: record.data_as_of,
    data_loaded_at: record.data_loaded_at,
  })) {
    if (value !== undefined && value !== null && value !== "") metadata[key] = value;
  }
  observation.metadata = metadata;

  const mapped: MappedRecord = { observation, receivedAt };
  const publishedAt = parseSfTimestamp(record.data_loaded_at);
  if (publishedAt) mapped.publishedAt = publishedAt;
  return mapped;
}

export const policeAdapter: SourceAdapter<SfpdCallRecord> = {
  source: SFPD_SOURCE,
  datasetId: SFPD_DATASET_ID,
  cursorField: SFPD_CURSOR_FIELD,
  idField: "id",
  // docs/01: a ~30-minute batch feed, so half an hour of silence is normal and an hour
  // is not.
  silenceThresholdSeconds: 60 * 60,
  map: mapSfpdRecord,
};
