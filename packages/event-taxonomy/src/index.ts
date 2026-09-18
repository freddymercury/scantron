/**
 * @scantron/event-taxonomy — configurable mapping from agency call types to product event types
 *
 * Stub. Implemented by S-A4; S-A1 only establishes the workspace.
 */

export const PACKAGE_NAME = "@scantron/event-taxonomy" as const;

/** Marker so the workspace is importable and testable before S-A4 lands. */
export function packageInfo(): { name: typeof PACKAGE_NAME; implementedBy: string } {
  return { name: PACKAGE_NAME, implementedBy: "S-A4" };
}
