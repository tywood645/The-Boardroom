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

  dispose(): void {
    clearTimeout(this.timer);
  }
}

/** A deadline abort must never be retried; a transient network error may be. */
export function isDeadlineAbort(e: unknown): e is DeadlineError {
  return e instanceof DeadlineError;
}
