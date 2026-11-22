import type { ProviderConfig, Backend } from '../provider/factory.js';
import type { Tier } from '../cost/catalog.js';
import { TIERS, CATALOG, blendedPrice, modelsInTier, openRouterId } from '../cost/catalog.js';
import { BoardRoomError } from '../util/error.js';

export type { Tier };

export class DelegationError extends BoardRoomError {
  constructor(message: string) {
    super(message, 'ROUTER_ERROR');
    this.name = 'DelegationError';
  }
}

export interface Resolution {
  tier: Tier;
  /** The config to dispatch with: the vendor's credentials, the tier's model. */
  config: ProviderConfig;
  vendor: string;
  model: string;
  blended: number;
  /** Set when the requested tier had no reachable vendor and we fell back. */
  downgradedFrom?: Tier;
  reason: string;
}

export interface ResolveOptions {
  /** "vendor:model" pairs to skip, e.g. so a verifier never checks its own work. */
  exclude?: string[];
  /** Restrict to these vendors (used for research, which needs a web-grounded model). */
  onlyVendors?: string[];
  /**
   * Skip the flag and env pins and resolve from the catalog. A pin names the
   * model that does the work; the checker must be a different one, and
   * honouring the pin for it resolved straight back to the model under check.
   */
  ignorePins?: boolean;
  /** Within a tier, take a model from any other vendor before one from this vendor. */
  avoidVendor?: string;
}

const ENV_BY_TIER: Record<Tier, string> = {
  cheap: 'BOARDROOM_TIER_CHEAP',
  mid: 'BOARDROOM_TIER_MID',
  frontier: 'BOARDROOM_TIER_FRONTIER',
};

function withModel(config: ProviderConfig, model: string): ProviderConfig {
  return { ...config, model };
}

function parsePin(raw: string): { vendor: string; model: string } {
  const idx = raw.indexOf(':');
  if (idx < 1 || idx === raw.length - 1) {
    throw new DelegationError(`Tier override "${raw}" must be in vendor:model form, e.g. deepseek:deepseek-v4-flash`);
  }
  return { vendor: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

/** The backend a set of configs came from. Hand-built configs count as per-vendor keys. */
export function backendOf(configs: ProviderConfig[]): Backend {
  return configs[0]?.backend ?? 'keys';
}

/** True when the backend has one flat pool of models and so nothing to escalate to. */
export function hasNoTiers(configs: ProviderConfig[]): boolean {
  return backendOf(configs) === 'ollama';
}

/**
 * The model string to put on the wire for a catalog model.
 *
 * `Resolution.model` stays the catalog ID, which is what the ledger, stats and
 * exclusion lists key on. Only the request carries the backend's spelling. A
 * model already written as `vendor/model`, or one the catalog does not carry,
 * is passed through as given.
 */
export function wireModel(model: string, backend: Backend): string {
  if (backend !== 'openrouter' || model.includes('/')) return model;
  return openRouterId(model) ?? model;
}

/**
 * Tier resolution for a local backend.
 *
 * Catalog tiers are price bands across cloud vendors; a local Ollama install
 * has neither prices nor those models, and `delegate` used to ask it for
 * `gpt-5-nano`. Every tier resolves to a configured local model instead. An
 * excluded model is excluded on every seat, so a checker is never the same
 * model under another seat's name.
 */
function resolveLocal(
  tier: Tier,
  configs: ProviderConfig[],
  excluded: Set<string>,
  opts: ResolveOptions,
): Resolution {
  const excludedModels = new Set([...excluded].map(e => e.slice(e.indexOf(':') + 1)));
  const candidates = configs.filter(
    c => !excludedModels.has(c.model) && (!opts.onlyVendors || opts.onlyVendors.includes(c.name)),
  );
  const best = candidates[0];
  if (!best) {
    throw new DelegationError(
      `No other local model is configured. Set a different model on another seat ` +
        `(for example BOARDROOM_OLLAMA_OPENAI) to have one check another's work.`,
    );
  }
  return {
    tier,
    config: best,
    vendor: best.name,
    model: best.model,
    blended: 0,
    reason: 'local model (the Ollama backend has no price tiers)',
  };
}

/**
 * Resolve a tier to a concrete vendor and model.
 *
 * A tier is a price band, not a model alias. The cheap band resolves to
 * whichever credentialed vendor is actually cheapest, which on most key sets
 * is deepseek or gemini-flash rather than haiku — an order of magnitude apart
 * for work that does not need judgment.
 *
 * Precedence: explicit pin, then env override, then cheapest catalog model
 * whose vendor has credentials. A tier with no reachable vendor downgrades to
 * the next one down and says so, rather than failing or silently substituting.
 */
export function resolveTier(
  tier: Tier,
  configs: ProviderConfig[],
  opts: ResolveOptions = {},
  pin?: string,
): Resolution {
  const byVendor = new Map(configs.map(c => [c.name, c]));
  const excluded = new Set(opts.exclude ?? []);
  const backend = backendOf(configs);

  const override = opts.ignorePins ? undefined : pin ?? process.env[ENV_BY_TIER[tier]];
  if (override) {
    const { vendor, model } = parsePin(override);
    const config = byVendor.get(vendor);
    if (!config) {
      throw new DelegationError(
        `Tier "${tier}" is pinned to ${vendor}:${model}, but no credentials were detected for ${vendor}.`,
      );
    }
    const spec = Object.prototype.hasOwnProperty.call(CATALOG, model) ? CATALOG[model] : undefined;
    return {
      tier,
      config: withModel(config, wireModel(model, backend)),
      vendor,
      model,
      blended: spec ? blendedPrice(spec) : Number.POSITIVE_INFINITY,
      reason: pin ? 'pinned by flag' : `pinned by ${ENV_BY_TIER[tier]}`,
    };
  }

  if (backend === 'ollama') return resolveLocal(tier, configs, excluded, opts);

  // Walk down from the requested tier so a missing tier degrades instead of failing.
  const startIndex = TIERS.indexOf(tier);
  for (let i = startIndex; i >= 0; i--) {
    const candidateTier = TIERS[i];
    const candidates = modelsInTier(candidateTier).filter(({ model, spec }) => {
      if (!byVendor.has(spec.vendor)) return false;
      if (excluded.has(`${spec.vendor}:${model}`)) return false;
      if (opts.onlyVendors && !opts.onlyVendors.includes(spec.vendor)) return false;
      return true;
    });

    // Cheapest first, but another vendor's model outranks a same-vendor sibling.
    const best =
      (opts.avoidVendor && candidates.find(c => c.spec.vendor !== opts.avoidVendor)) || candidates[0];
    if (!best) continue;

    const resolution: Resolution = {
      tier: candidateTier,
      config: withModel(byVendor.get(best.spec.vendor)!, wireModel(best.model, backend)),
      vendor: best.spec.vendor,
      model: best.model,
      blended: blendedPrice(best.spec),
      reason:
        candidates.length > 1
          ? `cheapest of ${candidates.length} credentialed ${candidateTier} models`
          : `only credentialed ${candidateTier} model`,
    };
    if (candidateTier !== tier) resolution.downgradedFrom = tier;
    return resolution;
  }

  throw new DelegationError(
    `No credentialed model available at tier "${tier}" or below. ` +
      `Detected vendors: ${configs.map(c => c.name).join(', ') || 'none'}.`,
  );
}

/** Next tier up, or null at the top of the ladder. */
export function nextTier(tier: Tier): Tier | null {
  const i = TIERS.indexOf(tier);
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

/** What every tier would resolve to right now, for `delegate stats` and --explain. */
export function describeTiers(configs: ProviderConfig[]): string[] {
  return TIERS.map(tier => {
    try {
      const r = resolveTier(tier, configs);
      const note = r.downgradedFrom ? ` (downgraded from ${r.downgradedFrom})` : '';
      return `${tier.padEnd(8)} → ${r.vendor}/${r.model}${note}  $${r.blended.toFixed(2)}/Mtok blended`;
    } catch (e) {
      return `${tier.padEnd(8)} → unavailable: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}
