import type { Command } from 'commander';
import { detectProviders } from '../provider/factory.js';
import { CostTracker } from '../cost/tracker.js';
import { loadBudget, describeBudget } from '../cost/config.js';
import { Semaphore } from '../util/semaphore.js';
import { Deadline, exitCleanlyOnSignal } from '../util/abort.js';
import type { RunContext } from '../provider/collect.js';
import { delegate } from '../delegate/escalate.js';
import { renderDelegation, renderStats, renderVerifyCatalog } from '../delegate/render.js';
import { verifyCatalog } from '../delegate/verify-catalog.js';
import { isTaskClass, TASK_CLASSES, type TaskClass } from '../delegate/classify.js';
import { TIERS, type Tier } from '../cost/catalog.js';
import { positive, positiveInt } from './args.js';
import { safeForTerminal } from '../util/terminal.js';

// delegate is the automated path, so it ships with caps on by default rather than
// waiting for someone to remember to set them.
const DEFAULT_SESSION_CAP = 1.0;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DEADLINE_MS = 180_000;

interface DelegateFlags {
  class?: string;
  minTier?: string;
  model?: string;
  maxTokens: string;
  verify: boolean;
  explain?: boolean;
  json?: boolean;
  verifyCatalog?: boolean;
  strict?: boolean;
  sessionCap?: string;
  dailyCap?: string;
  weeklyCap?: string;
  concurrency?: string;
  deadline?: string;
}

/** 0: an answer that was not refuted. 1: no answer. 2: the only answer was refuted. */
export function delegateExitCode(result: { answer: string; answerOutcome: string | null }): 0 | 1 | 2 {
  if (!result.answer) return 1;
  return result.answerOutcome === 'refuted' ? 2 : 0;
}

export function registerDelegate(program: Command): void {
  program
    .command('delegate [task...]')
    .description('Cheap-first tiered dispatch: try the cheapest capable model, escalate only on a named defect')
    .option('--class <c>', `Task class (${TASK_CLASSES.join('|')}); inferred when omitted`)
    .option('--min-tier <t>', `Never start below this tier (${TIERS.join('|')})`)
    .option('--model <vendor:model>', 'Pin one model; disables escalation')
    .option('--max-tokens <n>', 'Max tokens per attempt', '1024')
    .option('--no-verify', 'Skip cross-vendor verification (cheaper, unchecked)')
    .option('--explain', 'Show the delegation decision and every attempt')
    .option('--json', 'Emit the full result as JSON')
    .option('--verify-catalog', "Ask every credentialed vendor which models it serves; exit non-zero if the catalog names one that is gone")
    .option('--strict', 'With --verify-catalog, also fail when a vendor could not be checked at all')
    .option('--session-cap <usd>', `Refuse to dispatch a call that would push this run past this spend (default ${DEFAULT_SESSION_CAP} unless BOARDROOM_SESSION_CAP is set; "none" disables)`)
    .option('--daily-cap <usd>', "Refuse to dispatch once today's recorded spend would exceed this")
    .option('--weekly-cap <usd>', "Refuse to dispatch once this week's recorded spend would exceed this")
    .option('--concurrency <n>', 'Max provider calls in flight', String(DEFAULT_CONCURRENCY))
    .option('--deadline <ms>', 'Wall-clock budget for the whole run', String(DEFAULT_DEADLINE_MS))
    .action(async (taskParts: string[] | undefined, flags: DelegateFlags) => {
      const configs = detectProviders();
      const parts = taskParts ?? [];

      // `delegate stats` is a subcommand-shaped argument rather than a real
      // subcommand so that `delegate <task...>` keeps its natural free-text form.
      if (parts.length === 1 && parts[0] === 'stats') {
        renderStats(configs);
        process.exit(0);
      }

      // The catalog is hand-maintained and goes stale silently. This asks the
      // vendors instead of trusting the table, and exits non-zero when one of
      // them says a model we carry is gone, so it can gate a release.
      if (flags.verifyCatalog || (parts.length === 1 && parts[0] === 'verify-catalog')) {
        if (configs.length === 0) {
          console.error('No providers detected, so there is nobody to ask. Set at least one vendor API key (see .env.example).');
          process.exit(1);
        }
        const result = await verifyCatalog(configs);
        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else renderVerifyCatalog(result, Boolean(flags.strict));
        // Without --strict an unchecked vendor passes, so one key locally is
        // useful rather than noisy. A release gate wants the opposite: a run
        // that checked nothing knows nothing, and must not read as a pass.
        const failed = !result.ok || (Boolean(flags.strict) && result.incomplete);
        process.exit(failed ? 1 : 0);
      }

      const task = parts.join(' ').trim();
      if (!task) {
        console.error(
          'Usage: boardroom delegate <task...>   |   boardroom delegate stats   |   boardroom delegate --verify-catalog',
        );
        process.exit(1);
      }

      // Deliberately not ensureConfigs(): the board needs two vendors to
      // disagree, but a single credentialed vendor is a valid delegator setup.
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

      const maxTokens = positiveInt(flags.maxTokens, '--max-tokens');
      const budget = loadBudget(flags, { sessionCap: DEFAULT_SESSION_CAP });
      const tracker = new CostTracker(budget);
      const deadline = new Deadline(positive(flags.deadline, DEFAULT_DEADLINE_MS), 'delegate');
      exitCleanlyOnSignal(deadline);
      const ctx: RunContext = {
        tracker,
        limiter: new Semaphore(Math.max(1, Math.floor(positive(flags.concurrency, DEFAULT_CONCURRENCY)))),
        signal: deadline.signal,
      };

      if (flags.explain) {
        // On stderr when --json is set, so stdout stays one JSON document.
        (flags.json ? console.error : console.log)(`budget: ${describeBudget(budget)}`);
      }

      try {
        const result = await delegate(task, configs, ctx, {
          taskClass,
          minTier,
          pin: flags.model,
          maxTokens,
          verify: flags.verify,
        });

        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else renderDelegation(result, Boolean(flags.explain));

        deadline.dispose();
        // A run that never produced an answer is a failure the shell should
        // see (1). So is one whose only answer was refuted by the checker (2):
        // a wrapper reading the exit code must not take that for success.
        process.exit(delegateExitCode(result));
      } catch (e: any) {
        deadline.dispose();
        console.error(safeForTerminal(e?.message || String(e)));
        process.exit(1);
      }
    });
}
