/**
 * @scantron/correlation — turning observations into incidents (Epic D).
 *
 * The central hypothesis of the product lives here: that thousands of observations are
 * dozens of incidents. docs/05 records that it is currently unproven — 5,110 raw rows
 * became 4,484 incidents in the mockup, which is almost no reduction — so everything in
 * this package is built to be measured rather than believed.
 */

export * from "./config.ts";
export * from "./candidates.ts";
export * from "./scoring.ts";
export * from "./decide.ts";
export * from "./apply.ts";
export * from "./lifecycle.ts";
export * from "./timeline.ts";
export * from "./reports.ts";
export * from "./judge.ts";
export * from "./evaluate.ts";
