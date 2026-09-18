/**
 * The geo math we own instead of PostGIS (ADR-002 §3): haversine, a bounding-box
 * prefilter, and ray-casting point-in-polygon against ~40 Analysis Neighborhood polygons.
 * At this size the prefilter is the whole optimization — no spatial index required.
 */

export interface Point {
  lat: number;
  lng: number;
}

export interface BoundingBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a: Point, b: Point): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A bounding box that certainly contains everything within `meters` of `centre`.
 * Used as a cheap SQL prefilter before haversine; deliberately generous rather than exact.
 */
export function boundingBoxAround(centre: Point, meters: number): BoundingBox {
  const latDelta = (meters / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos(toRadians(centre.lat)), 1e-6);
  const lngDelta = latDelta / cosLat;
  return {
    south: centre.lat - latDelta,
    north: centre.lat + latDelta,
    west: centre.lng - lngDelta,
    east: centre.lng + lngDelta,
  };
}

export function containsPoint(box: BoundingBox, point: Point): boolean {
  return (
    point.lat >= box.south &&
    point.lat <= box.north &&
    point.lng >= box.west &&
    point.lng <= box.east
  );
}

/** GeoJSON ring: `[lng, lat]` pairs, as the spec orders them. */
export type Ring = readonly (readonly [number, number])[];
export type PolygonRings = readonly Ring[];
export type MultiPolygonRings = readonly PolygonRings[];

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: number[][][];
}

export interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: number[][][][];
}

export type GeoJsonGeometry = GeoJsonPolygon | GeoJsonMultiPolygon;

/**
 * Ray casting. A point exactly on an edge is not guaranteed either way — an ambiguity
 * that is irrelevant at neighborhood scale and not worth the code to resolve.
 */
export function pointInRing(point: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const current = ring[i];
    const previous = ring[j];
    if (!current || !previous) continue;

    const [lngI, latI] = current;
    const [lngJ, latJ] = previous;

    const straddles = latI > point.lat !== latJ > point.lat;
    if (!straddles) continue;

    const lngAtLat = ((lngJ - lngI) * (point.lat - latI)) / (latJ - latI) + lngI;
    if (point.lng < lngAtLat) inside = !inside;
  }
  return inside;
}

/** First ring is the outer boundary; any further rings are holes. */
export function pointInPolygon(point: Point, rings: PolygonRings): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !pointInRing(point, outer)) return false;
  return !holes.some((hole) => pointInRing(point, hole));
}

export function pointInGeometry(point: Point, geometry: GeoJsonGeometry): boolean {
  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates as unknown as PolygonRings);
  }
  return (geometry.coordinates as unknown as MultiPolygonRings).some((polygon) =>
    pointInPolygon(point, polygon),
  );
}

export function geometryBoundingBox(geometry: GeoJsonGeometry): BoundingBox {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;

  const visit = (coordinates: unknown): void => {
    if (
      Array.isArray(coordinates) &&
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      const [lng, lat] = coordinates as [number, number];
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      return;
    }
    if (Array.isArray(coordinates)) coordinates.forEach(visit);
  };
  visit(geometry.coordinates);

  return { south, north, west, east };
}

export interface NeighborhoodPolygon {
  name: string;
  geometry: GeoJsonGeometry;
  /** Precomputed, because the prefilter is what makes the lookup cheap. */
  bbox: BoundingBox;
}

export function toNeighborhoodPolygon(name: string, geometry: GeoJsonGeometry): NeighborhoodPolygon {
  return { name, geometry, bbox: geometryBoundingBox(geometry) };
}

/**
 * Point → neighborhood name. Bounding box first (a cheap reject for ~39 of ~40 polygons),
 * ray-casting only for survivors. Callers hold the polygon list in memory (S-C2).
 */
export function neighborhoodAt(
  point: Point,
  polygons: readonly NeighborhoodPolygon[],
): string | undefined {
  for (const polygon of polygons) {
    if (!containsPoint(polygon.bbox, point)) continue;
    if (pointInGeometry(point, polygon.geometry)) return polygon.name;
  }
  return undefined;
}
