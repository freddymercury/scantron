/**
 * SSE payloads (PRD §26/§52, S-E3). Every event carries the full public incident so a
 * client never has to refetch, and never carries anything `PublicIncident` would not.
 */

import { PublicIncidentSchema, type PublicIncident } from "./public.ts";
import { enumOf, objectOf, optional, string } from "./validator.ts";

export const INCIDENT_EVENT_TYPES = [
  "incident.created",
  "incident.updated",
  "incident.resolved",
  "incident.merged",
] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export interface IncidentEvent {
  /** SSE `id:` — also what `Last-Event-ID` replays from (S-E3). */
  id: string;
  type: IncidentEventType;
  at: string;
  incident: PublicIncident;
  /** On `incident.merged`: the incident that was absorbed and tombstoned (S-D9). */
  mergedFromId?: string;
}

export const IncidentEventSchema = objectOf(
  {
    id: string({ minLength: 1 }),
    type: enumOf(INCIDENT_EVENT_TYPES),
    at: string({ minLength: 1 }),
    incident: PublicIncidentSchema,
    mergedFromId: optional(string({ minLength: 1 })),
  },
  "IncidentEvent",
);
