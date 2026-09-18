import type { Incident, Observation, TimelineEvent } from "../src/index.ts";

/**
 * Like `Partial<T>`, but an explicit `undefined` is allowed — `exactOptionalPropertyTypes`
 * forbids that on `Partial<T>`, and tests want to say "this field is absent".
 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

export function anObservation(overrides: Overrides<Observation> = {}): Observation {
  // The cast is the price of letting a test say `{ location: undefined }`; every value
  // that survives is still type-checked against Observation by the spread source.
  return {
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "260918001",
    agency: "SFPD",
    occurredAt: new Date("2026-09-18T01:02:03.000Z"),
    ingestedAt: new Date("2026-09-18T01:39:00.000Z"),
    type: "collision",
    subtype: "vehicle vs pedestrian",
    rawType: "22500E",
    priority: "B",
    location: {
      raw: "MARKET ST/06TH ST",
      normalized: "Market St & 6th St",
      displayName: "Market St & 6th St",
      intersection: "Market St & 6th St",
      latitude: 37.7817,
      longitude: -122.4103,
      neighborhood: "Tenderloin",
    },
    units: ["3A12", "E01"],
    text: "RP reports vehicle vs pedestrian",
    metadata: { sensitive_call: false, cad_number: "260918001" },
    confidence: 0.8,
    visibility: "public",
    sensitive: false,
    ...overrides,
  } as Observation;
}

export function aTimelineEvent(overrides: Overrides<TimelineEvent> = {}): TimelineEvent {
  return {
    id: "tl_1",
    incidentId: "inc_1",
    occurredAt: new Date("2026-09-18T01:02:03.000Z"),
    recordedAt: new Date("2026-09-18T01:39:00.000Z"),
    kind: "initial_report",
    text: "Initial police dispatch record received",
    observationId: "obs_1",
    ...overrides,
  } as TimelineEvent;
}

export function anIncident(overrides: Overrides<Incident> = {}): Incident {
  return {
    id: "inc_1",
    primaryType: "collision",
    title: "Collision at Market St & 6th St",
    agencyTypes: ["police", "fire"],
    priority: "B",
    severity: "moderate",
    status: "active",
    location: {
      displayName: "Market St & 6th St",
      intersection: "Market St & 6th St",
      latitude: 37.7817,
      longitude: -122.4103,
      neighborhood: "Tenderloin",
    },
    firstObservedAt: new Date("2026-09-18T01:02:03.000Z"),
    lastUpdatedAt: new Date("2026-09-18T01:14:00.000Z"),
    units: ["3A12", "E01"],
    observationIds: ["obs_1", "obs_2"],
    timeline: [aTimelineEvent()],
    summary: "Two units responding to a collision in the Tenderloin.",
    confidence: 0.72,
    verification: {
      sourceCount: 2,
      independentSourceCount: 2,
      classification: "official-response-confirmed",
    },
    confidences: { location: 0.9, type: 0.7, correlation: 0.6, status: 0.8 },
    visibility: "public",
    publishedAt: new Date("2026-09-18T01:05:03.000Z"),
    ...overrides,
  } as Incident;
}
