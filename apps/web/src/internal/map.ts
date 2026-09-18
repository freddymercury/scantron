/**
 * The map (a first cut of S-F3, rendered here because the viewer is where you judge
 * whether the data is any good).
 *
 * ADR-002 §2 is the reason this is 60 lines rather than a dependency: San Francisco is a
 * fixed bounding box, so projecting lat/lng to SVG is arithmetic. No tiles, no basemap, no
 * pan or zoom — those are what would justify MapLibre, and we do not need them yet.
 */

import { SF_BBOX, type GeoJsonGeometry } from "@scantron/sf-domain";

import { escapeHtml } from "../security.ts";
import type { MapPoint, NeighborhoodShape } from "./queries.ts";

export const MAP_WIDTH = 760;
export const MAP_HEIGHT = 560;

/** Linear projection. Latitude is flipped because SVG y grows downward. */
export function project(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng - SF_BBOX.west) / (SF_BBOX.east - SF_BBOX.west)) * MAP_WIDTH;
  const y = ((SF_BBOX.north - lat) / (SF_BBOX.north - SF_BBOX.south)) * MAP_HEIGHT;
  return { x, y };
}

function ringPath(ring: number[][]): string {
  return `${ring
    .map((pair, index) => {
      const { x, y } = project(pair[1] as number, pair[0] as number);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ")} Z`;
}

export function geometryPath(geometry: GeoJsonGeometry): string {
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : (geometry.coordinates as unknown as number[][][][]);
  return polygons.map((rings) => rings.map((ring) => ringPath(ring)).join(" ")).join(" ");
}

/** Source → colour. Kept to three, because there are three sources. */
const SOURCE_COLOURS: Record<string, string> = {
  sf_police_cad: "var(--police)",
  sf_fire_cad: "var(--fire)",
  sf_ems_cad: "var(--ems)",
};

export function renderMap(points: MapPoint[], shapes: NeighborhoodShape[]): string {
  const outlines = shapes
    .map((shape) => {
      const path = geometryPath(JSON.parse(shape.geometry) as GeoJsonGeometry);
      return `<path d="${path}" class="hood"><title>${escapeHtml(shape.name)}</title></path>`;
    })
    .join("");

  const circles = points
    .map((point) => {
      const { x, y } = project(point.lat, point.lng);
      const colour = SOURCE_COLOURS[point.source] ?? "var(--other)";
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="${colour}"><title>${escapeHtml(
        `${point.type ?? "unknown"} · ${point.source}`,
      )}</title></circle>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" class="map" role="img"
    aria-label="${points.length} located observations plotted over San Francisco">
    <g class="hoods">${outlines}</g>
    <g class="points">${circles}</g>
  </svg>`;
}
