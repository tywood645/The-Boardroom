import type { BudgetConfig } from './tracker.js';
import { BoardRoomError } from '../util/error.js';

/** A CLI flag value that explicitly turns a cap off, overriding env and defaults. */
const OFF = new Set(['none', 'off']);

type Parsed = { kind: 'unset' } | { kind: 'off' } | { kind: 'value'; value: number };

/**
 * Parse one cap. An absent or empty value is unset; anything else must be a
 * positive number, or the run stops.
 *
 * A bad value used to be dropped silently, so `--session-cap 0.5o`,
 * `--session-cap 0` or BOARDROOM_DAILY_CAP=1,00 meant no cap at all, and on
 * `delegate` also discarded the $1.00 default. A typo must not be able to
 * remove a spending limit.
 */
function parseCap(raw: string | undefined, source: string): Parsed {
  if (raw === undefined || raw.trim() === '') return { kind: 'unset' };
  const s = raw.trim();
  if (OFF.has(s.toLowerCase())) return { kind: 'off' };
  const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new BoardRoomError(
      `${source} must be a positive amount in USD (or "none" to disable it), got "${raw}"`,
      'INVALID_ARGUMENT',
    );
  }
  return { kind: 'value', value: n };
}

/**
 * CLI flag, then env, then the command's built-in default. An explicit "none"
 * on the flag or in env stops the lookup there, default included.
 */
function resolve(cli: string | undefined, flag: string, envName: string, fallback?: number): number | undefined {
  for (const [raw, source] of [[cli, flag], [process.env[envName], envName]] as const) {
    const p = parseCap(raw, source);
    if (p.kind === 'value') return p.value;
    if (p.kind === 'off') return undefined;
  }
  return fallback;
}

/**
 * Resolve budget caps: CLI flags, then env, then `defaults`. Throws on any
 * value that is present but not usable.
 */
export function loadBudget(
  cli: Partial<Record<keyof BudgetConfig, string | undefined>> = {},
  defaults: { sessionCap?: number } = {},
): BudgetConfig {
  const budget: BudgetConfig = {};
  const sessionCap = resolve(cli.sessionCap, '--session-cap', 'BOARDROOM_SESSION_CAP', defaults.sessionCap);
  const dailyCap = resolve(cli.dailyCap, '--daily-cap', 'BOARDROOM_DAILY_CAP');
  const weeklyCap = resolve(cli.weeklyCap, '--weekly-cap', 'BOARDROOM_WEEKLY_CAP');
  const warnAt = resolve(cli.warnAt, '--warn-at', 'BOARDROOM_WARN_AT');

  if (sessionCap !== undefined) budget.sessionCap = sessionCap;
  if (dailyCap !== undefined) budget.dailyCap = dailyCap;
  if (weeklyCap !== undefined) budget.weeklyCap = weeklyCap;
  if (warnAt !== undefined) {
    if (warnAt >= 1) {
      throw new BoardRoomError(`BOARDROOM_WARN_AT must be a fraction below 1, got "${warnAt}"`, 'INVALID_ARGUMENT');
    }
    budget.warnAt = warnAt;
  }

  return budget;
}

export function describeBudget(b: BudgetConfig): string {
  const parts: string[] = [];
  if (b.sessionCap) parts.push(`session $${b.sessionCap.toFixed(2)}`);
  if (b.dailyCap) parts.push(`daily $${b.dailyCap.toFixed(2)}`);
  if (b.weeklyCap) parts.push(`weekly $${b.weeklyCap.toFixed(2)}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}
