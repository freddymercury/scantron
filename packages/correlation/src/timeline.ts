/**
 * Timeline construction (S-D5).
 *
 * Two rules shape this file and nothing else is allowed to bend them:
 *
 * 1. **Every line is rendered from structured fields through a template here.** No source
 *    free-text, no model output. The agency's call text never reaches a timeline entry, so
 *    a caller's words cannot be published by accident.
 * 2. **Entries are immutable and keyed by `(incident_id, observation_id, kind)`.** Writing
 *    is `INSERT … ON CONFLICT DO NOTHING`, never `UPDATE`, which makes re-processing an
 *    observation a no-op and makes a correction a *new* entry (S-D7).
 *
 * Ordering is by *source-reported* time, so a record that arrives late but happened early
 * lands in its true position — the insert order is only a tiebreak.
 */

import type { Database } from "bun:sqlite";
import {
  INCIDENT_TYPE_LABELS,
  type IncidentType,
  type TimelineEventKind,
} from "@scantron/incident-schema";

import type { CandidateObservation } from "./candidates.ts";
import type { StatusDecision } from "./lifecycle.ts";

/** The incident fields a timeline entry can talk about, before and after an observation. */
export interface IncidentSnapshot {
  primaryType: string;
  severity: string | null;
  status: string;
  units: string[];
  agencyTypes: string[];
}

/** An entry that has not been written yet: no id, no `recorded_at`. */
export interface TimelineDraft {
  kind: TimelineEventKind;
  /** ISO-8601 UTC, from the source's own clock. */
  occurredAt: string;
  text: string;
}

export interface TimelineRow {
  id: string;
  incidentId: string;
  occurredAt: string;
  recordedAt: string;
  kind: TimelineEventKind;
  text: string;
  observationId: string;
}

const AGENCY_LABELS: Readonly<Record<string, string>> = {
  police: "Police",
  fire: "Fire",
  ems: "EMS",
  other: "Another agency",
};

const SEVERITY_ORDER = ["low", "moderate", "high", "critical"] as const;

export function agencyOf(source: string): string {
  if (source === "sf_police_cad") return "police";
  if (source === "sf_fire_cad") return "fire";
  if (source === "sf_ems_cad") return "ems";
  return "other";
}

export function agencyLabel(agency: string): string {
  return AGENCY_LABELS[agency] ?? AGENCY_LABELS.other!;
}

export function severityRank(severity: string | null | undefined): number {
  if (!severity) return -1;
  return (SEVERITY_ORDER as readonly string[]).indexOf(severity);
}

function typeLabel(type: string | null | undefined): string {
  if (!type) return INCIDENT_TYPE_LABELS.unknown;
  return INCIDENT_TYPE_LABELS[type as IncidentType] ?? INCIDENT_TYPE_LABELS.unknown;
}

/** Units are agency identifiers (`E01`, `3T15`), not prose — safe to name directly. */
function unitList(units: readonly string[]): string {
  return [...units].sort().join(", ");
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before);
  return after.filter((value) => !seen.has(value));
}

export interface DraftInput {
  /** Undefined when this observation created the incident. */
  before?: IncidentSnapshot | undefined;
  after: IncidentSnapshot;
  observation: CandidateObservation;
}

/**
 * `(before, after, observation) → entries`, pure and total. Every branch is a change that
 * actually happened to the incident row, which is what keeps the timeline honest: an
 * observation that repeats what is already known adds nothing.
 */
export function timelineDrafts(input: DraftInput): TimelineDraft[] {
  const { before, after, observation } = input;
  const occurredAt = observation.occurredAt.toISOString();
  const agency = agencyLabel(agencyOf(observation.source));
  const drafts: TimelineDraft[] = [];

  if (!before) {
    const where = observation.locationCanonical ? ` at ${observation.locationCanonical}` : "";
    drafts.push({
      kind: "initial_report",
      occurredAt,
      text: `${typeLabel(after.primaryType)} reported${where} — first report from ${agency}.`,
    });
    if (after.units.length > 0) {
      drafts.push({
        kind: "unit_dispatched",
        occurredAt,
        text: `${agency} dispatched ${unitList(after.units)}.`,
      });
    }
  } else {
    const newUnits = added(before.units, after.units);
    if (newUnits.length > 0) {
      // The first units on an incident are a dispatch; later ones are reinforcement, and
      // the distinction is the whole point of having two kinds.
      drafts.push(
        before.units.length === 0
          ? { kind: "unit_dispatched", occurredAt, text: `${agency} dispatched ${unitList(newUnits)}.` }
          : { kind: "additional_unit", occurredAt, text: `${agency} added ${unitList(newUnits)}.` },
      );
    }

    for (const joined of added(before.agencyTypes, after.agencyTypes)) {
      drafts.push({
        kind: "agency_joined",
        occurredAt,
        text: `${agencyLabel(joined)} joined the response.`,
      });
    }

    if (after.primaryType !== before.primaryType) {
      drafts.push({
        kind: "type_changed",
        occurredAt,
        text: `Type changed from ${typeLabel(before.primaryType)} to ${typeLabel(after.primaryType)}.`,
      });
    }

    if (severityRank(after.severity) > severityRank(before.severity)) {
      drafts.push({
        kind: "escalation",
        occurredAt,
        text: before.severity
          ? `Severity raised from ${before.severity} to ${after.severity}.`
          : `Severity assessed as ${after.severity}.`,
      });
    }
  }

  // Status is not rendered here: `applyLifecycle` owns that transition and writes its own
  // entry through `renderStatus`, so there is one writer per kind.
  return drafts;
}

/**
 * The status line. Shared with `applyLifecycle` so there is exactly one place that turns a
 * `StatusDecision` into words.
 */
export function renderStatus(
  decision: StatusDecision,
  observation: CandidateObservation,
): TimelineDraft {
  return {
    kind: decision.status === "resolved" ? "closed" : "status_changed",
    occurredAt: decision.resolvedAt ?? observation.occurredAt.toISOString(),
    text: `Status ${decision.status}: ${decision.reason}`,
  };
}

/**
 * Write drafts. Deterministic ids mean a replay writes the same rows, and the unique
 * constraint means it writes them once.
 */
export function recordTimeline(
  db: Database,
  incidentId: string,
  observationId: string,
  drafts: readonly TimelineDraft[],
  now: Date,
): number {
  if (drafts.length === 0) return 0;
  const insert = db.query(
    `INSERT INTO timeline_events (id, incident_id, occurred_at, recorded_at, kind, text, observation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (incident_id, observation_id, kind) DO NOTHING`,
  );
  let written = 0;
  for (const draft of drafts) {
    const result = insert.run(
      `tl_${incidentId}_${observationId}_${draft.kind}`,
      incidentId,
      draft.occurredAt,
      now.toISOString(),
      draft.kind,
      draft.text,
      observationId,
    );
    if (result.changes > 0) written += 1;
  }
  return written;
}

/**
 * Read an incident's timeline in the order a reader should see it: by what the source said
 * happened, then by ingest order, then by id so the sort is total and stable across
 * re-renders even when two records share both timestamps.
 */
export function readTimeline(db: Database, incidentId: string): TimelineRow[] {
  return db
    .query<
      {
        id: string;
        incident_id: string;
        occurred_at: string;
        recorded_at: string;
        kind: string;
        text: string;
        observation_id: string;
      },
      [string]
    >(
      `SELECT id, incident_id, occurred_at, recorded_at, kind, text, observation_id
         FROM timeline_events
        WHERE incident_id = ?
        ORDER BY occurred_at, recorded_at, id`,
    )
    .all(incidentId)
    .map((row) => ({
      id: row.id,
      incidentId: row.incident_id,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      kind: row.kind as TimelineEventKind,
      text: row.text,
      observationId: row.observation_id,
    }));
}

/** The snapshot `timelineDrafts` compares against, read straight from the incident row. */
export function snapshotIncident(db: Database, incidentId: string): IncidentSnapshot | undefined {
  const row = db
    .query<
      { primary_type: string; severity: string | null; status: string; units: string; agency_types: string },
      [string]
    >("SELECT primary_type, severity, status, units, agency_types FROM incidents WHERE id = ?")
    .get(incidentId);
  if (!row) return undefined;
  return {
    primaryType: row.primary_type,
    severity: row.severity,
    status: row.status,
    units: JSON.parse(row.units) as string[],
    agencyTypes: JSON.parse(row.agency_types) as string[],
  };
}
