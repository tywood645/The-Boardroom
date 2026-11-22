import chalk from 'chalk';
import type { MotionResult } from './types.js';
import { quorumStatement } from './minutes.js';
import { safeDeep } from '../util/terminal.js';

/**
 * Total spend for a motion. Every phase now carries its own recorded cost, so
 * this is a sum of already-metered calls rather than a fresh calculation.
 */
export function motionCost(r: MotionResult): number {
  return (
    (r.briefing?.cost ?? 0) +
    r.seconds.reduce((n, s) => n + s.cost, 0) +
    r.debate.reduce((n, d) => n + d.cost, 0) +
    r.votes.reduce((n, v) => n + v.cost, 0)
  );
}

export function renderMotion(raw: MotionResult): void {
  // Everything below prints provider text; render only from an inert copy.
  const r = safeDeep(raw);
  console.log(chalk.bold.cyan('\n=== MOTION BEFORE THE BOARD ==='));
  console.log(chalk.italic('"' + r.motion + '"'));
  console.log();

  if (r.briefing) {
    console.log(chalk.bold.magenta('--- Consultant briefing ---'));
    console.log(chalk.dim('Source: ' + r.briefing.source + ' / ' + r.briefing.model));
    console.log(r.briefing.text);
    console.log();
  }

  console.log(chalk.bold.yellow('--- Seconds ---'));
  for (const s of r.seconds) {
    if (s.error) {
      console.log(`  ${chalk.red('ERROR')} ${s.role} (${s.panelist}): ${s.error}`);
      continue;
    }
    const mark = s.seconded ? chalk.green('✓ second') : chalk.dim('✗ decline');
    console.log(`  ${mark}  ${chalk.bold(s.role.padEnd(8))} ${chalk.dim('(' + s.panelist + ')')}  ${s.reason}`);
  }
  const validSeconds = r.seconds.filter(s => s.seconded && !s.error).length;
  console.log(chalk.dim(`  (${validSeconds} seconds)`));
  console.log();

  if (r.outcome === 'no_quorum' && r.quorum?.phase === 'second') {
    console.log(chalk.bold.red('NO QUORUM. NOTHING DECIDED.'));
    console.log(chalk.dim(quorumStatement(r)));
    console.log(chalk.dim(`Total motion cost: $${motionCost(r).toFixed(4)}`));
    if (r.minutesPath) {
      console.log(chalk.dim('Minutes: ' + r.minutesPath));
    }
    return;
  }

  if (r.outcome === 'died_for_lack_of_second') {
    console.log(chalk.bold.red('MOTION DIED FOR LACK OF SECOND.'));
    console.log(chalk.dim('Need at least 2 seconds to proceed to debate.'));
    console.log(chalk.dim(`Total motion cost: $${motionCost(r).toFixed(4)}`));
    if (r.minutesPath) {
      console.log(chalk.dim('Minutes: ' + r.minutesPath));
    }
    return;
  }

  console.log(chalk.bold.yellow('--- Debate ---\n'));
  for (const d of r.debate) {
    if (d.error) {
      console.log(`${chalk.bold(d.role)} ${chalk.red('ERROR:')} ${d.error}\n`);
      continue;
    }
    const stanceColor =
      d.stance === 'SUPPORT' ? chalk.bold.green :
      d.stance === 'OPPOSE'  ? chalk.bold.red :
      chalk.bold.gray;
    console.log(`${chalk.bold(d.role)} ${chalk.dim('(' + d.panelist + ')')}: ${stanceColor(d.stance)}`);
    console.log(d.case);
    console.log();
  }

  console.log(chalk.bold.yellow('--- Final vote ---'));
  for (const v of r.votes) {
    if (v.error) {
      console.log(`  ${chalk.red('ERROR')} ${v.role}: ${v.error}`);
      continue;
    }
    const voteColor =
      v.vote === 'AYE' ? chalk.bold.green :
      v.vote === 'NAY' ? chalk.bold.red :
      chalk.bold.gray;
    const flipMark = v.flipped ? chalk.yellow(' (flipped)') : '';
    console.log(`  ${voteColor(v.vote.padEnd(7))} ${chalk.bold(v.role.padEnd(8))} ${chalk.dim('(' + v.panelist + ')')}  ${v.reason}${flipMark}`);
  }
  console.log();
  console.log(chalk.bold(`Tally: AYE ${r.tally.aye} · NAY ${r.tally.nay} · ABSTAIN ${r.tally.abstain}`));
  console.log();

  const banner =
    r.outcome === 'passed' ? chalk.bold.green('  MOTION PASSED  ') :
    r.outcome === 'failed' ? chalk.bold.red('  MOTION FAILED  ') :
    r.outcome === 'no_quorum' ? chalk.bold.red('  NO QUORUM: NOTHING DECIDED  ') :
    chalk.bold.yellow('  MOTION TIED: CHAIR MUST DECIDE  ');
  console.log(banner);
  if (r.outcome === 'no_quorum') console.log(chalk.dim(quorumStatement(r)));
  console.log();

  console.log(chalk.dim(`Total motion cost: $${motionCost(r).toFixed(4)}`));

  if (r.minutesPath) {
    console.log(chalk.dim('Minutes saved: ' + r.minutesPath));
  }
}
