/**
 * `bun run load:neighborhoods` — load SF Analysis Neighborhood polygons into the database.
 *
 * Repeatable: it replaces rows by name in one transaction, so running it after a boundary
 * revision is the whole update procedure. Point-in-polygon happens in TypeScript against
 * these 41 polygons (ADR-002 §3), so the bounding box is precomputed here, once.
 */

import {
  NEIGHBORHOODS_DATASET_ID,
  databasePath,
  migrate,
  openDatabase,
  replaceNeighborhoods,
  type NeighborhoodRow,
} from "@scantron/database";
import { geometryBoundingBox, type GeoJsonGeometry } from "@scantron/sf-domain";

const HOST = process.env.DATASF_HOST ?? "https://data.sf.gov";
const URL_ = `${HOST}/resource/${NEIGHBORHOODS_DATASET_ID}.json?$limit=500`;

interface SourceRow {
  nhood?: string;
  the_geom?: GeoJsonGeometry;
}

async function main(): Promise<void> {
  const headers: Record<string, string> = {};
  const token = process.env.DATASF_APP_TOKEN?.trim();
  if (token) headers["X-App-Token"] = token;

  const response = await fetch(URL_, { headers });
  if (!response.ok) {
    console.error(`load:neighborhoods failed: ${response.status} ${response.statusText} from ${URL_}`);
    process.exit(1);
  }

  const loadedAt = new Date().toISOString();
  const rows: NeighborhoodRow[] = [];
  for (const row of (await response.json()) as SourceRow[]) {
    if (!row.nhood || !row.the_geom) continue;
    const bbox = geometryBoundingBox(row.the_geom);
    rows.push({
      name: row.nhood,
      geometry: JSON.stringify(row.the_geom),
      min_lat: bbox.south,
      min_lng: bbox.west,
      max_lat: bbox.north,
      max_lng: bbox.east,
      source: NEIGHBORHOODS_DATASET_ID,
      loaded_at: loadedAt,
    });
  }

  if (rows.length === 0) {
    console.error("load:neighborhoods failed: source returned no usable polygons");
    process.exit(1);
  }

  const db = openDatabase({ path: databasePath() });
  migrate(db);
  const count = replaceNeighborhoods(db, rows);
  db.close();
  console.log(`loaded ${count} neighborhoods from ${NEIGHBORHOODS_DATASET_ID}`);
}

await main();
