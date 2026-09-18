/**
 * The raw observation viewer (S-B4) — internal only, and the page Phase 0 is judged from.
 *
 * Access is a shared secret in a header or in basic auth, and **the route does not exist
 * unless `INTERNAL_API_KEY` is set**: an internal page that quietly serves everyone when a
 * variable is missing is worse than no page at all. Nothing here is linked publicly, and
 * S-E1 has not shipped, so this is the only surface on which raw source text appears.
 */

import type { Database } from "bun:sqlite";

import type { AppMetrics } from "@scantron/observability";

import { createNonce, escapeHtml, securityHeaders } from "../security.ts";
import { askBox, renderAnswer, renderExamples } from "../ask/render.ts";
import { parseQuestion } from "../ask/parse.ts";
import { expandForRetrieval, runAsk, runSearchFallback } from "../ask/answer.ts";
import { createJevClient } from "../ask/jev.ts";
import { renderDetail } from "./detail.ts";
import { renderMap } from "./map.ts";
import { INTERNAL_PREFIX } from "./paths.ts";
import {
  failedJobs,
  listObservations,
  mapPoints,
  neighborhoodBounds,
  neighborhoodShapes,
  neighborhoodsSeen,
  rawPayloads,
  requeueJob,
  sourceCoverage,
  unmappedCodes,
  windowCounters,
  type ObservationFilter,
  type ObservationListRow,
  type WindowCounters,
} from "./queries.ts";

export { INTERNAL_PREFIX } from "./paths.ts";

/**
 * Time windows for dispatch data. The short end is minutes because a call develops over
 * minutes; the long end is months because that is the span a trend question covers. In
 * between, `8h` is a shift and `24h` is "today so far" — the units people actually use
 * when talking about this, rather than a uniform ladder of round numbers.
 */
export const TIME_WINDOWS: readonly { value: string; label: string; minutes: number }[] = [
  { value: "15m", label: "last 15 minutes", minutes: 15 },
  { value: "1h", label: "last hour", minutes: 60 },
  { value: "4h", label: "last 4 hours", minutes: 4 * 60 },
  { value: "8h", label: "last shift (8 hours)", minutes: 8 * 60 },
  { value: "24h", label: "last 24 hours", minutes: 24 * 60 },
  { value: "3d", label: "last 3 days", minutes: 3 * 24 * 60 },
  { value: "7d", label: "last week", minutes: 7 * 24 * 60 },
  { value: "30d", label: "last month", minutes: 30 * 24 * 60 },
  { value: "90d", label: "last 3 months", minutes: 90 * 24 * 60 },
  { value: "all", label: "everything", minutes: 0 },
];

export const DEFAULT_WINDOW = "24h";

/** `since` → an absolute lower bound, so every query downstream deals in timestamps. */
export function windowStart(value: string | undefined, now: Date = new Date()): Date | undefined {
  const window = TIME_WINDOWS.find((candidate) => candidate.value === value);
  if (!window || window.minutes === 0) return undefined;
  return new Date(now.getTime() - window.minutes * 60_000);
}

export function internalKey(): string | undefined {
  return process.env.INTERNAL_API_KEY?.trim() || undefined;
}

/** Constant-time comparison, so a wrong key cannot be found one character at a time. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function isAuthorized(request: Request, key: string): boolean {
  const header = request.headers.get("x-scantron-internal-key");
  if (header && secretsMatch(header, key)) return true;

  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice("Basic ".length));
      const password = decoded.slice(decoded.indexOf(":") + 1);
      return secretsMatch(password, key);
    } catch {
      return false;
    }
  }
  return false;
}

function unauthorized(): Response {
  return new Response("unauthorized", {
    status: 401,
    headers: {
      ...securityHeaders(),
      "www-authenticate": 'Basic realm="scantron internal", charset="UTF-8"',
    },
  });
}

const STYLE = `
  /* Themed with variables so the toggle is one attribute on <html>, not two stylesheets. */
  :root {
    --bg: #fff; --fg: #16181d; --muted: #5b6270; --line: rgba(20,22,28,.18);
    --panel: #f6f7f9; --pass: #1a7f37; --fail: #b3261e;
    --police: #2f6fed; --fire: #e05a2b; --ems: #12a594; --other: #8a8f98;
    --hood: rgba(20,22,28,.14); --hood-fill: rgba(20,22,28,.03);
  }
  :root[data-theme="dark"] {
    --bg: #101216; --fg: #e6e8ec; --muted: #969cab; --line: rgba(230,232,236,.16);
    --panel: #171a20; --pass: #4ac26b; --fail: #ff7b72;
    --police: #6ea0ff; --fire: #ff9a63; --ems: #4fd6c4; --other: #9aa0aa;
    --hood: rgba(230,232,236,.22); --hood-fill: rgba(230,232,236,.03);
  }
  body {
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    margin: 0; padding: 1.5rem; background: var(--bg); color: var(--fg);
  }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  h2 { font-size: .95rem; margin: 1.5rem 0 .5rem; }
  .muted { color: var(--muted); }
  .topbar { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  .gate { padding: .75rem 1rem; border: 1px solid currentColor; border-radius: .25rem; margin: 1rem 0; }
  .pass { color: var(--pass); } .fail { color: var(--fail); }
  form { margin: 1rem 0; display: flex; gap: .5rem; flex-wrap: wrap; align-items: end; }
  label { display: flex; flex-direction: column; font-size: .8rem; color: var(--muted); }
  input, select, button {
    font: inherit; padding: .25rem; background: var(--panel); color: var(--fg);
    border: 1px solid var(--line); border-radius: .2rem;
  }
  button { cursor: pointer; padding: .25rem .6rem; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { position: sticky; top: 0; background: var(--bg); }
  details pre { white-space: pre-wrap; word-break: break-all; font-size: .75rem; max-height: 22rem; overflow: auto; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .counters { display: flex; gap: 1.25rem; flex-wrap: wrap; margin: .5rem 0 1rem; }
  .counters div { min-width: 7rem; }
  .counters b { display: block; font-size: 1.15rem; }
  .map { width: 100%; max-width: 760px; height: auto; background: var(--panel);
         border: 1px solid var(--line); border-radius: .25rem; }
  .map .hood { fill: var(--hood-fill); stroke: var(--hood); stroke-width: .7; }
  .legend { display: flex; gap: 1rem; font-size: .8rem; margin: .4rem 0 0; flex-wrap: wrap; }
  .legend span::before { content: "●"; margin-right: .3rem; }
  .legend .police { color: var(--police); } .legend .fire { color: var(--fire); }
  .legend .ems { color: var(--ems); }
  .brand a { color: inherit; text-decoration: none; }
  .pagetitle { margin: 0 0 .5rem; }
  a { color: var(--police); }
  a.pt circle { transition: r .08s ease; }
  a.pt:hover circle, a.pt:focus circle { r: 5; stroke: var(--fg); stroke-width: .8; outline: none; }
  #hovercard {
    position: fixed; z-index: 10; pointer-events: none; max-width: 22rem;
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: .3rem; padding: .5rem .6rem; font-size: .8rem; line-height: 1.4;
    box-shadow: 0 6px 24px rgba(0,0,0,.25);
  }
  #hovercard[hidden] { display: none; }
  details pre { background: var(--panel); padding: .5rem; border-radius: .25rem; }
  form.ask { margin: 1rem 0 .5rem; gap: .4rem; }
  form.ask input { flex: 1; min-width: 20rem; padding: .5rem .6rem; }
  .interp { margin: .25rem 0 1rem; font-size: .85rem; }
  .answer { border: 1px solid var(--line); border-radius: .3rem; padding: .75rem 1rem; }
  .answer p:first-child { margin-top: 0; }
  .highlight { border-left: 3px solid var(--police); padding: .35rem .75rem; margin: .6rem 0; }
  .examples { font-size: .85rem; }
`;

/**
 * Theme: OS preference by default, overridden by an explicit choice kept in localStorage.
 * Applied before first paint so the page does not flash the wrong theme on load.
 */
const THEME_SCRIPT = `
  (function () {
    var stored = null;
    try { stored = localStorage.getItem("scantron-theme"); } catch (e) {}
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = stored || (prefersDark ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    document.addEventListener("click", function (event) {
      var button = event.target.closest("[data-theme-toggle]");
      if (!button) return;
      var next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      button.textContent = next === "dark" ? "light mode" : "dark mode";
      try { localStorage.setItem("scantron-theme", next); } catch (e) {}
    });
    var toggle = document.querySelector("[data-theme-toggle]");
    if (toggle) toggle.textContent = theme === "dark" ? "light mode" : "dark mode";
  })();
`;

export function describeWindow(since: string): string {
  return TIME_WINDOWS.find((window) => window.value === since)?.label ?? since;
}

function counterBlock(counters: WindowCounters): string {
  const cells: [string, string][] = [
    ["observations", String(counters.total)],
    ["geocoded", `${counters.geocodedPercent.toFixed(1)}%`],
    ["geocoded (locatable)", `${counters.locatablePercent.toFixed(1)}%`],
    ["typed", `${counters.typedPercent.toFixed(1)}%`],
    ["backfilled", String(counters.backfilled)],
    ["duplicate upserts", String(counters.duplicateUpserts)],
    ["failed jobs", String(counters.failedJobs)],
    ["pending jobs", String(counters.pendingJobs)],
    ["quarantined", String(counters.quarantined)],
    ["open gaps", String(counters.openGaps)],
    ["unrecoverable gaps", String(counters.unrecoverableGaps)],
    ["coverage", `${counters.coverageHours.toFixed(1)} h`],
  ];
  return `<div class="counters">${cells
    .map(([label, value]) => `<div><b>${escapeHtml(value)}</b><span class="muted">${escapeHtml(label)}</span></div>`)
    .join("")}</div>`;
}

export interface PhaseZeroGate {
  continuousHours: number;
  duplicateUpserts: number;
  unrecoverableGaps: number;
  passes: boolean;
  reasons: string[];
}

/**
 * PRD §44: >=72 h of continuous ingestion, no duplicate explosion, no unexplained gaps.
 * Evaluated here rather than asserted anywhere else, because this is the page the decision
 * is supposed to be made from.
 *
 * "Continuous" is measured as the span from oldest to newest observation *with no recorded
 * gaps* — the span alone would happily pass on two records three days apart, which is why
 * a recorded gap fails the gate outright and why ingestion also has to be current now.
 */
export function evaluateGate(counters: WindowCounters, now: Date = new Date()): PhaseZeroGate {
  const reasons: string[] = [];
  if (counters.coverageHours < 72) {
    reasons.push(`${counters.coverageHours.toFixed(1)} h of coverage, needs 72 h`);
  }
  if (counters.newest) {
    const behindHours = (now.getTime() - new Date(counters.newest).getTime()) / 3_600_000;
    // The police feed is a ~30-minute batch (docs/01 §5), so three hours behind means
    // ingestion has stopped, whatever the historical span says.
    if (behindHours > 3) {
      reasons.push(`newest observation is ${behindHours.toFixed(1)} h old — ingestion is not current`);
    }
  }
  if (counters.duplicateUpserts > 0) {
    reasons.push(`${counters.duplicateUpserts} duplicate source records`);
  }
  if (counters.unrecoverableGaps > 0) {
    reasons.push(`${counters.unrecoverableGaps} unrecoverable gap(s)`);
  }
  if (counters.total === 0) reasons.push("no observations ingested");
  // Ingesting without normalizing is not a working pipeline, and the gate is about the
  // pipeline rather than about the poller.
  if (counters.total > 0 && counters.typed === 0) {
    reasons.push("nothing has been normalized — the worker is not keeping up");
  }
  return {
    continuousHours: counters.coverageHours,
    duplicateUpserts: counters.duplicateUpserts,
    unrecoverableGaps: counters.unrecoverableGaps,
    passes: reasons.length === 0,
    reasons,
  };
}

/**
 * Hover card for map points. The point itself is a link, so click, middle-click, keyboard
 * and no-JS already work; this only adds the summary you want before deciding to click.
 */
const HOVER_SCRIPT = `
  (function () {
    var card = null;
    function ensure() {
      card = card || document.getElementById("hovercard");
      return card;
    }
    function show(anchor, event) {
      var el = ensure();
      if (!el) return;
      var d = anchor.dataset;
      var bits = [];
      bits.push('<b>' + (d.label || d.type || "unknown") + '</b>');
      if (d.where) bits.push('<span>' + d.where + '</span>');
      var meta = [d.source];
      if (d.units) meta.push(d.units);
      if (d.priority) meta.push("priority " + d.priority + "/5");
      if (d.sensitive) meta.push("sensitive");
      bits.push('<span class="muted">' + meta.join(" · ") + '</span>');
      bits.push('<span class="muted">' + new Date(d.at).toLocaleString() + '</span>');
      el.innerHTML = bits.join("<br>");
      el.hidden = false;
      var pad = 14;
      var x = Math.min(event.clientX + pad, window.innerWidth - el.offsetWidth - pad);
      var y = Math.min(event.clientY + pad, window.innerHeight - el.offsetHeight - pad);
      el.style.left = x + "px";
      el.style.top = y + "px";
    }
    function hide() {
      var el = ensure();
      if (el) el.hidden = true;
    }
    document.addEventListener("mouseover", function (event) {
      var anchor = event.target.closest && event.target.closest("a.pt");
      if (anchor) show(anchor, event);
    });
    document.addEventListener("mousemove", function (event) {
      var anchor = event.target.closest && event.target.closest("a.pt");
      if (anchor) show(anchor, event);
      else hide();
    });
    document.addEventListener("focusin", function (event) {
      var anchor = event.target.closest && event.target.closest("a.pt");
      if (!anchor) return hide();
      var box = anchor.getBoundingClientRect();
      show(anchor, { clientX: box.left, clientY: box.bottom });
    });
    document.addEventListener("mouseleave", hide, true);
  })();
`;

function filterForm(
  filter: ObservationFilter & { since: string },
  sources: string[],
  types: string[],
  neighborhoods: { neighborhood: string; n: number }[],
): string {
  const option = (value: string, selected: string | undefined, label = value || "any") =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

  return `<form method="get">
    <label>since<select name="since">${TIME_WINDOWS.map((window) =>
      option(window.value, filter.since, window.label),
    ).join("")}</select></label>
    <label>neighborhood<select name="neighborhood">${[
      option("", filter.neighborhood, "anywhere"),
      ...neighborhoods.map((row) =>
        option(row.neighborhood, filter.neighborhood, `${row.neighborhood} (${row.n})`),
      ),
    ].join("")}</select></label>
    <label>source<select name="source">${["", ...sources].map((value) => option(value, filter.source)).join("")}</select></label>
    <label>type<select name="type">${["", ...types].map((value) => option(value, filter.type)).join("")}</select></label>
    <label>geocoded<select name="geocoded">${["", "yes", "no"].map((value) => option(value, filter.geocoded)).join("")}</select></label>
    <label>unmapped only<input type="checkbox" name="unmapped" value="1"${filter.unmappedOnly ? " checked" : ""}></label>
    <button type="submit">apply</button>
    ${filter.neighborhood || filter.source || filter.type || filter.since !== DEFAULT_WINDOW ? `<a href="${INTERNAL_PREFIX}">reset</a>` : ""}
  </form>`;
}

function observationRow(db: Database, row: ObservationListRow): string {
  const payloads = rawPayloads(db, row.source, row.source_record_id ?? "");
  const normalized = {
    id: row.id,
    source: row.source,
    sourceRecordId: row.source_record_id,
    occurredAt: row.occurred_at,
    ingestedAt: row.ingested_at,
    type: row.type,
    typeConfidence: row.type_confidence,
    rawType: row.raw_type,
    subtype: row.subtype,
    priority: row.priority,
    priorityRank: row.priority_rank,
    location: {
      raw: row.location_raw,
      normalized: row.location_normalized,
      neighborhood: row.neighborhood,
      latitude: row.lat,
      longitude: row.lng,
      method: row.location_method,
    },
    units: row.units ? (JSON.parse(row.units) as string[]) : [],
    sensitive: row.sensitive === 1,
    backfilled: row.backfilled === 1,
  };

  const raw = payloads[0]?.payload ?? "(no stored payload)";
  const formatted = payloads[0] ? JSON.stringify(JSON.parse(raw) as object, null, 2) : raw;

  return `<tr>
    <td>${escapeHtml(row.occurred_at)}</td>
    <td>${escapeHtml(row.source)}</td>
    <td>${escapeHtml(row.type ?? "—")}${row.type === "unknown" || row.type === null ? ` <span class="muted">(${escapeHtml(row.raw_type ?? "no code")})</span>` : ""}</td>
    <td>${escapeHtml(row.location_normalized ?? row.location_raw ?? "—")}</td>
    <td>${row.lat === null ? '<span class="muted">not located</span>' : escapeHtml(`${row.lat.toFixed(4)}, ${(row.lng ?? 0).toFixed(4)}`)}</td>
    <td>${escapeHtml(row.neighborhood ?? "—")}</td>
    <td>${row.sensitive === 1 ? "sensitive" : ""}${row.backfilled === 1 ? " backfilled" : ""}</td>
    <td><details><summary>raw + normalized</summary>
      <div class="cols">
        <div><b>source payload</b><pre>${escapeHtml(formatted)}</pre></div>
        <div><b>normalized observation</b><pre>${escapeHtml(JSON.stringify(normalized, null, 2))}</pre></div>
      </div>
      ${payloads.length > 1 ? `<p class="muted">${payloads.length} stored payloads for this record — the source changed it.</p>` : ""}
    </details></td>
  </tr>`;
}

export function parseFilter(url: URL, now: Date = new Date()): ObservationFilter & { since: string } {
  const since = url.searchParams.get("since")?.trim() || DEFAULT_WINDOW;
  const filter: ObservationFilter & { since: string } = { limit: 50, since };
  const take = (name: string) => url.searchParams.get(name)?.trim() || undefined;

  const source = take("source");
  if (source) filter.source = source;
  const type = take("type");
  if (type) filter.type = type;
  const neighborhood = take("neighborhood");
  if (neighborhood) filter.neighborhood = neighborhood;

  // An explicit `from` wins over the preset, so a pinned window survives a reload.
  const start = windowStart(since, now);
  if (start) filter.from = start.toISOString();
  const from = take("from");
  if (from) filter.from = from;
  const to = take("to");
  if (to) filter.to = to;
  const geocoded = take("geocoded");
  if (geocoded) filter.geocoded = geocoded;
  if (url.searchParams.get("unmapped") === "1") filter.unmappedOnly = true;
  const offset = Number(take("offset") ?? 0);
  if (Number.isFinite(offset) && offset > 0) filter.offset = offset;
  return filter;
}

/** One shell for every internal page: same styles, same theme, same hover behaviour. */
export function page(nonce: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>scantron — ${escapeHtml(title)} (internal)</title>
<style nonce="${nonce}">${STYLE}</style>
<script nonce="${nonce}">${THEME_SCRIPT}</script>
<script nonce="${nonce}">${HOVER_SCRIPT}</script>
<div class="topbar">
  <h1 class="brand"><a href="${INTERNAL_PREFIX}">scantron</a> <span class="muted">internal · not public</span></h1>
  <button type="button" data-theme-toggle>dark mode</button>
</div>
<div id="hovercard" hidden></div>
${body}`;
}

export function renderViewer(db: Database, url: URL, nonce: string): string {
  const filter = parseFilter(url);
  const counters = windowCounters(db, filter);
  const gate = evaluateGate(counters);
  const rows = listObservations(db, filter);
  const coverage = sourceCoverage(db);
  const gaps = unmappedCodes(db, 10);
  const failed = failedJobs(db);
  const points = mapPoints(db, filter);
  const shapes = neighborhoodShapes(db);
  const neighborhoods = neighborhoodsSeen(db);
  const focus = filter.neighborhood ? neighborhoodBounds(db, filter.neighborhood) : undefined;

  const sources = coverage.map((row) => row.source);
  const types = db
    .query<{ type: string }, []>("SELECT DISTINCT type FROM observations WHERE type IS NOT NULL ORDER BY type")
    .all()
    .map((row) => row.type);

  return page(
    nonce,
    "raw observations",
    `<h2 class="pagetitle">raw observations</h2>
${askBox()}
<div class="gate ${gate.passes ? "pass" : "fail"}">
  <b>Phase 0 gate: ${gate.passes ? "PASS" : "not yet"}</b>
  <div class="muted">PRD §44 — ≥72 h continuous ingestion, no duplicate explosion, no unexplained gaps.</div>
  <div class="muted">Coverage is the span from oldest to newest observation; any recorded gap fails the gate.</div>
  ${gate.reasons.length > 0 ? `<ul>${gate.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>` : ""}
</div>

${counterBlock(counters)}

<table>
  <tr><th>source</th><th>observations</th><th>first</th><th>last</th><th>last poll ok</th><th>failures</th></tr>
  ${coverage
    .map(
      (row) => `<tr><td>${escapeHtml(row.source)}</td><td>${row.observations}</td>
        <td>${escapeHtml(row.first_at ?? "—")}</td><td>${escapeHtml(row.last_at ?? "—")}</td>
        <td>${escapeHtml(row.last_success_at ?? "never")}</td><td>${row.consecutive_failures}</td></tr>`,
    )
    .join("")}
</table>

${filterForm(filter, sources, types, neighborhoods)}

<h2>map <span class="muted">${filter.neighborhood ? `${escapeHtml(filter.neighborhood)} · ` : ""}${points.length} located of ${counters.total} · ${describeWindow(filter.since)}${
    counters.total - counters.geocoded > 0
      ? ` — ${counters.total - counters.geocoded} have no point, almost all sensitive calls SFPD publishes without a location`
      : ""
  }</span></h2>
${renderMap(points, shapes, {
  ...(focus ? { focus } : {}),
  ...(filter.neighborhood ? { focusName: filter.neighborhood } : {}),
})}
<p class="legend"><span class="police">police</span><span class="fire">fire</span><span class="ems">EMS</span></p>

<table>
  <tr><th>occurred</th><th>source</th><th>type</th><th>location</th><th>point</th><th>neighborhood</th><th>flags</th><th></th></tr>
  ${rows.map((row) => observationRow(db, row)).join("")}
</table>
${rows.length === 0 ? "<p class=\"muted\">no observations match this filter</p>" : ""}

<h2>unmapped codes <span class="muted">most frequent first</span></h2>
<table>
  <tr><th>source</th><th>code</th><th>label</th><th>count</th></tr>
  ${gaps
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.raw_type ?? "—")}</td><td>${escapeHtml(row.subtype ?? "—")}</td><td>${row.n}</td></tr>`,
    )
    .join("")}
</table>
${gaps.length === 0 ? "<p class=\"muted\">every observed code maps to a type</p>" : ""}

<h2>failed jobs</h2>
<table>
  <tr><th>type</th><th>attempts</th><th>error</th><th>when</th><th></th></tr>
  ${failed
    .map(
      (job) => `<tr>
        <td>${escapeHtml(job.type)}</td>
        <td>${job.attempts}/${job.max_attempts}</td>
        <td>${escapeHtml(job.last_error ?? "—")}</td>
        <td>${escapeHtml(job.updated_at)}</td>
        <td><form method="post" action="${INTERNAL_PREFIX}/jobs/requeue">
          <input type="hidden" name="id" value="${escapeHtml(job.id)}">
          <button type="submit">requeue</button>
        </form></td>
      </tr>`,
    )
    .join("")}
</table>
${failed.length === 0 ? "<p class=\"muted\">no failed jobs</p>" : ""}
`,
  );
}

export interface InternalContext {
  db?: Database;
  metrics: AppMetrics;
}

/**
 * Returns `undefined` when the path is not internal, so the caller can fall through.
 */
export async function handleInternal(
  request: Request,
  context: InternalContext,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(INTERNAL_PREFIX)) return undefined;

  const key = internalKey();
  // No key configured, no internal surface. Failing closed is the only safe default for a
  // page that shows raw source text.
  if (!key) return new Response("not found", { status: 404, headers: securityHeaders() });
  if (!isAuthorized(request, key)) return unauthorized();

  const db = context.db;
  if (!db) return new Response("no database", { status: 503, headers: securityHeaders() });

  if (url.pathname === `${INTERNAL_PREFIX}/jobs/requeue` && request.method === "POST") {
    const form = await request.formData();
    const id = String(form.get("id") ?? "");
    const requeued = requeueJob(db, id);
    return new Response(null, {
      status: 303,
      headers: { ...securityHeaders(), location: INTERNAL_PREFIX + (requeued ? "" : "?requeue=failed") },
    });
  }

  if (url.pathname === `${INTERNAL_PREFIX}/ask`) {
    const nonce = createNonce();
    const question = url.searchParams.get("q")?.trim() ?? "";

    if (!question) {
      return new Response(
        page(nonce, "ask", `${askBox()}<div class="answer"><p>Ask about activity in a neighborhood over a window of time.</p>${renderExamples()}</div>`),
        { headers: { "content-type": "text/html; charset=utf-8", ...securityHeaders(nonce) } },
      );
    }

    const areas = db
      .query<{ neighborhood: string }, []>(
        "SELECT DISTINCT neighborhood FROM observations WHERE neighborhood IS NOT NULL",
      )
      .all()
      .map((row) => row.neighborhood);

    const query = parseQuestion(question, { knownAreas: areas });
    // One-click corrections come back as overrides on the same question, so the parse
    // stays visible and the correction is explicit rather than a silent re-guess.
    const areaOverride = url.searchParams.get("area");
    if (areaOverride !== null) {
      if (areaOverride === "") delete query.area;
      else query.area = areaOverride;
    }
    const windowOverride = Number(url.searchParams.get("window") ?? Number.NaN);
    if (Number.isFinite(windowOverride) && windowOverride > 0) {
      query.windowMinutes = windowOverride;
      query.windowLabel = windowOverride === 1440 ? "the last 24 hours" : `the last ${windowOverride} minutes`;
    }
    if (url.searchParams.get("category") === "") {
      query.types = [];
      query.rawCodes = [];
      delete query.categoryLabel;
    }

    const client = createJevClient();

    // Words the grammar could not place still say what the question is about. Expanding
    // them into types *before* the main query is what turns "gunshots somewhere downtown"
    // into weapon calls in the Financial District, rather than everything that happened
    // there plus a separate list of keyword hits.
    let expansion: Awaited<ReturnType<typeof expandForRetrieval>> | undefined;
    if (query.unresolved.length > 0 && !query.unanswerable && !query.categoryLabel) {
      expansion = await expandForRetrieval(db, query, client);
      if (expansion.types.length > 0) {
        query.types = expansion.types as never;
        query.rawCodes = expansion.rawCodes;
        query.categoryLabel = `${query.unresolved.join(" ")} → ${expansion.types.join(", ")} calls`;
      }
    }

    const answer = runAsk(db, query);
    // Anything still unplaced is a keyword search, not a dead end.
    if (query.unresolved.length > 0 && !query.unanswerable && !expansion?.types.length) {
      answer.search = await runSearchFallback(db, query, new Date(), client);

      const outcome = answer.search.reranked
        ? "answered"
        : client.stats.timeouts > 0
          ? "timeout"
          : client.available
            ? "failed"
            : "skipped";
      context.metrics.searchRerankOutcomes.increment({ outcome });
      if (client.stats.requests > 0) {
        context.metrics.searchRerankSeconds.observe(client.stats.lastMs / 1000);
        context.metrics.searchRerankCostUsd.increment({}, client.stats.costUsd);
      }
    }
    return new Response(page(nonce, "ask", renderAnswer(answer)), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders(nonce),
      },
    });
  }

  if (url.pathname.startsWith(`${INTERNAL_PREFIX}/observation/`)) {
    const id = decodeURIComponent(url.pathname.slice(`${INTERNAL_PREFIX}/observation/`.length));
    const nonce = createNonce();
    const body = renderDetail(db, id);
    if (!body) {
      return new Response(page(nonce, "not found", '<p>No observation with that id.</p>'), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", ...securityHeaders(nonce) },
      });
    }
    return new Response(page(nonce, "observation", body), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders(nonce),
      },
    });
  }

  if (url.pathname === INTERNAL_PREFIX || url.pathname === `${INTERNAL_PREFIX}/`) {
    const nonce = createNonce();
    return new Response(renderViewer(db, url, nonce), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...securityHeaders(nonce),
      },
    });
  }

  return new Response("not found", { status: 404, headers: securityHeaders() });
}
