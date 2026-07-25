import { appendFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../util/logger.js';
import type { Tier } from '../cost/catalog.js';
import type { TaskClass } from './classify.js';

/**
 * Append-only record of what the router did and whether it worked.
 *
 * Kept separate from usage.json on purpose. usage.json is the billing ledger,
 * filtered over a 30-day window and rewritten wholesale; this needs a longer
 * window to accumulate enough samples per (class, tier) cell, has a
 * per-attempt schema that means nothing to billing, and is written far more
 * often. JSONL makes each write O(1) instead of a full-file rewrite.
 *
 * This file is what "measured routing" is measured from. pilotfish's
 * equivalent is hand-committed benchmark JSON.
 */

export type Outcome =
  | 'confirmed'
  | 'refuted'
  | 'unverified'
  | 'error'
  | 'deadline'
  | 'budget_blocked';

export interface RouteRecord {
  v: 1;
  ts: string;
  runId: string;
  attempt: number;
  cls: TaskClass;
  tier: Tier;
  vendor: string;
  model: string;
  downgradedFrom?: Tier;
  inputTokens: number;
  outputTokens: number;
  /** True when the vendor reported no usage and tokens were estimated. */
  estimatedInput?: boolean;
  cost: number;
  latencyMs: number;
  ttfbMs: number;
  outcome: Outcome;
  /** "vendor:model" of the checker, when one ran. */
  verdictBy?: string;
  /** The named defect from a refutation, truncated. */
  defect?: string;
  escalatedTo?: Tier;
}

export function ledgerPath(): string {
  const dir = join(homedir(), '.boardroom');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'routing.jsonl');
}

export function appendRoute(record: RouteRecord): void {
  const path = ledgerPath();
  try {
    const existed = existsSync(path);
    appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
    // mode applies only at creation; tighten a pre-existing file too.
    if (!existed) chmodSync(path, 0o600);
  } catch (e) {
    // Losing a routing record must never fail the task it describes.
    logger.warn('Failed to append to routing.jsonl:', e instanceof Error ? e.message : e);
  }
}

export function readRoutes(sinceMs?: number): RouteRecord[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    logger.warn('Failed to read routing.jsonl:', e instanceof Error ? e.message : e);
    return [];
  }

  const cutoff = sinceMs ? new Date(Date.now() - sinceMs).toISOString() : null;
  const out: RouteRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as RouteRecord;
      // A truncated or hand-edited line must not take the whole history with it.
      if (rec?.v !== 1 || typeof rec.ts !== 'string') continue;
      if (cutoff && rec.ts < cutoff) continue;
      out.push(rec);
    } catch {
      continue;
    }
  }
  return out;
}
