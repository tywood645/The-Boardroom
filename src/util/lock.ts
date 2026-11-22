import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';

/**
 * Run `fn` holding an exclusive lock file next to `path`.
 *
 * For read-modify-write of small state files that more than one boardroom
 * process may update at once. The lock is a file created with O_EXCL, so the
 * filesystem arbitrates; a lock older than `staleMs` is assumed to belong to
 * a dead process and is broken.
 *
 * Synchronous on purpose: callers run just before process.exit().
 */
export function withFileLock<T>(path: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const lockPath = path + '.lock';
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));

  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // released between our open and stat
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }

  try {
    writeSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // already broken as stale by another process; nothing to do
    }
  }
}
