import chalk from 'chalk';
import type { DelegateResult } from './escalate.js';
import { describeTiers } from './tiers.js';
import { formatStats, loadStats } from './stats.js';
import type { ProviderConfig } from '../provider/factory.js';
import type { VerifyResult } from './verify-catalog.js';

const OUTCOME_STYLE: Record<string, (s: string) => string> = {
  confirmed: chalk.bold.green,
  refuted: chalk.bold.red,
  unverified: chalk.bold.yellow,
  error: chalk.bold.red,
  deadline: chalk.bold.red,
  budget_blocked: chalk.bold.red,
};

export function renderDelegation(r: DelegateResult, explain: boolean): void {
  if (explain) {
    console.log(chalk.dim(`class:  ${r.cls} (${r.classifiedWhy})`));
    console.log(chalk.dim(`start:  ${r.startTier} (${r.startWhy})`));
    console.log();
  }

  console.log(r.answer || chalk.dim('(no answer produced)'));
  if (r.answer && r.answerOutcome === 'refuted') {
    console.log(
      chalk.bold.red(
        '\nWARNING: the answer above was REFUTED by the checker, and no better attempt completed. Do not rely on it.',
      ),
    );
  }
  console.log();

  for (const [i, a] of r.attempts.entries()) {
    const style = OUTCOME_STYLE[a.outcome] ?? chalk.bold;
    const downgrade = a.downgradedFrom ? chalk.yellow(` (downgraded from ${a.downgradedFrom})`) : '';
    console.log(
      chalk.dim(`attempt ${i + 1}  `) +
        `${a.tier.padEnd(8)} ${chalk.dim(a.vendor + '/' + a.model)}${downgrade}  ` +
        `${style(a.outcome)}  ` +
        chalk.dim(`$${a.cost.toFixed(4)} · ${a.durationMs}ms`),
    );
    if (a.verdictBy) {
      console.log(chalk.dim(`            checked by ${a.verdictBy}: ${a.verdict?.why ?? 'no verdict'}`));
    }
    if (a.verdict?.defect) {
      console.log(chalk.red(`            defect: ${a.verdict.defect}`));
    }
  }

  if (r.stoppedBecause) {
    console.log(chalk.yellow(`\nstopped: ${r.stoppedBecause}`));
  }
  console.log(chalk.dim(`\nTotal: $${r.totalCost.toFixed(4)} across ${r.attempts.length} attempt(s)`));
}

const VERIFY_STYLE: Record<string, (s: string) => string> = {
  ok: chalk.bold.green,
  stale: chalk.bold.red,
  skipped: chalk.dim,
  unreachable: chalk.bold.yellow,
};

export function renderVerifyCatalog(result: VerifyResult, strict = false): void {
  console.log(chalk.bold.cyan('=== Catalog vs vendor ==='));
  console.log(chalk.dim('What each vendor says it still serves, against what the catalog carries.'));

  for (const r of result.reports) {
    const style = VERIFY_STYLE[r.status] ?? chalk.bold;
    const detail = r.detail ? chalk.dim(` — ${r.detail}`) : '';
    console.log(`  ${r.vendor.padEnd(11)} ${style(r.status)}${detail}`);

    for (const model of r.missing) {
      console.log(chalk.red(`      gone: ${model}`) + chalk.dim(' — the vendor no longer lists this'));
    }
    // Only a count: a vendor typically serves dozens of models it makes no
    // sense for us to carry, and printing them all buries the line above.
    if (r.uncatalogued.length > 0) {
      console.log(
        chalk.dim(`      ${r.confirmed.length} carried and confirmed, ` +
          `${r.uncatalogued.length} served but not carried (--json to list)`),
      );
    }
  }

  console.log();
  if (!result.ok) {
    console.log(chalk.bold.red('Catalog is stale.') + ' Entries above cannot be called; delegations routed to them fail.');
  } else if (result.incomplete) {
    const line = 'No stale entries found, but not every vendor could be checked.';
    console.log(strict ? chalk.bold.red(line) + ' --strict treats that as a failure.' : chalk.yellow(line));
  } else {
    console.log(chalk.bold.green('Every catalog model is still served by its vendor.'));
  }
}

export function renderStats(configs: ProviderConfig[]): void {
  console.log(chalk.bold.cyan('=== Tier resolution ==='));
  console.log(chalk.dim('What each tier resolves to with the vendors currently credentialed.'));
  for (const line of describeTiers(configs)) console.log('  ' + line);

  console.log();
  console.log(chalk.bold.cyan('=== Measured delegation ==='));
  console.log(chalk.dim('Confirm rate per task class and tier, from verified runs in delegations.jsonl.'));
  for (const line of formatStats(loadStats())) console.log('  ' + line);
}
