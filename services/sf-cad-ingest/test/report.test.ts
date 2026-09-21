/**
 * SFPD incident reports (S-I2). The two properties under test are the ones that make this
 * source safe to ingest at all: the field allowlist, and the refusal to guess a join.
 */

import { expect, test } from "bun:test";

import { MalformedRecordError } from "../src/adapter.ts";
import {
  droppedFields,
  KEPT_FIELDS,
  mapSfpdReportRecord,
  reportAdapter,
  typeForCategory,
  type SfpdReportRecord,
} from "../src/report.ts";

const INGESTED_AT = new Date("2026-09-21T18:00:00.000Z");

const record = (
  overrides: Partial<Record<keyof SfpdReportRecord, unknown>> = {},
): SfpdReportRecord => ({
  row_id: "160098504014",
  incident_id: "1600985",
  incident_number: "260552182",
  cad_number: "262633905",
  incident_datetime: "2026-09-20T23:55:00.000",
  report_datetime: "2026-09-21T00:03:00.000",
  report_type_description: "Initial",
  incident_code: "04014",
  incident_category: "Assault",
  incident_subcategory: "Aggravated Assault",
  incident_description: "Assault, Aggravated, W/ Force",
  resolution: "Open or Active",
  intersection: "16TH ST \\ WIESE ST",
  analysis_neighborhood: "Mission",
  police_district: "Mission",
  latitude: "37.7650032043457",
  longitude: "-122.42047882080078",
  data_loaded_at: "2026-09-21T10:13:25.000",
  ...overrides,
});

test("a report maps to an observation with the outcome the city stated", () => {
  const { observation } = mapSfpdReportRecord(record(), INGESTED_AT);

  expect(observation.source).toBe("sf_police_report");
  expect(observation.id).toBe("obs_sf_police_report_160098504014");
  // Naive SF-local, like every timestamp in these feeds: 23:55 local is 06:55Z next day.
  expect(observation.occurredAt.toISOString()).toBe("2026-09-21T06:55:00.000Z");
  expect(observation.type).toBe("assault");
  expect(observation.metadata?.["resolution"]).toBe("Open or Active");
  expect(observation.metadata?.["cad_number"]).toBe("262633905");
  // A report is the agency's own record of its own call, so it is not a guess.
  expect(observation.confidence).toBe(1);
});

test("fields outside the allowlist are dropped, not copied", () => {
  const withPeople = record({ suspect_name: "REDACTED", victim_dob: "1990-01-01" });

  expect(droppedFields(withPeople).sort()).toEqual(["suspect_name", "victim_dob"]);

  const { observation } = mapSfpdReportRecord(withPeople, INGESTED_AT);
  const serialized = JSON.stringify(observation);
  expect(serialized).not.toContain("suspect_name");
  expect(serialized).not.toContain("REDACTED");
  expect(serialized).not.toContain("victim_dob");
});

test("the allowlist covers the dataset as published", () => {
  // Every key the feed emitted across 800 live rows on 2026-09-21. A new one appearing is
  // meant to fail here rather than silently ride along into storage.
  for (const field of [
    "row_id", "incident_datetime", "incident_date", "incident_time", "incident_year",
    "incident_day_of_week", "report_datetime", "incident_id", "incident_number",
    "report_type_code", "report_type_description", "incident_code", "incident_description",
    "resolution", "police_district", "data_as_of", "data_loaded_at", "incident_category",
    "incident_subcategory", "intersection", "cnn", "analysis_neighborhood",
    "supervisor_district", "supervisor_district_2012", "latitude", "longitude", "point",
    "cad_number", "filed_online",
  ]) {
    expect(KEPT_FIELDS.has(field)).toBe(true);
  }
});

test("a report with no cad_number still maps — it is stored, just never joined", () => {
  const online = record({ cad_number: undefined, filed_online: true });
  const { observation } = mapSfpdReportRecord(online, INGESTED_AT);
  expect(observation.metadata?.["cad_number"]).toBeUndefined();
  expect(observation.metadata?.["filed_online"]).toBe(true);
});

test("a row with no row_id or no datetime is quarantined, not written", () => {
  expect(() => mapSfpdReportRecord(record({ row_id: undefined }), INGESTED_AT)).toThrow(
    MalformedRecordError,
  );
  expect(() => mapSfpdReportRecord(record({ incident_datetime: "" }), INGESTED_AT)).toThrow(
    MalformedRecordError,
  );
});

test("SFPD's categories map onto the product taxonomy", () => {
  expect(typeForCategory("Larceny Theft")).toBe("theft");
  expect(typeForCategory("Malicious Mischief")).toBe("disturbance");
  expect(typeForCategory("Motor Vehicle Theft?")).toBe("theft");
  expect(typeForCategory("Traffic Collision")).toBe("collision");
  expect(typeForCategory("Weapons Offence")).toBe("weapon");
  // Unmapped is undefined, not a wrong guess — it surfaces in /internal's unmapped list.
  expect(typeForCategory("Other Miscellaneous")).toBeUndefined();
  expect(typeForCategory(undefined)).toBeUndefined();
});

test("the adapter polls slowly, because the feed lags days", () => {
  expect(reportAdapter.datasetId).toBe("wg3w-h783");
  expect(reportAdapter.cursorField).toBe("data_loaded_at");
  expect(reportAdapter.silenceThresholdSeconds).toBeGreaterThanOrEqual(6 * 60 * 60);
});
