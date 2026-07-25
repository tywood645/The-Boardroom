import type { Command } from 'commander';
import { detectProviders } from '../provider/factory.js';
import { CostTracker } from '../cost/tracker.js';
import { loadBudget, describeBudget } from '../cost/config.js';
import { Semaphore } from '../util/semaphore.js';
import { Deadline } from '../util/abort.js';
import type { RunContext } from '../provider/collect.js';
import { route } from '../router/escalate.js';
import { renderRoute, renderStats } from '../router/render.js';
import { isTaskClass, TASK_CLASSES, type TaskClass } from '../router/classify.js';
import { TIERS, type Tier } from '../cost/catalog.js';

// route is the automated path, so it ships with caps on by default rather than
// waiting for someone to remember to set them.
const DEFAULT_SESSION_CAP = '1.00';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DEADLINE_MS = 180_000;

interface RouteFlags {
  class?: string;
  minTier?: string;
  model?: string;
  maxTokens: string;
  verify: boolean;
  explain?: boolean;
  json?: boolean;
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

export function registerRoute(program: Command): void {
  program
    .command('route [task...]')
    .description('Cheap-first tiered dispatch: try the cheapest capable model, escalate only on a named defect')
    .option('--class <c>', `Task class (${TASK_CLASSES.join('|')}); inferred when omitted`)
    .option('--min-tier <t>', `Never start below this tier (${TIERS.join('|')})`)
    .option('--model <vendor:model>', 'Pin one model; disables escalation')
    .option('--max-tokens <n>', 'Max tokens per attempt', '1024')
    .option('--no-verify', 'Skip cross-vendor verification (cheaper, unchecked)')
    .option('--explain', 'Show the routing decision and every attempt')
    .option('--json', 'Emit the full result as JSON')
    .option('--session-cap <usd>', 'Refuse to dispatch a call that would push this run past this spend', DEFAULT_SESSION_CAP)
    .option('--daily-cap <usd>', "Refuse to dispatch once today's recorded spend would exceed this")
    .option('--weekly-cap <usd>', "Refuse to dispatch once this week's recorded spend would exceed this")
    .option('--concurrency <n>', 'Max provider calls in flight', String(DEFAULT_CONCURRENCY))
    .option('--deadline <ms>', 'Wall-clock budget for the whole run', String(DEFAULT_DEADLINE_MS))
    .action(async (taskParts: string[] | undefined, flags: RouteFlags) => {
      const configs = detectProviders();
      const parts = taskParts ?? [];

      // `route stats` is a subcommand-shaped argument rather than a real
      // subcommand so that `route <task...>` keeps its natural free-text form.
      if (parts.length === 1 && parts[0] === 'stats') {
        renderStats(configs);
        process.exit(0);
      }

      const task = parts.join(' ').trim();
      if (!task) {
        console.error('Usage: boardroom route <task...>   |   boardroom route stats');
        process.exit(1);
      }

      // Deliberately not ensureConfigs(): the board needs two vendors to
      // disagree, but a single credentialed vendor is a valid router setup.
      if (configs.length === 0) {
        console.error('No providers detected. Set at least one vendor API key (see .env.example).');
        process.exit(1);
      }

      let taskClass: TaskClass | undefined;
      if (flags.class) {
        if (!isTaskClass(flags.class)) {
          console.error(`Unknown --class "${flags.class}". Expected one of: ${TASK_CLASSES.join(', ')}`);
          process.exit(1);
        }
        taskClass = flags.class;
      }

      let minTier: Tier | undefined;
      if (flags.minTier) {
        if (!(TIERS as readonly string[]).includes(flags.minTier)) {
          console.error(`Unknown --min-tier "${flags.minTier}". Expected one of: ${TIERS.join(', ')}`);
          process.exit(1);
        }
        minTier = flags.minTier as Tier;
      }

      const budget = loadBudget(flags);
      const tracker = new CostTracker(budget);
      const deadline = new Deadline(positive(flags.deadline, DEFAULT_DEADLINE_MS), 'route');
      const ctx: RunContext = {
        tracker,
        limiter: new Semaphore(Math.floor(positive(flags.concurrency, DEFAULT_CONCURRENCY))),
        signal: deadline.signal,
      };

      if (flags.explain) {
        console.log(`budget: ${describeBudget(budget)}`);
      }

      try {
        const result = await route(task, configs, ctx, {
          taskClass,
          minTier,
          pin: flags.model,
          maxTokens: parseInt(flags.maxTokens),
          verify: flags.verify,
        });

        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else renderRoute(result, Boolean(flags.explain));

        deadline.dispose();
        tracker.flush();
        // A run that never produced an answer is a failure the shell should see.
        process.exit(result.answer ? 0 : 1);
      } catch (e: any) {
        deadline.dispose();
        tracker.flush();
        console.error(e?.message || String(e));
        process.exit(1);
      }
    });
}
