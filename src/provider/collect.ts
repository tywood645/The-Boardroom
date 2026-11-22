import type { LLMProvider } from './base.js';
import type { MessageCreateParams } from './types.js';
import type { CostTracker, Hold } from '../cost/tracker.js';
import type { Semaphore } from '../util/semaphore.js';
import { costOf } from '../cost/catalog.js';
import { BoardRoomError, BudgetError, DeadlineError, ProviderError } from '../util/error.js';

/**
 * The single place a provider stream is consumed.
 *
 * Every provider call passes through here, so budget, concurrency and
 * deadline limits are enforced rather than advised. A test in
 * tests/enforcement-invariant.test.ts asserts that this is the only
 * non-provider file that calls createMessage().
 *
 * Accounting contract: before dispatch the call's worst case is held against
 * every cap; afterwards the hold is settled to what the call cost, on success
 * and on failure alike. Where the vendor does not report a count, or reports
 * one that cannot be right, a conservative upper bound is charged instead.
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
  /** True when inputTokens came from an upper-bound estimate, not the provider. */
  estimatedInput: boolean;
  /** True when outputTokens came from an upper-bound estimate, not the provider. */
  estimatedOutput: boolean;
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

/** No single call reports more than this; a larger count is not believed. */
export const MAX_PLAUSIBLE_TOKENS = 10_000_000;

/** Generous ceiling on output bytes per token; typical text is about 4. See maxTextBytes. */
export const MAX_BYTES_PER_TOKEN = 64;

/** Role markers, separators and similar framing each message costs on top of its text. */
const PER_MESSAGE_OVERHEAD = 16;

/** A provider-reported token count is trusted only if it is a plausible non-negative integer. */
export function validTokenCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_PLAUSIBLE_TOKENS;
}

/**
 * Upper bound on the tokens a piece of text can encode to.
 *
 * Every tokenizer the catalog's vendors use is byte-level or has byte
 * fallback, so a token covers at least one byte of UTF-8. Byte length is
 * therefore a ceiling, whatever the script or entropy of the text. The old
 * estimate, characters / 4, was an average and could be beaten by 8x with
 * token-dense input, which let a single call blow through a hard cap.
 */
export function upperBoundTokens(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

/** Upper bound on a request's input tokens. Used to reserve, and as the fallback charge. */
export function estimateTokens(params: MessageCreateParams): number {
  let n = upperBoundTokens(params.system) + PER_MESSAGE_OVERHEAD;
  for (const m of params.messages) {
    n += PER_MESSAGE_OVERHEAD;
    n += typeof m.content === 'string' ? upperBoundTokens(m.content) : upperBoundTokens(JSON.stringify(m.content));
  }
  if (params.tools.length > 0) n += upperBoundTokens(JSON.stringify(params.tools));
  // A response schema is sent with the request and billed as input too.
  if (params.responseFormat) n += upperBoundTokens(JSON.stringify(params.responseFormat)) + 4 * PER_MESSAGE_OVERHEAD;
  return n;
}

export async function collectStream(
  provider: LLMProvider,
  params: MessageCreateParams,
  ctx: RunContext = {},
): Promise<Collected> {
  // Wait for a slot before checking the budget, so the gate sees holds that
  // concurrent calls have already taken.
  const release = ctx.limiter ? await ctx.limiter.acquire() : () => {};
  try {
    return await dispatch(provider, params, ctx);
  } finally {
    release();
  }
}

/** Resolve when `p` does, or reject with the signal's reason if it aborts first. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Take a hold for the call's worst case. If the only thing in the way is this
 * run's other in-flight calls, wait for one of them to settle (their holds
 * shrink to actual cost) and ask again, rather than refusing a call that will
 * fit.
 */
async function acquireHold(
  tracker: CostTracker,
  provider: LLMProvider,
  model: string,
  estIn: number,
  maxOut: number,
  signal?: AbortSignal,
): Promise<Hold> {
  for (;;) {
    const r = tracker.reserve(model, estIn, maxOut);
    if (r.hold) return r.hold;
    if (r.blockedByInFlight) {
      await untilAborted(tracker.waitForSettle(), signal);
      continue;
    }
    const alert = r.alert!;
    throw new BudgetError(
      `${alert.message} ($${alert.currentSpend.toFixed(4)} of $${alert.cap.toFixed(2)}); ` +
        `refusing to dispatch to ${provider.name}/${model}`,
      alert.currentSpend,
      alert.cap,
    );
  }
}

async function dispatch(
  provider: LLMProvider,
  params: MessageCreateParams,
  ctx: RunContext,
): Promise<Collected> {
  if (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0) {
    throw new BoardRoomError(`maxTokens must be a positive integer, got ${params.maxTokens}`, 'INVALID_ARGUMENT');
  }
  const signal = ctx.signal ?? params.signal;
  if (signal?.aborted) throw signal.reason;

  const model = params.model || provider.modelId;
  const { tracker } = ctx;
  const estIn = estimateTokens(params);

  // Pre-dispatch gate. This runs before fetch, which is the whole point:
  // recording usage afterwards can report an overrun but cannot prevent one.
  const hold = tracker ? await acquireHold(tracker, provider, model, estIn, params.maxTokens, signal) : undefined;

  const start = Date.now();
  let text = '';
  let ttfbMs = 0;
  let reportedIn: number | null = null;
  let reportedOut: number | null = null;
  let sawContent = false;
  let abandoned = 0;
  let textBytes = 0;
  let overflowed = false;
  // No tokenizer averages anywhere near this many bytes per token, so text
  // past this was not produced within max_tokens: the vendor is ignoring it.
  const maxTextBytes = params.maxTokens * MAX_BYTES_PER_TOKEN + 4096;
  const toolReply = params.responseFormat?.mode === 'tool';

  /** What this call is charged: authoritative counts where valid, upper bounds where not. */
  const tally = () => {
    const estimatedInput = reportedIn === null;
    const estimatedOutput = reportedOut === null;
    const thisAttemptIn = reportedIn ?? estIn;
    // Each abandoned attempt sent the same prompt; the vendor may have billed it.
    const inputTokens = thisAttemptIn + abandoned * estIn;
    // With no reported count, charge the text's upper bound. It is capped at
    // maxTokens because the vendor enforces that limit, unless this very
    // response proved it does not, in which case there is no cap to trust.
    const bound = upperBoundTokens(text);
    const outputTokens = reportedOut ?? (overflowed ? bound : Math.min(params.maxTokens, bound));
    return { inputTokens, outputTokens, estimatedInput, estimatedOutput };
  };

  const charge = (inputTokens: number, outputTokens: number): number =>
    hold && tracker
      ? tracker.settle(hold, model, inputTokens, outputTokens).cost
      : costOf(model, inputTokens, outputTokens);

  try {
    const stream = provider.createMessage({ ...params, signal });
    for await (const ev of stream) {
      switch (ev.type) {
        case 'message_start': {
          // Authoritative on the Anthropic path. OpenAI-compatible streams send
          // 0 here (usage arrives at the end), and 0 input is never real.
          const n = ev.message?.usage?.input_tokens;
          if (validTokenCount(n) && n > 0) reportedIn = n;
          break;
        }
        case 'content_block_delta': {
          // With a forced tool call the reply is the tool's arguments, which
          // arrive as JSON fragments. They are the answer text in that case.
          const raw =
            ev.delta.type === 'text_delta'
              ? ev.delta.text
              : toolReply && ev.delta.type === 'input_json_delta'
                ? ev.delta.partial_json
                : undefined;
          if (raw !== undefined) {
            if (ttfbMs === 0) ttfbMs = Date.now() - start;
            sawContent = true;
            const piece = typeof raw === 'string' ? raw : String(raw ?? '');
            text += piece;
            textBytes += Buffer.byteLength(piece, 'utf-8');
            if (textBytes > maxTextBytes) {
              // Stop reading: an unbounded stream is unbounded memory here and
              // unbounded spend there. Leaving the loop cancels the transfer.
              overflowed = true;
              throw new ProviderError(
                `${provider.name}/${model} sent over ${maxTextBytes} bytes for max_tokens=${params.maxTokens}; ` +
                  `it is not honouring the output limit, so the stream was cut off`,
              );
            }
          }
          break;
        }
        case 'message_delta': {
          const out = ev.usage?.output_tokens;
          if (validTokenCount(out)) reportedOut = out;
          const inp = ev.usage?.input_tokens;
          if (validTokenCount(inp) && inp > 0) reportedIn = inp;
          break;
        }
        case 'attempt_abandoned':
          // Counts reported so far belonged to the dropped attempt, which is
          // charged at the estimate instead; the next attempt reports afresh.
          abandoned++;
          reportedIn = null;
          reportedOut = null;
          break;
        case 'error':
          throw new ProviderError(ev.error.message);
      }
    }
  } catch (e) {
    // Charge what a failed call plausibly cost. A started stream or a deadline
    // abort means the vendor had the request; a rejection before any stream
    // (4xx, connect failure, every retry refused) means it billed nothing.
    if (hold && !hold.closed) {
      const started = sawContent || reportedIn !== null || reportedOut !== null || e instanceof DeadlineError;
      if (started || abandoned > 0) {
        const t = tally();
        const inputTokens = started ? t.inputTokens : abandoned * estIn;
        charge(inputTokens, started ? t.outputTokens : 0);
      } else {
        tracker!.release(hold);
      }
    }
    throw e;
  }

  const { inputTokens, outputTokens, estimatedInput, estimatedOutput } = tally();
  const cost = charge(inputTokens, outputTokens);

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
    estimatedOutput,
  };
}
