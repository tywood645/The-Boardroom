import type { Tier } from '../cost/catalog.js';
import { TIERS } from '../cost/catalog.js';
import type { TaskClass } from './classify.js';
import { TIER_PRIORS } from './classify.js';
import { readDelegations, type DelegationRecord } from './ledger.js';

/**
 * Turns the delegation ledger into the starting tier for the next task.
 *
 * This is the difference from pilotfish, whose role→tier map is hand-picked
 * prose with no feedback loop. The rule here is deliberately simple and
 * explainable: a delegator whose decisions you cannot audit is a delegator you will
 * not trust, so every decision carries a `why` string that names the evidence.
 */

/** Below this many samples a cell is treated as unknown and explored. */
export const MIN_SAMPLES = 5;
/** Below this confirmed-rate a tier is considered to be failing the class. */
export const PROMOTE_BELOW = 0.6;
/** Ledger window used for delegation decisions. */
export const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface CellStat {
  n: number;
  confirmed: number;
  confirmRate: number;
  meanCost: number;
  p50LatencyMs: number;
}

export type CellKey = `${TaskClass}:${Tier}`;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function loadStats(records: DelegationRecord[] = readDelegations(WINDOW_MS)): Map<CellKey, CellStat> {
  const buckets = new Map<CellKey, DelegationRecord[]>();
  for (const r of records) {
    // Only attempts that were actually judged tell us anything about quality.
    if (r.outcome !== 'confirmed' && r.outcome !== 'refuted') continue;
    const key: CellKey = `${r.cls}:${r.tier}`;
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }

  const stats = new Map<CellKey, CellStat>();
  for (const [key, list] of buckets) {
    const confirmed = list.filter(r => r.outcome === 'confirmed').length;
    stats.set(key, {
      n: list.length,
      confirmed,
      confirmRate: confirmed / list.length,
      meanCost: list.reduce((s, r) => s + r.cost, 0) / list.length,
      p50LatencyMs: median(list.map(r => r.latencyMs)),
    });
  }
  return stats;
}

export interface TierChoice {
  tier: Tier;
  why: string;
}

/**
 * Start at the class's prior, then walk up while the measured confirm rate at
 * the current tier is poor. Only cells with enough samples can promote, so a
 * single bad run never moves the delegator.
 */
export function pickStartTier(cls: TaskClass, stats: Map<CellKey, CellStat>): TierChoice {
  const prior = TIER_PRIORS[cls];
  let index = TIERS.indexOf(prior);

  for (;;) {
    const tier = TIERS[index];
    const cell = stats.get(`${cls}:${tier}`);

    if (!cell || cell.n < MIN_SAMPLES) {
      const why = cell
        ? `${cell.n} of ${MIN_SAMPLES} samples at ${tier}; still exploring`
        : `no measurements for ${cls} at ${tier} yet`;
      return { tier, why };
    }

    if (cell.confirmRate >= PROMOTE_BELOW) {
      return {
        tier,
        why: `${tier} confirms ${(cell.confirmRate * 100).toFixed(0)}% of ${cls} tasks over ${cell.n} runs`,
      };
    }

    if (index === TIERS.length - 1) {
      return {
        tier,
        why: `${tier} only confirms ${(cell.confirmRate * 100).toFixed(0)}% of ${cls} tasks, but it is the top tier`,
      };
    }

    index++;
  }
}

/** Rows for `boardroom delegate stats`. */
export function formatStats(stats: Map<CellKey, CellStat>): string[] {
  if (stats.size === 0) return ['(no verified delegation history yet)'];
  const rows = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b));
  return rows.map(([key, s]) => {
    const [cls, tier] = key.split(':');
    return (
      `${cls.padEnd(10)} ${tier.padEnd(9)} ` +
      `n=${String(s.n).padStart(4)}  ` +
      `confirm=${(s.confirmRate * 100).toFixed(0).padStart(3)}%  ` +
      `mean=$${s.meanCost.toFixed(4)}  ` +
      `p50=${String(s.p50LatencyMs).padStart(6)}ms`
    );
  });
}
