/**
 * Bounds how many provider calls are in flight at once.
 *
 * The fan-outs in panel.ts and motion/protocol.ts use bare Promise.all, so all
 * six advisors hit their vendors simultaneously. Rather than rewrite every
 * call site, the limit is applied inside collectStream — the one place every
 * call passes through — so the fan-out code is unchanged and there is no way
 * to spawn an unthrottled call.
 */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  /** Resolves once a slot is free. Call the returned function to release it. */
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
    }
    this.active++;
    return this.makeRelease();
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // releasing twice would let an extra call through
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}
