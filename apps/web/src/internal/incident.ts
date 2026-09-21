/**
 * One incident, in full — the object the product is actually about.
 *
 * The observation page (`detail.ts`) answers "what did this agency say". This one answers
 * "what happened, as far as anyone reported": the timeline built in S-D5, the records it
 * was built from, and where those records disagree. It is the drill-in target for every
 * list in the internal viewer, so it has to stand on its own.
 */

import type { Database } from "bun:sqlite";
import { readTimeline, reportFields } from "@scantron/correlation";
import { INCIDENT_TYPE_LABELS, type IncidentType } from "@scantron/incident-schema";

import { escapeHtml } from "../security.ts";
import { fact, relativeTime } from "./detail.ts";
import {
  elapsed,
  firstOnScene,
  medianResponseMs,
  recordFacts,
  toSceneMs,
  unitResponses,
  type UnitResponse,
} from "./dispatch.ts";
import { renderMap } from "./map.ts";
import { INTERNAL_PREFIX } from "./paths.ts";
import { timeTag } from "./time.ts";
import {
  comparableCallMetadata,
  cornerHistory,
  earliestObservation,
  incidentById,
  nearMisses,
  neighborhoodShapes,
  observationsWithMetadata,
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


/**
 * Who went, and how long it took them.
 *
 * SFFD and SFEMS publish a timestamp per unit — dispatch, en route, on scene, available —
 * on every record. It is the one place this data describes an event unfolding rather than
 * a row being filed.
 */

/**
 * What SFPD wrote up afterwards (S-I2).
 *
 * This is the only outcome any of these feeds states in the city's own words. It is a
 * statement about the case file and nothing more: "Cite or Arrest Adult" means a report was
 * written that way, not that anyone was convicted of anything, and the page says so.
 */

/**
 * One response time against its peers. Stated as a comparison and nothing more — a fast
 * response is not a good outcome and a slow one is not a failure, and the sentence is
 * written so it cannot be read either way.
 */
function responseComparison(
  ownMs: number | undefined,
  medianMs: number | undefined,
  sample: number,
  incident: IncidentRow,
  citywide: boolean,
): string {
  if (ownMs === undefined || medianMs === undefined) return "";
  const own = elapsed("1970-01-01T00:00:00Z", new Date(ownMs).toISOString());
  const median = elapsed("1970-01-01T00:00:00Z", new Date(medianMs).toISOString());
  const delta = ownMs - medianMs;
  const word = Math.abs(delta) < 30_000 ? "about the same as" : delta < 0 ? "faster than" : "slower than";
  const where = citywide || !incident.neighborhood ? " citywide" : ` in ${incident.neighborhood}`;
  return `<p class="muted">First unit on scene in <b>${escapeHtml(own ?? "—")}</b> — ${escapeHtml(word)} the median of ${escapeHtml(median ?? "—")} for ${escapeHtml(incident.primary_type)} calls${escapeHtml(where)} over the last 30 days (${sample} calls). A comparison of dispatch timings, not of how well anyone did.</p>`;
}

/**
 * What correlation looked at and left alone (S-D3).
 *
 * The probable band is logged rather than merged, and showing it is the difference between
 * a page that says "nothing else happened here" and one that says "something did, and we
 * were not sure enough to say it was the same event".
 */
function nearMissSection(missed: ReturnType<typeof nearMisses>, now: Date): string {
  if (missed.length === 0) return "";
  return `<h2>considered and not merged <span class="muted">${missed.length}</span></h2>
  <table>
    <tr><th>when</th><th>source</th><th>reported as</th><th>where</th><th>score</th><th>on</th><th></th></tr>
    ${missed
      .map(
        (row) => `<tr>
          <td>${timeTag(row.occurred_at, { text: relativeTime(row.occurred_at, now) })}</td>
          <td>${escapeHtml(row.source.replace("sf_", "").replace("_cad", ""))}</td>
          <td>${escapeHtml(row.subtype ?? row.type ?? "unknown")}</td>
          <td>${escapeHtml(row.location_normalized ?? row.location_raw ?? "—")}</td>
          <td>${row.score.toFixed(2)}</td>
          <td class="muted">${escapeHtml((JSON.parse(row.applied_features) as string[]).join(", "))}</td>
          <td><a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(row.observation_id)}">open</a></td>
        </tr>`,
      )
      .join("")}
  </table>
  <p class="muted">Scored in the probable band (0.65–0.85): close enough to log, not close enough to merge. The features column says which parts of the comparison actually applied — a pair with no shared units and no type affinity is scored on less than it looks.</p>`;
}

function reportSection(
  reports: { row: { id: string; occurred_at: string }; fields: ReturnType<typeof reportFields> }[],
): string {
  if (reports.length === 0) return "";
  return `<h2>how it was written up <span class="muted">${reports.length} report${reports.length === 1 ? "" : "s"}</span></h2>
  <table>
    <tr><th>offence</th><th>category</th><th>case status</th><th>report</th><th></th></tr>
    ${reports
      .map(
        ({ row, fields }) => `<tr>
          <td>${escapeHtml(fields.description ?? "—")}</td>
          <td>${escapeHtml(fields.category ?? "—")}</td>
          <td>${escapeHtml(fields.resolution ?? "—")}</td>
          <td>${escapeHtml(fields.reportType ?? "—")}</td>
          <td><a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(row.id)}">open</a></td>
        </tr>`,
      )
      .join("")}
  </table>
  <p class="muted">Joined to this call on its <code>cad_number</code> — a lookup, not a guess (S-I2). One call yields 1.71 offence rows on average, so several lines here are normal. "Case status" is what the report says about the case file; it is not a statement about any person.</p>`;
}

function responseSection(responses: (UnitResponse & { source: string })[]): string {
  if (responses.length === 0) return "";
  return `<h2>response <span class="muted">${responses.length} unit${responses.length === 1 ? "" : "s"}</span></h2>
  <table>
    <tr><th>unit</th><th>kind</th><th>dispatched</th><th>en route after</th><th>on scene</th><th>took</th><th>cleared</th></tr>
    ${responses
      .map(
        (response) => `<tr>
          <td>${escapeHtml(response.unit)}</td>
          <td>${escapeHtml((response.unitType ?? "—").toLowerCase())}</td>
          <td>${response.dispatch ? timeTag(response.dispatch) : "—"}</td>
          <td>${response.response ? elapsed(response.dispatch, response.response) ?? "—" : "—"}</td>
          <td>${response.onScene ? timeTag(response.onScene) : "—"}</td>
          <td>${escapeHtml(elapsed(response.dispatch, response.onScene) ?? "—")}</td>
          <td>${response.available ? escapeHtml(elapsed(response.onScene ?? response.dispatch, response.available) ?? "—") : "—"}</td>
        </tr>`,
      )
      .join("")}
  </table>
  <p class="muted">"took" is dispatch to on-scene, as the agency recorded it. A dash means that unit never reported that step, which is common and is not evidence it did not happen.</p>`;
}

/**
 * The corner's own record. Most incidents are one call, so the event itself is thin — but
 * the place has a history, and that is context the data genuinely supports.
 */
function historySection(
  history: ReturnType<typeof cornerHistory> | undefined,
  incident: IncidentRow,
  since: string | undefined,
  now: Date,
): string {
  if (!history || history.total === 0) return "";
  const where = incident.location_display_name ?? "this corner";
  const trend =
    history.earlier > 0
      ? ` The ${history.days} days before that had ${history.earlier}.`
      : "";
  return `<h2>this corner</h2>
  <p><b>${history.total} other call${history.total === 1 ? "" : "s"}</b> within about 165 m of ${escapeHtml(where)} in the last ${history.days} days.${escapeHtml(trend)}</p>
  <p class="muted breakdown">${history.byType
    .map((entry) => `${entry.n} ${escapeHtml(entry.type)}`)
    .join(" · ")}</p>
  <p class="muted">Counted from what has been ingested${
    since ? `, which begins ${escapeHtml(relativeTime(since, now))}` : ""
  } — not from the city's full archive. It says how busy a place is for dispatch, nothing about whether it is safe.</p>`;
}

export function renderIncident(db: Database, id: string, now: Date = new Date()): string | undefined {
  const incident = incidentById(db, id);
  if (!incident) return undefined;

  const observations = observationsWithMetadata(db, id);
  const metadata = new Map(
    observations.map((row) => [
      row.id,
      row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    ]),
  );
  const responses = observations.flatMap((row) =>
    unitResponses(metadata.get(row.id)).map((response) => ({ ...response, source: row.source })),
  );
  // Two agencies on one incident repeat the district, the outcome and so on. The same
  // label and value twice says nothing twice, so identical facts collapse.
  const facts = [
    ...new Map(
      observations
        .flatMap((row) => recordFacts(metadata.get(row.id)))
        .map((entry) => [`${entry.label}|${entry.value}`.toLowerCase(), entry]),
    ).values(),
  ];
  // SFPD's written-up reports for this call. They are attached, but they are not calls —
  // they are the same agency's paperwork days later (S-I2).
  const reports = observations
    .filter((row) => row.source === "sf_police_report")
    .map((row) => ({ row, fields: reportFields(metadata.get(row.id)) }));
  const calls = observations.filter((row) => row.source !== "sf_police_report");

  const missed = nearMisses(db, id);

  // The incident's own response time, against comparable calls. Only computed when there
  // is one to compare, which rules out most police incidents (no on-scene time on 16%).
  const ownResponseMs = calls
    .map((row) => toSceneMs(metadata.get(row.id)))
    .find((value) => value !== undefined);
  const sceneTimes = (neighborhood: string | null): number[] =>
    comparableCallMetadata(db, incident.primary_type, neighborhood, now)
      .map((raw) => toSceneMs(JSON.parse(raw) as Record<string, unknown>))
      .filter((value): value is number => value !== undefined);

  // A neighborhood is often too small a sample — "assault in Treasure Island" was one
  // call — so the comparison widens to the city rather than going quiet, and the sentence
  // says which it used.
  let comparableMs = ownResponseMs === undefined ? [] : sceneTimes(incident.neighborhood);
  let comparedCitywide = false;
  if (ownResponseMs !== undefined && medianResponseMs(comparableMs) === undefined) {
    comparableMs = sceneTimes(null);
    comparedCitywide = true;
  }
  const medianMs = medianResponseMs(comparableMs);

  const history =
    incident.lat !== null && incident.lng !== null
      ? cornerHistory(db, incident.lat, incident.lng, id, now)
      : undefined;
  const timeline = readTimeline(db, id);
  const agencies = JSON.parse(incident.agency_types) as string[];
  const units = JSON.parse(incident.units) as string[];
  // The map plots the calls. A report is paperwork filed at the same corner days later,
  // so plotting it adds a dot that means nothing new.
  const located = calls.filter((row) => row.lat !== null && row.lng !== null);

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
  ${fact(
    "first on scene",
    (() => {
      const first = firstOnScene(responses);
      if (!first) return null;
      const took = elapsed(first.dispatch, first.onScene);
      return took ? `${first.unit} in ${took}` : first.unit;
    })(),
  )}
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

${responseSection(responses)}
${responseComparison(ownResponseMs, medianMs, comparableMs.length, incident, comparedCitywide)}

${
  facts.length === 0
    ? ""
    : `<h2>what the record says</h2>
       <ul class="facts">
         ${facts
           .map(
             (entry) => `<li${entry.notable ? ' class="notable"' : ""}>
               <span class="muted">${escapeHtml(entry.label)}</span> ${escapeHtml(entry.value)}
             </li>`,
           )
           .join("")}
       </ul>
       <p class="muted">These are fields the agency published that normalization does not keep. There is no narrative anywhere in this feed — no call notes, no remarks — so this is everything the record says.</p>`
}

${historySection(history, incident, earliestObservation(db), now)}

${nearMissSection(missed, now)}

${reportSection(reports)}

<h2>calls <span class="muted">${calls.length} record${calls.length === 1 ? "" : "s"}</span></h2>
<table>
  <tr><th>when</th><th>source</th><th>reported as</th><th>where</th><th>units</th><th></th></tr>
  ${calls
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
