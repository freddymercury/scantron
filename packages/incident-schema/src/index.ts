/**
 * @scantron/incident-schema — one canonical definition of what an observation and an
 * incident are, validated at runtime, with the public projection built as an allowlist.
 *
 * Zero dependencies (ADR-002). See `validator.ts` for why we own the validator.
 */

export * from "./validator.ts";
export * from "./domain.ts";
export * from "./public.ts";
export * from "./events.ts";
export * from "./rows.ts";
