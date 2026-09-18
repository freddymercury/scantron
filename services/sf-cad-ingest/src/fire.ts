/**
 * SFFD / EMS calls for service (`nuek-vuh3`) → Observations.
 *
 * Two facts about this feed shape everything here:
 *
 *   1. **It publishes one row per responding unit, not per call.** A structure fire with
 *      eight units is eight rows sharing a `call_number`. Ingesting rows as observations
 *      would inflate counts by exactly the number of units, so rows are folded into one
 *      observation per call and the units accumulate.
 *   2. **It serves both fire and EMS.** They are separate `source` values because S-D6's
 *      independent-source count is meaningless otherwise, so each row is routed by a
 *      documented rule (`isEmsRecord`) and a call answered by both agencies produces one
 *      observation for each — which is a genuine cross-agency signal, not a duplicate.
 */

import type { Observation } from "@scantron/incident-schema";
import { parseSfTimestamp } from "@scantron/sf-domain";

import { MalformedRecordError, type MappedRecord, type SourceAdapter } from "./adapter.ts";

export const SFFD_DATASET_ID = "nuek-vuh3";
export const FIRE_SOURCE = "sf_fire_cad" as const;
export const EMS_SOURCE = "sf_ems_cad" as const;
export const SFFD_CURSOR_FIELD = "data_loaded_at";
/** `rowid` is `${call_number}-${unit_id}`, unique per unit row — the keyset tiebreaker. */
export const SFFD_ID_FIELD = "rowid";

export interface SffdCallRecord extends Record<string, unknown> {
  call_number?: string;
  unit_id?: string;
  incident_number?: string;
  call_type?: string;
  call_type_group?: string;
  received_dttm?: string;
  entry_dttm?: string;
  dispatch_dttm?: string;
  response_dttm?: string;
  on_scene_dttm?: string;
  available_dttm?: string;
  call_final_disposition?: string;
  address?: string;
  city?: string;
  zipcode_of_incident?: string;
  battalion?: string;
  station_area?: string;
  box?: string;
  original_priority?: string;
  priority?: string;
  final_priority?: string;
  als_unit?: boolean | string;
  number_of_alarms?: string;
  unit_type?: string;
  unit_sequence_in_call_dispatch?: string;
  fire_prevention_district?: string;
  supervisor_district?: string;
  neighborhoods_analysis_boundaries?: string;
  rowid?: string;
  case_location?: { coordinates?: number[] };
  data_as_of?: string;
  data_loaded_at?: string;
}

/**
 * The documented EMS rule. Medical transport units and medical call types are EMS; engines,
 * trucks and chiefs on a fire call are fire. Kept as one function so the rule is a single
 * readable statement rather than scattered conditions.
 */
export const EMS_UNIT_TYPES = new Set(["MEDIC", "PRIVATE", "AMBULANCE", "RESCUE CAPTAIN"]);

export function isEmsRecord(record: SffdCallRecord): boolean {
  const unitType = record.unit_type?.trim().toUpperCase();
  if (unitType && EMS_UNIT_TYPES.has(unitType)) return true;
  const callType = record.call_type?.trim().toLowerCase();
  return callType === "medical incident";
}

export function sourceFor(record: SffdCallRecord): typeof FIRE_SOURCE | typeof EMS_SOURCE {
  return isEmsRecord(record) ? EMS_SOURCE : FIRE_SOURCE;
}

function mapRecord(record: SffdCallRecord, ingestedAt: Date, source: string): MappedRecord {
  const callNumber = record.call_number?.trim();
  if (!callNumber) {
    throw new MalformedRecordError("record has no call_number", record.rowid);
  }
  const receivedAt = parseSfTimestamp(record.received_dttm);
  if (!receivedAt) {
    throw new MalformedRecordError("received_dttm missing or unparseable", record.rowid);
  }

  const observation: Observation = {
    // Keyed by call, not by row: one call is one observation however many units respond.
    id: `obs_${source}_${callNumber}`,
    source: source as Observation["source"],
    sourceRecordId: callNumber,
    agency: source === EMS_SOURCE ? "SFFD EMS" : "SFFD",
    occurredAt: receivedAt,
    ingestedAt,
    confidence: 0.6,
  };

  if (record.call_type) {
    observation.rawType = record.call_type;
    observation.subtype = record.call_type;
  }
  const priority = record.final_priority ?? record.priority ?? record.original_priority;
  if (priority) observation.priority = priority;

  const unit = record.unit_id?.trim();
  if (unit) observation.units = [unit];

  const coordinates = record.case_location?.coordinates;
  const [lng, lat] = Array.isArray(coordinates) ? coordinates : [undefined, undefined];
  const location: NonNullable<Observation["location"]> = {};
  if (record.address) {
    location.raw = record.address;
  }
  if (record.neighborhoods_analysis_boundaries) {
    location.neighborhood = record.neighborhoods_analysis_boundaries;
  }
  if (typeof lat === "number" && typeof lng === "number") {
    location.latitude = lat;
    location.longitude = lng;
  }
  if (Object.keys(location).length > 0) observation.location = location;

  const metadata: Record<string, unknown> = { call_number: callNumber };
  for (const [key, value] of Object.entries({
    incident_number: record.incident_number,
    call_type_group: record.call_type_group,
    entry_dttm: record.entry_dttm,
    dispatch_dttm: record.dispatch_dttm,
    response_dttm: record.response_dttm,
    on_scene_dttm: record.on_scene_dttm,
    available_dttm: record.available_dttm,
    call_final_disposition: record.call_final_disposition,
    battalion: record.battalion,
    station_area: record.station_area,
    box: record.box,
    original_priority: record.original_priority,
    priority: record.priority,
    final_priority: record.final_priority,
    als_unit: record.als_unit,
    number_of_alarms: record.number_of_alarms,
    supervisor_district: record.supervisor_district,
    fire_prevention_district: record.fire_prevention_district,
    zipcode_of_incident: record.zipcode_of_incident,
    data_as_of: record.data_as_of,
    data_loaded_at: record.data_loaded_at,
  })) {
    if (value !== undefined && value !== null && value !== "") metadata[key] = value;
  }
  // Unit rows carry per-unit timestamps; keep them keyed by unit so S-D5 can build a
  // timeline that says which unit did what, when.
  // Set from the first row, so a single-unit call looks the same whether or not a merge
  // ever ran — otherwise a re-poll would "change" every one-unit call.
  metadata.unit_count = unit ? 1 : 0;
  if (unit) {
    metadata.unit_timestamps = {
      [unit]: {
        dispatch: record.dispatch_dttm,
        response: record.response_dttm,
        on_scene: record.on_scene_dttm,
        available: record.available_dttm,
        unit_type: record.unit_type,
      },
    };
  }
  observation.metadata = metadata;

  const mapped: MappedRecord = { observation, receivedAt };
  const publishedAt = parseSfTimestamp(record.data_loaded_at);
  if (publishedAt) mapped.publishedAt = publishedAt;
  return mapped;
}

/** Fold another unit's row into the call's observation. */
export function mergeUnitRow(existing: Observation, incoming: Observation): Observation {
  const units = [...new Set([...(existing.units ?? []), ...(incoming.units ?? [])])].sort();

  const existingTimestamps = (existing.metadata?.unit_timestamps ?? {}) as Record<string, unknown>;
  const incomingTimestamps = (incoming.metadata?.unit_timestamps ?? {}) as Record<string, unknown>;

  const merged: Observation = {
    ...existing,
    // The earliest received time is the call's; a later unit row does not move it.
    occurredAt: existing.occurredAt <= incoming.occurredAt ? existing.occurredAt : incoming.occurredAt,
    ingestedAt: incoming.ingestedAt,
    metadata: {
      ...existing.metadata,
      ...incoming.metadata,
      unit_timestamps: { ...existingTimestamps, ...incomingTimestamps },
      unit_count: units.length,
    },
  };
  if (units.length > 0) merged.units = units;
  // A location or type on any row of the call is a location or type for the call.
  if (!merged.location && incoming.location) merged.location = incoming.location;
  if (!merged.rawType && incoming.rawType) merged.rawType = incoming.rawType;
  return merged;
}

function adapterFor(source: typeof FIRE_SOURCE | typeof EMS_SOURCE): SourceAdapter<SffdCallRecord> {
  return {
    source,
    datasetId: SFFD_DATASET_ID,
    cursorField: SFFD_CURSOR_FIELD,
    idField: SFFD_ID_FIELD,
    // docs/01: this feed runs ~19 h behind, so it must not be held to the police
    // threshold — it would be permanently "stale" and the alert would mean nothing.
    silenceThresholdSeconds: 36 * 3600,
    accepts: (record) => sourceFor(record) === source,
    map: (record, ingestedAt) => mapRecord(record, ingestedAt, source),
    merge: mergeUnitRow,
  };
}

export const fireAdapter: SourceAdapter<SffdCallRecord> = adapterFor(FIRE_SOURCE);
export const emsAdapter: SourceAdapter<SffdCallRecord> = adapterFor(EMS_SOURCE);
