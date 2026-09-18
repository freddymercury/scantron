import { expect, test } from "bun:test";
import {
  incidentToRow,
  observationToRow,
  rowToIncident,
  rowToObservation,
  rowToTimelineEvent,
  timelineEventToRow,
} from "../src/index.ts";
import { anIncident, anObservation, aTimelineEvent } from "./fixtures.ts";

test("observation round-trips through its row", () => {
  const observation = anObservation();
  expect(rowToObservation(observationToRow(observation))).toEqual(observation);
});

test("a sparse observation round-trips without inventing fields", () => {
  const sparse = anObservation({
    sourceRecordId: undefined,
    agency: undefined,
    type: undefined,
    subtype: undefined,
    rawType: undefined,
    priority: undefined,
    location: undefined,
    units: undefined,
    text: undefined,
    metadata: undefined,
    visibility: undefined,
    sensitive: undefined,
  });
  const restored = rowToObservation(observationToRow(sparse));
  expect(restored).toEqual(sparse);
  expect(Object.keys(restored).sort()).toEqual([
    "confidence",
    "id",
    "ingestedAt",
    "occurredAt",
    "source",
  ]);
});

test("incident round-trips through its row plus its relations", () => {
  const incident = anIncident();
  const restored = rowToIncident(incidentToRow(incident), {
    timeline: incident.timeline,
    observationIds: incident.observationIds,
  });
  expect(restored).toEqual(incident);
});

test("an incident without a confidence breakdown round-trips as undefined", () => {
  const incident = anIncident({ confidences: undefined, publishedAt: undefined });
  const restored = rowToIncident(incidentToRow(incident), {
    timeline: incident.timeline,
    observationIds: incident.observationIds,
  });
  expect(restored.confidences).toBeUndefined();
  expect("confidences" in restored).toBe(false);
});

test("timeline event round-trips through its row", () => {
  const event = aTimelineEvent();
  expect(rowToTimelineEvent(timelineEventToRow(event))).toEqual(event);
});

test("rows carry ISO-8601 UTC strings, never Date objects", () => {
  const row = observationToRow(anObservation());
  expect(row.occurred_at).toBe("2026-09-18T01:02:03.000Z");
  expect(row.sensitive).toBe(0);
  expect(JSON.parse(row.units as string)).toEqual(["3A12", "E01"]);
});

test("row column names match what the correlation index expects", () => {
  const row = observationToRow(anObservation());
  // ADR-003: the covering index is (occurred_at, lat, lng), in that order.
  expect(Object.keys(row)).toContain("occurred_at");
  expect(Object.keys(row)).toContain("lat");
  expect(Object.keys(row)).toContain("lng");
});
