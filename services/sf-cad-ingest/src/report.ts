/**
 * SFPD Police Department Incident Reports (`wg3w-h783`) → Observation (S-I2).
 *
 * This is the only source that says how a call was *written up* rather than how it was
 * dispatched, and it is the only one that carries an outcome in the city's own words:
 * `resolution` is `Open or Active` (78%), `Cite or Arrest Adult` (21%), `Unfounded` or
 * `Exceptional Adult`.
 *
 * Three properties of this feed shape the file:
 *
 * 1. **It lags.** Median 2.0 days, p90 3.8 (docs/01 §1). An hourly poll is generous; the
 *    report for a call is never going to arrive while someone is looking at it live.
 * 2. **It is one-to-many.** 2,000 report rows carried 1,169 distinct `cad_number`s — 1.71
 *    rows per call, because one call yields several offence rows. Each row is its own
 *    observation, keyed on `row_id`; they all join to the same incident.
 * 3. **~11% have no `cad_number`** — online-filed (Coplogic) reports and supplements.
 *    Those are stored and counted, never fuzzy-matched onto an incident. A guess here
 *    would attach a stranger's report to somebody else's event.
 *
 * ## The allowlist is the point
 *
 * PRD §5 forbids person-level data, and S-I2 makes that a hard constraint rather than a
 * default. So this adapter does not copy fields it does not recognise: `KEPT_FIELDS` is an
 * explicit list, anything else is dropped and counted. SFPD does not publish names or
 * suspect descriptions on this dataset today — the point is that if it ever starts, the
 * default is to drop, and the counter says it happened.
 */

import type { Observation } from "@scantron/incident-schema";
import { parseSfTimestamp } from "@scantron/sf-domain";

import { MalformedRecordError, type MappedRecord, type SourceAdapter } from "./adapter.ts";

export const SFPD_REPORT_SOURCE = "sf_police_report" as const;
export const SFPD_REPORT_DATASET_ID = "wg3w-h783";
export const SFPD_REPORT_CURSOR_FIELD = "data_loaded_at";

export interface SfpdReportRecord extends Record<string, unknown> {
  row_id?: string;
  incident_id?: string;
  incident_number?: string;
  cad_number?: string;
  incident_datetime?: string;
  report_datetime?: string;
  report_type_code?: string;
  report_type_description?: string;
  incident_code?: string;
  incident_category?: string;
  incident_subcategory?: string;
  incident_description?: string;
  resolution?: string;
  filed_online?: boolean | string;
  intersection?: string;
  cnn?: string;
  analysis_neighborhood?: string;
  police_district?: string;
  supervisor_district?: string;
  latitude?: string | number;
  longitude?: string | number;
  point?: { type?: string; coordinates?: number[] };
  data_as_of?: string;
  data_loaded_at?: string;
}

/**
 * Every field this adapter will copy. Enumerated over 800 live rows on 2026-09-21; the
 * dataset published exactly 28 distinct keys and all of them are here, which is what makes
 * the drop counter meaningful rather than noise.
 */
export const KEPT_FIELDS: ReadonlySet<string> = new Set([
  "row_id",
  "incident_id",
  "incident_number",
  "cad_number",
  "incident_datetime",
  "incident_date",
  "incident_time",
  "incident_year",
  "incident_day_of_week",
  "report_datetime",
  "report_type_code",
  "report_type_description",
  "incident_code",
  "incident_category",
  "incident_subcategory",
  "incident_description",
  "resolution",
  "filed_online",
  "intersection",
  "cnn",
  "analysis_neighborhood",
  "police_district",
  "supervisor_district",
  "supervisor_district_2012",
  "latitude",
  "longitude",
  "point",
  "data_as_of",
  "data_loaded_at",
]);

/** Fields seen and refused, by name, so the counter can be read rather than just counted. */
export const droppedFieldCounts = new Map<string, number>();

export function droppedFields(record: SfpdReportRecord): string[] {
  return Object.keys(record).filter((key) => !KEPT_FIELDS.has(key));
}

/**
 * SFPD's own categories → our taxonomy (PRD §10).
 *
 * Only the categories that actually appear are mapped; anything else is `unknown` and
 * surfaces in the unmapped-codes list on `/internal`, which is how the mapping grows.
 */
const CATEGORY_TYPES: Readonly<Record<string, string>> = {
  // Property — 44% of all reports, and `larceny theft` alone is 29%.
  "larceny theft": "theft",
  burglary: "burglary",
  "motor vehicle theft": "theft",
  "motor vehicle theft?": "theft", // SFPD publishes both spellings
  "recovered vehicle": "theft",
  "stolen property": "theft",
  "vehicle impounded": "theft",
  "vehicle misplaced": "theft",
  robbery: "robbery",
  fraud: "theft",
  embezzlement: "theft",
  "forgery and counterfeiting": "theft",

  // Against a person.
  assault: "assault",
  homicide: "assault",
  rape: "assault",
  "sex offense": "assault",
  "human trafficking (a), commercial sex acts": "assault",
  "human trafficking (b), involuntary servitude": "assault",
  "human trafficking, commercial sex acts": "assault",
  "offences against the family and children": "assault",

  // Disturbance and disorder.
  "malicious mischief": "disturbance", // SFPD's name for vandalism, 6.8%
  vandalism: "disturbance",
  "disorderly conduct": "disturbance",
  "suspicious occ": "disturbance",
  suspicious: "disturbance",
  "liquor laws": "disturbance",
  gambling: "disturbance",
  "civil sidewalks": "disturbance",

  weapon: "weapon",
  "weapons offense": "weapon",
  "weapons offence": "weapon",
  "weapons carrying etc": "weapon",

  arson: "fire",
  "fire report": "fire",
  "traffic collision": "collision",
  "traffic violation arrest": "traffic",
  "missing person": "missing_person",
  suicide: "medical",

  // Police process rather than an event in the street.
  warrant: "police_activity",
  "drug offense": "police_activity",
  "drug violation": "police_activity",
  "miscellaneous investigation": "police_activity",
  "courtesy report": "police_activity",
  "case closure": "police_activity",

  "lost property": "public_safety",
  "non-criminal": "public_safety",

  // Deliberately unmapped: `Prostitution` (1,125 reports) and the trafficking categories.
  // Every product type broad enough to hold them — `disturbance`, `public_safety` — puts
  // them in a breakdown beside vandalism and lost property, which is a worse answer than
  // no type at all. They stay findable by their own words and the agency's own codes
  // through search (docs/06), which is where a question about them actually goes.
};

export function typeForCategory(category: string | undefined): string | undefined {
  if (!category) return undefined;
  return CATEGORY_TYPES[category.trim().toLowerCase()];
}

function coordinate(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapSfpdReportRecord(record: SfpdReportRecord, ingestedAt: Date): MappedRecord {
  for (const field of droppedFields(record)) {
    droppedFieldCounts.set(field, (droppedFieldCounts.get(field) ?? 0) + 1);
  }

  // `row_id` is the offence row, not the call: one call has several. Keying on it is what
  // keeps all of them, and keying the *join* on `cad_number` is what folds them together.
  const sourceRecordId = record.row_id?.trim();
  if (!sourceRecordId) {
    throw new MalformedRecordError("report has no row_id", record.incident_id);
  }

  const occurredAt = parseSfTimestamp(record.incident_datetime);
  if (!occurredAt) {
    throw new MalformedRecordError("incident_datetime missing or unparseable", sourceRecordId);
  }

  const observation: Observation = {
    id: `obs_${SFPD_REPORT_SOURCE}_${sourceRecordId}`,
    source: SFPD_REPORT_SOURCE,
    sourceRecordId,
    occurredAt,
    ingestedAt,
    // A report is the agency's own written record of a call it dispatched. It is not a
    // guess, so it is not scored — but it is not an independent witness either (S-I2).
    confidence: 1,
  };

  observation.agency = "SFPD";
  if (record.incident_code) observation.rawType = record.incident_code;
  if (record.incident_description) observation.subtype = record.incident_description;
  const type = typeForCategory(record.incident_category);
  if (type !== undefined) observation.type = type as NonNullable<Observation["type"]>;

  const location: NonNullable<Observation["location"]> = {};
  if (record.intersection) {
    location.raw = record.intersection;
    location.intersection = record.intersection;
  }
  if (record.analysis_neighborhood) location.neighborhood = record.analysis_neighborhood;
  const lat = coordinate(record.latitude);
  const lng = coordinate(record.longitude);
  if (lat !== undefined && lng !== undefined) {
    location.latitude = lat;
    location.longitude = lng;
  }
  if (Object.keys(location).length > 0) observation.location = location;

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    cad_number: record.cad_number,
    incident_id: record.incident_id,
    incident_number: record.incident_number,
    incident_category: record.incident_category,
    incident_subcategory: record.incident_subcategory,
    incident_description: record.incident_description,
    incident_code: record.incident_code,
    resolution: record.resolution,
    report_type_description: record.report_type_description,
    report_datetime: record.report_datetime,
    filed_online: record.filed_online,
    police_district: record.police_district,
    supervisor_district: record.supervisor_district,
    data_as_of: record.data_as_of,
    data_loaded_at: record.data_loaded_at,
  })) {
    if (value !== undefined && value !== null && value !== "") metadata[key] = value;
  }
  observation.metadata = metadata;

  const mapped: MappedRecord = { observation, receivedAt: occurredAt };
  const publishedAt = parseSfTimestamp(record.data_loaded_at);
  if (publishedAt) mapped.publishedAt = publishedAt;
  return mapped;
}

export const reportAdapter: SourceAdapter<SfpdReportRecord> = {
  source: SFPD_REPORT_SOURCE,
  datasetId: SFPD_REPORT_DATASET_ID,
  cursorField: SFPD_REPORT_CURSOR_FIELD,
  idField: "row_id",
  // This feed lags days, so a quiet hour means nothing. Six hours of silence is the point
  // at which something is actually wrong.
  silenceThresholdSeconds: 6 * 60 * 60,
  map: mapSfpdReportRecord,
};
