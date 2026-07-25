import type { BudgetConfig } from './tracker.js';

function num(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve budget caps from env, overridden by explicit CLI flags.
 *
 * Caps used to be constructor-only and nothing ever passed them, so every
 * branch of checkBudget was dead code. This is the path that makes them real.
 */
export function loadBudget(cli: Partial<Record<keyof BudgetConfig, string | undefined>> = {}): BudgetConfig {
  const budget: BudgetConfig = {};
  const sessionCap = num(cli.sessionCap) ?? num(process.env.BOARDROOM_SESSION_CAP);
  const dailyCap = num(cli.dailyCap) ?? num(process.env.BOARDROOM_DAILY_CAP);
  const weeklyCap = num(cli.weeklyCap) ?? num(process.env.BOARDROOM_WEEKLY_CAP);
  const warnAt = num(cli.warnAt) ?? num(process.env.BOARDROOM_WARN_AT);

  if (sessionCap !== undefined) budget.sessionCap = sessionCap;
  if (dailyCap !== undefined) budget.dailyCap = dailyCap;
  if (weeklyCap !== undefined) budget.weeklyCap = weeklyCap;
  if (warnAt !== undefined && warnAt < 1) budget.warnAt = warnAt;

  return budget;
}

export function describeBudget(b: BudgetConfig): string {
  const parts: string[] = [];
  if (b.sessionCap) parts.push(`session $${b.sessionCap.toFixed(2)}`);
  if (b.dailyCap) parts.push(`daily $${b.dailyCap.toFixed(2)}`);
  if (b.weeklyCap) parts.push(`weekly $${b.weeklyCap.toFixed(2)}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}
