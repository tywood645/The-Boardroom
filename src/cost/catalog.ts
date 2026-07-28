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
  'grok-3': { vendor: 'xai', input: 3.0, output: 15.0, tier: 'mid' },
  'grok-3-mini': { vendor: 'xai', input: 0.30, output: 0.50, tier: 'cheap' },

  // ── Google ──
  'gemini-2.0-flash': { vendor: 'google', input: 0.10, output: 0.40, tier: 'cheap' },
  'gemini-1.5-pro': { vendor: 'google', input: 1.25, output: 5.0, tier: 'mid' },

  // ── DeepSeek ──
  'deepseek-chat': { vendor: 'deepseek', input: 0.27, output: 1.10, tier: 'cheap' },

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
 * band to change any decision. It does not: within every band here the spread
 * is far wider than the ratio's influence. Across bands the numbers do abut
 * (Haiku 4.5 blends to $2.00, mid-tier gemini-1.5-pro to $2.19), which is why
 * a tier is defined by the assignment in CATALOG rather than by a price
 * threshold — bands are capability, priced roughly.
 */
export function blendedPrice(spec: ModelSpec): number {
  return (spec.input * 3 + spec.output) / 4;
}

export function modelsInTier(tier: Tier): Array<{ model: string; spec: ModelSpec }> {
  return Object.entries(CATALOG)
    .filter(([, spec]) => spec.tier === tier)
    .map(([model, spec]) => ({ model, spec }))
    .sort((a, b) => blendedPrice(a.spec) - blendedPrice(b.spec));
}
