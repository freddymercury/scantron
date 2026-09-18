import { expect, test } from "bun:test";
import {
  boundingBoxAround,
  containsPoint,
  geometryBoundingBox,
  haversineMeters,
  neighborhoodAt,
  pointInGeometry,
  toNeighborhoodPolygon,
  type GeoJsonGeometry,
} from "../src/index.ts";

const CIVIC_CENTER = { lat: 37.7793, lng: -122.4193 };
const FERRY_BUILDING = { lat: 37.7955, lng: -122.3937 };

test("haversine matches a known SF distance", () => {
  // Civic Center to the Ferry Building: ~1.80 km north, ~2.25 km east, so ~2.88 km.
  const meters = haversineMeters(CIVIC_CENTER, FERRY_BUILDING);
  expect(meters).toBeGreaterThan(2800);
  expect(meters).toBeLessThan(2950);
  expect(haversineMeters(CIVIC_CENTER, CIVIC_CENTER)).toBe(0);
});

test("haversine is symmetric", () => {
  expect(haversineMeters(CIVIC_CENTER, FERRY_BUILDING)).toBeCloseTo(
    haversineMeters(FERRY_BUILDING, CIVIC_CENTER),
    6,
  );
});

test("the bounding box prefilter never rejects a point inside the radius", () => {
  const radius = 400;
  const box = boundingBoxAround(CIVIC_CENTER, radius);
  for (let bearing = 0; bearing < 360; bearing += 15) {
    const radians = (bearing * Math.PI) / 180;
    // Walk `radius` metres out in each direction; every such point must be in the box.
    const latDelta = (radius / 6_371_008.8) * (180 / Math.PI);
    const point = {
      lat: CIVIC_CENTER.lat + latDelta * Math.cos(radians),
      lng:
        CIVIC_CENTER.lng +
        (latDelta / Math.cos((CIVIC_CENTER.lat * Math.PI) / 180)) * Math.sin(radians),
    };
    expect(haversineMeters(CIVIC_CENTER, point)).toBeLessThanOrEqual(radius + 1);
    expect(containsPoint(box, point)).toBe(true);
  }
});

const square: GeoJsonGeometry = {
  type: "Polygon",
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

const squareWithHole: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    square.coordinates[0] as number[][],
    [
      [-122.47, 37.73],
      [-122.43, 37.73],
      [-122.43, 37.77],
      [-122.47, 37.77],
      [-122.47, 37.73],
    ],
  ],
};

test("ray casting puts points inside and outside a polygon", () => {
  expect(pointInGeometry({ lat: 37.75, lng: -122.42 }, square)).toBe(true);
  expect(pointInGeometry({ lat: 37.75, lng: -122.3 }, square)).toBe(false);
  expect(pointInGeometry({ lat: 37.9, lng: -122.45 }, square)).toBe(false);
});

test("holes are holes", () => {
  const inHole = { lat: 37.75, lng: -122.45 };
  expect(pointInGeometry(inHole, square)).toBe(true);
  expect(pointInGeometry(inHole, squareWithHole)).toBe(false);
  expect(pointInGeometry({ lat: 37.71, lng: -122.42 }, squareWithHole)).toBe(true);
});

test("multipolygons match any of their parts", () => {
  const multi: GeoJsonGeometry = {
    type: "MultiPolygon",
    coordinates: [
      square.coordinates,
      [
        [
          [-122.3, 37.7],
          [-122.2, 37.7],
          [-122.2, 37.8],
          [-122.3, 37.8],
          [-122.3, 37.7],
        ],
      ],
    ],
  };
  expect(pointInGeometry({ lat: 37.75, lng: -122.42 }, multi)).toBe(true);
  expect(pointInGeometry({ lat: 37.75, lng: -122.25 }, multi)).toBe(true);
  expect(pointInGeometry({ lat: 37.75, lng: -122.35 }, multi)).toBe(false);
});

test("a geometry's bounding box covers its coordinates", () => {
  expect(geometryBoundingBox(square)).toEqual({
    south: 37.7,
    north: 37.8,
    west: -122.5,
    east: -122.4,
  });
});

test("neighborhood lookup returns the containing polygon, or nothing", () => {
  const polygons = [
    toNeighborhoodPolygon("West Square", square),
    toNeighborhoodPolygon("East Square", {
      type: "Polygon",
      coordinates: [
        [
          [-122.3, 37.7],
          [-122.2, 37.7],
          [-122.2, 37.8],
          [-122.3, 37.8],
          [-122.3, 37.7],
        ],
      ],
    }),
  ];
  expect(neighborhoodAt({ lat: 37.75, lng: -122.42 }, polygons)).toBe("West Square");
  expect(neighborhoodAt({ lat: 37.75, lng: -122.25 }, polygons)).toBe("East Square");
  expect(neighborhoodAt({ lat: 37.75, lng: -122.35 }, polygons)).toBeUndefined();
  expect(neighborhoodAt({ lat: 0, lng: 0 }, polygons)).toBeUndefined();
});
