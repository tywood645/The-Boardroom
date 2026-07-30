import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../util/logger.js';
import { priceFor, costOf } from './catalog.js';

export { priceFor, costOf };

interface UsageEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface BudgetConfig {
  sessionCap?: number;
  dailyCap?: number;
  weeklyCap?: number;
  warnAt?: number;
}

export interface CostAlert {
  type: 'warning' | 'blocked';
  message: string;
  currentSpend: number;
  cap: number;
}

export class CostTracker {
  private dataPath: string;
  private sessionCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private budget: BudgetConfig;

  // History is read once per process and kept in memory. Previously every
  // recordUsage re-read, re-parsed, filtered and rewrote the whole file, and
  // checkBudget read it twice more on top of that.
  private history: UsageEntry[] | null = null;
  private pending: UsageEntry[] = [];

  constructor(budget: BudgetConfig = {}) {
    const dir = join(homedir(), '.boardroom');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dataPath = join(dir, 'usage.json');
    this.budget = budget;
  }

  /**
   * Pre-dispatch gate. Prices the worst case for a call that has not happened
   * yet — full maxTokens of output, prompt length estimated at 4 chars/token —
   * and reports whether making it would breach a cap. Over-estimating is the
   * correct direction for a gate.
   *
   * A `blocked` result here is the only thing that can prevent spend;
   * recordUsage runs after the money is gone.
   */
  reserve(model: string, estInputTokens: number, maxOutputTokens: number): CostAlert | null {
    return this.checkBudgetAgainst(costOf(model, estInputTokens, maxOutputTokens));
  }

  recordUsage(model: string, inputTokens: number, outputTokens: number): { cost: number; alert?: CostAlert } {
    const cost = costOf(model, inputTokens, outputTokens);
    this.sessionCost += cost;
    this.sessionInputTokens += inputTokens;
    this.sessionOutputTokens += outputTokens;

    this.pending.push({ timestamp: new Date().toISOString(), model, inputTokens, outputTokens, cost });

    const alert = this.checkBudget();
    return { cost, alert: alert || undefined };
  }

  private checkBudget(): CostAlert | null {
    return this.checkBudgetAgainst(0);
  }

  /** `extra` is projected additional spend not yet recorded (0 for a post-hoc check). */
  private checkBudgetAgainst(extra: number): CostAlert | null {
    const warnPct = this.budget.warnAt ?? 0.8;

    const verdict = (spend: number, cap: number, label: string): CostAlert | null => {
      if (spend >= cap) return { type: 'blocked', message: `${label} budget exceeded`, currentSpend: spend, cap };
      if (spend >= cap * warnPct) return { type: 'warning', message: `Approaching ${label.toLowerCase()} budget`, currentSpend: spend, cap };
      return null;
    };

    if (this.budget.sessionCap) {
      const a = verdict(this.sessionCost + extra, this.budget.sessionCap, 'Session');
      if (a) return a;
    }
    if (this.budget.dailyCap) {
      const a = verdict(this.getDailySpend() + extra, this.budget.dailyCap, 'Daily');
      if (a) return a;
    }
    if (this.budget.weeklyCap) {
      const a = verdict(this.getWeeklySpend() + extra, this.budget.weeklyCap, 'Weekly');
      if (a) return a;
    }
    return null;
  }

  getSessionStats() {
    return { cost: this.sessionCost, inputTokens: this.sessionInputTokens, outputTokens: this.sessionOutputTokens };
  }

  getDailySpend(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.allEntries()
      .filter(e => e.timestamp.startsWith(today))
      .reduce((sum, e) => sum + e.cost, 0);
  }

  getWeeklySpend(): number {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.allEntries()
      .filter(e => e.timestamp >= weekAgo)
      .reduce((sum, e) => sum + e.cost, 0);
  }

  /**
   * Write buffered entries to disk. Must be called before the process exits;
   * cli.ts calls process.exit() explicitly, which skips any async teardown, so
   * this is deliberately synchronous.
   */
  flush(): void {
    if (this.pending.length === 0) return;
    const entries = this.allEntries();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const kept = entries.filter(e => e.timestamp >= cutoff);
    try {
      // mode applies only at creation; chmod also tightens pre-existing files.
      writeFileSync(this.dataPath, JSON.stringify({ entries: kept }, null, 2), { mode: 0o600 });
      chmodSync(this.dataPath, 0o600);
      this.history = kept;
      this.pending = [];
    } catch (e) {
      logger.warn('Failed to write usage.json:', e instanceof Error ? e.message : e);
    }
  }

  private allEntries(): UsageEntry[] {
    return this.loadHistory().concat(this.pending);
  }

  private loadHistory(): UsageEntry[] {
    if (this.history) return this.history;
    let loaded: UsageEntry[] = [];
    if (existsSync(this.dataPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.dataPath, 'utf-8'));
        if (Array.isArray(parsed?.entries)) loaded = parsed.entries;
      } catch (e) {
        logger.warn('Failed to parse usage.json; cost history unavailable:', e instanceof Error ? e.message : e);
      }
    }
    this.history = loaded;
    return loaded;
  }
}
