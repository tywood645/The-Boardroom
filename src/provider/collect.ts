import type { LLMProvider } from './base.js';
import type { MessageCreateParams } from './types.js';
import type { CostTracker } from '../cost/tracker.js';
import { costOf } from '../cost/catalog.js';
import { BudgetError, ProviderError } from '../util/error.js';

/**
 * The single place a provider stream is consumed.
 *
 * Three near-identical drain loops used to live in panel.ts, consultant.ts and
 * motion/protocol.ts. Collapsing them here fixes token accounting once instead
 * of three times, and — more importantly — creates one choke point that every
 * provider call must pass through, so the budget gate cannot be bypassed.
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
  /** Time to first text delta; the router's latency signal. */
  ttfbMs: number;
  vendor: string;
  model: string;
  /** True when inputTokens came from a character estimate, not the provider. */
  estimatedInput: boolean;
}

export interface CollectOptions {
  tracker?: CostTracker;
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
  opts: CollectOptions = {},
): Promise<Collected> {
  const model = params.model || provider.modelId;
  const { tracker } = opts;

  // Pre-dispatch gate. This runs before fetch, which is the whole point:
  // recording usage afterwards can report an overrun but cannot prevent one.
  if (tracker) {
    const alert = tracker.reserve(model, estimateTokens(params), params.maxTokens);
    if (alert?.type === 'blocked') {
      throw new BudgetError(
        `${alert.message} ($${alert.currentSpend.toFixed(4)} of $${alert.cap.toFixed(2)}); refusing to dispatch to ${provider.name}/${model}`,
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

  for await (const ev of provider.createMessage(params)) {
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
