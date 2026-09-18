/**
 * Agency priority codes → one 1–5 scale (S-C3).
 *
 * SFPD writes A/B/C and SFFD writes 2/3/E; neither means anything to the other, and the
 * product needs one comparable number. 1 is most urgent. Config, not code, so a scale can
 * be corrected without a deploy.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { number, objectOf, parse, recordOf, string, optional } from "@scantron/incident-schema";

// Resolved here rather than imported from `index.ts`, which re-exports this module.
export const PRIORITY_CONFIG_PATH = join(resolve(import.meta.dir, "../config"), "priorities.json");

export const PriorityConfigSchema = objectOf(
  {
    version: string({ minLength: 1 }),
    note: optional(string({ maxLength: 1000 })),
    scales: recordOf(recordOf(number({ integer: true, min: 1, max: 5 }))),
  },
  "PriorityConfig",
);

export interface PriorityConfig {
  version: string;
  note?: string;
  scales: Record<string, Record<string, number>>;
}

export function loadPriorityConfig(path: string = PRIORITY_CONFIG_PATH): PriorityConfig {
  return parse(PriorityConfigSchema, JSON.parse(readFileSync(path, "utf8")) as unknown, path) as PriorityConfig;
}

export interface PriorityMapper {
  rank(source: string, code: string | null | undefined): number | undefined;
  readonly version: string;
}

export function createPriorityMapper(config: PriorityConfig = loadPriorityConfig()): PriorityMapper {
  return {
    version: config.version,
    rank(source, code) {
      if (!code) return undefined;
      const scale = config.scales[source];
      // An unmapped code is left unranked rather than guessed into the middle of the scale,
      // where it would quietly look like an ordinary call.
      return scale?.[code.trim().toUpperCase()];
    },
  };
}
