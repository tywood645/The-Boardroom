import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { detectProviders } from './provider/factory.js';
import { runEval } from './eval/run.js';
import { runExperiment } from './eval/experiment.js';
import { renderExperiment } from './eval/experiment-render.js';
import { renderReport, renderComparison } from './eval/render.js';
import { compareToControl } from './eval/divergence.js';
import { CATEGORIES, type Category } from './eval/corpus.js';
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

  // ----- measurement mode (divergence eval over the fixed corpus) -----
  // A full run is 180 provider calls per arm, so it takes the same budget,
  // concurrency and deadline flags as the board itself and shares the one
  // tracker: the eval is not exempt from the spend gate.
  program
    .command('eval')
    .description('Measure how often the board actually splits, over a fixed 30-question corpus')
    .option('--category <name>', 'Restrict to one category: capital, hiring, product, gtm')
    .option('--limit <n>', 'Run only the first N questions (smoke tests)')
    .option('--max-tokens <n>', 'Max tokens per panelist response', '512')
    .option('--control <vendor>', 'Seat ONE vendor in all six roles instead of the real panel')
    .option('--compare <vendor>', 'Run the panel AND a single-vendor control, then compare')
    .option('--rotate', 'Sweep a Latin square of role assignments so vendor effects are not role effects')
    .option('--trials <n>', 'Independent repetitions of the whole sweep, for run-to-run variance', '1')
    .option('--rotations <n>', 'Rotations per trial (default: a full square over the detected vendors)')
    .option('--threshold <rate>', 'Practical significance floor for the premise, as a rate', '0.10')
    .option('--json <path>', 'Write the full report to a JSON file')
    .option('--session-cap <usd>', 'Refuse to dispatch a call that would push this run past this spend')
    .option('--daily-cap <usd>', 'Refuse to dispatch once today\'s recorded spend would exceed this')
    .option('--weekly-cap <usd>', 'Refuse to dispatch once this week\'s recorded spend would exceed this')
    .option('--concurrency <n>', 'Max provider calls in flight', String(DEFAULT_CONCURRENCY))
    .option('--deadline <ms>', 'Wall-clock budget for the whole run', String(DEFAULT_DEADLINE_MS))
    .action(async (cmdOpts: RunFlags & {
      category?: string; limit?: string; maxTokens: string;
      control?: string; compare?: string; json?: string;
      rotate?: boolean; trials: string; rotations?: string; threshold: string;
    }) => {
      const configs = ensureConfigs();

      if (cmdOpts.category && !CATEGORIES.includes(cmdOpts.category as Category)) {
        console.error(`--category must be one of: ${CATEGORIES.join(', ')}`);
        process.exit(1);
      }
      if (cmdOpts.control && cmdOpts.compare) {
        console.error('--control and --compare are mutually exclusive.');
        process.exit(1);
      }
      // Rotation and trials only mean something for a two-arm comparison: there
      // is no premise to check without a control, and silently ignoring the
      // flags would let someone believe they ran the hardened design.
      if ((cmdOpts.rotate || cmdOpts.rotations || parseInt(cmdOpts.trials) > 1) && !cmdOpts.compare) {
        console.error('--rotate, --rotations and --trials require --compare <vendor>.');
        process.exit(1);
      }

      const { ctx, tracker, deadline } = makeContext(cmdOpts);
      const base = {
        category: cmdOpts.category as Category | undefined,
        limit: cmdOpts.limit ? parseInt(cmdOpts.limit) : undefined,
        maxTokens: parseInt(cmdOpts.maxTokens),
        ctx,
        onProgress: (done: number, total: number, id: string) => {
          process.stderr.write(`\r  ${done}/${total} ${id}          `);
        },
      };

      // The hardened path: paired arms, rotated seats, repeated trials, and a
      // McNemar decision. Chosen whenever the run is designed as an experiment
      // rather than a single descriptive pass.
      const trials = parseInt(cmdOpts.trials);
      if (cmdOpts.compare && (cmdOpts.rotate || cmdOpts.rotations || trials > 1)) {
        const result = await runExperiment(configs, {
          ...base,
          control: cmdOpts.compare,
          trials,
          rotations: cmdOpts.rotations ? parseInt(cmdOpts.rotations) : undefined,
          threshold: parseFloat(cmdOpts.threshold),
        });
        process.stderr.write('\r');
        renderExperiment(result);

        if (cmdOpts.json) {
          writeFileSync(cmdOpts.json, JSON.stringify(result, null, 2), 'utf-8');
          console.log(`Report written to ${cmdOpts.json}`);
        }
        deadline.dispose();
        tracker.flush();
        // A refuted premise is a successful measurement, not a tool failure, so
        // only an inconclusive run signals non-zero for a CI gate to catch.
        process.exit(result.premise.verdict === 'inconclusive' ? 2 : 0);
      }

      const panel = await runEval(configs, { ...base, control: cmdOpts.control });
      process.stderr.write('\r');
      renderReport(panel.report, panel.costUsd);

      let comparison;
      if (cmdOpts.compare) {
        const control = await runEval(configs, { ...base, control: cmdOpts.compare });
        process.stderr.write('\r');
        renderReport(control.report, control.costUsd);
        comparison = compareToControl(panel.report, control.report);
        renderComparison(comparison);
      }

      if (cmdOpts.json) {
        writeFileSync(
          cmdOpts.json,
          JSON.stringify(comparison ?? panel.report, null, 2),
          'utf-8',
        );
        console.log(`Report written to ${cmdOpts.json}`);
      }
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
