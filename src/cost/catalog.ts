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
  // The 5-family rates below are carried forward from the equivalent 4.x tier and
  // are not independently verified. Override with BOARDROOM_PRICING_FILE if the
  // published rates differ; priceFor() warns whenever it falls back to a default.
  'claude-opus-5': { vendor: 'anthropic', input: 15.0, output: 75.0, tier: 'frontier' },
  'claude-sonnet-5': { vendor: 'anthropic', input: 3.0, output: 15.0, tier: 'mid' },
  'claude-fable-5': { vendor: 'anthropic', input: 15.0, output: 75.0, tier: 'frontier' },
  'claude-opus-4-20250514': { vendor: 'anthropic', input: 15.0, output: 75.0, tier: 'frontier' },
  'claude-sonnet-4-20250514': { vendor: 'anthropic', input: 3.0, output: 15.0, tier: 'mid' },
  'claude-haiku-4-5-20251001': { vendor: 'anthropic', input: 0.80, output: 4.0, tier: 'cheap' },

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
  const spec = CATALOG[model];
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
 * roughly 3 input tokens per output token; ranking is insensitive to the exact
 * ratio because tiers are already an order of magnitude apart.
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
