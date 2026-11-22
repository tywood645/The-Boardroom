import { logger } from '../util/logger.js';
import { BoardRoomError } from '../util/error.js';
import { activeBackend, type Backend } from '../provider/factory.js';

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
  /** OpenRouter's ID for this model, where it is not `<vendor namespace>/<this key>`. See openRouterId. */
  openrouter?: string;
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
  // Current generation only. "Still has a published price" is not the same
  // question as "is current" -- gpt-4o is four generations behind and still
  // sells -- and answering only the first is how this table filled up with
  // models nobody should be routed to.
  'claude-opus-5': { vendor: 'anthropic', input: 5.0, output: 25.0, tier: 'frontier' },
  'claude-fable-5': { vendor: 'anthropic', input: 10.0, output: 50.0, tier: 'frontier' },
  'claude-sonnet-5': { vendor: 'anthropic', input: 3.0, output: 15.0, tier: 'mid' },
  'claude-haiku-4-5-20251001': { vendor: 'anthropic', input: 1.0, output: 5.0, tier: 'cheap' },

  // ── OpenAI ── (5.6 is the current generation; 5.6-sol is the flagship)
  'gpt-5.6-sol': { vendor: 'openai', input: 5.0, output: 30.0, tier: 'frontier' },
  'gpt-5.6-terra': { vendor: 'openai', input: 2.50, output: 15.0, tier: 'mid' },
  'gpt-5.6-luna': { vendor: 'openai', input: 1.0, output: 6.0, tier: 'mid' },
  'gpt-5-nano': { vendor: 'openai', input: 0.05, output: 0.40, tier: 'cheap' },

  // ── xAI ── (grok-3 was retired 2026-05-15; 4.5 is the current flagship)
  'grok-4.5': { vendor: 'xai', input: 2.0, output: 6.0, tier: 'mid' },
  'grok-4.3': { vendor: 'xai', input: 1.25, output: 2.50, tier: 'mid' },

  // ── Google ── (2.0-flash was shut down 2026-06-01; 3.x is current)
  'gemini-3.6-flash': { vendor: 'google', input: 1.50, output: 7.50, tier: 'mid' },
  'gemini-3.1-flash-lite': { vendor: 'google', input: 0.25, output: 1.50, tier: 'cheap' },

  // ── DeepSeek ── (deepseek-chat was retired 2026-07-24; v4 is current)
  // Input is the cache-MISS rate; the cache-hit rate is ~50x lower and would
  // badly under-reserve.
  'deepseek-v4-pro': { vendor: 'deepseek', input: 0.435, output: 0.87, tier: 'mid' },
  'deepseek-v4-flash': { vendor: 'deepseek', input: 0.14, output: 0.28, tier: 'cheap' },

  // ── Perplexity ──
  // Token rates only. Perplexity also bills $6/$10/$14 per 1,000 requests by
  // search_context_size, which nothing here models, so a search-heavy run
  // costs more than this table can predict.
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

/**
 * The catalog key a model string prices as.
 *
 * Gateways wrap the vendor's ID: OpenRouter serves `anthropic/claude-fable-5`
 * and variants such as `...:nitro`. Looking those up verbatim always missed,
 * so every gateway call fell to the fallback price, which for frontier models
 * was a third of the real one. The vendor prefix and variant suffix are
 * stripped for the lookup only; the wire still carries the full string.
 */
export function catalogKey(model: string): string {
  // An OpenRouter ID that was declared for a catalog model maps straight back
  // to it, even where the two spellings differ.
  const declared = slugToCatalog().get(model.split(':')[0]);
  if (declared) return declared;
  const base = model.slice(model.lastIndexOf('/') + 1).split(':')[0];
  return canonicalModel(base);
}

/** OpenRouter's namespace for each vendor. Mostly the vendor name; xAI is the exception. */
const OPENROUTER_VENDOR: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  xai: 'x-ai',
  google: 'google',
  deepseek: 'deepseek',
  perplexity: 'perplexity',
};

/**
 * Operator-declared OpenRouter IDs, for where the derived one is wrong:
 *   BOARDROOM_OPENROUTER_IDS="claude-haiku-4-5-20251001=anthropic/claude-haiku-4.5"
 * A malformed entry is an error, not a silent fallback.
 */
export function parseOpenRouterIds(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of (raw ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
    const m = entry.match(/^([^=\s]+)=([^=\s/]+\/[^=\s]+)$/);
    if (!m) {
      throw new BoardRoomError(
        `BOARDROOM_OPENROUTER_IDS entry "${entry}" must look like catalog-model=vendor/model`,
        'INVALID_ARGUMENT',
      );
    }
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * The ID OpenRouter serves a catalog model under, or null for a model the
 * catalog does not carry.
 *
 * OpenRouter does not take a vendor's bare ID: it wants `openai/gpt-5-nano`,
 * not `gpt-5-nano`. `delegate` used to send the bare catalog ID, so on the
 * OpenRouter backend every delegated call was refused.
 *
 * Precedence: BOARDROOM_OPENROUTER_IDS, then the catalog entry's own
 * `openrouter` field, then `<vendor namespace>/<catalog id>`. The derived
 * form is a convention, not a guarantee; `delegate --verify-catalog` on the
 * OpenRouter backend checks every one against the live list.
 */
export function openRouterId(model: string): string | null {
  const key = canonicalModel(model);
  if (!Object.prototype.hasOwnProperty.call(CATALOG, key)) return null;
  const spec = CATALOG[key];
  return (
    parseOpenRouterIds(process.env.BOARDROOM_OPENROUTER_IDS).get(key) ??
    spec.openrouter ??
    `${OPENROUTER_VENDOR[spec.vendor] ?? spec.vendor}/${key}`
  );
}

function slugToCatalog(): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of Object.keys(CATALOG)) {
    const id = openRouterId(key);
    if (id) out.set(id, key);
  }
  return out;
}

function catalogSpec(model: string): ModelSpec | undefined {
  const key = catalogKey(model);
  // Own keys only: "constructor" and friends must not resolve to Object.prototype.
  return Object.prototype.hasOwnProperty.call(CATALOG, key) ? CATALOG[key] : undefined;
}

/**
 * Applied to any model absent from the catalog: the highest input and output
 * price the catalog carries. A cap can only hold if an unknown model is never
 * priced below what it might really cost, and the old flat $3/$15 was under
 * every frontier model. Name the model's real price in BOARDROOM_MODEL_PRICES
 * to replace this.
 */
export const DEFAULT_PRICING = {
  input: Math.max(...Object.values(CATALOG).map(s => s.input)),
  output: Math.max(...Object.values(CATALOG).map(s => s.output)),
};

/** Ollama's default seat models. */
const FREE_LOCAL_MODELS = new Set(['llama3.1', 'qwen2.5', 'deepseek-r1', 'mistral', 'gemma2', 'phi3']);

/**
 * Whether a model costs nothing on the backend in use.
 *
 * Decided by backend, not by name alone: a model merely called "mistral", or
 * ending ":free", is not free when it is being sent to a paid vendor.
 *  - ollama: everything is local and free, except a catalog-named model, which
 *    keeps its catalog price in case OLLAMA_HOST fronts a paid gateway.
 *  - openrouter: only its ":free" variants.
 *  - per-vendor keys: nothing.
 */
export function isFree(model: string, backend: Backend = activeBackend()): boolean {
  if (backend === 'ollama') return FREE_LOCAL_MODELS.has(model) || !catalogSpec(model);
  if (backend === 'openrouter') return model.endsWith(':free');
  return false;
}

/**
 * Operator-declared prices for models the catalog does not carry:
 *   BOARDROOM_MODEL_PRICES="meta-llama/llama-3.1-8b-instruct=0.02/0.05,other=1/4"
 * USD per 1M tokens, input/output. A malformed entry is an error, not a
 * silent fallback: this table feeds the budget gate.
 */
export function parseModelPrices(raw: string | undefined): Map<string, { input: number; output: number }> {
  const out = new Map<string, { input: number; output: number }>();
  for (const entry of (raw ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
    const m = entry.match(/^(.+)=(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (!m) {
      throw new BoardRoomError(
        `BOARDROOM_MODEL_PRICES entry "${entry}" must look like model=input/output (USD per 1M tokens)`,
        'INVALID_ARGUMENT',
      );
    }
    out.set(m[1].trim(), { input: Number(m[2]), output: Number(m[3]) });
  }
  return out;
}

// A model priced by the fallback is mispriced upward: safe for a cap, wrong on
// the report. Warn once per unknown model per process.
const warnedUnknown = new Set<string>();

export function priceFor(model: string): { input: number; output: number } {
  const declared = parseModelPrices(process.env.BOARDROOM_MODEL_PRICES).get(model);
  if (declared) return declared;
  if (isFree(model)) return { input: 0, output: 0 };
  const spec = catalogSpec(model);
  if (spec) return { input: spec.input, output: spec.output };
  if (!warnedUnknown.has(model)) {
    warnedUnknown.add(model);
    logger.warn(
      `No catalog entry for "${model}"; pricing it at the catalog maximum ` +
        `$${DEFAULT_PRICING.input}/$${DEFAULT_PRICING.output} per 1M so caps still hold. ` +
        `Set BOARDROOM_MODEL_PRICES="${model}=<in>/<out>" to use its real price.`,
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
 * Known limitation: the grok models are priced by context length, doubling
 * above a 200k-token prompt, and xAI reprices every token in the request
 * rather than just the overflow. OpenAI likewise quotes these as its "short
 * context" rates. Only the base tier is modelled, so the budget gate
 * under-reserves for very large prompts.
 */
export function blendedPrice(spec: ModelSpec): number {
  return (spec.input * 3 + spec.output) / 4;
}

/**
 * Models in a tier, cheapest first, under a total order.
 *
 * Ties are real and not hypothetical: grok-4.5 ($2.00/$6.00) and
 * gemini-3.6-flash ($1.50/$7.50) blend to exactly $3.00. Sorting on blended
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
