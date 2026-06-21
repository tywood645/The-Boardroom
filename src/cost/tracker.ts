import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../util/logger.js';

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  'gpt-4o': { input: 2.50, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'grok-3': { input: 3.0, output: 15.0 },
  'grok-3-mini': { input: 0.30, output: 0.50 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-pro': { input: 1.25, output: 5.0 },
  'deepseek-chat': { input: 0.27, output: 1.10 },
  'sonar-pro': { input: 3.0, output: 15.0 },
};

const DEFAULT_PRICING = { input: 3.0, output: 15.0 };

// Local (Ollama) default models and any OpenRouter ':free' slug cost nothing.
const FREE_LOCAL_MODELS = new Set(['llama3.1', 'qwen2.5', 'deepseek-r1', 'mistral', 'gemma2', 'phi3']);

function priceFor(model: string): { input: number; output: number } {
  if (PRICING[model]) return PRICING[model];
  if (model.endsWith(':free') || FREE_LOCAL_MODELS.has(model)) return { input: 0, output: 0 };
  return DEFAULT_PRICING;
}

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

  constructor(budget: BudgetConfig = {}) {
    const dir = join(homedir(), '.boardroom');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dataPath = join(dir, 'usage.json');
    this.budget = budget;
  }

  recordUsage(model: string, inputTokens: number, outputTokens: number): { cost: number; alert?: CostAlert } {
    const pricing = priceFor(model);
    const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    this.sessionCost += cost;
    this.sessionInputTokens += inputTokens;
    this.sessionOutputTokens += outputTokens;

    const entry: UsageEntry = { timestamp: new Date().toISOString(), model, inputTokens, outputTokens, cost };
    this.appendEntry(entry);

    const alert = this.checkBudget();
    return { cost, alert: alert || undefined };
  }

  private checkBudget(): CostAlert | null {
    const warnPct = this.budget.warnAt ?? 0.8;

    if (this.budget.sessionCap) {
      if (this.sessionCost >= this.budget.sessionCap) {
        return { type: 'blocked', message: 'Session budget exceeded', currentSpend: this.sessionCost, cap: this.budget.sessionCap };
      }
      if (this.sessionCost >= this.budget.sessionCap * warnPct) {
        return { type: 'warning', message: 'Approaching session budget', currentSpend: this.sessionCost, cap: this.budget.sessionCap };
      }
    }

    if (this.budget.dailyCap) {
      const daily = this.getDailySpend();
      if (daily >= this.budget.dailyCap) return { type: 'blocked', message: 'Daily budget exceeded', currentSpend: daily, cap: this.budget.dailyCap };
      if (daily >= this.budget.dailyCap * warnPct) return { type: 'warning', message: 'Approaching daily budget', currentSpend: daily, cap: this.budget.dailyCap };
    }

    if (this.budget.weeklyCap) {
      const weekly = this.getWeeklySpend();
      if (weekly >= this.budget.weeklyCap) return { type: 'blocked', message: 'Weekly budget exceeded', currentSpend: weekly, cap: this.budget.weeklyCap };
      if (weekly >= this.budget.weeklyCap * warnPct) return { type: 'warning', message: 'Approaching weekly budget', currentSpend: weekly, cap: this.budget.weeklyCap };
    }
    return null;
  }

  getSessionStats() { return { cost: this.sessionCost, inputTokens: this.sessionInputTokens, outputTokens: this.sessionOutputTokens }; }

  getDailySpend(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.loadData().entries.filter(e => e.timestamp.startsWith(today)).reduce((sum, e) => sum + e.cost, 0);
  }

  getWeeklySpend(): number {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.loadData().entries.filter(e => e.timestamp >= weekAgo).reduce((sum, e) => sum + e.cost, 0);
  }

  private loadData(): { entries: UsageEntry[] } {
    if (!existsSync(this.dataPath)) return { entries: [] };
    try {
      return JSON.parse(readFileSync(this.dataPath, 'utf-8'));
    } catch (e) {
      logger.warn('Failed to parse usage.json; cost history unavailable:', e instanceof Error ? e.message : e);
      return { entries: [] };
    }
  }

  private appendEntry(entry: UsageEntry): void {
    const data = this.loadData();
    data.entries.push(entry);
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    data.entries = data.entries.filter(e => e.timestamp >= cutoff);
    // mode applies only at creation; chmod also tightens pre-existing files.
    writeFileSync(this.dataPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.dataPath, 0o600);
  }
}
