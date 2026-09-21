/**
 * Joining SFPD's written-up incident reports to the calls they came from (S-I2).
 *
 * This is the one attachment in the system that is **not** scored. A report carries the
 * `cad_number` of the call it was written up from, so the link is a lookup, not a
 * judgement: confidence 1.0, no candidate set, no threshold. `docs/01 §1` measured the key
 * present on 88.7% of report rows and effectively 100% of dispatched ones.
 *
 * The rule that matters more than the join: **a report with no `cad_number` is never
 * matched by any other means.** The missing 11% are online-filed (Coplogic) reports and
 * supplements. Guessing which incident one of those belongs to — by place and time, the way
 * correlation guesses for dispatch records — would attach a stranger's written report to
 * somebody else's event. They are stored, counted, and left alone.
 */

import type { Database } from "bun:sqlite";

import { recordTimeline } from "./timeline.ts";

export interface ReportJoinResult {
  /** `joined` — attached deterministically. `unjoinable` — no cad_number, left alone. */
  outcome: "joined" | "unjoinable" | "no_matching_call" | "already_attached";
  incidentId?: string;
  /** Days between the call and the report being published, when both are known. */
  lagDays?: number;
}

interface ReportFields {
  cadNumber?: string;
  category?: string;
  description?: string;
  resolution?: string;
  reportType?: string;
  reportedAt?: string;
}

export function reportFields(metadata: Record<string, unknown> | undefined): ReportFields {
  if (!metadata) return {};
  const text = (key: string): string | undefined => {
    const value = metadata[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const fields: ReportFields = {};
  const cad = text("cad_number");
  if (cad) fields.cadNumber = cad;
  const category = text("incident_category");
  if (category) fields.category = category;
  const description = text("incident_description");
  if (description) fields.description = description;
  const resolution = text("resolution");
  if (resolution) fields.resolution = resolution;
  const reportType = text("report_type_description");
  if (reportType) fields.reportType = reportType;
  const reportedAt = text("report_datetime");
  if (reportedAt) fields.reportedAt = reportedAt;
  return fields;
}

/**
 * The timeline line a report produces.
 *
 * `resolution` is the only outcome any of these feeds states in the city's own words, so it
 * leads. It is a statement about the case file, not about a person: "Cite or Arrest Adult"
 * means a report was written that way, and the template says no more than that.
 */
export function renderReport(fields: ReportFields): string {
  const what = fields.description ?? fields.category ?? "an incident";
  const outcome = fields.resolution ? ` Case status: ${fields.resolution}.` : "";
  return `SFPD filed ${article(reportKind(fields.reportType))}: ${what}.${outcome}`;
}

/**
 * SFPD's `report_type_description` is one of six values, and two of the words in them are
 * doing real work: a *supplement* is an addition to a report that already exists, and
 * *Coplogic* means the public filed it online rather than an officer writing it up.
 */
export function reportKind(reportType: string | undefined): string {
  if (!reportType) return "report";
  const value = reportType.toLowerCase();
  const online = value.includes("coplogic") ? "online-filed " : "";
  if (value.includes("supplement")) return `${online}supplement`;
  if (value.includes("vehicle")) return `${online}vehicle report`;
  return `${online}initial report`;
}

function article(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/**
 * Attach a report observation to the incident of the call it names.
 *
 * One call yields 1.71 report rows on average, so several reports land on one incident.
 * Each is its own attachment and its own timeline entry, deduplicated by the
 * `(incident_id, observation_id, kind)` constraint rather than by anything clever.
 */
export function joinReport(
  db: Database,
  report: { id: string; source: string; occurredAt: Date; metadata?: Record<string, unknown> },
  now: Date = new Date(),
): ReportJoinResult {
  const fields = reportFields(report.metadata);
  const cadNumber = fields.cadNumber;
  if (!cadNumber) return { outcome: "unjoinable" };

  const run = db.transaction((): ReportJoinResult => {
    const existing = db
      .query<{ incident_id: string }, [string]>(
        "SELECT incident_id FROM incident_observations WHERE observation_id = ?",
      )
      .get(report.id);
    if (existing) return { outcome: "already_attached", incidentId: existing.incident_id };

    // The dispatch record is keyed on `cad_number` (see `police.ts`), which is exactly what
    // makes this a lookup.
    const call = db
      .query<{ incident_id: string }, [string]>(
        `SELECT io.incident_id FROM observations o
           JOIN incident_observations io ON io.observation_id = o.id
          WHERE o.source = 'sf_police_cad' AND o.source_record_id = ?
          LIMIT 1`,
      )
      .get(cadNumber);
    if (!call) return { outcome: "no_matching_call" };

    db.query(
      `INSERT INTO incident_observations (incident_id, observation_id, attached_at, score,
         decision, breakdown, applied_features)
       VALUES (?, ?, ?, 1.0, 'merged', '{}', '["cad_number"]')
       ON CONFLICT (incident_id, observation_id) DO NOTHING`,
    ).run(call.incident_id, report.id, now.toISOString());

    // A report arriving days later still touches the incident — a closed incident is not
    // immutable to outcomes (S-I2) — but it does not move `last_observed_at`, because the
    // event did not happen again when the paperwork was filed.
    db.query("UPDATE incidents SET last_updated_at = ? WHERE id = ?").run(
      now.toISOString(),
      call.incident_id,
    );

    recordTimeline(
      db,
      call.incident_id,
      report.id,
      [
        {
          kind: "report_filed",
          occurredAt: report.occurredAt.toISOString(),
          text: renderReport(fields),
        },
      ],
      now,
    );

    const result: ReportJoinResult = { outcome: "joined", incidentId: call.incident_id };
    const lag = lagDays(db, call.incident_id, fields.reportedAt);
    if (lag !== undefined) result.lagDays = lag;
    return result;
  });

  return run.immediate();
}

function lagDays(db: Database, incidentId: string, reportedAt: string | undefined): number | undefined {
  if (!reportedAt) return undefined;
  const incident = db
    .query<{ first_observed_at: string }, [string]>(
      "SELECT first_observed_at FROM incidents WHERE id = ?",
    )
    .get(incidentId);
  if (!incident) return undefined;
  const days = (Date.parse(reportedAt) - Date.parse(incident.first_observed_at)) / 86_400_000;
  return Number.isFinite(days) ? Math.round(days * 10) / 10 : undefined;
}
