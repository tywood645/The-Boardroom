import chalk from 'chalk';
import type { BoardroomResult } from './protocol.js';
import type { PanelistAnswer } from './panel.js';

// Cost is recorded at the point of the call, in collectStream. Rendering only
// displays what was already spent; it must never be where accounting happens.
export function renderBoardroom(r: BoardroomResult): void {
  console.log(chalk.bold.cyan('\n=== BOARDROOM ==='));
  console.log(chalk.dim(r.question));
  console.log();

  let totalCost = 0;

  if (r.briefing) {
    console.log(chalk.bold.magenta('--- Consultant briefing ---'));
    console.log(chalk.dim('Source: ' + r.briefing.source + ' / ' + r.briefing.model));
    console.log(r.briefing.text);
    console.log(chalk.dim(`[${r.briefing.durationMs}ms · ${r.briefing.inputTokens} in / ${r.briefing.outputTokens} out · $${r.briefing.cost.toFixed(4)}]\n`));
    totalCost += r.briefing.cost;
  } else {
    console.log(chalk.dim('(no consultant briefing: disabled, unavailable, or returned empty)\n'));
  }

  console.log(chalk.bold.yellow('--- Round 1: Independent answers (sealed-bid) ---\n'));
  for (const a of r.round1) {
    totalCost += renderAnswer(a);
  }

  if (r.round2) {
    console.log(chalk.bold.yellow('--- Round 2: Cross-examination ---\n'));
    for (const a of r.round2) {
      totalCost += renderAnswer(a);
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
    for (const rec of recs) {
      console.log(`  ${chalk.bold.green(rec.role.padEnd(8))} ${chalk.dim('(' + rec.panelist + ')')}  ${rec.first}`);
    }
    console.log();
  }

  console.log(chalk.dim(`Total boardroom cost: $${totalCost.toFixed(4)}`));
}

function renderAnswer(a: PanelistAnswer): number {
  const header = `${chalk.bold.green(a.role)} ${chalk.dim('· ' + a.panelist + ' / ' + a.model)}`;
  if (a.error) {
    console.log(`${header} ${chalk.red('FAILED:')} ${a.error}\n`);
    return 0;
  }
  console.log(header);
  console.log(a.text);
  console.log(
    chalk.dim(
      `[${a.durationMs}ms · ${a.inputTokens} in / ${a.outputTokens} out · $${a.cost.toFixed(4)}]\n`,
    ),
  );
  return a.cost;
}

// Extract the first sentence, stripping markdown bold and trimming.
function extractFirstSentence(text: string): string {
  const cleaned = text.replace(/^\s*\*+\s*/, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
  const match = cleaned.match(/^[^.!?\n]+[.!?]/);
  return (match ? match[0] : cleaned.split('\n')[0]).trim();
}
