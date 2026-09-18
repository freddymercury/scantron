/**
 * @scantron/database — SQLite connection, migration runner and query helpers
 *
 * Stub. Implemented by S-A2; S-A1 only establishes the workspace.
 */

export const PACKAGE_NAME = "@scantron/database" as const;

/** Marker so the workspace is importable and testable before S-A2 lands. */
export function packageInfo(): { name: typeof PACKAGE_NAME; implementedBy: string } {
  return { name: PACKAGE_NAME, implementedBy: "S-A2" };
}
