import { closeSync, fstatSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';

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
      if (breakIfStale(lockPath, staleMs)) continue;
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
      Atomics.wait(sleeper, 0, 0, 25);
    }
  }

  const ours = fstatSync(fd).ino;
  try {
    writeSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    // Remove the lock only if it is still the file we created. If another
    // process judged ours stale and replaced it, that one is theirs to remove.
    try {
      if (statSync(lockPath).ino === ours) unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

/**
 * Remove `lockPath` if it is older than `staleMs`. Returns true if it is gone.
 *
 * Checking the age and removing the file are two steps, and two processes
 * doing them at once used to race: both saw a stale lock, the first removed it
 * and took a fresh one, and the second then removed that fresh lock, leaving
 * two holders. Breaking is therefore serialised by a second O_EXCL file, and
 * the age is checked again while holding it, so only a lock that is still
 * stale at that moment is removed.
 */
export function breakIfStale(lockPath: string, staleMs: number): boolean {
  const age = (p: string): number | null => {
    try {
      return Date.now() - statSync(p).mtimeMs;
    } catch {
      return null; // gone
    }
  };

  const seen = age(lockPath);
  if (seen === null) return true;
  if (seen <= staleMs) return false;

  const breaker = lockPath + '.break';
  let bfd: number;
  try {
    bfd = openSync(breaker, 'wx', 0o600);
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    // Someone else is breaking it. A breaker file that is itself stale was
    // left by a process that died in this short section; clear it and retry.
    const breakerAge = age(breaker);
    if (breakerAge !== null && breakerAge > staleMs) {
      try {
        unlinkSync(breaker);
      } catch {
        // someone else cleared it
      }
    }
    return false;
  }

  try {
    const now = age(lockPath);
    if (now === null) return true;
    if (now <= staleMs) return false; // replaced by a live holder since we looked
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(bfd);
    try {
      unlinkSync(breaker);
    } catch {
      // already gone
    }
  }
}
