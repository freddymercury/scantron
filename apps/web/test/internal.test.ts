import { afterEach, beforeEach, expect, test } from "bun:test";
import { enqueue, claim, fail as failJob, upsertObservation, ensureSourceConfiguration, recordSourcePayload, recordGap } from "@scantron/database";
import { createTestDatabase } from "@scantron/database/testing";
import { observationToRow, type Observation } from "@scantron/incident-schema";
import { createAppMetrics } from "@scantron/observability";

import {
  describeWindow,
  evaluateGate,
  handleInternal,
  isAuthorized,
  parseFilter,
  TIME_WINDOWS,
  windowStart,
} from "../src/internal/viewer.ts";
import { windowCounters, failedJobs, requeueJob } from "../src/internal/queries.ts";

const KEY = "test-internal-key";
let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = KEY;
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = previousKey;
});

function mapPoint(overrides: Partial<import("../src/internal/queries.ts").MapPoint>) {
  return {
    id: "obs_1",
    lat: 37.7793,
    lng: -122.4193,
    source: "sf_police_cad",
    type: "assault",
    occurred_at: "2026-09-18T01:00:00.000Z",
    subtype: "STABBING",
    location_normalized: "24th St & Mission St",
    location_raw: null,
    neighborhood: "Mission",
    units: null,
    priority_rank: 1,
    sensitive: null,
    ...overrides,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    source: "sf_police_cad",
    sourceRecordId: "262600914",
    occurredAt: new Date("2026-09-18T01:00:00.000Z"),
    ingestedAt: new Date("2026-09-18T01:30:00.000Z"),
    rawType: "219",
    subtype: "STABBING",
    type: "assault",
    location: { raw: "MISSION ST \\ 24TH ST", normalized: "24th St & Mission St", latitude: 37.75, longitude: -122.41, neighborhood: "Mission" },
    confidence: 0.6,
    ...overrides,
  } as Observation;
}

function seeded() {
  const db = createTestDatabase();
  ensureSourceConfiguration(db, { source: "sf_police_cad", datasetId: "gnap-fj3t" });
  upsertObservation(db, observationToRow(observation()));
  recordSourcePayload(db, {
    source: "sf_police_cad",
    sourceRecordId: "262600914",
    payload: { cad_number: "262600914", call_type_final: "219" },
    fetchedAt: new Date("2026-09-18T01:30:00.000Z"),
  });
  return db;
}

const request = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init);

test("without a key configured the internal route does not exist", async () => {
  delete process.env.INTERNAL_API_KEY;
  const db = seeded();
  const response = await handleInternal(request("/internal"), { db, metrics: createAppMetrics() });
  expect(response?.status).toBe(404);
  db.close();
});

test("an unauthenticated request is challenged, not served", async () => {
  const db = seeded();
  const response = await handleInternal(request("/internal"), { db, metrics: createAppMetrics() });
  expect(response?.status).toBe(401);
  expect(response?.headers.get("www-authenticate")).toContain("Basic");
  expect(await response?.text()).not.toContain("observations");
  db.close();
});

test("either a header secret or basic auth gets in; a wrong one does not", () => {
  expect(isAuthorized(request("/internal", { headers: { "x-scantron-internal-key": KEY } }), KEY)).toBe(true);
  expect(
    isAuthorized(request("/internal", { headers: { authorization: `Basic ${btoa(`ops:${KEY}`)}` } }), KEY),
  ).toBe(true);
  expect(isAuthorized(request("/internal", { headers: { "x-scantron-internal-key": "wrong" } }), KEY)).toBe(false);
  expect(isAuthorized(request("/internal"), KEY)).toBe(false);
  // Length differences must not be distinguishable by the comparison itself.
  expect(isAuthorized(request("/internal", { headers: { "x-scantron-internal-key": `${KEY}x` } }), KEY)).toBe(false);
});

test("the page shows raw payload beside the normalized observation", async () => {
  const db = seeded();
  const response = await handleInternal(
    request("/internal", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  const html = (await response?.text()) ?? "";

  expect(response?.status).toBe(200);
  expect(html).toContain("source payload");
  expect(html).toContain("normalized observation");
  expect(html).toContain("262600914");
  expect(html).toContain("24th St &amp; Mission St");
  // Internal pages are not for indexing, and not for caching.
  expect(html).toContain('name="robots" content="noindex,nofollow"');
  expect(response?.headers.get("cache-control")).toBe("no-store");
  // Inline style still runs under the nonce CSP, like everything else.
  const policy = response?.headers.get("content-security-policy") ?? "";
  const nonce = /style-src 'nonce-([^']+)'/.exec(policy)?.[1];
  expect(html).toContain(`<style nonce="${nonce}">`);
  db.close();
});

test("filters are parsed from the query string", () => {
  const url = new URL(
    "http://localhost/internal?source=sf_fire_cad&type=fire&neighborhood=Mission&geocoded=no&unmapped=1&from=2026-09-18T00:00:00Z",
  );
  expect(parseFilter(url)).toMatchObject({
    source: "sf_fire_cad",
    type: "fire",
    neighborhood: "Mission",
    geocoded: "no",
    unmappedOnly: true,
    // An explicit `from` wins over the preset, so a pinned window survives a reload.
    from: "2026-09-18T00:00:00Z",
  });
});

test("the default window is the last 24 hours, and presets resolve to timestamps", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");
  const plain = parseFilter(new URL("http://localhost/internal"), now);
  expect(plain.since).toBe("24h");
  expect(plain.from).toBe("2026-09-17T12:00:00.000Z");

  const shift = parseFilter(new URL("http://localhost/internal?since=8h"), now);
  expect(shift.from).toBe("2026-09-18T04:00:00.000Z");

  const quarter = parseFilter(new URL("http://localhost/internal?since=90d"), now);
  expect(quarter.from).toBe("2026-06-20T12:00:00.000Z");

  // "everything" means no lower bound at all, not a very large one.
  expect(parseFilter(new URL("http://localhost/internal?since=all"), now).from).toBeUndefined();
  expect(windowStart("nonsense", now)).toBeUndefined();
});

test("the time windows span the units this data is actually discussed in", () => {
  const values = TIME_WINDOWS.map((window) => window.value);
  // Minutes because a call develops over minutes; months because a trend question spans them.
  expect(values).toEqual(["15m", "1h", "4h", "8h", "24h", "3d", "7d", "30d", "90d", "all"]);
  expect(describeWindow("8h")).toBe("last shift (8 hours)");
});

test("counters report what would expose a failure, not what flatters", () => {
  const db = seeded();
  upsertObservation(
    db,
    observationToRow(
      observation({
        id: "obs_2",
        sourceRecordId: "2",
        type: "unknown",
        location: { raw: "Not Available" },
        sensitive: true,
      }),
    ),
  );

  const counters = windowCounters(db);
  expect(counters.total).toBe(2);
  expect(counters.geocodedPercent).toBe(50);
  // The sensitive call has no location upstream (docs/01 §8), so the honest denominator
  // for our own work excludes it.
  expect(counters.locatablePercent).toBe(100);
  expect(counters.typedPercent).toBe(50);
  expect(counters.duplicateUpserts).toBe(0);
  db.close();
});

test("the Phase 0 gate is evaluated from the same numbers, and fails loudly", () => {
  const now = new Date("2026-09-18T02:00:00.000Z");
  const counters = {
    total: 100,
    bySource: [],
    geocoded: 90,
    geocodedPercent: 90,
    locatablePercent: 98,
    typed: 95,
    typedPercent: 95,
    duplicateUpserts: 0,
    failedJobs: 0,
    pendingJobs: 0,
    quarantined: 0,
    openGaps: 0,
    unrecoverableGaps: 0,
    backfilled: 0,
    coverageHours: 12,
    newest: "2026-09-18T01:30:00.000Z",
  };

  const notYet = evaluateGate(counters, now);
  expect(notYet.passes).toBe(false);
  expect(notYet.reasons[0]).toContain("12.0 h of coverage, needs 72 h");

  // Ingesting without normalizing is not a working pipeline.
  const unnormalized = evaluateGate({ ...counters, typed: 0, coverageHours: 80 }, now);
  expect(unnormalized.reasons.join(" ")).toContain("nothing has been normalized");

  const passing = evaluateGate({
    total: 10_000,
    bySource: [],
    geocoded: 9_000,
    geocodedPercent: 90,
    locatablePercent: 98,
    typed: 9_500,
    typedPercent: 95,
    duplicateUpserts: 0,
    failedJobs: 0,
    pendingJobs: 0,
    quarantined: 0,
    openGaps: 0,
    unrecoverableGaps: 0,
    backfilled: 0,
    coverageHours: 80,
    newest: "2026-09-18T01:30:00.000Z",
  }, now);
  expect(passing.passes).toBe(true);

  // A long span means nothing if ingestion has since stopped.
  const stalled = evaluateGate({ ...passing, newest: "2026-09-17T00:00:00.000Z" } as never, now);
  expect(stalled.passes).toBe(false);
  expect(stalled.reasons.join(" ")).toContain("not current");

  // Duplicates and unrecoverable gaps fail the gate even with plenty of coverage.
  const duplicated = evaluateGate({ ...passing, duplicateUpserts: 3 } as never, now);
  expect(duplicated.passes).toBe(false);
});

test("a failed job is listed and can be requeued in one click", async () => {
  const db = seeded();
  const { job } = enqueue(db, { type: "geocode_location", payload: { observationId: "obs_1" }, maxAttempts: 1 });
  const claimed = claim(db, { worker: "w" })[0]!;
  failJob(db, claimed, new Error("geocoder exploded"));

  expect(failedJobs(db)).toHaveLength(1);
  expect(failedJobs(db)[0]?.last_error).toBe("geocoder exploded");

  const form = new FormData();
  form.set("id", job.id);
  const response = await handleInternal(
    request("/internal/jobs/requeue", {
      method: "POST",
      headers: { "x-scantron-internal-key": KEY },
      body: form,
    }),
    { db, metrics: createAppMetrics() },
  );

  expect(response?.status).toBe(303);
  expect(failedJobs(db)).toHaveLength(0);
  // Requeuing something that is not failed is a no-op, not an error.
  expect(requeueJob(db, job.id)).toBe(false);
  db.close();
});

test("gaps and quarantine show up in the counters", () => {
  const db = seeded();
  recordGap(db, {
    source: "sf_police_cad",
    from: new Date("2026-09-10T00:00:00.000Z"),
    to: new Date("2026-09-11T00:00:00.000Z"),
  });
  const counters = windowCounters(db);
  expect(counters.openGaps).toBe(1);
  expect(evaluateGate(counters).passes).toBe(false);
  db.close();
});

test("the map projects San Francisco into the viewport, corners included", async () => {
  const { project, MAP_WIDTH, MAP_HEIGHT } = await import("../src/internal/map.ts");
  const { SF_BBOX } = await import("@scantron/sf-domain");

  const northWest = project(SF_BBOX.north, SF_BBOX.west);
  const southEast = project(SF_BBOX.south, SF_BBOX.east);
  expect(northWest).toEqual({ x: 0, y: 0 });
  expect(southEast).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });

  // Civic Center lands in the middle-ish, and latitude is flipped for SVG's y axis.
  const civic = project(37.7793, -122.4193);
  expect(civic.x).toBeGreaterThan(0);
  expect(civic.x).toBeLessThan(MAP_WIDTH);
  expect(project(37.8, -122.42).y).toBeLessThan(project(37.72, -122.42).y);
});

test("the map renders points and neighborhood outlines", async () => {
  const { renderMap } = await import("../src/internal/map.ts");
  const svg = renderMap(
    [
      mapPoint({ id: "obs_a", lat: 37.7793, lng: -122.4193, source: "sf_police_cad", type: "assault" }),
      mapPoint({ id: "obs_b", lat: 37.75, lng: -122.41, source: "sf_fire_cad", type: "fire" }),
    ],
    [
      {
        name: "Mission",
        geometry: JSON.stringify({
          type: "Polygon",
          coordinates: [
            [
              [-122.42, 37.75],
              [-122.41, 37.75],
              [-122.41, 37.76],
              [-122.42, 37.76],
              [-122.42, 37.75],
            ],
          ],
        }),
      },
    ],
  );

  expect(svg).toContain("<svg");
  expect((svg.match(/<circle /g) ?? [])).toHaveLength(2);
  expect(svg).toContain("<title>Mission</title>");
  // Every point is a link to its record: click, middle-click and keyboard all work.
  expect(svg).toContain('href="/internal/observation/obs_a"');
  expect(svg).toContain('data-type="assault"');
  // Colours come from CSS variables, so the map follows the theme toggle.
  expect(svg).toContain("var(--police)");
});

test("the page carries a theme toggle whose script runs under the nonce", async () => {
  const db = seeded();
  const response = await handleInternal(
    request("/internal", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  const html = (await response?.text()) ?? "";
  const policy = response?.headers.get("content-security-policy") ?? "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];

  expect(html).toContain("data-theme-toggle");
  expect(html).toContain(`<script nonce="${nonce}">`);
  expect(html).toContain("scantron-theme");
  // No unsafe-inline escape hatch was added to make the toggle work.
  expect(policy).not.toContain("unsafe-inline");
  db.close();
});

test("selecting a neighborhood filters the rows and zooms the map", async () => {
  const db = seeded();
  upsertObservation(
    db,
    observationToRow(
      observation({
        id: "obs_sunset",
        sourceRecordId: "3",
        location: { normalized: "19th Ave & Irving St", latitude: 37.7636, longitude: -122.4772, neighborhood: "Sunset/Parkside" },
      }),
    ),
  );
  db.query(
    `INSERT INTO neighborhoods (name, geometry, min_lat, min_lng, max_lat, max_lng, source, loaded_at)
     VALUES ('Mission', '{"type":"Polygon","coordinates":[[[-122.43,37.74],[-122.40,37.74],[-122.40,37.77],[-122.43,37.77],[-122.43,37.74]]]}',
             37.74, -122.43, 37.77, -122.40, 'test', '2026-09-18T00:00:00.000Z')`,
  ).run();

  const response = await handleInternal(
    request("/internal?since=all&neighborhood=Mission", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  const html = (await response?.text()) ?? "";

  // Only the Mission observation is plotted and listed.
  expect((html.match(/<circle /g) ?? [])).toHaveLength(1);
  expect(html).toContain("24th St &amp; Mission St");
  expect(html).not.toContain("19th Ave &amp; Irving St");

  // The map is zoomed to the neighborhood rather than the whole city.
  expect(html).not.toContain(`viewBox="0 0 760 560"`);
  expect(html).toContain('class="hood focused"');
  db.close();
});

test("zooming keeps the projection and shrinks what is drawn in user units", async () => {
  const { viewBoxFor, MAP_WIDTH } = await import("../src/internal/map.ts");

  const whole = viewBoxFor(undefined);
  expect(whole.viewBox).toBe(`0 0 760 560`);
  expect(whole.scale).toBe(1);

  const mission = viewBoxFor({ min_lat: 37.74, min_lng: -122.43, max_lat: 37.77, max_lng: -122.4 });
  const [x, y, width] = mission.viewBox.split(" ").map(Number);
  expect(width as number).toBeLessThan(MAP_WIDTH);
  expect(x as number).toBeGreaterThan(0);
  expect(y as number).toBeGreaterThan(0);
  // Circles are in user units, so they must shrink with the view or a zoomed neighborhood
  // becomes a field of blobs.
  expect(mission.scale).toBeLessThan(1);
});

test("relative time speaks in the unit that fits", async () => {
  const { relativeTime } = await import("../src/internal/detail.ts");
  const now = new Date("2026-09-18T12:00:00.000Z");
  expect(relativeTime("2026-09-18T11:59:40.000Z", now)).toBe("just now");
  expect(relativeTime("2026-09-18T11:48:00.000Z", now)).toBe("12 min ago");
  expect(relativeTime("2026-09-18T04:00:00.000Z", now)).toBe("8 h ago");
  expect(relativeTime("2026-09-15T12:00:00.000Z", now)).toBe("3 d ago");
  expect(relativeTime("2026-08-28T12:00:00.000Z", now)).toBe("3 w ago");
  expect(relativeTime("2026-06-18T12:00:00.000Z", now)).toBe("3 mo ago");
});

test("clicking a point opens its record, with what was near it", async () => {
  const db = seeded();
  // A fire unit on the same corner five minutes later — the pair correlation will judge.
  upsertObservation(
    db,
    observationToRow(
      observation({
        id: "obs_fire",
        sourceRecordId: "fire-1",
        source: "sf_fire_cad",
        type: "medical",
        subtype: "Medical Incident",
        units: ["E07"],
        occurredAt: new Date("2026-09-18T01:05:00.000Z"),
        location: { normalized: "24th St & Mission St", latitude: 37.7502, longitude: -122.4101, neighborhood: "Mission" },
      }),
    ),
  );

  const response = await handleInternal(
    request("/internal/observation/obs_1", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  const html = (await response?.text()) ?? "";

  expect(response?.status).toBe(200);
  // The summary answers "what, where, when" before anything else.
  expect(html).toContain("STABBING · 24th St &amp; Mission St");
  expect(html).toContain("agency code");
  expect(html).toContain("219");
  // What else was happening beside it — the raw material of correlation.
  expect(html).toContain("within 450 m and an hour");
  expect(html).toContain("sf_fire_cad");
  expect(html).toContain("E07");
  // And the payload as fetched.
  expect(html).toContain("source payloads");
  expect(html).toContain("262600914");
  db.close();
});

test("an unknown observation id is a 404, not a blank page", async () => {
  const db = seeded();
  const response = await handleInternal(
    request("/internal/observation/nope", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  expect(response?.status).toBe(404);
  expect(await response?.text()).toContain("No observation with that id");
  db.close();
});

test("a record whose location was withheld says so rather than showing an empty map", async () => {
  const db = seeded();
  upsertObservation(
    db,
    observationToRow(
      observation({ id: "obs_secret", sourceRecordId: "s1", sensitive: true, location: undefined } as unknown as Partial<Observation>),
    ),
  );
  const response = await handleInternal(
    request("/internal/observation/obs_secret", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  const html = (await response?.text()) ?? "";
  expect(html).toContain("No location was published");
  expect(html).toContain("SFPD's suppression, not a gap in our geocoding");
  expect(html).not.toContain("<svg");
  db.close();
});

test("the hover card is an enhancement, not the only way in", async () => {
  const db = seeded();
  const response = await handleInternal(
    request("/internal?since=all", { headers: { "x-scantron-internal-key": KEY } }),
    { db, metrics: createAppMetrics() },
  );
  const html = (await response?.text()) ?? "";

  // Points are links first: click, middle-click and keyboard focus all work without JS.
  expect(html).toContain('<a href="/internal/observation/obs_1" class="pt"');
  expect(html).toContain('data-where="24th St &amp; Mission St"');
  expect(html).toContain('id="hovercard"');
  db.close();
});

test("a guessable internal credential is flagged, not silently accepted", async () => {
  const { isWeakKey } = await import("../src/internal/viewer.ts");
  for (const weak of ["admin", "password", "dev", "secret", "short"]) {
    expect(`${weak}: ${isWeakKey(weak)}`).toBe(`${weak}: true`);
  }
  expect(isWeakKey("2Iv1Bvqs6sfKL-_qvGguXPC1")).toBe(false);
  // Unset is a different thing entirely: the route does not exist at all.
  expect(isWeakKey(undefined)).toBe(false);
});
