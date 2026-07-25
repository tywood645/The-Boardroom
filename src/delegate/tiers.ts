import type { ProviderConfig } from '../provider/factory.js';
import type { Tier } from '../cost/catalog.js';
import { TIERS, CATALOG, blendedPrice, modelsInTier } from '../cost/catalog.js';
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
    throw new DelegationError(`Tier override "${raw}" must be in vendor:model form, e.g. deepseek:deepseek-chat`);
  }
  return { vendor: raw.slice(0, idx), model: raw.slice(idx + 1) };
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

  const override = pin ?? process.env[ENV_BY_TIER[tier]];
  if (override) {
    const { vendor, model } = parsePin(override);
    const config = byVendor.get(vendor);
    if (!config) {
      throw new DelegationError(
        `Tier "${tier}" is pinned to ${vendor}:${model}, but no credentials were detected for ${vendor}.`,
      );
    }
    const spec = CATALOG[model];
    return {
      tier,
      config: withModel(config, model),
      vendor,
      model,
      blended: spec ? blendedPrice(spec) : Number.POSITIVE_INFINITY,
      reason: pin ? 'pinned by flag' : `pinned by ${ENV_BY_TIER[tier]}`,
    };
  }

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

    const best = candidates[0];
    if (!best) continue;

    const resolution: Resolution = {
      tier: candidateTier,
      config: withModel(byVendor.get(best.spec.vendor)!, best.model),
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
