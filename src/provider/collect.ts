import type { LLMProvider } from './base.js';
import type { MessageCreateParams } from './types.js';
import type { CostTracker } from '../cost/tracker.js';
import type { Semaphore } from '../util/semaphore.js';
import { costOf } from '../cost/catalog.js';
import { BudgetError, ProviderError } from '../util/error.js';

/**
 * The single place a provider stream is consumed.
 *
 * Three near-identical drain loops used to live in panel.ts, consultant.ts and
 * motion/protocol.ts. Collapsing them here fixes token accounting once instead
 * of three times, and — more importantly — creates one choke point that every
 * provider call must pass through, so budget, concurrency and deadline limits
 * are enforced rather than advised.
 *
 * A test in tests/enforcement-invariant.test.ts asserts that this is the only
 * non-provider file that calls createMessage().
 */

export interface Collected {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  /** Time to first text delta; the delegator's latency signal. */
  ttfbMs: number;
  vendor: string;
  model: string;
  /** True when inputTokens came from a character estimate, not the provider. */
  estimatedInput: boolean;
}

/**
 * Everything a run enforces on its provider calls. Threaded through the
 * protocols so every call inherits the same limits.
 */
export interface RunContext {
  /** Records spend and answers the pre-dispatch budget question. */
  tracker?: CostTracker;
  /** Caps calls in flight. Applied here so fan-out sites stay unchanged. */
  limiter?: Semaphore;
  /** Run-level wall-clock deadline. */
  signal?: AbortSignal;
}

/** Rough token estimate for budgeting only. Never reported as actual usage. */
export function estimateTokens(params: MessageCreateParams): number {
  const messageChars = params.messages.reduce((n, m) => {
    if (typeof m.content === 'string') return n + m.content.length;
    return n + m.content.reduce((k, b) => k + JSON.stringify(b).length, 0);
  }, 0);
  return Math.ceil((params.system.length + messageChars) / 4);
}

export async function collectStream(
  provider: LLMProvider,
  params: MessageCreateParams,
  ctx: RunContext = {},
): Promise<Collected> {
  // Wait for a slot before checking the budget, so the gate sees spend that
  // concurrent calls have already committed rather than a stale total.
  const release = ctx.limiter ? await ctx.limiter.acquire() : () => {};
  try {
    return await dispatch(provider, params, ctx);
  } finally {
    release();
  }
}

async function dispatch(
  provider: LLMProvider,
  params: MessageCreateParams,
  ctx: RunContext,
): Promise<Collected> {
  const model = params.model || provider.modelId;
  const { tracker } = ctx;

  // Pre-dispatch gate. This runs before fetch, which is the whole point:
  // recording usage afterwards can report an overrun but cannot prevent one.
  if (tracker) {
    const alert = tracker.reserve(model, estimateTokens(params), params.maxTokens);
    if (alert?.type === 'blocked') {
      throw new BudgetError(
        `${alert.message} ($${alert.currentSpend.toFixed(4)} of $${alert.cap.toFixed(2)}); ` +
          `refusing to dispatch to ${provider.name}/${model}`,
        alert.currentSpend,
        alert.cap,
      );
    }
  }

  const start = Date.now();
  let text = '';
  let ttfbMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = provider.createMessage({ ...params, signal: ctx.signal ?? params.signal });

  for await (const ev of stream) {
    switch (ev.type) {
      case 'message_start':
        // Authoritative on the Anthropic path. On OpenAI-compatible streams this
        // fires before the usage chunk exists, so it carries 0 and is ignored.
        if (ev.message.usage.input_tokens > 0) inputTokens = ev.message.usage.input_tokens;
        break;
      case 'content_block_delta':
        if (ev.delta.type === 'text_delta') {
          if (ttfbMs === 0) ttfbMs = Date.now() - start;
          text += ev.delta.text;
        }
        break;
      case 'message_delta':
        outputTokens = ev.usage.output_tokens;
        // Emitted after the usage chunk has been parsed, so this is the only
        // trustworthy source of input tokens on OpenAI-compatible streams.
        if (ev.usage.input_tokens) inputTokens = ev.usage.input_tokens;
        break;
      case 'error':
        throw new ProviderError(ev.error.message);
    }
  }

  // Not every OpenAI-compatible vendor honours stream_options.include_usage. A
  // vendor that never sends usage would otherwise report a free call, so fall
  // back to the estimate and mark it, keeping budget math conservative.
  let estimatedInput = false;
  if (inputTokens === 0) {
    inputTokens = estimateTokens(params);
    estimatedInput = true;
  }

  const cost = tracker
    ? tracker.recordUsage(model, inputTokens, outputTokens).cost
    : costOf(model, inputTokens, outputTokens);

  return {
    text: text.trim(),
    inputTokens,
    outputTokens,
    cost,
    durationMs: Date.now() - start,
    ttfbMs,
    vendor: provider.name,
    model,
    estimatedInput,
  };
}
