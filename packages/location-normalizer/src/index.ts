/**
 * @scantron/location-normalizer — SF dispatch location text to a normalized, geocodable form
 *
 * Stub. Implemented by S-C1; S-A1 only establishes the workspace.
 */

export const PACKAGE_NAME = "@scantron/location-normalizer" as const;

/** Marker so the workspace is importable and testable before S-C1 lands. */
export function packageInfo(): { name: typeof PACKAGE_NAME; implementedBy: string } {
  return { name: PACKAGE_NAME, implementedBy: "S-C1" };
}
