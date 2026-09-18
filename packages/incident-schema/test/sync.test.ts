/**
 * The types and the validators are written by hand, side by side, so this file exists to
 * make drift a build failure rather than a surprise at runtime. It checks both directions:
 * assignability (types agree) and key sets (neither side has a field the other lacks).
 */

import { expect, test } from "bun:test";
import {
  ConfidenceBreakdownSchema,
  IncidentEventSchema,
  IncidentSchema,
  NormalizedLocationSchema,
  ObservationSchema,
  PublicIncidentSchema,
  TimelineEventSchema,
  VerificationSchema,
  type ConfidenceBreakdown,
  type Incident,
  type IncidentEvent,
  type Infer,
  type NormalizedLocation,
  type Observation,
  type PublicIncident,
  type TimelineEvent,
  type Verification,
} from "../src/index.ts";

// Compile-time: every schema type is mutually assignable with its declared interface.
// A missing field, an extra required field or a changed field type breaks `bun run typecheck`.
type MutuallyAssignable<A extends B, B extends C, C = A> = true;
const bothWays = <T extends true>(_assertion: T): void => {};

bothWays<MutuallyAssignable<Infer<typeof ObservationSchema>, Observation>>(true);
bothWays<MutuallyAssignable<Observation, Infer<typeof ObservationSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof IncidentSchema>, Incident>>(true);
bothWays<MutuallyAssignable<Incident, Infer<typeof IncidentSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof TimelineEventSchema>, TimelineEvent>>(true);
bothWays<MutuallyAssignable<TimelineEvent, Infer<typeof TimelineEventSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof NormalizedLocationSchema>, NormalizedLocation>>(true);
bothWays<MutuallyAssignable<NormalizedLocation, Infer<typeof NormalizedLocationSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof VerificationSchema>, Verification>>(true);
bothWays<MutuallyAssignable<Verification, Infer<typeof VerificationSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof ConfidenceBreakdownSchema>, ConfidenceBreakdown>>(true);
bothWays<MutuallyAssignable<ConfidenceBreakdown, Infer<typeof ConfidenceBreakdownSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof PublicIncidentSchema>, PublicIncident>>(true);
bothWays<MutuallyAssignable<PublicIncident, Infer<typeof PublicIncidentSchema>>>(true);
bothWays<MutuallyAssignable<Infer<typeof IncidentEventSchema>, IncidentEvent>>(true);
bothWays<MutuallyAssignable<IncidentEvent, Infer<typeof IncidentEventSchema>>>(true);

// Runtime: the declared key sets. These objects are typed as `Record<keyof T, true>`, so
// adding a field to an interface without adding it here is a compile error, and adding it
// to a schema without adding it to the interface fails the assertion below.
const OBSERVATION_KEYS: Record<keyof Observation, true> = {
  id: true,
  source: true,
  sourceRecordId: true,
  agency: true,
  occurredAt: true,
  ingestedAt: true,
  type: true,
  subtype: true,
  rawType: true,
  priority: true,
  location: true,
  units: true,
  text: true,
  audio: true,
  metadata: true,
  confidence: true,
  visibility: true,
  sensitive: true,
  locationMethod: true,
  locationConfidence: true,
  typeConfidence: true,
  severity: true,
  priorityRank: true,
  normalizedAt: true,
  backfilled: true,
};

const INCIDENT_KEYS: Record<keyof Incident, true> = {
  id: true,
  primaryType: true,
  title: true,
  agencyTypes: true,
  priority: true,
  severity: true,
  status: true,
  location: true,
  firstObservedAt: true,
  lastUpdatedAt: true,
  resolvedAt: true,
  units: true,
  observationIds: true,
  timeline: true,
  summary: true,
  confidence: true,
  verification: true,
  confidences: true,
  visibility: true,
  publishedAt: true,
  mergedIntoId: true,
};

const TIMELINE_EVENT_KEYS: Record<keyof TimelineEvent, true> = {
  id: true,
  incidentId: true,
  occurredAt: true,
  recordedAt: true,
  kind: true,
  text: true,
  observationId: true,
};

const PUBLIC_INCIDENT_KEYS: Record<keyof PublicIncident, true> = {
  id: true,
  primaryType: true,
  title: true,
  agencyTypes: true,
  priority: true,
  severity: true,
  status: true,
  location: true,
  firstObservedAt: true,
  lastUpdatedAt: true,
  resolvedAt: true,
  units: true,
  summary: true,
  timeline: true,
  verification: true,
};

/** Widened to `string[]` on both sides so the comparison is about names, not types. */
const keysOf = (source: { keys: readonly string[] } | object): string[] =>
  ("keys" in source ? [...(source.keys as readonly string[])] : Object.keys(source)).sort();

test("Observation schema and interface declare the same fields", () => {
  expect(keysOf(ObservationSchema)).toEqual(keysOf(OBSERVATION_KEYS));
});

test("Incident schema and interface declare the same fields", () => {
  expect(keysOf(IncidentSchema)).toEqual(keysOf(INCIDENT_KEYS));
});

test("TimelineEvent schema and interface declare the same fields", () => {
  expect(keysOf(TimelineEventSchema)).toEqual(keysOf(TIMELINE_EVENT_KEYS));
});

test("PublicIncident schema and interface declare the same fields", () => {
  expect(keysOf(PublicIncidentSchema)).toEqual(keysOf(PUBLIC_INCIDENT_KEYS));
});
