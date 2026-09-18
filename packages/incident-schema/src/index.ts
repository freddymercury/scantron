/**
 * @scantron/incident-schema — incident, observation and public-projection schemas with allowlist-by-default validation
 *
 * Stub. Implemented by S-A3; S-A1 only establishes the workspace.
 */

export const PACKAGE_NAME = "@scantron/incident-schema" as const;

/** Marker so the workspace is importable and testable before S-A3 lands. */
export function packageInfo(): { name: typeof PACKAGE_NAME; implementedBy: string } {
  return { name: PACKAGE_NAME, implementedBy: "S-A3" };
}
