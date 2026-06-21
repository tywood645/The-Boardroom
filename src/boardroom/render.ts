import chalk from 'chalk';
import type { BoardroomResult } from './protocol.js';
import type { PanelistAnswer } from './panel.js';
import { CostTracker } from '../cost/tracker.js';

export function renderBoardroom(r: BoardroomResult, tracker: CostTracker): void {
  console.log(chalk.bold.cyan('\n=== BOARDROOM ==='));
  console.log(chalk.dim(r.question));
  console.log();

  let totalCost = 0;

  if (r.briefing) {
    console.log(chalk.bold.magenta('--- Consultant briefing ---'));
    console.log(chalk.dim('Source: ' + r.briefing.source + ' / ' + r.briefing.model));
    console.log(r.briefing.text);
    const { cost } = tracker.recordUsage(r.briefing.model, r.briefing.inputTokens, r.briefing.outputTokens);
    console.log(chalk.dim(`[${r.briefing.durationMs}ms · ${r.briefing.inputTokens} in / ${r.briefing.outputTokens} out · $${cost.toFixed(4)}]\n`));
    totalCost += cost;
  } else {
    console.log(chalk.dim('(no consultant briefing: disabled, unavailable, or returned empty)\n'));
  }

  console.log(chalk.bold.yellow('--- Round 1: Independent answers (sealed-bid) ---\n'));
  for (const a of r.round1) {
    totalCost += renderAnswer(a, tracker);
  }

  if (r.round2) {
    console.log(chalk.bold.yellow('--- Round 2: Cross-examination ---\n'));
    for (const a of r.round2) {
      totalCost += renderAnswer(a, tracker);
    }
  }

  // Recommendations summary: first sentence per role.
  const recs = r.round1
    .filter(a => !a.error && a.text)
    .map(a => ({
      role: a.role,
      panelist: a.panelist,
      first: extractFirstSentence(a.text),
    }));

  if (recs.length > 0) {
    console.log(chalk.bold.cyan('--- Recommendations at a glance ---'));
    for (const r of recs) {
      console.log(`  ${chalk.bold.green(r.role.padEnd(8))} ${chalk.dim('(' + r.panelist + ')')}  ${r.first}`);
    }
    console.log();
  }

  console.log(chalk.dim(`Total boardroom cost: $${totalCost.toFixed(4)}`));
}

function renderAnswer(a: PanelistAnswer, tracker: CostTracker): number {
  const header = `${chalk.bold.green(a.role)} ${chalk.dim('· ' + a.panelist + ' / ' + a.model)}`;
  if (a.error) {
    console.log(`${header} ${chalk.red('FAILED:')} ${a.error}\n`);
    return 0;
  }
  const { cost } = tracker.recordUsage(a.model, a.inputTokens, a.outputTokens);
  console.log(header);
  console.log(a.text);
  console.log(
    chalk.dim(
      `[${a.durationMs}ms · ${a.inputTokens} in / ${a.outputTokens} out · $${cost.toFixed(4)}]\n`,
    ),
  );
  return cost;
}

// Extract the first sentence, stripping markdown bold and trimming.
function extractFirstSentence(text: string): string {
  const cleaned = text.replace(/^\s*\*+\s*/, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
  const match = cleaned.match(/^[^.!?\n]+[.!?]/);
  return (match ? match[0] : cleaned.split('\n')[0]).trim();
}
