import { logger } from '../util/logger.js';

/**
 * Model catalog: the single table that both prices a call and places a model in
 * a delegation tier. Keeping these together means the delegator can never pick a
 * model it cannot price.
 *
 * Prices are USD per 1M tokens.
 */

export type Tier = 'cheap' | 'mid' | 'frontier';

/** Ordered cheapest-first. The escalation ladder walks this array. */
export const TIERS: readonly Tier[] = ['cheap', 'mid', 'frontier'] as const;

export interface ModelSpec {
  vendor: string;
  input: number;
  output: number;
  tier: Tier;
}

export const CATALOG: Record<string, ModelSpec> = {
  // ── Anthropic ──
  // The 5-family rates are the published ones, not the 4.x rates they were
  // briefly assumed to match: the 5-family Opus tier is a third of Opus 4's
  // price, and Haiku 4.5 is more expensive than the 3.5 rate it inherited.
  //
  // Sonnet 5 carries an introductory $2.00/$10.00 through 2026-08-31. The
  // standard rate is listed instead, because the budget gate reserves against
  // this table: pricing the discount would under-reserve today and silently
  // stop being wrong when the discount lapses.
  // Only models that are currently active. Claude Opus 4 and Sonnet 4 were
  // retired on 2026-06-15 and now fail outright, so listing them would let
  // resolveTier hand back a model that cannot be called at all -- a worse
  // version of the mispricing this table exists to prevent.
  'claude-opus-5': { vendor: 'anthropic', input: 5.0, output: 25.0, tier: 'frontier' },
  'claude-sonnet-5': { vendor: 'anthropic', input: 3.0, output: 15.0, tier: 'mid' },
  'claude-fable-5': { vendor: 'anthropic', input: 10.0, output: 50.0, tier: 'frontier' },
  'claude-haiku-4-5-20251001': { vendor: 'anthropic', input: 1.0, output: 5.0, tier: 'cheap' },

  // ── OpenAI ──
  'gpt-4o': { vendor: 'openai', input: 2.50, output: 10.0, tier: 'mid' },
  'gpt-4o-mini': { vendor: 'openai', input: 0.15, output: 0.60, tier: 'cheap' },

  // ── xAI ──
  // grok-3 was retired on 2026-05-15 and grok-3-mini is absent from every
  // current xAI page. Requests to the retired slug are billed at grok-4.3's
  // rates, not the old ones, so the entry was wrong even for callers it
  // still appeared to work for.
  'grok-4.3': { vendor: 'xai', input: 1.25, output: 2.50, tier: 'mid' },

  // ── Google ──
  // gemini-2.0-flash was shut down 2026-06-01 and gemini-1.5-pro is gone from
  // Google's docs entirely. flash-lite is the current cheap class and happens
  // to carry the same $0.10/$0.40 the dead 2.0-flash did.
  'gemini-2.5-flash-lite': { vendor: 'google', input: 0.10, output: 0.40, tier: 'cheap' },
  'gemini-2.5-pro': { vendor: 'google', input: 1.25, output: 10.0, tier: 'mid' },

  // ── DeepSeek ──
  // deepseek-chat was retired on 2026-07-24. Input is the cache-MISS rate;
  // the cache-hit rate is ~50x lower and would badly under-reserve.
  'deepseek-v4-flash': { vendor: 'deepseek', input: 0.14, output: 0.28, tier: 'cheap' },

  // ── Perplexity ──
  'sonar-pro': { vendor: 'perplexity', input: 3.0, output: 15.0, tier: 'mid' },
};

/**
 * Undated aliases for catalog entries keyed by their dated ID. Anthropic accepts
 * both spellings, so a config naming the alias would otherwise be priced by the
 * fallback — for Haiku that is a 3x overcharge on every recorded call.
 *
 * These are deliberately kept out of CATALOG: modelsInTier() ranks whatever it
 * finds there, and two rows for one model at an identical price would make tier
 * resolution depend on object key order.
 */
const ALIASES: Record<string, string> = {
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

/** Resolve an alias to its catalog key; returns the input if it is already one. */
export function canonicalModel(model: string): string {
  return ALIASES[model] ?? model;
}

/** Applied to any model absent from the catalog. Deliberately pessimistic. */
export const DEFAULT_PRICING = { input: 3.0, output: 15.0 };

/** Local (Ollama) default models and any OpenRouter ':free' slug cost nothing. */
const FREE_LOCAL_MODELS = new Set(['llama3.1', 'qwen2.5', 'deepseek-r1', 'mistral', 'gemma2', 'phi3']);

export function isFree(model: string): boolean {
  return model.endsWith(':free') || FREE_LOCAL_MODELS.has(model);
}

// A model priced by the fallback is silently mispriced, which is exactly the
// failure this table exists to prevent. Warn once per unknown model per process.
const warnedUnknown = new Set<string>();

export function priceFor(model: string): { input: number; output: number } {
  const spec = CATALOG[canonicalModel(model)];
  if (spec) return { input: spec.input, output: spec.output };
  if (isFree(model)) return { input: 0, output: 0 };
  if (!warnedUnknown.has(model)) {
    warnedUnknown.add(model);
    logger.warn(
      `No catalog entry for "${model}"; pricing it at the default ` +
        `$${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per 1M. Reported cost may be wrong.`,
    );
  }
  return DEFAULT_PRICING;
}

export function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/**
 * Rank models within a tier. Assumes a representative call is input-heavy at
 * roughly 3 input tokens per output token.
 *
 * Only the ordering within a tier is load-bearing — modelsInTier() filters
 * before it sorts, so the ratio would have to reorder two models in the same
 * band to change a decision, and modelsInTier breaks the remaining ties
 * explicitly rather than leaving them to this number.
 *
 * Across bands the price ranges do not merely abut, they overlap: mid-tier
 * grok-4.3 blends to $1.56, below cheap-tier Haiku 4.5 at $2.00. That is not
 * a bug to correct. A tier is a capability band that price only approximates,
 * so it is set by the assignment in CATALOG and never inferred from a
 * threshold — otherwise cross-vendor escalation could walk downhill in price
 * while walking uphill in capability, which is exactly what it should do when
 * a vendor prices a strong model cheaply.
 *
 * Known limitation: gemini-2.5-pro and grok-4.3 are priced by context length
 * (both roughly double above a 200k-token prompt, and xAI reprices every token
 * in the request rather than just the overflow). Only the base tier is
 * modelled, so the budget gate under-reserves for very large prompts.
 */
export function blendedPrice(spec: ModelSpec): number {
  return (spec.input * 3 + spec.output) / 4;
}

/**
 * Models in a tier, cheapest first, under a total order.
 *
 * Ties are real and not hypothetical: gemini-2.5-flash-lite ($0.10/$0.40) and
 * deepseek-v4-flash ($0.14/$0.28) blend to exactly $0.175. Sorting on blended
 * price alone leaves the winner to be decided by which line sits higher in the
 * CATALOG literal, which would make a routing decision an artifact of file
 * layout -- measured-looking, arbitrary in fact.
 *
 * So the comparison falls through to output price (the volatile half of a
 * bill, and the half a verbose answer inflates), then to the model name, which
 * cannot tie. The rule is arbitrary but fixed, declared, and tested; that is
 * the property that matters, not which of two equally priced models wins.
 */
export function modelsInTier(tier: Tier): Array<{ model: string; spec: ModelSpec }> {
  return Object.entries(CATALOG)
    .filter(([, spec]) => spec.tier === tier)
    .map(([model, spec]) => ({ model, spec }))
    .sort(
      (a, b) =>
        blendedPrice(a.spec) - blendedPrice(b.spec) ||
        a.spec.output - b.spec.output ||
        a.model.localeCompare(b.model),
    );
}
