/**
 * Row ↔ domain mappers. These row shapes are the contract S-A2's tables implement:
 * flat columns, ISO-8601 UTC `TEXT` timestamps, JSON `TEXT` for the small arrays, `REAL`
 * lat/lng named `lat`/`lng` so the `(occurred_at, lat, lng)` covering index reads plainly
 * (ADR-003). Absent is `null` in a row and an omitted key in the domain object.
 */

import type {
  AgencyType,
  ConfidenceBreakdown,
  Incident,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  NormalizedLocation,
  LocationMethod,
  Observation,
  ObservationAudio,
  ObservationSource,
  TimelineEvent,
  TimelineEventKind,
  VerificationClassification,
  Visibility,
} from "./domain.ts";

export interface ObservationRow {
  id: string;
  source: string;
  source_record_id: string | null;
  agency: string | null;
  occurred_at: string;
  ingested_at: string;
  type: string | null;
  subtype: string | null;
  raw_type: string | null;
  priority: string | null;
  location_raw: string | null;
  location_normalized: string | null;
  location_display_name: string | null;
  address: string | null;
  intersection: string | null;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
  units: string | null;
  text: string | null;
  audio: string | null;
  metadata: string | null;
  confidence: number;
  visibility: string | null;
  sensitive: number | null;
  location_method: string | null;
  location_confidence: number | null;
  type_confidence: number | null;
  severity: string | null;
  priority_rank: number | null;
  normalized_at: string | null;
}

export interface IncidentRow {
  id: string;
  primary_type: string;
  title: string;
  agency_types: string;
  priority: string | null;
  severity: string | null;
  status: string;
  location_display_name: string | null;
  address: string | null;
  intersection: string | null;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
  first_observed_at: string;
  last_updated_at: string;
  resolved_at: string | null;
  units: string;
  summary: string | null;
  confidence: number;
  source_count: number;
  independent_source_count: number;
  verification_classification: string;
  confidence_location: number | null;
  confidence_type: number | null;
  confidence_correlation: number | null;
  confidence_status: number | null;
  visibility: string | null;
  published_at: string | null;
  merged_into_id: string | null;
}

export interface TimelineEventRow {
  id: string;
  incident_id: string;
  occurred_at: string;
  recorded_at: string;
  kind: string;
  text: string;
  observation_id: string;
}

// --- helpers ---------------------------------------------------------------

const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);
const iso = (date: Date | undefined): string | null => (date ? date.toISOString() : null);
const json = (value: unknown | undefined): string | null =>
  value === undefined ? null : JSON.stringify(value);

function set<T, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined): void {
  if (value !== null && value !== undefined) target[key] = value;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  return JSON.parse(raw) as T;
}

// --- observation -----------------------------------------------------------

export function observationToRow(observation: Observation): ObservationRow {
  const location = observation.location ?? {};
  return {
    id: observation.id,
    source: observation.source,
    source_record_id: orNull(observation.sourceRecordId),
    agency: orNull(observation.agency),
    occurred_at: observation.occurredAt.toISOString(),
    ingested_at: observation.ingestedAt.toISOString(),
    type: orNull(observation.type),
    subtype: orNull(observation.subtype),
    raw_type: orNull(observation.rawType),
    priority: orNull(observation.priority),
    location_raw: orNull(location.raw),
    location_normalized: orNull(location.normalized),
    location_display_name: orNull(location.displayName),
    address: orNull(location.address),
    intersection: orNull(location.intersection),
    lat: orNull(location.latitude),
    lng: orNull(location.longitude),
    neighborhood: orNull(location.neighborhood),
    units: json(observation.units),
    text: orNull(observation.text),
    audio: json(observation.audio),
    metadata: json(observation.metadata),
    confidence: observation.confidence,
    visibility: orNull(observation.visibility),
    sensitive: observation.sensitive === undefined ? null : observation.sensitive ? 1 : 0,
    location_method: orNull(observation.locationMethod),
    location_confidence: orNull(observation.locationConfidence),
    type_confidence: orNull(observation.typeConfidence),
    severity: orNull(observation.severity),
    priority_rank: orNull(observation.priorityRank),
    normalized_at: iso(observation.normalizedAt),
  };
}

function locationFromRow(row: {
  location_raw?: string | null;
  location_normalized?: string | null;
  location_display_name: string | null;
  address: string | null;
  intersection: string | null;
  lat: number | null;
  lng: number | null;
  neighborhood: string | null;
}): NormalizedLocation {
  const location: NormalizedLocation = {};
  set(location, "raw", row.location_raw ?? null);
  set(location, "normalized", row.location_normalized ?? null);
  set(location, "displayName", row.location_display_name);
  set(location, "address", row.address);
  set(location, "intersection", row.intersection);
  set(location, "latitude", row.lat);
  set(location, "longitude", row.lng);
  set(location, "neighborhood", row.neighborhood);
  return location;
}

export function rowToObservation(row: ObservationRow): Observation {
  const observation: Observation = {
    id: row.id,
    source: row.source as ObservationSource,
    occurredAt: new Date(row.occurred_at),
    ingestedAt: new Date(row.ingested_at),
    confidence: row.confidence,
  };
  set(observation, "sourceRecordId", row.source_record_id);
  set(observation, "agency", row.agency);
  set(observation, "type", row.type as IncidentType | null);
  set(observation, "subtype", row.subtype);
  set(observation, "rawType", row.raw_type);
  set(observation, "priority", row.priority);
  set(observation, "text", row.text);
  set(observation, "visibility", row.visibility as Visibility | null);
  set(observation, "locationMethod", row.location_method as LocationMethod | null);
  set(observation, "locationConfidence", row.location_confidence);
  set(observation, "typeConfidence", row.type_confidence);
  set(observation, "severity", row.severity as IncidentSeverity | null);
  set(observation, "priorityRank", row.priority_rank);
  if (row.normalized_at !== null) observation.normalizedAt = new Date(row.normalized_at);
  if (row.sensitive !== null) observation.sensitive = row.sensitive === 1;
  if (row.units !== null) observation.units = parseJson<string[]>(row.units, []);
  if (row.audio !== null) observation.audio = parseJson<ObservationAudio>(row.audio, {});
  if (row.metadata !== null) {
    observation.metadata = parseJson<Record<string, unknown>>(row.metadata, {});
  }

  const location = locationFromRow(row);
  if (Object.keys(location).length > 0) observation.location = location;
  return observation;
}

// --- incident --------------------------------------------------------------

export function incidentToRow(incident: Incident): IncidentRow {
  const breakdown = incident.confidences;
  return {
    id: incident.id,
    primary_type: incident.primaryType,
    title: incident.title,
    agency_types: JSON.stringify(incident.agencyTypes),
    priority: orNull(incident.priority),
    severity: orNull(incident.severity),
    status: incident.status,
    location_display_name: orNull(incident.location.displayName),
    address: orNull(incident.location.address),
    intersection: orNull(incident.location.intersection),
    lat: orNull(incident.location.latitude),
    lng: orNull(incident.location.longitude),
    neighborhood: orNull(incident.location.neighborhood),
    first_observed_at: incident.firstObservedAt.toISOString(),
    last_updated_at: incident.lastUpdatedAt.toISOString(),
    resolved_at: iso(incident.resolvedAt),
    units: JSON.stringify(incident.units),
    summary: orNull(incident.summary),
    confidence: incident.confidence,
    source_count: incident.verification.sourceCount,
    independent_source_count: incident.verification.independentSourceCount,
    verification_classification: incident.verification.classification,
    confidence_location: breakdown ? breakdown.location : null,
    confidence_type: breakdown ? breakdown.type : null,
    confidence_correlation: breakdown ? breakdown.correlation : null,
    confidence_status: breakdown ? breakdown.status : null,
    visibility: orNull(incident.visibility),
    published_at: iso(incident.publishedAt),
    merged_into_id: orNull(incident.mergedIntoId),
  };
}

export interface IncidentRelations {
  /** From `timeline_events`, already ordered (S-D5). */
  timeline?: TimelineEvent[];
  /** From `incident_observations`. */
  observationIds?: string[];
}

export function rowToIncident(row: IncidentRow, relations: IncidentRelations = {}): Incident {
  const incident: Incident = {
    id: row.id,
    primaryType: row.primary_type as IncidentType,
    title: row.title,
    agencyTypes: parseJson<AgencyType[]>(row.agency_types, []),
    status: row.status as IncidentStatus,
    location: locationFromRow(row),
    firstObservedAt: new Date(row.first_observed_at),
    lastUpdatedAt: new Date(row.last_updated_at),
    units: parseJson<string[]>(row.units, []),
    observationIds: relations.observationIds ?? [],
    timeline: relations.timeline ?? [],
    confidence: row.confidence,
    verification: {
      sourceCount: row.source_count,
      independentSourceCount: row.independent_source_count,
      classification: row.verification_classification as VerificationClassification,
    },
  };
  set(incident, "priority", row.priority);
  set(incident, "severity", row.severity as IncidentSeverity | null);
  set(incident, "summary", row.summary);
  set(incident, "visibility", row.visibility as Visibility | null);
  set(incident, "mergedIntoId", row.merged_into_id);
  if (row.resolved_at !== null) incident.resolvedAt = new Date(row.resolved_at);
  if (row.published_at !== null) incident.publishedAt = new Date(row.published_at);

  if (
    row.confidence_location !== null &&
    row.confidence_type !== null &&
    row.confidence_correlation !== null &&
    row.confidence_status !== null
  ) {
    const breakdown: ConfidenceBreakdown = {
      location: row.confidence_location,
      type: row.confidence_type,
      correlation: row.confidence_correlation,
      status: row.confidence_status,
    };
    incident.confidences = breakdown;
  }
  return incident;
}

// --- timeline --------------------------------------------------------------

export function timelineEventToRow(event: TimelineEvent): TimelineEventRow {
  return {
    id: event.id,
    incident_id: event.incidentId,
    occurred_at: event.occurredAt.toISOString(),
    recorded_at: event.recordedAt.toISOString(),
    kind: event.kind,
    text: event.text,
    observation_id: event.observationId,
  };
}

export function rowToTimelineEvent(row: TimelineEventRow): TimelineEvent {
  return {
    id: row.id,
    incidentId: row.incident_id,
    occurredAt: new Date(row.occurred_at),
    recordedAt: new Date(row.recorded_at),
    kind: row.kind as TimelineEventKind,
    text: row.text,
    observationId: row.observation_id,
  };
}
