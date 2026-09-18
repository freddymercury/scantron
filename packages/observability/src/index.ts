/**
 * @scantron/observability — structured JSON logging, metrics and health reporting
 *
 * Stub. Implemented by S-A6; S-A1 only establishes the workspace.
 */

export const PACKAGE_NAME = "@scantron/observability" as const;

/** Marker so the workspace is importable and testable before S-A6 lands. */
export function packageInfo(): { name: typeof PACKAGE_NAME; implementedBy: string } {
  return { name: PACKAGE_NAME, implementedBy: "S-A6" };
}
