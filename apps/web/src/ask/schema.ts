/**
 * The structured query is the contract, and this is its gate.
 *
 * Tier 1 (the deterministic grammar) produces an `AskQuery` directly. A future Tier 2 —
 * a model constrained to emit *only* this JSON — would produce the same shape and pass
 * through the same validator, which is the point: the model's entire output surface is one
 * validated object, never prose, never a query it gets to run itself. Anything that fails
 * validation falls back to Tier 1's best guess.
 *
 * The validator is @scantron/incident-schema's, so it is allowlist-by-default: a field the
 * model invents is dropped rather than carried.
 */

import {
  arrayOf,
  enumOf,
  INCIDENT_TYPES,
  number,
  objectOf,
  optional,
  string,
  type Result,
} from "@scantron/incident-schema";

import type { AskQuery } from "./parse.ts";

export const ASK_INTENTS = ["list", "highlight", "count"] as const;

export const AskQuerySchema = objectOf(
  {
    intent: enumOf(ASK_INTENTS),
    area: optional(string({ maxLength: 120 })),
    windowMinutes: number({ integer: true, min: 0, max: 366 * 24 * 60 }),
    windowLabel: string({ minLength: 1, maxLength: 80 }),
    types: arrayOf(enumOf(INCIDENT_TYPES)),
    rawCodes: arrayOf(string({ minLength: 1, maxLength: 20 })),
    categoryLabel: optional(string({ maxLength: 80 })),
    unresolved: arrayOf(string({ maxLength: 60 })),
    unanswerable: optional(string({ maxLength: 400 })),
    question: string({ maxLength: 500 }),
  },
  "AskQuery",
);

export function validateAskQuery(candidate: unknown): Result<AskQuery> {
  return AskQuerySchema.validate(candidate, "") as Result<AskQuery>;
}
