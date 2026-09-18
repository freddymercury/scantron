/**
 * The canonical shapes. PRD §8 (Observation), §9 (Incident), §10 (types), §20 (timeline),
 * §23 (verification), plus the internal fields S-E1 and S-D6 need.
 *
 * Types are declared here by hand and the schema below it; `test/sync.test.ts` asserts the
 * two are structurally identical at compile time, so they cannot drift.
 */

import {
  arrayOf,
  boolean,
  confidence,
  enumOf,
  latitude,
  longitude,
  number,
  objectOf,
  optional,
  recordOf,
  string,
  timestamp,
  unknown,
} from "./validator.ts";

// --- enumerations ----------------------------------------------------------

/** PRD §10, deliberately broad. Raw agency codes stay on the observation. */
export const INCIDENT_TYPES = [
  "fire",
  "medical",
  "collision",
  "assault",
  "weapon",
  "robbery",
  "burglary",
  "theft",
  "disturbance",
  "missing_person",
  "hazard",
  "rescue",
  "traffic",
  "public_safety",
  "police_activity",
  "unknown",
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

/** Human labels for the same list; the UI never invents its own. */
export const INCIDENT_TYPE_LABELS: Readonly<Record<IncidentType, string>> = {
  fire: "Fire",
  medical: "Medical",
  collision: "Collision",
  assault: "Assault",
  weapon: "Weapon",
  robbery: "Robbery",
  burglary: "Burglary",
  theft: "Theft",
  disturbance: "Disturbance",
  missing_person: "Missing Person",
  hazard: "Hazard",
  rescue: "Rescue",
  traffic: "Traffic",
  public_safety: "Public Safety",
  police_activity: "Police Activity",
  unknown: "Unknown",
};

export const INCIDENT_STATUSES = [
  "reported",
  "dispatched",
  "active",
  "contained",
  "resolved",
  "unknown",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

/** PRD §9 names IncidentSeverity without enumerating it; this is the enumeration. */
export const INCIDENT_SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** PRD §23. A statement about response activity, never about the truth of an allegation. */
export const VERIFICATION_CLASSIFICATIONS = [
  "reported",
  "multi-source",
  "official-response-confirmed",
] as const;
export type VerificationClassification = (typeof VERIFICATION_CLASSIFICATIONS)[number];

export const OBSERVATION_SOURCES = [
  "sf_police_cad",
  "sf_fire_cad",
  "sf_ems_cad",
  "radio",
  "other",
] as const;
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number];

export const AGENCY_TYPES = ["police", "fire", "ems", "other"] as const;
export type AgencyType = (typeof AGENCY_TYPES)[number];

/** S-E1 / PRD §30. Internal: never appears in a public payload. */
export const VISIBILITIES = ["public", "delayed", "restricted", "discard"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** How a location was resolved (S-C2). Persisted so the viewer can explain a point. */
export const LOCATION_METHODS = [
  "source_coordinates",
  "intersection_lookup",
  "block_interpolation",
  "unresolved",
] as const;
export type LocationMethod = (typeof LOCATION_METHODS)[number];

/** S-D5 event kinds. Timeline text is templated from these, never free-text. */
export const TIMELINE_EVENT_KINDS = [
  "initial_report",
  "unit_dispatched",
  "additional_unit",
  "agency_joined",
  "type_changed",
  "escalation",
  "status_changed",
  "closed",
  "correction",
] as const;
export type TimelineEventKind = (typeof TIMELINE_EVENT_KINDS)[number];

// --- interfaces ------------------------------------------------------------

export interface NormalizedLocation {
  raw?: string;
  normalized?: string;
  displayName?: string;
  address?: string;
  intersection?: string;
  latitude?: number;
  longitude?: number;
  neighborhood?: string;
}

/**
 * An incident's location is *derived*, so it deliberately has no `raw` or `normalized`
 * source text: correlation writes a display form, not the caller's words. One less place
 * free-text could reach a public payload.
 */
export interface IncidentLocation {
  displayName?: string;
  address?: string;
  intersection?: string;
  latitude?: number;
  longitude?: number;
  neighborhood?: string;
}

export interface ObservationAudio {
  url?: string;
  duration?: number;
  talkgroup?: string;
  frequency?: number;
}

export interface Observation {
  id: string;
  source: ObservationSource;
  sourceRecordId?: string;
  agency?: string;
  occurredAt: Date;
  ingestedAt: Date;
  /** Normalized product type (S-C3). */
  type?: IncidentType;
  subtype?: string;
  /** The agency's own code, kept verbatim (PRD §10). */
  rawType?: string;
  priority?: string;
  location?: NormalizedLocation;
  units?: string[];
  /** Source free-text. Internal — S-E1 forbids publishing it. */
  text?: string;
  audio?: ObservationAudio;
  metadata?: Record<string, unknown>;
  confidence: number;
  /** Internal, assigned at normalization (S-E1). */
  visibility?: Visibility;
  /** SFPD's own `sensitive_call` flag, treated as authoritative (S-E1). */
  sensitive?: boolean;
  /** Confidence in `type`, from the taxonomy mapping that produced it (S-C3). */
  typeConfidence?: number;
  /** Severity hint from the taxonomy, not a judgement of this particular call. */
  severity?: IncidentSeverity;
  /** Agency priority on the shared 1 (most urgent) – 5 scale (S-C3). */
  priorityRank?: number;
  /** When normalization last ran, so a taxonomy change can find stale rows. */
  normalizedAt?: Date;
  /** Refilled from the historical dataset (S-B5), so latency metrics can exclude it. */
  backfilled?: boolean;
  /** How `location.latitude`/`longitude` were arrived at (S-C2). */
  locationMethod?: LocationMethod;
  /** Confidence in the resolved point, separate from the observation's own confidence. */
  locationConfidence?: number;
}

export interface TimelineEvent {
  id: string;
  incidentId: string;
  occurredAt: Date;
  /** Ingest order, used only to break ties on equal `occurredAt` (S-D5). */
  recordedAt: Date;
  kind: TimelineEventKind;
  /** Rendered from templates over structured fields — never source free-text. */
  text: string;
  /** PRD §32: every entry keeps its source reference. */
  observationId: string;
}

export interface Verification {
  sourceCount: number;
  independentSourceCount: number;
  classification: VerificationClassification;
}

/** Per-dimension confidences (S-D6). Internal: the UI gets the classification label only. */
export interface ConfidenceBreakdown {
  location: number;
  type: number;
  correlation: number;
  status: number;
}

export interface Incident {
  id: string;
  primaryType: IncidentType;
  title: string;
  agencyTypes: AgencyType[];
  priority?: string;
  severity?: IncidentSeverity;
  status: IncidentStatus;
  location: IncidentLocation;
  firstObservedAt: Date;
  lastUpdatedAt: Date;
  resolvedAt?: Date;
  units: string[];
  observationIds: string[];
  timeline: TimelineEvent[];
  summary?: string;
  confidence: number;
  verification: Verification;
  /** Internal from here down — excluded from PublicIncident by construction. */
  confidences?: ConfidenceBreakdown;
  visibility?: Visibility;
  publishedAt?: Date;
  /** Set when this incident was merged into another (S-D9 tombstone). */
  mergedIntoId?: string;
}

// --- schemas ---------------------------------------------------------------

export const NormalizedLocationSchema = objectOf(
  {
    raw: optional(string({ maxLength: 500 })),
    normalized: optional(string({ maxLength: 500 })),
    displayName: optional(string({ maxLength: 500 })),
    address: optional(string({ maxLength: 500 })),
    intersection: optional(string({ maxLength: 500 })),
    latitude: optional(latitude()),
    longitude: optional(longitude()),
    neighborhood: optional(string({ maxLength: 120 })),
  },
  "NormalizedLocation",
);

export const IncidentLocationSchema = objectOf(
  {
    displayName: optional(string({ maxLength: 500 })),
    address: optional(string({ maxLength: 500 })),
    intersection: optional(string({ maxLength: 500 })),
    latitude: optional(latitude()),
    longitude: optional(longitude()),
    neighborhood: optional(string({ maxLength: 120 })),
  },
  "IncidentLocation",
);

export const ObservationAudioSchema = objectOf(
  {
    url: optional(string({ maxLength: 2000 })),
    duration: optional(number({ min: 0 })),
    talkgroup: optional(string({ maxLength: 120 })),
    frequency: optional(number({ min: 0 })),
  },
  "ObservationAudio",
);

export const ObservationSchema = objectOf(
  {
    id: string({ minLength: 1 }),
    source: enumOf(OBSERVATION_SOURCES),
    sourceRecordId: optional(string({ maxLength: 200 })),
    agency: optional(string({ maxLength: 120 })),
    occurredAt: timestamp(),
    ingestedAt: timestamp(),
    type: optional(enumOf(INCIDENT_TYPES)),
    subtype: optional(string({ maxLength: 120 })),
    rawType: optional(string({ maxLength: 120 })),
    priority: optional(string({ maxLength: 40 })),
    location: optional(NormalizedLocationSchema),
    units: optional(arrayOf(string({ minLength: 1, maxLength: 40 }))),
    text: optional(string({ maxLength: 10_000 })),
    audio: optional(ObservationAudioSchema),
    metadata: optional(recordOf(unknown())),
    confidence: confidence(),
    visibility: optional(enumOf(VISIBILITIES)),
    sensitive: optional(boolean()),
    typeConfidence: optional(confidence()),
    severity: optional(enumOf(INCIDENT_SEVERITIES)),
    priorityRank: optional(number({ integer: true, min: 1, max: 5 })),
    normalizedAt: optional(timestamp()),
    backfilled: optional(boolean()),
    locationMethod: optional(enumOf(LOCATION_METHODS)),
    locationConfidence: optional(confidence()),
  },
  "Observation",
);

export const TimelineEventSchema = objectOf(
  {
    id: string({ minLength: 1 }),
    incidentId: string({ minLength: 1 }),
    occurredAt: timestamp(),
    recordedAt: timestamp(),
    kind: enumOf(TIMELINE_EVENT_KINDS),
    text: string({ minLength: 1, maxLength: 500 }),
    observationId: string({ minLength: 1 }),
  },
  "TimelineEvent",
);

export const VerificationSchema = objectOf(
  {
    sourceCount: number({ integer: true, min: 0 }),
    independentSourceCount: number({ integer: true, min: 0 }),
    classification: enumOf(VERIFICATION_CLASSIFICATIONS),
  },
  "Verification",
);

export const ConfidenceBreakdownSchema = objectOf(
  {
    location: confidence(),
    type: confidence(),
    correlation: confidence(),
    status: confidence(),
  },
  "ConfidenceBreakdown",
);

export const IncidentSchema = objectOf(
  {
    id: string({ minLength: 1 }),
    primaryType: enumOf(INCIDENT_TYPES),
    title: string({ minLength: 1, maxLength: 200 }),
    agencyTypes: arrayOf(enumOf(AGENCY_TYPES)),
    priority: optional(string({ maxLength: 40 })),
    severity: optional(enumOf(INCIDENT_SEVERITIES)),
    status: enumOf(INCIDENT_STATUSES),
    location: IncidentLocationSchema,
    firstObservedAt: timestamp(),
    lastUpdatedAt: timestamp(),
    resolvedAt: optional(timestamp()),
    units: arrayOf(string({ minLength: 1, maxLength: 40 })),
    observationIds: arrayOf(string({ minLength: 1 })),
    timeline: arrayOf(TimelineEventSchema),
    summary: optional(string({ maxLength: 1000 })),
    confidence: confidence(),
    verification: VerificationSchema,
    confidences: optional(ConfidenceBreakdownSchema),
    visibility: optional(enumOf(VISIBILITIES)),
    publishedAt: optional(timestamp()),
    mergedIntoId: optional(string({ minLength: 1 })),
  },
  "Incident",
);
