import { randomBytes } from 'node:crypto';
import type { ProviderConfig } from '../provider/factory.js';
import { createProvider } from '../provider/factory.js';
import { collectStream, type RunContext, type Collected } from '../provider/collect.js';
import type { Tier } from '../cost/catalog.js';
import { TIERS } from '../cost/catalog.js';
import { BudgetError, DeadlineError } from '../util/error.js';
import { resolveTier, nextTier, type Resolution } from './tiers.js';
import { classify, type TaskClass } from './classify.js';
import { loadStats, pickStartTier } from './stats.js';
import { appendDelegation, type Outcome } from './ledger.js';
import { VERIFY_SYSTEM, buildVerifyPrompt, parseVerdict, type Verdict } from './verify.js';

/**
 * Cheap-first escalation.
 *
 * The cheap tier is attempted first, a same-tier different-vendor checker
 * tries to refute it, and only a concretely named defect buys a more expensive
 * attempt. Spending the expensive tier up front, or verifying on it by
 * default, pays for capability most tasks never needed.
 */

/** cheap → mid → frontier and stop. Past two escalations, more spend stops buying quality. */
export const MAX_ESCALATIONS = 2;
/** Belt and braces, independent of the ladder. */
export const MAX_ATTEMPTS = 4;

const DELEGATE_SYSTEM = `You are completing a single, self-contained task. Answer it directly and completely.

Do not restate the task. Do not explain your approach unless the task asks for it. Do not hedge.
If the task is ambiguous, state the single assumption you made in one sentence, then answer under it.`;

export interface DelegateOptions {
  taskClass?: TaskClass;
  /** Floor for the ladder; the delegator never starts below this. */
  minTier?: Tier;
  /** "vendor:model" pin. Disables escalation, since the model was chosen for us. */
  pin?: string;
  maxTokens?: number;
  verify?: boolean;
  /** Injected in tests so a run can be driven without touching ~/.boardroom. */
  stats?: ReturnType<typeof loadStats>;
}

export interface Attempt {
  tier: Tier;
  vendor: string;
  model: string;
  text: string;
  cost: number;
  durationMs: number;
  verdict?: Verdict;
  verdictBy?: string;
  outcome: Outcome;
  downgradedFrom?: Tier;
}

export interface DelegateResult {
  task: string;
  cls: TaskClass;
  classifiedWhy: string;
  startTier: Tier;
  startWhy: string;
  attempts: Attempt[];
  /** The answer that was accepted, or the best one reached before stopping. */
  answer: string;
  /**
   * How the attempt that produced `answer` was judged, or null with no answer.
   * Differs from finalOutcome when a later attempt failed: the run then ends
   * 'error' or 'budget_blocked' while still returning an earlier answer, which
   * may be one the checker refuted.
   */
  answerOutcome: Outcome | null;
  finalOutcome: Outcome;
  totalCost: number;
  stoppedBecause?: string;
}

function atLeast(tier: Tier, floor: Tier | undefined, order: readonly Tier[]): Tier {
  if (!floor) return tier;
  return order.indexOf(tier) >= order.indexOf(floor) ? tier : floor;
}

async function callOnce(
  config: ProviderConfig,
  system: string,
  prompt: string,
  maxTokens: number,
  ctx: RunContext,
): Promise<Collected> {
  return collectStream(
    createProvider(config),
    { system, messages: [{ role: 'user', content: prompt }], tools: [], maxTokens, model: config.model },
    ctx,
  );
}

function classifyFailure(e: unknown): { outcome: Outcome; reason: string } {
  if (e instanceof BudgetError) return { outcome: 'budget_blocked', reason: e.message };
  if (e instanceof DeadlineError) return { outcome: 'deadline', reason: e.message };
  return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
}

export async function delegate(
  task: string,
  configs: ProviderConfig[],
  ctx: RunContext,
  opts: DelegateOptions = {},
): Promise<DelegateResult> {
  const maxTokens = opts.maxTokens ?? 1024;
  const verifyEnabled = opts.verify !== false && !opts.pin;

  const { cls, why: classifiedWhy } = classify(task, opts.taskClass);
  const stats = opts.stats ?? loadStats();
  const picked = pickStartTier(cls, stats);
  const startTier = atLeast(picked.tier, opts.minTier, TIERS);
  const startWhy =
    startTier === picked.tier ? picked.why : `${picked.why}; raised to ${startTier} by --min-tier`;

  // Stats group attempts by run, so ids from parallel processes must not collide.
  const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}-${cls}`;
  const result: DelegateResult = {
    task,
    cls,
    classifiedWhy,
    startTier,
    startWhy,
    attempts: [],
    answer: '',
    answerOutcome: null,
    finalOutcome: 'error',
    totalCost: 0,
  };

  let tier: Tier = startTier;
  let escalations = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let resolved: Resolution;
    try {
      resolved = resolveTier(tier, configs, {}, opts.pin);
    } catch (e) {
      result.stoppedBecause = e instanceof Error ? e.message : String(e);
      break;
    }

    let answer: Collected;
    try {
      answer = await callOnce(resolved.config, DELEGATE_SYSTEM, task, maxTokens, ctx);
    } catch (e) {
      const { outcome, reason } = classifyFailure(e);
      result.attempts.push({
        tier: resolved.tier,
        vendor: resolved.vendor,
        model: resolved.model,
        text: '',
        cost: 0,
        durationMs: 0,
        outcome,
        downgradedFrom: resolved.downgradedFrom,
      });
      appendDelegation({
        v: 1, ts: new Date().toISOString(), runId, attempt,
        cls, tier: resolved.tier, vendor: resolved.vendor, model: resolved.model,
        downgradedFrom: resolved.downgradedFrom,
        inputTokens: 0, outputTokens: 0, cost: 0, latencyMs: 0, ttfbMs: 0,
        outcome,
      });
      result.finalOutcome = outcome;
      result.stoppedBecause = reason;
      break;
    }

    result.totalCost += answer.cost;
    // Hold onto the best answer so far, so a later budget stop still returns something.
    result.answer = answer.text;

    const record: Attempt = {
      tier: resolved.tier,
      vendor: resolved.vendor,
      model: resolved.model,
      text: answer.text,
      cost: answer.cost,
      durationMs: answer.durationMs,
      outcome: 'unverified',
      downgradedFrom: resolved.downgradedFrom,
    };

    // The top tier is the end of the ladder. Verifying it buys nothing, since
    // a refutation would have nowhere to escalate to — and it is the single
    // most expensive call the delegator can make.
    const atTop = nextTier(resolved.tier) === null;
    const canEscalate = escalations < MAX_ESCALATIONS && !atTop;

    if (verifyEnabled && canEscalate) {
      const check = await runCheck(task, answer.text, resolved, configs, ctx, maxTokens);
      if (check) {
        record.verdict = check.verdict;
        record.verdictBy = check.by;
        record.cost += check.cost;
        result.totalCost += check.cost;
      }
    }

    record.outcome =
      record.verdict?.kind === 'refuted'
        ? 'refuted'
        : record.verdict?.kind === 'confirmed'
          ? 'confirmed'
          : 'unverified';

    const escalateTo = record.outcome === 'refuted' ? nextTier(resolved.tier) : null;

    appendDelegation({
      v: 1, ts: new Date().toISOString(), runId, attempt,
      cls, tier: resolved.tier, vendor: resolved.vendor, model: resolved.model,
      downgradedFrom: resolved.downgradedFrom,
      inputTokens: answer.inputTokens, outputTokens: answer.outputTokens,
      estimatedInput: answer.estimatedInput || undefined,
      cost: answer.cost, latencyMs: answer.durationMs, ttfbMs: answer.ttfbMs,
      outcome: record.outcome,
      verdictBy: record.verdictBy,
      defect: record.verdict?.defect || undefined,
      escalatedTo: escalateTo ?? undefined,
    });

    result.attempts.push(record);
    result.finalOutcome = record.outcome;
    result.answerOutcome = record.outcome;

    if (!escalateTo) break;
    tier = escalateTo;
    escalations++;
  }

  if (result.attempts.length >= MAX_ATTEMPTS && !result.stoppedBecause) {
    result.stoppedBecause = `hit the ${MAX_ATTEMPTS}-attempt ceiling`;
  }
  return result;
}

/**
 * Check an answer with a different model at the same tier.
 *
 * A model must never check its own work, so the attempt's vendor:model is
 * excluded outright rather than discouraged in the prompt. If the tier has no
 * second model, the check is skipped rather than falling back to the same one.
 * A failed check is not a failed task: it records `unverified` and keeps the
 * answer, because a budget stop during verification should not throw away work
 * that was already paid for.
 */
async function runCheck(
  task: string,
  answer: string,
  attempted: Resolution,
  configs: ProviderConfig[],
  ctx: RunContext,
  maxTokens: number,
): Promise<{ verdict: Verdict; by: string; cost: number } | null> {
  let checker: Resolution;
  try {
    // Pins are ignored here: a tier pinned by env or flag names the model
    // doing the work, and resolving the checker through the same pin returned
    // that very model, so every pinned run went silently unverified.
    checker = resolveTier(attempted.tier, configs, {
      exclude: [`${attempted.vendor}:${attempted.model}`],
      ignorePins: true,
      avoidVendor: attempted.vendor,
    });
  } catch {
    return null; // no independent checker available at this tier
  }
  if (checker.vendor === attempted.vendor && checker.model === attempted.model) return null;

  try {
    const collected = await callOnce(
      checker.config,
      VERIFY_SYSTEM,
      buildVerifyPrompt(task, answer),
      Math.min(maxTokens, 200),
      ctx,
    );
    const verdict = parseVerdict(collected.text);
    // A sibling from the same vendor is a weaker check than the cross-vendor
    // one the design calls for. Use it when it is all there is, and say so.
    if (checker.vendor === attempted.vendor) {
      verdict.why += ' (same-vendor checker: no other vendor is credentialed at this tier)';
    }
    return {
      verdict,
      by: `${checker.vendor}:${checker.model}`,
      cost: collected.cost,
    };
  } catch {
    return null;
  }
}
