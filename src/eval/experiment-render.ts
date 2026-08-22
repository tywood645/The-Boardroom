// Terminal report for the experiment.
//
// The renderer's obligation is that a reader cannot mistake a weak result for a
// strong one. So the verdict never appears without the evidence that produced
// it: the interval, the p-value, the discordant count that the test actually
// saw, and the parse rate that bounds how much of the panel was measured at all.
// A green "SUPPORTED" with no numbers beside it is how an eval becomes
// marketing.

import chalk from 'chalk';
import type { DivergenceReport } from './divergence.js';
import type { ExperimentResult } from './experiment.js';
import type { Interval } from './stats.js';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (i: Interval) => `[${pct(i.low)}, ${pct(i.high)}]`;

function arm(report: DivergenceReport, costUsd: number, interval: Interval): void {
  console.log(chalk.bold(`\n  ${report.label}`));
  console.log(`    divergence      ${pct(report.divergenceRate)}  95% CI ${ci(interval)}`);
  console.log(`    scored          ${report.divergentQuestions} divergent of ${report.scoredQuestions} scored`);
  console.log(
    `    parse rate      ${pct(report.parseRate)}` +
    `  (${report.ambiguousVotes} ambiguous, ${report.noMatchVotes} unmatched, ` +
    `${report.emptyVotes} empty, ${report.errorVotes} errored)`,
  );
  console.log(`    minority share  ${pct(report.meanMinorityShare)} mean`);
  console.log(`    cost            $${costUsd.toFixed(4)}`);
}

export function renderExperiment(result: ExperimentResult): void {
  const { premise } = result;

  console.log(chalk.bold('\n=== Divergence experiment ==='));
  console.log(
    `  design          ${result.trials} trial(s) x ${result.rotations} rotation(s)` +
    `, ${result.balanced ? chalk.green('balanced Latin square') : chalk.yellow('UNBALANCED')}`,
  );
  console.log(`  paired          ${result.pairedQuestions} questions scored in both arms`);

  arm(result.treatment.report, result.treatment.costUsd, premise.treatmentInterval);
  arm(result.control.report, result.control.costUsd, premise.controlInterval);

  // Run-to-run spread. With one trial there is nothing to show, and saying so
  // is better than printing a single number that looks like a range.
  if (result.trials > 1) {
    const fmt = (xs: number[]) => xs.map(pct).join(', ');
    console.log(chalk.bold('\n  Per-trial divergence'));
    console.log(`    multi-vendor    ${fmt(result.perTrialTreatmentRate)}`);
    console.log(`    control         ${fmt(result.perTrialControlRate)}`);
  } else {
    console.log(chalk.dim('\n  Single trial: no run-to-run variance estimate. Use --trials 3 or more.'));
  }

  console.log(chalk.bold('\n=== Premise check ==='));
  console.log(`  H0              multi-vendor divergence equals single-vendor divergence`);
  console.log(`  delta           ${pct(premise.delta)}  95% CI ${ci(premise.deltaInterval)}`);
  console.log(
    `  McNemar         ${premise.mcNemar.exact ? 'exact binomial' : 'chi-square, continuity-corrected'}` +
    `, p=${premise.mcNemar.pValue < 0.001 ? '<0.001' : premise.mcNemar.pValue.toFixed(4)}`,
  );
  console.log(
    `  discordant      ${premise.mcNemar.discordant} of ${result.pairedQuestions}` +
    `  (${premise.mcNemar.treatmentOnly} multi-only, ${premise.mcNemar.controlOnly} control-only)`,
  );
  console.log(`  decision rule   CI excludes 0 AND delta >= ${pct(premise.threshold)}, at alpha=${premise.alpha}`);

  const paint =
    premise.verdict === 'supported' ? chalk.green.bold
    : premise.verdict === 'refuted' ? chalk.red.bold
    : chalk.yellow.bold;
  console.log(`\n  ${paint(premise.verdict.toUpperCase())}  ${premise.rationale}`);

  if (premise.verdict === 'inconclusive') {
    console.log(chalk.dim('  Inconclusive is a statement about the evidence, not a disproof of the premise.'));
  }

  // Only shown when the design earned it. An unbalanced sweep cannot separate
  // these two axes, and printing the table anyway would invite the exact
  // misreading rotation was built to prevent.
  if (result.balanced && result.vendorEffects.length > 0) {
    console.log(chalk.bold('\n=== Vendor effect (pooled over every role) ==='));
    for (const v of result.vendorEffects) {
      console.log(
        `  ${v.vendor.padEnd(12)} ${pct(v.minorityRate).padStart(6)} minority` +
        `  (${v.minority}/${v.participated}, ${v.rolesHeld} roles held)`,
      );
    }
    console.log(chalk.bold('\n=== Role effect (pooled over every vendor) ==='));
    for (const r of result.roleEffects) {
      console.log(
        `  ${r.role.padEnd(12)} ${pct(r.minorityRate).padStart(6)} minority  (${r.minority}/${r.participated})`,
      );
    }
    console.log(chalk.dim('\n  Rotation makes these independent: each vendor held every role and each role was held by every vendor.'));
  } else if (!result.balanced) {
    console.log(chalk.yellow(
      '\n  Vendor and role effects withheld: the sweep was not a full Latin square, so the two cannot be separated.',
    ));
  }

  console.log(chalk.dim(`\n  total cost $${result.totalCostUsd.toFixed(4)}`));
}
