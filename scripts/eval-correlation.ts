/**
 * `bun run eval:correlation [--sweep] [--update-baseline]` — the guard on the system's
 * biggest technical risk (S-D10, PRD §55).
 *
 * Replays the labelled fixtures through the real correlator and reports precision, recall
 * and F1 on grouping, plus the two failure modes named separately because they are not
 * equally bad: a **false merge** puts two unrelated calls in one incident, which a reader
 * sees; a **missed merge** leaves one event as two, which only shows up as the feed being
 * noisier than it should be.
 */

import {
  createJevJudge,
  evaluate,
  evaluateJudged,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  type EvaluationResult,
  type FixtureSet,
  type Weights,
} from "@scantron/correlation";
import { migrate, openDatabase, IN_MEMORY } from "@scantron/database";

const FIXTURES = new URL("../packages/correlation/fixtures/correlation-cases.json", import.meta.url).pathname;
const BASELINE = new URL("../packages/correlation/fixtures/baseline.json", import.meta.url).pathname;
/** How far F1 may fall before CI fails. */
const MAX_REGRESSION = 0.02;

const fixtures = JSON.parse(await Bun.file(FIXTURES).text()) as FixtureSet;
const db = openDatabase({ path: IN_MEMORY });
migrate(db);

function report(result: EvaluationResult, label: string): void {
  const { metrics } = result;
  console.log(`\n${label}`);
  console.log(`  cases        ${metrics.cases}  (${metrics.casesCorrect} grouped correctly)`);
  console.log(`  precision    ${metrics.precision.toFixed(3)}`);
  console.log(`  recall       ${metrics.recall.toFixed(3)}`);
  console.log(`  F1           ${metrics.f1.toFixed(3)}`);
  console.log(`  false merges ${metrics.falseMerges}   (unrelated calls put together — a reader sees these)`);
  console.log(`  missed       ${metrics.missedMerges}   (one event left as two)`);

  // Ground-truth labels reported separately: they are the ones that lean on nothing this
  // system computes.
  const byKey = result.outcomes.filter((outcome) => outcome.labelSource === "agency_call_number");
  const correct = byKey.filter((outcome) => outcome.correct).length;
  console.log(`  agency-key   ${correct}/${byKey.length} correct  (ground truth, independent of our features)`);
}

const baseResult = evaluate(db, fixtures);
report(baseResult, `correlation eval — ${fixtures.cases.length} cases, current settings`);

const failures = baseResult.outcomes.filter((outcome) => !outcome.correct);
if (failures.length > 0) {
  console.log(`\n  failing cases (${failures.length}):`);
  for (const outcome of failures.slice(0, 15)) {
    console.log(
      `    ${outcome.id.padEnd(12)} labelled ${outcome.label.padEnd(9)} produced ${outcome.incidents} incident(s) — ${outcome.note.slice(0, 84)}`,
    );
  }
  if (failures.length > 15) console.log(`    …and ${failures.length - 15} more`);
}

// `--judge` measures the second opinion: same fixtures, judge consulted on the probable
// band only, so the comparison is exactly the production difference.
if (process.argv.includes("--judge")) {
  const judge = createJevJudge();
  if (!judge.available) {
    console.log("\n--judge given but no JEV_API_KEY is set; skipping.");
  } else {
    const judged = await evaluateJudged(db, fixtures, judge);
    report(judged, "with the judge on the probable band");
    console.log(
      `  cost         $${judge.stats.costUsd.toFixed(5)} for ${judge.stats.requests} requests (${judge.stats.timeouts} timed out)`,
    );
    const delta = judged.metrics.f1 - baseResult.metrics.f1;
    console.log(`  F1 change    ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`);
  }
}

if (process.argv.includes("--sweep")) {
  console.log(`\nweight and threshold sweep`);
  console.log(`  merge  location  time   type   F1     precision  recall  false  missed`);

  const rows: { line: string; f1: number }[] = [];
  for (const merge of [0.75, 0.8, 0.85, 0.9]) {
    for (const weights of [
      DEFAULT_WEIGHTS,
      { location: 0.45, time: 0.25, type: 0.2, units: 0.05, text: 0.05 },
      { location: 0.3, time: 0.2, type: 0.35, units: 0.1, text: 0.05 },
      { location: 0.4, time: 0.3, type: 0.25, units: 0.05, text: 0 },
    ] as Weights[]) {
      const result = evaluate(db, fixtures, {
        weights,
        thresholds: { ...DEFAULT_THRESHOLDS, merge },
      });
      rows.push({
        f1: result.metrics.f1,
        line: `  ${merge.toFixed(2)}   ${weights.location.toFixed(2)}      ${weights.time.toFixed(2)}   ${weights.type.toFixed(2)}   ${result.metrics.f1.toFixed(3)}  ${result.metrics.precision.toFixed(3)}      ${result.metrics.recall.toFixed(3)}   ${String(result.metrics.falseMerges).padEnd(6)} ${result.metrics.missedMerges}`,
      });
    }
  }
  for (const row of rows.sort((a, b) => b.f1 - a.f1)) console.log(row.line);
}

interface Baseline {
  recordedAt: string;
  fixtureVersion: string;
  cases: number;
  precision: number;
  recall: number;
  f1: number;
  falseMerges: number;
  missedMerges: number;
}

if (process.argv.includes("--update-baseline")) {
  const baseline: Baseline = {
    recordedAt: new Date().toISOString(),
    fixtureVersion: fixtures.version,
    cases: baseResult.metrics.cases,
    precision: baseResult.metrics.precision,
    recall: baseResult.metrics.recall,
    f1: baseResult.metrics.f1,
    falseMerges: baseResult.metrics.falseMerges,
    missedMerges: baseResult.metrics.missedMerges,
  };
  await Bun.write(BASELINE, `${JSON.stringify(baseline, null, 1)}\n`);
  console.log(`\nbaseline updated: F1 ${baseline.f1.toFixed(3)} — say why in the commit message.`);
} else if (await Bun.file(BASELINE).exists()) {
  const baseline = JSON.parse(await Bun.file(BASELINE).text()) as Baseline;
  const delta = baseResult.metrics.f1 - baseline.f1;
  console.log(
    `\nbaseline F1 ${baseline.f1.toFixed(3)} (recorded ${baseline.recordedAt.slice(0, 10)}) · now ${baseResult.metrics.f1.toFixed(3)} · ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`,
  );
  if (delta < -MAX_REGRESSION) {
    console.error(
      `\nFAIL: F1 dropped ${Math.abs(delta).toFixed(3)}, more than the ${MAX_REGRESSION} allowed. Fix it, or update the baseline deliberately with --update-baseline and say why.`,
    );
    db.close();
    process.exit(1);
  }
}

db.close();
