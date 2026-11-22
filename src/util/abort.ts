import { DeadlineError } from './error.js';

/**
 * Forward an external signal into a provider's own AbortController.
 *
 * AbortSignal.any would do this, but it landed in Node 20.3 and package.json
 * declares >=18. The returned disposer matters: one deadline signal is shared
 * across every call in a run (18 of them in a motion), and listeners left
 * attached would accumulate on it.
 */
export function linkAbort(controller: AbortController, external?: AbortSignal): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort(external.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(external.reason);
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

/**
 * A wall-clock budget for a whole run.
 *
 * Distinct from the providers' connect-only timeout, which is deliberately
 * cleared once headers arrive so a long stream is never truncated. That leaves
 * a stalled body able to hang forever; this is the bound on total time.
 */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(ms: number, label = 'run') {
    this.timer = setTimeout(
      () => this.controller.abort(new DeadlineError(`${label} exceeded its ${ms}ms deadline`, ms)),
      ms,
    );
    // Do not keep the process alive just to fire a deadline.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get expired(): boolean {
    return this.controller.signal.aborted;
  }

  /** Abort every call in the run now, for a reason other than the clock. */
  cancel(reason: string): void {
    clearTimeout(this.timer);
    if (!this.controller.signal.aborted) this.controller.abort(new DeadlineError(reason, 0));
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/**
 * On Ctrl-C or SIGTERM, abort the run's in-flight calls before exiting.
 *
 * Node's default is to die at once, which leaves every in-flight call's hold
 * open in the ledger at its worst case. Aborting first sends each call down
 * its normal failure path, which settles the hold at what the call plausibly
 * cost; the ledger writes are synchronous, so a short grace is enough. A
 * second signal gets the default behaviour and exits immediately.
 */
export function exitCleanlyOnSignal(deadline: Deadline, graceMs = 250): void {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      deadline.cancel(`interrupted by ${signal}`);
      // With every call aborted the command reaches its own process.exit(0)
      // within a few ticks, usually before the grace timer. However it exits,
      // an interrupted run must not report success.
      process.once('exit', () => {
        process.exitCode = code;
      });
      setTimeout(() => process.exit(code), graceMs);
    });
  }
}

/** A deadline abort must never be retried; a transient network error may be. */
export function isDeadlineAbort(e: unknown): e is DeadlineError {
  return e instanceof DeadlineError;
}
