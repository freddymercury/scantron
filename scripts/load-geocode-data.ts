/**
 * `bun run load:geocode-data` — build the geocoding gazetteer from the city's own data.
 *
 * Two loads, both repeatable:
 *
 *  1. **Intersections.** Rather than a separate gazetteer, this derives them from dispatch
 *     history: every historical call that carried both an `intersection_name` and an
 *     `intersection_point` is the city telling us where that corner is. Canonicalized
 *     through S-C1, so a lookup is a text match on `19th Ave & Irving St`.
 *  2. **Street centerlines** (`3psu-pn9h`, 17,170 segments) with their address ranges, for
 *     block interpolation.
 */

import {
  databasePath,
  migrate,
  openDatabase,
  upsertIntersections,
  upsertStreetSegments,
  type IntersectionRow,
  type StreetSegmentRow,
} from "@scantron/database";
import { normalizeLocation, normalizeStreetName } from "@scantron/location-normalizer";
import { geometryBoundingBox, type GeoJsonGeometry } from "@scantron/sf-domain";

import { createSocrataClient } from "../services/sf-cad-ingest/src/socrata.ts";

const HISTORICAL_DISPATCH = "2zdj-bwza";
const CENTERLINES = "3psu-pn9h";

interface IntersectionSource {
  intersection_name?: string;
  intersection_point?: { coordinates?: number[] };
  n?: string;
}

interface CenterlineSource {
  cnn?: string;
  street?: string;
  st_type?: string;
  lf_fadd?: string;
  lf_toadd?: string;
  rt_fadd?: string;
  rt_toadd?: string;
  line?: GeoJsonGeometry;
  nhood?: string;
  active?: boolean;
}

const addressNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

async function loadIntersections(client: ReturnType<typeof createSocrataClient>): Promise<IntersectionRow[]> {
  const rows = await client.query<IntersectionSource>({
    dataset: HISTORICAL_DISPATCH,
    select: "intersection_name, intersection_point, count(*) as n",
    where: "intersection_point IS NOT NULL",
    group: "intersection_name, intersection_point",
    order: "intersection_name",
    limit: 50_000,
  });

  const loadedAt = new Date().toISOString();
  const best = new Map<string, IntersectionRow>();

  for (const row of rows) {
    const coordinates = row.intersection_point?.coordinates;
    if (!row.intersection_name || !Array.isArray(coordinates)) continue;
    const [lng, lat] = coordinates as [number, number];
    if (typeof lat !== "number" || typeof lng !== "number") continue;

    const parsed = normalizeLocation(row.intersection_name);
    if (parsed.kind !== "intersection" || parsed.streets.length < 2) continue;

    const observations = Number(row.n ?? 1);
    const existing = best.get(parsed.canonical);
    // The same corner can carry slightly different points across years; keep the one the
    // most records agree on.
    if (existing && existing.observations >= observations) continue;

    best.set(parsed.canonical, {
      canonical: parsed.canonical,
      street_a: parsed.streets[0] as string,
      street_b: parsed.streets[1] as string,
      lat,
      lng,
      observations,
      source: HISTORICAL_DISPATCH,
      loaded_at: loadedAt,
    });
  }
  return [...best.values()];
}

async function loadSegments(client: ReturnType<typeof createSocrataClient>): Promise<StreetSegmentRow[]> {
  const rows = await client.query<CenterlineSource>({
    dataset: CENTERLINES,
    limit: 50_000,
  });

  const loadedAt = new Date().toISOString();
  const segments: StreetSegmentRow[] = [];

  for (const row of rows) {
    if (!row.cnn || !row.street || !row.line || row.active === false) continue;
    const street = normalizeStreetName(`${row.street} ${row.st_type ?? ""}`.trim());
    if (!street) continue;

    const bbox = geometryBoundingBox(row.line);
    if (!Number.isFinite(bbox.south) || !Number.isFinite(bbox.west)) continue;

    segments.push({
      cnn: row.cnn,
      street,
      left_from: addressNumber(row.lf_fadd),
      left_to: addressNumber(row.lf_toadd),
      right_from: addressNumber(row.rt_fadd),
      right_to: addressNumber(row.rt_toadd),
      min_lat: bbox.south,
      min_lng: bbox.west,
      max_lat: bbox.north,
      max_lng: bbox.east,
      line: JSON.stringify(row.line),
      neighborhood: row.nhood ?? null,
      source: CENTERLINES,
      loaded_at: loadedAt,
    });
  }
  return segments;
}

const client = createSocrataClient();
const db = openDatabase({ path: databasePath() });
migrate(db);

const intersections = await loadIntersections(client);
upsertIntersections(db, intersections);
console.log(`loaded ${intersections.length} intersections from ${HISTORICAL_DISPATCH}`);

const segments = await loadSegments(client);
upsertStreetSegments(db, segments);
console.log(`loaded ${segments.length} street segments from ${CENTERLINES}`);

db.close();
