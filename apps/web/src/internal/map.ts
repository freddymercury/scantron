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
import { INTERNAL_PREFIX } from "./paths.ts";
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

export interface MapBounds {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
}

export interface MapOptions {
  /** Zoom to these bounds instead of the whole city. */
  focus?: MapBounds | undefined;
  /** Drawn heavier than its neighbours, so the focused area reads as the subject. */
  focusName?: string | undefined;
}

/**
 * Zooming is a viewBox change, not a reprojection: the same arithmetic places every point,
 * and the browser does the scaling. 8% padding keeps a neighborhood off the edges.
 */
export function viewBoxFor(focus: MapBounds | undefined): {
  viewBox: string;
  scale: number;
} {
  if (!focus) return { viewBox: `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`, scale: 1 };

  const topLeft = project(focus.max_lat, focus.min_lng);
  const bottomRight = project(focus.min_lat, focus.max_lng);
  const width = Math.max(bottomRight.x - topLeft.x, 1);
  const height = Math.max(bottomRight.y - topLeft.y, 1);
  const padX = width * 0.08;
  const padY = height * 0.08;

  return {
    viewBox: `${(topLeft.x - padX).toFixed(1)} ${(topLeft.y - padY).toFixed(1)} ${(width + padX * 2).toFixed(1)} ${(height + padY * 2).toFixed(1)}`,
    // Circles and strokes are in user units, so they must shrink as the view zooms in or
    // a zoomed neighborhood turns into a field of blobs.
    scale: Math.min((width + padX * 2) / MAP_WIDTH, (height + padY * 2) / MAP_HEIGHT),
  };
}

export function renderMap(
  points: MapPoint[],
  shapes: NeighborhoodShape[],
  options: MapOptions = {},
): string {
  const { viewBox, scale } = viewBoxFor(options.focus);
  const radius = Math.max(0.6, 2.2 * scale);
  const strokeWidth = Math.max(0.2, 0.7 * scale);

  const outlines = shapes
    .map((shape) => {
      const path = geometryPath(JSON.parse(shape.geometry) as GeoJsonGeometry);
      const focused = options.focusName === shape.name;
      return `<path d="${path}" class="hood${focused ? " focused" : ""}" stroke-width="${(
        focused ? strokeWidth * 2 : strokeWidth
      ).toFixed(2)}"><title>${escapeHtml(shape.name)}</title></path>`;
    })
    .join("");

  // Each point is a link, so clicking drills into the record and middle-click, keyboard and
  // no-JS all behave the way they do everywhere else. The hover card is an enhancement on
  // top of that, not the only way in.
  const circles = points
    .map((point) => {
      const { x, y } = project(point.lat, point.lng);
      const colour = SOURCE_COLOURS[point.source] ?? "var(--other)";
      const units = point.units ? (JSON.parse(point.units) as string[]) : [];
      const where = point.location_normalized ?? point.location_raw ?? point.neighborhood ?? "";

      return `<a href="${INTERNAL_PREFIX}/observation/${encodeURIComponent(point.id)}" class="pt"
        data-at="${escapeHtml(point.occurred_at)}"
        data-type="${escapeHtml(point.type ?? "unknown")}"
        data-label="${escapeHtml(point.subtype ?? "")}"
        data-where="${escapeHtml(where)}"
        data-hood="${escapeHtml(point.neighborhood ?? "")}"
        data-source="${escapeHtml(point.source)}"
        data-units="${escapeHtml(units.join(" "))}"
        data-priority="${point.priority_rank ?? ""}"
        data-sensitive="${point.sensitive === 1 ? "1" : ""}"
      ><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" fill="${colour}"/></a>`;
    })
    .join("");

  const subject = options.focusName ? escapeHtml(options.focusName) : "San Francisco";
  return `<svg viewBox="${viewBox}" class="map" role="img"
    aria-label="${points.length} located observations plotted over ${subject}">
    <g class="hoods">${outlines}</g>
    <g class="points">${circles}</g>
  </svg>`;
}
