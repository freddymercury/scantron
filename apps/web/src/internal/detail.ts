/**
 * One observation, in full (a first cut of S-F4's detail view).
 *
 * The page answers three questions in order: what was reported, where the point came from,
 * and what else was happening beside it. That last section is the interesting one — it is
 * the raw material of correlation, shown before correlation exists, so the merge decisions
 * Epic D will make can be judged against what a human would do with the same rows.
 */

import type { Database } from "bun:sqlite";

import { readTimeline } from "@scantron/correlation";

import { escapeHtml } from "../security.ts";
import { renderMap } from "./map.ts";
import { INTERNAL_PREFIX } from "./paths.ts";
import {
  incidentForObservation,
  nearbyObservations,
  neighborhoodShapes,
  observationById,
  rawPayloads,
  type ObservationListRow,
} from "./queries.ts";

/** "12 minutes ago" beats an ISO timestamp for the question this page answers. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const deltaMs = now.getTime() - new Date(iso).getTime();
  const future = deltaMs < 0;
  const minutes = Math.round(Math.abs(deltaMs) / 60_000);

  const render = (): string => {
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days} d`;
    const weeks = Math.round(days / 7);
    if (weeks < 9) return `${weeks} w`;
    return `${Math.round(days / 30)} mo`;
  };
  const value = render();
  if (value === "just now") return value;
  return future ? `in ${value}` : `${value} ago`;
}

function fact(label: string, value: string | undefined | null): string {
  if (value === undefined || value === null || value === "") return "";
  return `<div><span class="muted">${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function summaryLine(row: ObservationListRow, now: Date): string {
  const what = row.subtype ?? row.type ?? "unknown";
  const where = row.location_normalized ?? row.location_raw ?? row.neighborhood ?? "location withheld";
  return `${what} · ${where} · ${relativeTime(row.occurred_at, now)}`;
}

export function renderDetail(db: Database, id: string, now: Date = new Date()): string | undefined {
  const row = observationById(db, id);
  if (!row) return undefined;

  const payloads = rawPayloads(db, row.source, row.source_record_id ?? "");
  const nearby = nearbyObservations(db, row);
  const incident = incidentForObservation(db, row.id);
  const timeline = incident ? readTimeline(db, incident.id) : [];
  const units = row.units ? (JSON.parse(row.units) as string[]) : [];

  // A tight box around the point, so the detail map is a street-level view rather than
  // the whole city with one dot in it.
  const focus =
    row.lat !== null && row.lng !== null
      ? {
          min_lat: row.lat - 0.004,
          max_lat: row.lat + 0.004,
          min_lng: row.lng - 0.005,
          max_lng: row.lng + 0.005,
        }
      : undefined;

  const points =
    row.lat !== null && row.lng !== null
      ? [
          { ...row, lat: row.lat, lng: row.lng },
          ...nearby.filter((other) => other.lat !== null && other.lng !== null),
        ].map((point) => ({
          id: point.id,
          lat: point.lat as number,
          lng: point.lng as number,
          source: point.source,
          type: point.type,
          occurred_at: point.occurred_at,
          subtype: point.subtype,
          location_normalized: point.location_normalized,
          location_raw: point.location_raw,
          neighborhood: point.neighborhood,
          units: point.units,
          priority_rank: point.priority_rank,
          sensitive: point.sensitive,
        }))
      : [];

  return `
<p><a href="${INTERNAL_PREFIX}">← all observations</a>${
    row.neighborhood
      ? ` · <a href="${INTERNAL_PREFIX}?neighborhood=${encodeURIComponent(row.neighborhood)}&since=24h">${escapeHtml(row.neighborhood)}</a>`
      : ""
  }</p>

<h1>${escapeHtml(summaryLine(row, now))}</h1>
<p class="muted">${escapeHtml(row.occurred_at)} · reported by ${escapeHtml(row.source)}${
    row.backfilled === 1 ? " · backfilled from the historical dataset" : ""
  }</p>

<div class="counters">
  ${fact("type", row.type ?? "unknown")}
  ${fact("agency code", row.raw_type ? `${row.raw_type}${row.subtype ? ` (${row.subtype})` : ""}` : null)}
  ${fact("confidence", row.type_confidence === null ? null : row.type_confidence.toFixed(2))}
  ${fact("priority", row.priority ? `${row.priority}${row.priority_rank ? ` → ${row.priority_rank}/5` : ""}` : null)}
  ${fact("units", units.length > 0 ? units.join(" ") : null)}
  ${fact("neighborhood", row.neighborhood)}
  ${fact(
    "located by",
    row.location_method ?? (row.lat === null ? "not located" : "source coordinates (not yet re-checked)"),
  )}
  ${fact("first seen", `${relativeTime(row.ingested_at, now)} (${Math.round((new Date(row.ingested_at).getTime() - new Date(row.occurred_at).getTime()) / 60_000)} min after the call)`)}
  ${row.sensitive === 1 ? fact("flagged", "sensitive_call — SFPD withholds its location") : ""}
</div>

${
  points.length > 0
    ? `${renderMap(points, neighborhoodShapes(db), { focus, focusName: row.neighborhood ?? undefined })}
       <p class="legend"><span class="police">police</span><span class="fire">fire</span><span class="ems">EMS</span></p>`
    : `<p class="muted">No location was published for this call, so there is nothing to plot. That is SFPD's suppression, not a gap in our geocoding.</p>`
}

${
  incident
    ? `<h2>incident <span class="muted">${escapeHtml(incident.id)}</span></h2>
       <div class="counters">
         ${fact("status", incident.status)}
         ${fact("type", incident.primary_type)}
         ${fact("severity", incident.severity)}
         ${fact("agencies", (JSON.parse(incident.agency_types) as string[]).join(" "))}
         ${fact("observations", String(incident.source_count))}
         ${fact(
           "attached as",
           incident.decision
             ? `${incident.decision}${incident.score === null ? "" : ` (${incident.score.toFixed(2)})`}`
             : null,
         )}
       </div>
       <h3>timeline <span class="muted">${timeline.length} entr${timeline.length === 1 ? "y" : "ies"}</span></h3>
       <ol class="timeline">
         ${timeline
           .map(
             (entry) => `<li${entry.observationId === row.id ? ' class="here"' : ""}>
               <span class="muted">${escapeHtml(relativeTime(entry.occurredAt, now))}</span>
               <b>${escapeHtml(entry.text)}</b>
               <span class="muted">${escapeHtml(entry.kind)} · <a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(entry.observationId)}">source</a></span>
             </li>`,
           )
           .join("")}
       </ol>
       <p class="muted">Entries are ordered by when the agency said each thing happened, not by when we saw it, and every line is templated from structured fields (S-D5).</p>`
    : `<p class="muted">This observation has not been correlated yet, so it has no incident or timeline.</p>`
}

<h2>within 450 m and an hour <span class="muted">${nearby.length} other observation${nearby.length === 1 ? "" : "s"}</span></h2>
${
  nearby.length === 0
    ? '<p class="muted">Nothing else was reported nearby. This one stands alone.</p>'
    : `<table>
        <tr><th>when</th><th>source</th><th>type</th><th>location</th><th>units</th><th></th></tr>
        ${nearby
          .map(
            (other) => `<tr>
              <td>${escapeHtml(relativeTime(other.occurred_at, new Date(row.occurred_at)))}</td>
              <td>${escapeHtml(other.source)}</td>
              <td>${escapeHtml(other.type ?? "unknown")}</td>
              <td>${escapeHtml(other.location_normalized ?? other.location_raw ?? "—")}</td>
              <td>${escapeHtml(other.units ? (JSON.parse(other.units) as string[]).join(" ") : "—")}</td>
              <td><a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(other.id)}">open</a></td>
            </tr>`,
          )
          .join("")}
      </table>
      <p class="muted">These are the rows correlation will decide about (Epic D): same place, same hour, possibly the same event.</p>`
}

<h2>source payloads <span class="muted">${payloads.length} version${payloads.length === 1 ? "" : "s"}</span></h2>
${
  payloads.length > 1
    ? `<p class="muted">The source revised this record — every version is kept, which is what makes a correction traceable (S-D7).</p>`
    : ""
}
${payloads
  .map(
    (payload) => `<details${payloads.indexOf(payload) === 0 ? " open" : ""}>
      <summary>fetched ${escapeHtml(relativeTime(payload.fetched_at, now))} · ${escapeHtml(payload.fetched_at)}</summary>
      <pre>${escapeHtml(JSON.stringify(JSON.parse(payload.payload) as object, null, 2))}</pre>
    </details>`,
  )
  .join("")}
`;
}
