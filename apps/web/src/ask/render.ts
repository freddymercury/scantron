/**
 * Rendering an answer (S-H4).
 *
 * Every sentence is a template over structured fields. The strongest constraint in this
 * file is what it refuses to say: no safety judgement, no outcome, no causation, and no
 * claim that dispatch volume means danger.
 */

import { escapeHtml } from "../security.ts";
import { relativeTime } from "../internal/detail.ts";
import { incidentSummary, typeLabel } from "../internal/incident.ts";
import { timeTag } from "../internal/time.ts";
import { INTERNAL_PREFIX } from "../internal/paths.ts";
import type { AskAnswer } from "./answer.ts";
import { describeQuery, type AskQuery } from "./parse.ts";

const EXAMPLES = [
  "most interesting thing in the last 90 minutes in the Mission",
  "car break-ins in the last 2 weeks in SoMa",
  "what's happening in the Tenderloin right now",
  "how many fires in the Bayview today",
  "shootings this week",
];

export function renderExamples(): string {
  return `<ul class="examples">${EXAMPLES.map(
    (example) => `<li><a href="${INTERNAL_PREFIX}/ask?q=${encodeURIComponent(example)}">${escapeHtml(example)}</a></li>`,
  ).join("")}</ul>`;
}

export function askBox(question = ""): string {
  return `<form method="get" action="${INTERNAL_PREFIX}/ask" class="ask">
    <input type="text" name="q" value="${escapeHtml(question)}" placeholder="ask: most interesting thing in the last 90 minutes in the Mission" autocomplete="off">
    <button type="submit">ask</button>
  </form>`;
}

/** The interpretation, with one-click corrections — a misparse must be visible and fixable. */
function interpretation(query: AskQuery): string {
  const corrections: string[] = [];
  const url = (patch: Record<string, string>) => {
    const params = new URLSearchParams({ q: query.question, ...patch });
    return `${INTERNAL_PREFIX}/ask?${params.toString()}`;
  };

  if (query.area) corrections.push(`<a href="${url({ area: "" })}">all of SF instead</a>`);
  if (query.windowMinutes !== 24 * 60) corrections.push(`<a href="${url({ window: "1440" })}">last 24 hours instead</a>`);
  if (query.categoryLabel) corrections.push(`<a href="${url({ category: "" })}">any type instead</a>`);

  return `<p class="interp">Read as <b>${escapeHtml(describeQuery(query))}</b>${
    corrections.length > 0 ? ` · ${corrections.join(" · ")}` : ""
  }</p>`;
}

function row(observation: AskAnswer["rows"][number], now: Date, relevance?: Map<string, string>): string {
  const what = observation.subtype ?? observation.type ?? "unknown";
  const where = observation.location_normalized ?? observation.location_raw ?? "location withheld";
  return `<tr>
    <td>${timeTag(observation.occurred_at, { text: relativeTime(observation.occurred_at, now) })}</td>
    <td>${escapeHtml(what)}</td>
    <td>${escapeHtml(where)}</td>
    <td>${escapeHtml(observation.neighborhood ?? "—")}</td>
    <td>${escapeHtml(observation.source.replace("sf_", "").replace("_cad", ""))}</td>
    ${relevance ? `<td class="muted">${escapeHtml(relevance.get(observation.id) ?? "—")}</td>` : ""}
    <td><a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(observation.id)}">open</a></td>
  </tr>`;
}

function searchSection(answer: AskAnswer, now: Date): string {
  const search = answer.search;
  if (!search) return "";

  if (search.hits.length === 0) {
    return `<div class="answer">
      <p><b>Nothing matched ${escapeHtml(answer.query.unresolved.join(" "))}.</b></p>
      <p class="muted">Those words are not in the grammar, so they were searched for instead — in what the agency called each call, where it happened, which units went, and in the kinds of call the question appears to be about.</p>
    </div>`;
  }

  const expansion =
    search.expandedTo && search.expandedTo.length > 0
      ? ` <span class="muted">Searched as ${escapeHtml(search.expandedTo.join("; "))}${
          search.retrievedByCategory
            ? `, which found ${search.retrievedByCategory} record${search.retrievedByCategory === 1 ? "" : "s"} that share no word with the question`
            : ""
        }.</span>`
      : "";

  return `<div class="answer">
    <p><b>${search.hits.length} match${search.hits.length === 1 ? "" : "es"}</b> for
      <b>${escapeHtml(answer.query.unresolved.join(" "))}</b>, which the grammar did not recognise, so they were searched for.${expansion}
      ${
        search.reranked
          ? `<span class="muted">Ranked semantically by Jev in ${Math.round(search.latencyMs ?? 0)} ms.</span>`
          : `<span class="muted">${escapeHtml(search.fallbackReason ?? "")}.</span>`
      }
    </p>
    <table>
      <tr><th>when</th><th>reported as</th><th>where</th><th>neighborhood</th>${search.reranked ? "<th>match</th>" : ""}<th></th></tr>
      ${search.hits
        .slice(0, 20)
        .map(
          (hit) => `<tr>
            <td>${timeTag(hit.row.occurred_at, { text: relativeTime(hit.row.occurred_at, now) })}</td>
            <td>${escapeHtml(hit.row.subtype ?? hit.row.type ?? "unknown")}</td>
            <td>${escapeHtml(hit.row.location_normalized ?? hit.row.location_raw ?? "—")}</td>
            <td>${escapeHtml(hit.row.neighborhood ?? "—")}</td>
            ${search.reranked ? `<td class="muted">${escapeHtml(hit.relevanceLabel ?? "not scored")}</td>` : ""}
            <td><a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(hit.row.id)}">open</a></td>
          </tr>`,
        )
        .join("")}
    </table>
  </div>`;
}

/**
 * The list of incidents behind the count, which is what a reader wants next: the number is
 * an opening, not an answer. Each row drills into the incident's own page and its timeline.
 */
function incidentList(answer: AskAnswer, now: Date): string {
  if (answer.incidents.length === 0) {
    return `<p class="muted">None of those calls have been correlated into incidents yet, so there is nothing to drill into. Correlation runs behind ingestion.</p>`;
  }

  const shown = answer.incidents.length;
  return `<h3>incidents <span class="muted">${
    answer.incidentTotal > shown ? `${shown} of ${answer.incidentTotal}` : `${answer.incidentTotal}`
  }</span></h3>
  <table>
    <tr><th>when</th><th>what</th><th>where</th><th>status</th><th>calls</th><th>agencies</th><th></th></tr>
    ${answer.incidents
      .map((incident) => {
        const agencies = JSON.parse(incident.agency_types) as string[];
        return `<tr>
          <td>${timeTag(incident.first_observed_at, { text: relativeTime(incident.first_observed_at, now) })}</td>
          <td>${escapeHtml(typeLabel(incident.primary_type))}</td>
          <td>${escapeHtml(incident.location_display_name ?? incident.neighborhood ?? "location withheld")}</td>
          <td>${escapeHtml(incident.status)}</td>
          <td>${incident.source_count}</td>
          <td>${escapeHtml(agencies.join(" "))}</td>
          <td><a href="${INTERNAL_PREFIX}/incident/${encodeURIComponent(incident.id)}">open</a></td>
        </tr>`;
      })
      .join("")}
  </table>
  ${
    answer.incidentTotal > shown
      ? `<p class="muted">Showing the ${shown} most recently active of ${answer.incidentTotal}. Narrow the window or the type to see the rest.</p>`
      : ""
  }`;
}

/**
 * True when the grammar placed nothing and search did.
 *
 * "prostitution" has no category in this taxonomy, so the structured half of the answer is
 * *all activity in the window* — 14,656 calls, none of which is what was asked. Leading
 * with that number is worse than leading with the two records that actually matched.
 *
 * This holds when the search found *nothing* too: "nothing matched, and here is why" is a
 * real answer, and "1,318 reported calls in the Tenderloin" in its place is not.
 */
function searchLeads(answer: AskAnswer): boolean {
  return (
    answer.query.unresolved.length > 0 &&
    answer.query.types.length === 0 &&
    answer.query.categoryLabel === undefined &&
    answer.search !== undefined
  );
}

export function renderAnswer(answer: AskAnswer, now: Date = new Date()): string {
  const { query } = answer;

  if (searchLeads(answer)) {
    const scope = query.area ?? "San Francisco";
    return `${askBox(query.question)}
      ${interpretation(query)}
      ${searchSection(answer, now)}
      <div class="answer">
        <p class="muted">No category in this taxonomy covers <b>${escapeHtml(query.unresolved.join(" "))}</b>, so this is a search of what each agency called its own calls rather than a count. For context, ${answer.total} call${answer.total === 1 ? "" : "s"} of every kind were reported in ${escapeHtml(scope)} in ${escapeHtml(query.windowLabel)}.</p>
        ${breakdown(answer)}
      </div>`;
  }

  if (query.unanswerable) {
    return `${askBox(query.question)}
      ${interpretation(query)}
      <div class="answer">
        <p><b>This data cannot answer that.</b> ${escapeHtml(query.unanswerable)}.</p>
        <p class="muted">What it can tell you is what was reported and who was dispatched. If this is an emergency, call 911.</p>
        ${renderExamples()}
      </div>`;
  }

  const scope = query.area ?? "San Francisco";
  const subject = query.categoryLabel ?? "reported calls";

  if (answer.total === 0) {
    return `${askBox(query.question)}
      ${interpretation(query)}
      <div class="answer">
        <p><b>No ${escapeHtml(subject)} were reported in ${escapeHtml(scope)} in ${escapeHtml(query.windowLabel)}.</b></p>
        <p class="muted">That means nothing was dispatched and published — not that nothing happened. The police feed publishes on a ~30 minute delay, and sensitive calls are published without a location.</p>
        </div>
      ${searchSection(answer, now)}`;
  }

  const trend =
    answer.previousTotal > 0
      ? ` The previous ${escapeHtml(query.windowLabel.replace("the last ", ""))} had ${answer.previousTotal}.`
      : "";

  if (query.intent === "count") {
    return `${askBox(query.question)}
      ${interpretation(query)}
      <div class="answer">
        <p><b>${answer.total} ${escapeHtml(subject)}</b> in ${escapeHtml(scope)} in ${escapeHtml(query.windowLabel)}.${trend}</p>
        ${breakdown(answer)}
        ${incidentList(answer, now)}
      </div>
      ${searchSection(answer, now)}`;
  }

  if (query.intent === "highlight") {
    return `${askBox(query.question)}
      ${interpretation(query)}
      <div class="answer">
        <p><b>${answer.total} call${answer.total === 1 ? "" : "s"}</b> in ${escapeHtml(scope)} in ${escapeHtml(query.windowLabel)}.${trend}</p>
        ${answer.ranked
          .map(
            (item) => `<div class="highlight">
              <b>${escapeHtml(item.row.subtype ?? item.row.type ?? "unknown")}</b>
              · ${escapeHtml(item.row.location_normalized ?? item.row.location_raw ?? "location withheld")}
              · ${timeTag(item.row.occurred_at, { text: relativeTime(item.row.occurred_at, now) })}
              ${item.reasons.length > 0 ? `<div class="muted">${escapeHtml(item.reasons.join(" · "))}</div>` : ""}
              <a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(item.row.id)}">open</a>
            </div>`,
          )
          .join("")}
        <p class="muted">Ranked by what the agency called it, how urgently it was dispatched, how many units went, and whether a second agency responded nearby. It is a ranking of dispatch activity, not of harm.</p>
        ${breakdown(answer)}
        ${incidentList(answer, now)}
      </div>
      ${searchSection(answer, now)}`;
  }

  return `${askBox(query.question)}
    ${interpretation(query)}
    <div class="answer">
      <p><b>${answer.total} ${escapeHtml(subject)}</b> in ${escapeHtml(scope)} in ${escapeHtml(query.windowLabel)}.${trend}${
        answer.withheldLocations > 0
          ? ` <span class="muted">${answer.withheldLocations} of them were published without a location.</span>`
          : ""
      }</p>
      ${answer.ordering ? `<p class="muted">${escapeHtml(answer.ordering)}.</p>` : ""}
      ${breakdown(answer)}
      ${incidentList(answer, now)}
      <h3>calls <span class="muted">${answer.rows.length} of ${answer.total}</span></h3>
      <table>
        <tr><th>when</th><th>reported as</th><th>where</th><th>neighborhood</th><th>source</th>${answer.relevance ? "<th>match</th>" : ""}<th></th></tr>
        ${answer.rows.map((observation) => row(observation, now, answer.relevance)).join("")}
      </table>
      ${answer.total > answer.rows.length ? `<p class="muted">Showing the ${answer.rows.length} most recent of ${answer.total}.</p>` : ""}
    </div>
    ${searchSection(answer, now)}`;
}

/** The type mix, with each type a link that narrows the same question to it. */
function breakdown(answer: AskAnswer): string {
  if (answer.breakdown.length === 0) return "";
  return `<p class="muted breakdown">${answer.breakdown
    .map((entry) => {
      const params = new URLSearchParams({ q: answer.query.question, category: entry.type });
      if (answer.query.area) params.set("area", answer.query.area);
      params.set("window", String(answer.query.windowMinutes));
      return `<a href="${INTERNAL_PREFIX}/ask?${params.toString()}">${entry.n} ${escapeHtml(entry.type)}</a>`;
    })
    .join(" · ")}</p>`;
}
