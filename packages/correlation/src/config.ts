/**
 * Correlation configuration (S-D1, S-D2).
 *
 * All of it is settings rather than constants, because correlation is the part of this
 * system that will be tuned against measured outcomes — the handoff's warning is that it
 * may barely merge anything at all, and finding out means changing these numbers and
 * re-running the harness, not editing code.
 */

import type { Database } from "bun:sqlite";
import { createSettingsCache, type SettingsCache } from "@scantron/database";

export const CORRELATION_SETTINGS_KEY = "correlation";

export interface CorrelationConfig {
  /** Metres. A candidate further than this is not considered at all. */
  radiusMeters: number;
  /**
   * How far *back* an incident may have started and still claim this observation. Larger
   * than the forward window on purpose: a response follows a call, so the fire unit
   * arrives after the police record, not before it.
   */
  windowBackMinutes: number;
  /** And how far ahead an incident may start — smaller, and only for out-of-order arrival. */
  windowForwardMinutes: number;
  /** A resolved incident stays eligible this long, for the late unit that arrives after closure. */
  resolvedGraceMinutes: number;
  /** More candidates than this for one observation means the window is wrong; it logs. */
  candidateWarnThreshold: number;
  /** Hard cap, so a pathological case cannot turn one observation into a table scan. */
  maxCandidates: number;
}

export const DEFAULT_CORRELATION_CONFIG: CorrelationConfig = {
  radiusMeters: 400,
  windowBackMinutes: 15,
  windowForwardMinutes: 10,
  resolvedGraceMinutes: 20,
  candidateWarnThreshold: 50,
  maxCandidates: 200,
};

export function correlationConfig(db: Database): SettingsCache<CorrelationConfig> {
  return createSettingsCache(db, CORRELATION_SETTINGS_KEY, DEFAULT_CORRELATION_CONFIG);
}
