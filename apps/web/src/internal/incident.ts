/**
 * One incident, in full — the object the product is actually about.
 *
 * The observation page (`detail.ts`) answers "what did this agency say". This one answers
 * "what happened, as far as anyone reported": the timeline built in S-D5, the records it
 * was built from, and where those records disagree. It is the drill-in target for every
 * list in the internal viewer, so it has to stand on its own.
 */

import type { Database } from "bun:sqlite";
import { readTimeline } from "@scantron/correlation";
import { INCIDENT_TYPE_LABELS, type IncidentType } from "@scantron/incident-schema";

import { escapeHtml } from "../security.ts";
import { fact, relativeTime } from "./detail.ts";
import { renderMap } from "./map.ts";
import { INTERNAL_PREFIX } from "./paths.ts";
import { timeTag } from "./time.ts";
import {
  incidentById,
  neighborhoodShapes,
  observationsForIncident,
  type IncidentRow,
} from "./queries.ts";

export function typeLabel(type: string | null | undefined): string {
  if (!type) return INCIDENT_TYPE_LABELS.unknown;
  return INCIDENT_TYPE_LABELS[type as IncidentType] ?? INCIDENT_TYPE_LABELS.unknown;
}

/** The one-line form used in lists and in the page heading. */
export function incidentSummary(incident: IncidentRow, now: Date): string {
  const where = incident.location_display_name ?? incident.neighborhood ?? "location withheld";
  return `${typeLabel(incident.primary_type)} · ${where} · ${relativeTime(incident.first_observed_at, now)}`;
}

/**
 * How current the incident is, in words that do not overclaim. `unknown` is a real answer
 * here and the most common one — PRD §19 forbids inventing a resolution (S-D4).
 */
export function statusNote(incident: IncidentRow): string {
  switch (incident.status) {
    case "resolved":
      return "an agency closed this call";
    case "unknown":
      return "nothing further has been reported — not a statement that it ended";
    case "active":
      return "a unit reported on scene";
    case "dispatched":
      return "units were dispatched";
    case "contained":
      return "reported contained";
    default:
      return "the call was received";
  }
}

export function renderIncident(db: Database, id: string, now: Date = new Date()): string | undefined {
  const incident = incidentById(db, id);
  if (!incident) return undefined;

  const observations = observationsForIncident(db, id);
  const timeline = readTimeline(db, id);
  const agencies = JSON.parse(incident.agency_types) as string[];
  const units = JSON.parse(incident.units) as string[];
  const located = observations.filter((row) => row.lat !== null && row.lng !== null);

  const focus =
    incident.lat !== null && incident.lng !== null
      ? {
          min_lat: incident.lat - 0.004,
          max_lat: incident.lat + 0.004,
          min_lng: incident.lng - 0.005,
          max_lng: incident.lng + 0.005,
        }
      : undefined;

  const points = located.map((row) => ({
    id: row.id,
    lat: row.lat as number,
    lng: row.lng as number,
    source: row.source,
    type: row.type,
    occurred_at: row.occurred_at,
    subtype: row.subtype,
    location_normalized: row.location_normalized,
    location_raw: row.location_raw,
    neighborhood: row.neighborhood,
    units: row.units,
    priority_rank: row.priority_rank,
    sensitive: row.sensitive,
  }));

  const span =
    incident.last_observed_at && incident.last_observed_at !== incident.first_observed_at
      ? `${Math.max(1, Math.round((new Date(incident.last_observed_at).getTime() - new Date(incident.first_observed_at).getTime()) / 60_000))} min of reports`
      : "a single report";

  return `
<p class="crumbs"><a href="${INTERNAL_PREFIX}">← viewer</a>${
    incident.neighborhood
      ? ` · <a href="${INTERNAL_PREFIX}?neighborhood=${encodeURIComponent(incident.neighborhood)}&since=24h">${escapeHtml(incident.neighborhood)}</a>`
      : ""
  }</p>

<h1>${escapeHtml(incidentSummary(incident, now))}</h1>
<p class="muted">${timeTag(incident.first_observed_at)} · ${escapeHtml(span)} · ${escapeHtml(
    statusNote(incident),
  )}</p>
${
  incident.merged_into_id
    ? `<p class="muted">This incident was absorbed by <a href="${INTERNAL_PREFIX}/incident/${encodeURIComponent(incident.merged_into_id)}">${escapeHtml(incident.merged_into_id)}</a>; it is kept so old links still resolve.</p>`
    : ""
}

<div class="counters">
  ${fact("status", incident.status)}
  ${fact("type", incident.primary_type)}
  ${fact("severity", incident.severity)}
  ${fact("agencies", agencies.join(" "))}
  ${fact("calls", String(incident.source_count))}
  ${fact("units", units.length > 0 ? units.join(" ") : null)}
  ${fact("corroboration", incident.verification_classification)}
  ${fact("last reported", incident.last_observed_at ? relativeTime(incident.last_observed_at, now) : null)}
</div>

${
  points.length > 0
    ? `${renderMap(points, neighborhoodShapes(db), { focus, focusName: incident.neighborhood ?? undefined })}
       <p class="legend"><span class="police">police</span><span class="fire">fire</span><span class="ems">EMS</span></p>`
    : `<p class="muted">No location was published for any record in this incident, so there is nothing to plot.</p>`
}

<h2>timeline <span class="muted">${timeline.length} entr${timeline.length === 1 ? "y" : "ies"}</span></h2>
${
  timeline.length === 0
    ? `<p class="muted">This incident was correlated before timelines were built (S-D5), so it has none. New incidents get one from their first record.</p>`
    : `<ol class="timeline">
        ${timeline
          .map(
            (entry) => `<li>
              <span class="muted">${escapeHtml(relativeTime(entry.occurredAt, now))} · ${timeTag(entry.occurredAt)}</span>
              <b>${escapeHtml(entry.text)}</b>
              <span class="muted">${escapeHtml(entry.kind)} · <a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(entry.observationId)}">source</a></span>
            </li>`,
          )
          .join("")}
      </ol>
      <p class="muted">Ordered by when the agency said each thing happened, not by when we saw it. Every line is templated from structured fields — no source free-text, no model output (S-D5).</p>`
}

<h2>calls <span class="muted">${observations.length} record${observations.length === 1 ? "" : "s"}</span></h2>
<table>
  <tr><th>when</th><th>source</th><th>reported as</th><th>where</th><th>units</th><th></th></tr>
  ${observations
    .map(
      (row) => `<tr>
        <td>${timeTag(row.occurred_at, { text: relativeTime(row.occurred_at, now) })}</td>
        <td>${escapeHtml(row.source.replace("sf_", "").replace("_cad", ""))}</td>
        <td>${escapeHtml(row.subtype ?? row.type ?? "unknown")}</td>
        <td>${escapeHtml(row.location_normalized ?? row.location_raw ?? "—")}</td>
        <td>${escapeHtml(row.units ? (JSON.parse(row.units) as string[]).join(" ") : "—")}</td>
        <td><a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(row.id)}">open</a></td>
      </tr>`,
    )
    .join("")}
</table>
${
  agencies.length > 1
    ? `<p class="muted">${agencies.length} agencies reported this, which is the strongest corroboration this data offers — and the rarest (S-D3).</p>`
    : ""
}
`;
}
