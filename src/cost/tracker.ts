import { randomBytes } from 'node:crypto';
import { priceFor, costOf } from './catalog.js';
import { UsageLedger } from './ledger.js';

export { priceFor, costOf };

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

/** Worst-case spend set aside for one in-flight call. Closed exactly once by settle or release. */
export interface Hold {
  readonly id: string;
  readonly cost: number;
  readonly ts: string;
  closed: boolean;
}

export interface Reservation {
  alert: CostAlert | null;
  /** Present when the call may proceed. The caller must settle or release it. */
  hold?: Hold;
  /**
   * True when the call is blocked only by this tracker's own in-flight holds,
   * which will shrink to actual cost as they settle. The caller may wait for a
   * settle and ask again rather than give up.
   */
  blockedByInFlight: boolean;
}

interface OwnUse {
  ts: string;
  cost: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isCount(v: number): boolean {
  return Number.isSafeInteger(v) && v >= 0;
}

export class CostTracker {
  /** Distinguishes this tracker's ledger lines from every other writer's. */
  private readonly src = `${process.pid}-${randomBytes(4).toString('hex')}`;
  private readonly ledger: UsageLedger;
  private readonly budget: BudgetConfig;

  private sessionCost = 0;
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private readonly ownUses: OwnUse[] = [];
  private readonly holds = new Map<string, Hold>();
  private holdSeq = 0;
  private waiters: Array<() => void> = [];

  constructor(budget: BudgetConfig = {}) {
    this.budget = budget;
    this.ledger = new UsageLedger();
  }

  /**
   * Pre-dispatch gate. Prices the worst case for a call that has not happened
   * yet and, if it fits under every cap, sets that amount aside before
   * returning. Check and hold happen in one synchronous step, so concurrent
   * calls in this process cannot all pass against the same stale total.
   *
   * A blocked result is the only thing that can prevent spend.
   */
  reserve(model: string, estInputTokens: number, maxOutputTokens: number): Reservation {
    const worst = costOf(model, estInputTokens, maxOutputTokens);
    const alert = this.checkBudgetAgainst(worst, true);
    if (alert?.type === 'blocked') {
      const ownHeld = this.heldTotal();
      const blockedByInFlight =
        Number.isFinite(worst) && ownHeld > 0 && this.checkBudgetAgainst(worst, false)?.type !== 'blocked';
      return { alert, blockedByInFlight };
    }

    const hold: Hold = {
      id: `${this.src}:${++this.holdSeq}`,
      cost: worst,
      ts: new Date().toISOString(),
      closed: false,
    };
    this.holds.set(hold.id, hold);
    this.ledger.append({ t: 'hold', ts: hold.ts, src: this.src, id: hold.id, cost: hold.cost });
    return { alert, hold, blockedByInFlight: false };
  }

  /** Close a hold at the call's actual cost. */
  settle(hold: Hold, model: string, inputTokens: number, outputTokens: number): { cost: number; alert?: CostAlert } {
    if (hold.closed) throw new Error(`hold ${hold.id} was already closed`);
    hold.closed = true;
    this.holds.delete(hold.id);
    try {
      return this.recordUsage(model, inputTokens, outputTokens, hold.id);
    } finally {
      this.wake();
    }
  }

  /** Close a hold without charge: the request was never accepted. */
  release(hold: Hold): void {
    if (hold.closed) return;
    hold.closed = true;
    this.holds.delete(hold.id);
    this.ledger.append({ t: 'release', ts: new Date().toISOString(), src: this.src, id: hold.id });
    this.wake();
  }

  /** Resolves on the next settle or release. */
  waitForSettle(): Promise<void> {
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }

  recordUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
    holdId?: string,
  ): { cost: number; alert?: CostAlert } {
    if (!isCount(inputTokens) || !isCount(outputTokens)) {
      throw new RangeError(`refusing to record non-integer or negative usage (${inputTokens} in, ${outputTokens} out)`);
    }
    const cost = costOf(model, inputTokens, outputTokens);
    const ts = new Date().toISOString();
    this.sessionCost += cost;
    this.sessionInputTokens += inputTokens;
    this.sessionOutputTokens += outputTokens;
    this.ownUses.push({ ts, cost });
    this.ledger.append({
      t: 'use', ts, src: this.src, model, in: inputTokens, out: outputTokens, cost,
      ...(holdId ? { hold: holdId } : {}),
    });

    const alert = this.checkBudgetAgainst(0, true);
    return { cost, alert: alert || undefined };
  }

  private heldTotal(): number {
    let sum = 0;
    for (const h of this.holds.values()) sum += h.cost;
    return sum;
  }

  /**
   * `extra` is projected spend not yet held (0 for a post-hoc check). Holds,
   * this tracker's and every other process's, count as spent until they settle.
   */
  private checkBudgetAgainst(extra: number, includeOwnHolds: boolean): CostAlert | null {
    const warnPct = this.budget.warnAt ?? 0.8;
    const anyCap = Boolean(this.budget.sessionCap || this.budget.dailyCap || this.budget.weeklyCap);

    // NaN compares false against everything, so an unpriceable call would
    // otherwise pass every cap below. Fail closed.
    if (!Number.isFinite(extra)) {
      return { type: 'blocked', message: 'Projected cost is not a finite number', currentSpend: NaN, cap: 0 };
    }
    if (!anyCap) return null;

    const ownHeld = includeOwnHolds ? this.heldTotal() : 0;

    const verdict = (spend: number, cap: number, label: string): CostAlert | null => {
      if (spend >= cap) return { type: 'blocked', message: `${label} budget exceeded`, currentSpend: spend, cap };
      if (spend >= cap * warnPct) return { type: 'warning', message: `Approaching ${label.toLowerCase()} budget`, currentSpend: spend, cap };
      return null;
    };

    if (this.budget.sessionCap) {
      const a = verdict(this.sessionCost + ownHeld + extra, this.budget.sessionCap, 'Session');
      if (a) return a;
    }
    if (this.budget.dailyCap || this.budget.weeklyCap) this.ledger.refresh();
    if (this.budget.dailyCap) {
      const cutoff = this.dayCutoff();
      const spend = this.spendSince(cutoff) + this.ledger.heldSince(cutoff, this.src) + ownHeld + extra;
      const a = verdict(spend, this.budget.dailyCap, 'Daily');
      if (a) return a;
    }
    if (this.budget.weeklyCap) {
      const cutoff = this.weekCutoff();
      const spend = this.spendSince(cutoff) + this.ledger.heldSince(cutoff, this.src) + ownHeld + extra;
      const a = verdict(spend, this.budget.weeklyCap, 'Weekly');
      if (a) return a;
    }
    return null;
  }

  private dayCutoff(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private weekCutoff(): string {
    return new Date(Date.now() - 7 * DAY_MS).toISOString();
  }

  /** Recorded spend since cutoff: this tracker's from memory, every other writer's from the ledger. */
  private spendSince(cutoff: string): number {
    let own = 0;
    for (const u of this.ownUses) if (u.ts >= cutoff) own += u.cost;
    return own + this.ledger.spendSince(cutoff, this.src);
  }

  getSessionStats() {
    return { cost: this.sessionCost, inputTokens: this.sessionInputTokens, outputTokens: this.sessionOutputTokens };
  }

  /** Recorded (settled) spend today across every process. Excludes open holds. */
  getDailySpend(): number {
    this.ledger.refresh();
    return this.spendSince(this.dayCutoff());
  }

  /** Recorded (settled) spend over the last 7 days across every process. Excludes open holds. */
  getWeeklySpend(): number {
    this.ledger.refresh();
    return this.spendSince(this.weekCutoff());
  }
}
