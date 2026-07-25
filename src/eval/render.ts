import chalk from 'chalk';
import type { DivergenceReport, ControlComparison } from './divergence.js';

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function renderReport(report: DivergenceReport, costUsd: number): void {
  console.log(chalk.bold.cyan(`\nBoardRoom divergence eval - ${report.questionCount} questions, ${report.label}`));
  console.log();

  console.log(
    '  ' + pad('parse rate', 18) +
    `${report.parsedVotes}/${report.totalVotes} votes (${pct(report.parseRate)})`,
  );
  console.log(
    '  ' + pad('scored questions', 18) +
    `${report.scoredQuestions} of ${report.questionCount}` +
    chalk.dim('  (>=2 parsed votes)'),
  );
  console.log(
    '  ' + pad('divergence rate', 18) +
    chalk.bold(report.divergenceRate.toFixed(3)) +
    chalk.dim(`   (${report.divergentQuestions} of ${report.scoredQuestions} questions split)`),
  );
  console.log(
    '  ' + pad('mean minority', 18) +
    report.meanMinorityShare.toFixed(3) +
    chalk.dim('   (share of panel on the losing side)'),
  );

  if (report.ambiguousVotes || report.noMatchVotes || report.errorVotes) {
    console.log(
      chalk.dim(
        '  ' + pad('unscored votes', 18) +
        `${report.ambiguousVotes} ambiguous, ${report.noMatchVotes} no-match, ${report.errorVotes} provider errors`,
      ),
    );
  }

  if (report.perCategory.length > 1) {
    console.log();
    console.log('  ' + chalk.bold(pad('by category', 22)) + chalk.dim('  scored  divergent    rate'));
    for (const c of report.perCategory) {
      console.log(
        '  ' + pad('    ' + c.category, 22) +
        String(c.scored).padStart(8) +
        String(c.divergent).padStart(11) +
        c.divergenceRate.toFixed(3).padStart(8),
      );
    }
  }

  const ranked = report.perVendor.filter(v => v.participated > 0);
  if (ranked.length > 1) {
    const most = ranked[0];
    const least = ranked[ranked.length - 1];
    console.log();
    if (most.contrarianRate === least.contrarianRate) {
      // Naming a "most contrarian" seat when every seat scored identically
      // would invent a ranking the run did not measure.
      console.log(
        '  ' + pad('contrarian rate', 18) +
        `identical across all ${ranked.length} seats (${most.contrarianRate.toFixed(3)})`,
      );
    } else {
      console.log('  ' + pad('most contrarian', 18) + `${most.role} (${most.panelist})  ${most.contrarianRate.toFixed(3)}`);
      console.log('  ' + pad('least contrarian', 18) + `${least.role} (${least.panelist})  ${least.contrarianRate.toFixed(3)}`);
    }
  }

  console.log();
  console.log(chalk.dim(`  run cost: $${costUsd.toFixed(4)}`));
  console.log();
}

export function renderComparison(cmp: ControlComparison): void {
  console.log(chalk.bold.cyan('\n=== Premise check ==='));
  console.log(`  multi-vendor divergence   ${cmp.multiVendor.divergenceRate.toFixed(3)}`);
  console.log(`  single-vendor divergence  ${cmp.singleVendor.divergenceRate.toFixed(3)}`);
  console.log(`  delta                     ${cmp.delta >= 0 ? '+' : ''}${cmp.delta.toFixed(3)}`);
  console.log();
  if (cmp.premiseSupported) {
    console.log(chalk.green('  Six vendors disagreed measurably more than one vendor in six roles.'));
  } else {
    console.log(chalk.red('  Six vendors did NOT disagree measurably more than one vendor in six roles.'));
    console.log(chalk.red("  BoardRoom's core premise is unsupported by this run."));
  }
  console.log();
}
