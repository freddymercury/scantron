/**
 * `PublicIncident` — exactly what the API may return, built by explicit field allowlist.
 *
 * The projection below names every field that may leave the building. Adding a field to
 * `Incident` therefore cannot widen the public surface: it has to be named here too, in a
 * diff a reviewer sees. Deliberately absent: source free-text, `confidence` and the
 * per-dimension breakdown (S-D6), `visibility`, `sensitive`, correlation debug and
 * observation ids (S-E1, S-E2 exposes sources through their own endpoint).
 */

import type { Incident, TimelineEvent } from "./domain.ts";
import {
  AGENCY_TYPES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  TIMELINE_EVENT_KINDS,
  VERIFICATION_CLASSIFICATIONS,
} from "./domain.ts";
import {
  arrayOf,
  enumOf,
  latitude,
  longitude,
  number,
  objectOf,
  optional,
  string,
} from "./validator.ts";

export interface PublicLocation {
  displayName?: string;
  address?: string;
  intersection?: string;
  neighborhood?: string;
  latitude?: number;
  longitude?: number;
}

export interface PublicTimelineEvent {
  occurredAt: string;
  kind: (typeof TIMELINE_EVENT_KINDS)[number];
  text: string;
}

export interface PublicIncident {
  id: string;
  primaryType: (typeof INCIDENT_TYPES)[number];
  title: string;
  agencyTypes: (typeof AGENCY_TYPES)[number][];
  priority?: string;
  severity?: (typeof INCIDENT_SEVERITIES)[number];
  status: (typeof INCIDENT_STATUSES)[number];
  location: PublicLocation;
  /** ISO-8601 UTC strings: this is a JSON payload, not a domain object. */
  firstObservedAt: string;
  lastUpdatedAt: string;
  resolvedAt?: string;
  units: string[];
  summary?: string;
  timeline: PublicTimelineEvent[];
  verification: {
    sourceCount: number;
    independentSourceCount: number;
    classification: (typeof VERIFICATION_CLASSIFICATIONS)[number];
  };
}

export const PublicLocationSchema = objectOf(
  {
    displayName: optional(string({ maxLength: 500 })),
    address: optional(string({ maxLength: 500 })),
    intersection: optional(string({ maxLength: 500 })),
    neighborhood: optional(string({ maxLength: 120 })),
    latitude: optional(latitude()),
    longitude: optional(longitude()),
  },
  "PublicLocation",
);

export const PublicTimelineEventSchema = objectOf(
  {
    occurredAt: string({ minLength: 1 }),
    kind: enumOf(TIMELINE_EVENT_KINDS),
    text: string({ minLength: 1, maxLength: 500 }),
  },
  "PublicTimelineEvent",
);

export const PublicVerificationSchema = objectOf(
  {
    sourceCount: number({ integer: true, min: 0 }),
    independentSourceCount: number({ integer: true, min: 0 }),
    classification: enumOf(VERIFICATION_CLASSIFICATIONS),
  },
  "PublicVerification",
);

export const PublicIncidentSchema = objectOf(
  {
    id: string({ minLength: 1 }),
    primaryType: enumOf(INCIDENT_TYPES),
    title: string({ minLength: 1, maxLength: 200 }),
    agencyTypes: arrayOf(enumOf(AGENCY_TYPES)),
    priority: optional(string({ maxLength: 40 })),
    severity: optional(enumOf(INCIDENT_SEVERITIES)),
    status: enumOf(INCIDENT_STATUSES),
    location: PublicLocationSchema,
    firstObservedAt: string({ minLength: 1 }),
    lastUpdatedAt: string({ minLength: 1 }),
    resolvedAt: optional(string({ minLength: 1 })),
    units: arrayOf(string({ minLength: 1, maxLength: 40 })),
    summary: optional(string({ maxLength: 1000 })),
    timeline: arrayOf(PublicTimelineEventSchema),
    verification: PublicVerificationSchema,
  },
  "PublicIncident",
);

/** The public location allowlist. */
function publicLocation(location: Incident["location"]): PublicLocation {
  const out: PublicLocation = {};
  if (location.displayName !== undefined) out.displayName = location.displayName;
  if (location.address !== undefined) out.address = location.address;
  if (location.intersection !== undefined) out.intersection = location.intersection;
  if (location.neighborhood !== undefined) out.neighborhood = location.neighborhood;
  if (location.latitude !== undefined) out.latitude = location.latitude;
  if (location.longitude !== undefined) out.longitude = location.longitude;
  return out;
}

function publicTimelineEvent(event: TimelineEvent): PublicTimelineEvent {
  return {
    occurredAt: event.occurredAt.toISOString(),
    kind: event.kind,
    text: event.text,
  };
}

/**
 * Project an internal incident to its public form. Field-by-field and on purpose: a
 * spread would make every future internal field public by default.
 */
export function toPublicIncident(incident: Incident): PublicIncident {
  const out: PublicIncident = {
    id: incident.id,
    primaryType: incident.primaryType,
    title: incident.title,
    agencyTypes: [...incident.agencyTypes],
    status: incident.status,
    location: publicLocation(incident.location),
    firstObservedAt: incident.firstObservedAt.toISOString(),
    lastUpdatedAt: incident.lastUpdatedAt.toISOString(),
    units: [...incident.units],
    timeline: incident.timeline.map(publicTimelineEvent),
    verification: {
      sourceCount: incident.verification.sourceCount,
      independentSourceCount: incident.verification.independentSourceCount,
      classification: incident.verification.classification,
    },
  };
  if (incident.priority !== undefined) out.priority = incident.priority;
  if (incident.severity !== undefined) out.severity = incident.severity;
  if (incident.resolvedAt !== undefined) out.resolvedAt = incident.resolvedAt.toISOString();
  if (incident.summary !== undefined) out.summary = incident.summary;
  return out;
}
