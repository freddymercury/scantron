/**
 * San Francisco domain constants. See ADR-002 §2: the map is a fixed bbox, not a
 * general slippy map, so the projection lives here rather than in a mapping library.
 */

export * from "./geo.ts";
export * from "./time.ts";
export * from "./streets.ts";
export * from "./street-data.ts";

/** Matches the bbox the mockups project against (`mockups/live.template.html`). */
export const SF_BBOX = {
  west: -122.517,
  east: -122.357,
  south: 37.705,
  north: 37.812,
};

export function isWithinSF(lat: number, lng: number): boolean {
  return (
    lat >= SF_BBOX.south && lat <= SF_BBOX.north && lng >= SF_BBOX.west && lng <= SF_BBOX.east
  );
}
