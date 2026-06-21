import { Command } from 'commander';
import { detectProviders } from './provider/factory.js';
import { runBoardroom, describeAssignment } from './boardroom/protocol.js';
import { renderBoardroom } from './boardroom/render.js';
import { CostTracker } from './cost/tracker.js';
import { runMotion } from './motion/protocol.js';
import { renderMotion } from './motion/render.js';
import { writeMinutes } from './motion/minutes.js';
import { appendDecision } from './state/store.js';
import { buildRecallBlock } from './state/format.js';

export async function main(): Promise<void> {
  const program = new Command()
    .name('boardroom')
    .description('Multi-vendor LLM advisory panel for solo founders')
    .version('0.1.0');

  // ----- exploration mode (sealed-bid, original) -----
  program
    .command('ask <question...>', { isDefault: true })
    .description('Sealed-bid exploration: 6 advisors answer in parallel (default mode)')
    .option('--rounds <n>', 'Rounds (1=independent only, 2=+cross-examination)', '1')
    .option('--max-tokens <n>', 'Max tokens per panelist response', '1024')
    .option('--no-consultant', 'Skip the Consultant research briefing (isolate vendor priors)')
    .option('--no-recall', 'Skip prior board context (default: load ~/.boardroom/context.md + state.json)')
    .action(async (questionParts: string[], cmdOpts: { rounds: string; maxTokens: string; consultant: boolean; recall: boolean }) => {
      const question = questionParts.join(' ');
      const configs = ensureConfigs();
      console.log('Convening ' + configs.length + ' advisors: ' + describeAssignment(configs));
      const rounds = parseInt(cmdOpts.rounds);
      if (rounds !== 1 && rounds !== 2) {
        console.error('--rounds must be 1 or 2');
        process.exit(1);
      }
      const recall = cmdOpts.recall === false ? null : buildRecallBlock();
      if (recall) console.log('Loaded prior board context (' + recall.length + ' chars)');
      const result = await runBoardroom(configs, question, {
        rounds: rounds as 1 | 2,
        maxTokens: parseInt(cmdOpts.maxTokens),
        consultant: cmdOpts.consultant,
        recall,
      });
      renderBoardroom(result, new CostTracker());
      process.exit(0);
    });

  // ----- resolution mode (Robert's Rules, motion → second → debate → vote → minutes) -----
  program
    .command('motion <text...>')
    .description('Resolution mode: put a concrete motion to the board for binding deliberation and vote')
    .option('--max-tokens <n>', 'Max tokens per phase response', '600')
    .option('--no-consultant', 'Skip the Consultant research briefing')
    .option('--no-recall', 'Skip prior board context (default: load ~/.boardroom/context.md + state.json)')
    .action(async (textParts: string[], cmdOpts: { maxTokens: string; consultant: boolean; recall: boolean }) => {
      const motion = textParts.join(' ');
      const configs = ensureConfigs();
      console.log('Convening ' + configs.length + ' advisors: ' + describeAssignment(configs));
      console.log('Motion phases: brief → second → debate → vote → minutes');
      const recall = cmdOpts.recall === false ? null : buildRecallBlock();
      if (recall) console.log('Loaded prior board context (' + recall.length + ' chars)');
      console.log();
      const result = await runMotion(configs, motion, {
        maxTokens: parseInt(cmdOpts.maxTokens),
        consultant: cmdOpts.consultant,
        recall,
      });
      result.minutesPath = writeMinutes(result);
      // Persist this decision into the institutional memory so future
      // meetings see it via --recall.
      try {
        appendDecision(result);
      } catch (e: any) {
        console.error('Warning: failed to persist decision to state.json:', e?.message || e);
      }
      renderMotion(result);
      process.exit(0);
    });

  await program.parseAsync(process.argv);
}

function ensureConfigs() {
  const configs = detectProviders();
  if (configs.length < 2) {
    console.error('BoardRoom needs at least 2 providers with API keys set.');
    console.error('Detected: ' + (configs.map(c => c.name).join(', ') || 'none'));
    console.error('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY, or PERPLEXITY_API_KEY.');
    process.exit(1);
  }
  return configs;
}
