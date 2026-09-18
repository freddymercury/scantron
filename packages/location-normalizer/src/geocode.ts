/**
 * Resolving a location to a point and a neighborhood (S-C2).
 *
 * Resolution order, and the order matters more than the mechanics:
 *   1. **Coordinates the source supplied.** ~63% of CAD calls already carry
 *      `intersection_point`; nothing we compute beats the dispatcher's own point.
 *   2. **Intersection lookup** — a text match on the canonical pair from S-C1, against a
 *      gazetteer derived from the city's own dispatch history.
 *   3. **Block interpolation** along the street centerline segment whose address range
 *      covers the number.
 *   4. **Unresolved** — which is a real answer, not a failure to hide.
 *
 * A point outside every neighborhood polygon yields `undefined`, never a nearest guess.
 */

import type { Database } from "bun:sqlite";
import type { LocationMethod } from "@scantron/incident-schema";
import {
  haversineMeters,
  neighborhoodAt,
  toNeighborhoodPolygon,
  type GeoJsonGeometry,
  type NeighborhoodPolygon,
  type Point,
} from "@scantron/sf-domain";

import { normalizeLocation, type NormalizedLocationText } from "./index.ts";

/** Published coordinates are snapped to ~11 m, per the coarse-location assumption. */
export const PUBLISH_PRECISION_DECIMALS = 4;

export function snapToBlockPrecision(value: number): number {
  const factor = 10 ** PUBLISH_PRECISION_DECIMALS;
  return Math.round(value * factor) / factor;
}

export interface GeocodeResult {
  latitude?: number;
  longitude?: number;
  neighborhood?: string;
  method: LocationMethod;
  confidence: number;
  canonical: string;
  kind: NormalizedLocationText["kind"];
  /** Why nothing was resolved, when nothing was. Reported by source in the shortfall. */
  reason?: string;
}

export interface GeocoderOptions {
  /** Reloaded on demand; 41 polygons, so holding them in memory is free. */
  neighborhoods?: NeighborhoodPolygon[];
}

interface IntersectionLookupRow {
  lat: number;
  lng: number;
}

interface SegmentRow {
  line: string;
  left_from: number | null;
  left_to: number | null;
  right_from: number | null;
  right_to: number | null;
  neighborhood: string | null;
}

export interface Geocoder {
  geocode(input: {
    raw?: string | undefined;
    latitude?: number | undefined;
    longitude?: number | undefined;
    neighborhood?: string | undefined;
  }): GeocodeResult;
  neighborhoodFor(point: Point): string | undefined;
  readonly polygonCount: number;
}

export function loadNeighborhoodPolygons(db: Database): NeighborhoodPolygon[] {
  return db
    .query<{ name: string; geometry: string }, []>("SELECT name, geometry FROM neighborhoods")
    .all()
    .map((row) => toNeighborhoodPolygon(row.name, JSON.parse(row.geometry) as GeoJsonGeometry));
}

export function createGeocoder(db: Database, options: GeocoderOptions = {}): Geocoder {
  const polygons = options.neighborhoods ?? loadNeighborhoodPolygons(db);

  const intersectionQuery = db.query<IntersectionLookupRow, [string]>(
    "SELECT lat, lng FROM intersections WHERE canonical = ?",
  );
  const segmentQuery = db.query<SegmentRow, [string]>(
    `SELECT line, left_from, left_to, right_from, right_to, neighborhood
       FROM street_segments WHERE street = ?`,
  );

  function neighborhoodFor(point: Point): string | undefined {
    return neighborhoodAt(point, polygons);
  }

  function withNeighborhood(result: GeocodeResult, supplied?: string): GeocodeResult {
    if (supplied) {
      // The source's own `analysis_neighborhood` is authoritative when present.
      result.neighborhood = supplied;
      return result;
    }
    if (result.latitude === undefined || result.longitude === undefined) return result;
    const found = neighborhoodFor({ lat: result.latitude, lng: result.longitude });
    if (found) result.neighborhood = found;
    return result;
  }

  function interpolate(parsed: NormalizedLocationText): GeocodeResult | undefined {
    const street = parsed.streets[0];
    const number = parsed.addressNumber;
    if (!street || number === undefined) return undefined;

    for (const segment of segmentQuery.all(street)) {
      const ranges: [number | null, number | null][] = [
        [segment.left_from, segment.left_to],
        [segment.right_from, segment.right_to],
      ];
      for (const [from, to] of ranges) {
        if (from === null || to === null || from === 0 || to === 0) continue;
        const low = Math.min(from, to);
        const high = Math.max(from, to);
        if (number < low || number > high) continue;

        const line = JSON.parse(segment.line) as { coordinates: number[][] };
        const point = pointAlong(line.coordinates, high === low ? 0 : (number - low) / (high - low));
        if (!point) continue;

        const result: GeocodeResult = {
          latitude: point.lat,
          longitude: point.lng,
          method: "block_interpolation",
          // Interpolation places a point on the right block, not at the right door.
          confidence: 0.6,
          canonical: parsed.canonical,
          kind: parsed.kind,
        };
        if (segment.neighborhood) result.neighborhood = segment.neighborhood;
        return result;
      }
    }
    return undefined;
  }

  return {
    polygonCount: polygons.length,
    neighborhoodFor,

    geocode(input): GeocodeResult {
      const parsed = normalizeLocation(input.raw);

      // 1. The source's own coordinates.
      if (typeof input.latitude === "number" && typeof input.longitude === "number") {
        return withNeighborhood(
          {
            latitude: input.latitude,
            longitude: input.longitude,
            method: "source_coordinates",
            confidence: 0.95,
            canonical: parsed.canonical,
            kind: parsed.kind,
          },
          input.neighborhood,
        );
      }

      // 2. The intersection gazetteer.
      if (parsed.kind === "intersection") {
        const hit = intersectionQuery.get(parsed.canonical);
        if (hit) {
          return withNeighborhood(
            {
              latitude: hit.lat,
              longitude: hit.lng,
              method: "intersection_lookup",
              confidence: 0.9,
              canonical: parsed.canonical,
              kind: parsed.kind,
            },
            input.neighborhood,
          );
        }
      }

      // 3. Block interpolation.
      if (parsed.kind === "address" || parsed.kind === "block") {
        const interpolated = interpolate(parsed);
        if (interpolated) return withNeighborhood(interpolated, input.neighborhood);
      }

      // 4. Unresolved, and said so.
      const unresolved: GeocodeResult = {
        method: "unresolved",
        confidence: 0,
        canonical: parsed.canonical,
        kind: parsed.kind,
        reason:
          parsed.kind === "unknown"
            ? "unparseable_location_text"
            : parsed.kind === "intersection"
              ? "intersection_not_in_gazetteer"
              : "no_matching_street_segment",
      };
      if (input.neighborhood) unresolved.neighborhood = input.neighborhood;
      return unresolved;
    },
  };
}

/** A point `fraction` of the way along a polyline, by distance rather than by vertex. */
export function pointAlong(coordinates: number[][], fraction: number): Point | undefined {
  if (coordinates.length === 0) return undefined;
  const points = coordinates
    .filter((pair) => pair.length >= 2)
    .map((pair) => ({ lat: pair[1] as number, lng: pair[0] as number }));
  if (points.length === 0) return undefined;
  if (points.length === 1) return points[0] as Point;

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const length = haversineMeters(points[i - 1] as Point, points[i] as Point);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return points[0] as Point;

  let target = Math.min(Math.max(fraction, 0), 1) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    const length = lengths[i] as number;
    if (target > length) {
      target -= length;
      continue;
    }
    const start = points[i] as Point;
    const end = points[i + 1] as Point;
    const t = length === 0 ? 0 : target / length;
    return { lat: start.lat + (end.lat - start.lat) * t, lng: start.lng + (end.lng - start.lng) * t };
  }
  return points.at(-1) as Point;
}
