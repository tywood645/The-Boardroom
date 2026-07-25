import { Command } from 'commander';
import { detectProviders } from './provider/factory.js';
import { runBoardroom, describeAssignment } from './boardroom/protocol.js';
import { renderBoardroom } from './boardroom/render.js';
import { CostTracker } from './cost/tracker.js';
import { loadBudget, describeBudget } from './cost/config.js';
import type { RunContext } from './provider/collect.js';
import { Semaphore } from './util/semaphore.js';
import { Deadline } from './util/abort.js';
import { runMotion } from './motion/protocol.js';
import { renderMotion } from './motion/render.js';
import { writeMinutes } from './motion/minutes.js';
import { appendDecision } from './state/store.js';
import { buildRecallBlock } from './state/format.js';
import { registerDelegate } from './cli/delegate.js';

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
    .option('--session-cap <usd>', 'Refuse to dispatch a call that would push this run past this spend')
    .option('--daily-cap <usd>', 'Refuse to dispatch once today\'s recorded spend would exceed this')
    .option('--weekly-cap <usd>', 'Refuse to dispatch once this week\'s recorded spend would exceed this')
    .option('--concurrency <n>', 'Max provider calls in flight', String(DEFAULT_CONCURRENCY))
    .option('--deadline <ms>', 'Wall-clock budget for the whole run', String(DEFAULT_DEADLINE_MS))
    .action(async (questionParts: string[], cmdOpts: RunFlags & { rounds: string; maxTokens: string; consultant: boolean; recall: boolean }) => {
      const question = questionParts.join(' ');
      const configs = ensureConfigs();
      const { ctx, tracker, deadline } = makeContext(cmdOpts);
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
        ctx,
      });
      renderBoardroom(result);
      // process.exit skips async teardown, so persist usage before it runs.
      deadline.dispose();
      tracker.flush();
      process.exit(0);
    });

  // ----- resolution mode (Robert's Rules, motion → second → debate → vote → minutes) -----
  program
    .command('motion <text...>')
    .description('Resolution mode: put a concrete motion to the board for binding deliberation and vote')
    .option('--max-tokens <n>', 'Max tokens per phase response', '600')
    .option('--no-consultant', 'Skip the Consultant research briefing')
    .option('--no-recall', 'Skip prior board context (default: load ~/.boardroom/context.md + state.json)')
    .option('--session-cap <usd>', 'Refuse to dispatch a call that would push this run past this spend')
    .option('--daily-cap <usd>', 'Refuse to dispatch once today\'s recorded spend would exceed this')
    .option('--weekly-cap <usd>', 'Refuse to dispatch once this week\'s recorded spend would exceed this')
    .option('--concurrency <n>', 'Max provider calls in flight', String(DEFAULT_CONCURRENCY))
    .option('--deadline <ms>', 'Wall-clock budget for the whole run', String(DEFAULT_DEADLINE_MS))
    .action(async (textParts: string[], cmdOpts: RunFlags & { maxTokens: string; consultant: boolean; recall: boolean }) => {
      const motion = textParts.join(' ');
      const configs = ensureConfigs();
      const { ctx, tracker, deadline } = makeContext(cmdOpts);
      console.log('Convening ' + configs.length + ' advisors: ' + describeAssignment(configs));
      console.log('Motion phases: brief → second → debate → vote → minutes');
      const recall = cmdOpts.recall === false ? null : buildRecallBlock();
      if (recall) console.log('Loaded prior board context (' + recall.length + ' chars)');
      console.log();
      const result = await runMotion(configs, motion, {
        maxTokens: parseInt(cmdOpts.maxTokens),
        consultant: cmdOpts.consultant,
        recall,
        ctx,
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
      deadline.dispose();
      tracker.flush();
      process.exit(0);
    });

  // Tiered dispatch. A sibling of the board, not a layer under it: the board
  // seats one vendor per role to manufacture disagreement, the delegator picks
  // one model per task to minimise cost. Opposite objectives, separate command.
  registerDelegate(program);

  await program.parseAsync(process.argv);
}

// The board is six seats, so this preserves today's fan-out exactly while
// making the cap explicit and adjustable.
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_DEADLINE_MS = 120_000;

interface RunFlags {
  sessionCap?: string;
  dailyCap?: string;
  weeklyCap?: string;
  concurrency?: string;
  deadline?: string;
}

function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the limits every provider call in this run will be held to. They are
 * applied inside collectStream, so no call site can opt out of them.
 */
function makeContext(flags: RunFlags): { ctx: RunContext; tracker: CostTracker; deadline: Deadline } {
  const budget = loadBudget(flags);
  if (budget.sessionCap || budget.dailyCap || budget.weeklyCap) {
    console.log('Budget caps: ' + describeBudget(budget));
  }
  const tracker = new CostTracker(budget);
  const limiter = new Semaphore(Math.floor(positive(flags.concurrency, DEFAULT_CONCURRENCY)));
  const deadline = new Deadline(positive(flags.deadline, DEFAULT_DEADLINE_MS), 'run');
  return { ctx: { tracker, limiter, signal: deadline.signal }, tracker, deadline };
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
