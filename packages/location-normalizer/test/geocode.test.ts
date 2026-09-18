import { expect, test } from "bun:test";
import { createTestDatabase } from "@scantron/database/testing";
import { replaceNeighborhoods, upsertIntersections, upsertStreetSegments } from "@scantron/database";
import {
  createGeocoder,
  pointAlong,
  snapToBlockPrecision,
} from "../src/geocode.ts";

/** A square covering most of the city, so a point either lands in it or is outside SF. */
const TEST_POLYGON = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-122.5, 37.7],
      [-122.4, 37.7],
      [-122.4, 37.8],
      [-122.5, 37.8],
      [-122.5, 37.7],
    ],
  ],
};

function seeded() {
  const db = createTestDatabase();
  replaceNeighborhoods(db, [
    {
      name: "Test Sunset",
      geometry: JSON.stringify(TEST_POLYGON),
      min_lat: 37.7,
      min_lng: -122.5,
      max_lat: 37.8,
      max_lng: -122.4,
      source: "test",
      loaded_at: "2026-09-18T00:00:00.000Z",
    },
  ]);
  upsertIntersections(db, [
    {
      canonical: "19th Ave & Irving St",
      street_a: "19th Ave",
      street_b: "Irving St",
      lat: 37.763559498,
      lng: -122.477174111,
      observations: 4613,
      source: "2zdj-bwza",
      loaded_at: "2026-09-18T00:00:00.000Z",
    },
  ]);
  upsertStreetSegments(db, [
    {
      cnn: "1",
      street: "Mission St",
      left_from: 2300,
      left_to: 2398,
      right_from: 2301,
      right_to: 2399,
      min_lat: 37.75,
      min_lng: -122.42,
      max_lat: 37.752,
      max_lng: -122.418,
      line: JSON.stringify({
        type: "LineString",
        coordinates: [
          [-122.42, 37.75],
          [-122.418, 37.752],
        ],
      }),
      neighborhood: "Mission",
      source: "3psu-pn9h",
      loaded_at: "2026-09-18T00:00:00.000Z",
    },
  ]);
  return db;
}

test("the source's own coordinates win over everything we could compute", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);

  const result = geocoder.geocode({
    raw: "19TH AVE \\ IRVING ST",
    latitude: 37.7635,
    longitude: -122.4771,
  });
  expect(result.method).toBe("source_coordinates");
  expect(result.latitude).toBe(37.7635);
  expect(result.confidence).toBeGreaterThan(0.9);
  db.close();
});

test("an intersection resolves through the canonical pair, whatever the spelling", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);

  for (const raw of ["19TH AVE \\ IRVING ST", "IRVING ST/19TH AVE", "19th and Irving"]) {
    const result = geocoder.geocode({ raw });
    expect(`${raw}: ${result.method}`).toBe(`${raw}: intersection_lookup`);
    expect(result.latitude).toBeCloseTo(37.7636, 3);
    expect(result.longitude).toBeCloseTo(-122.4772, 3);
  }
  db.close();
});

test("a block number interpolates along its centerline segment", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);

  const start = geocoder.geocode({ raw: "2300 BLOCK OF MISSION ST" });
  const middle = geocoder.geocode({ raw: "2350 MISSION ST" });
  const end = geocoder.geocode({ raw: "2398 MISSION ST" });

  expect(start.method).toBe("block_interpolation");
  expect(start.latitude).toBeCloseTo(37.75, 4);
  expect(middle.latitude as number).toBeGreaterThan(start.latitude as number);
  expect(end.latitude as number).toBeGreaterThan(middle.latitude as number);
  expect(end.latitude).toBeCloseTo(37.752, 4);
  // Interpolation is a block, not a doorstep, and says so.
  expect(start.confidence).toBeLessThan(0.9);
  db.close();
});

test("an address outside every segment's range is unresolved, not snapped to the nearest", () => {
  const db = seeded();
  const result = createGeocoder(db).geocode({ raw: "9999 MISSION ST" });
  expect(result.method).toBe("unresolved");
  expect(result.reason).toBe("no_matching_street_segment");
  expect(result.latitude).toBeUndefined();
  db.close();
});

test("unresolved answers carry a reason, reportable by source", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);
  expect(geocoder.geocode({ raw: "Not Available" }).reason).toBe("unparseable_location_text");
  expect(geocoder.geocode({ raw: "NOWHERE ST \\ NEVER AVE" }).reason).toBe(
    "intersection_not_in_gazetteer",
  );
  db.close();
});

test("the source's neighborhood is used when present; otherwise the polygon decides", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);

  // 63% of records arrive with this already filled in — no point recomputing it.
  expect(
    geocoder.geocode({ raw: "19TH AVE \\ IRVING ST", neighborhood: "Sunset/Parkside" }).neighborhood,
  ).toBe("Sunset/Parkside");

  expect(geocoder.geocode({ raw: "19TH AVE \\ IRVING ST" }).neighborhood).toBe("Test Sunset");
  db.close();
});

test("a point outside every polygon gets no neighborhood, not the nearest one", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);
  // Oakland.
  expect(geocoder.geocode({ raw: "", latitude: 37.8044, longitude: -122.2712 }).neighborhood).toBeUndefined();
  expect(geocoder.neighborhoodFor({ lat: 37.75, lng: -122.45 })).toBe("Test Sunset");
  db.close();
});

test("published coordinates are snapped to block precision", () => {
  expect(snapToBlockPrecision(37.763559498)).toBe(37.7636);
  expect(snapToBlockPrecision(-122.477174111)).toBe(-122.4772);
  // ~11 m at this latitude: a block, not a doorstep.
  expect(String(snapToBlockPrecision(37.763559498)).split(".")[1]?.length).toBeLessThanOrEqual(4);
});

test("pointAlong walks a polyline by distance, not by vertex count", () => {
  const line = [
    [-122.42, 37.75],
    [-122.419, 37.75],
    [-122.41, 37.75],
  ];
  const half = pointAlong(line, 0.5);
  // Half the *distance* is past the middle vertex, which sits at 10% of the length.
  expect(half?.lng).toBeCloseTo(-122.415, 3);
  expect(pointAlong(line, 0)?.lng).toBeCloseTo(-122.42, 6);
  expect(pointAlong(line, 1)?.lng).toBeCloseTo(-122.41, 6);
  expect(pointAlong([], 0.5)).toBeUndefined();
});

test("geocoding a batch of 1,000 stays far inside the 60 s budget", () => {
  const db = seeded();
  const geocoder = createGeocoder(db);
  const started = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    geocoder.geocode({ raw: i % 2 === 0 ? "19TH AVE \\ IRVING ST" : "2350 MISSION ST" });
  }
  const elapsedMs = performance.now() - started;
  expect(elapsedMs).toBeLessThan(60_000);
  // Recorded rather than asserted tightly: the indexes are doing the work, and this is
  // the number to watch if that stops being true.
  console.log(`1,000 geocodes in ${elapsedMs.toFixed(1)} ms`);
  db.close();
});
