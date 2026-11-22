import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { logger } from '../util/logger.js';
import { boardroomDir, boardroomSubdir } from '../util/paths.js';

/**
 * The billing ledger: append-only JSONL, one file per UTC month.
 *
 * It replaces usage.json, which every process read once at start and rewrote
 * wholesale on exit. Two runs that overlapped each saw only their own spend,
 * and whichever exited last erased the other's entries. Appending a line per
 * event needs no rewrite and no lock, and every reader sees every writer.
 *
 * Three line types:
 *   hold     worst-case cost reserved before a call is dispatched
 *   use      what the call actually cost (closes its hold, if it had one)
 *   release  a hold closed without charge (the request was never accepted)
 *
 * Every line carries `src`, the id of the CostTracker that wrote it, so a
 * tracker can tell its own lines (already counted in memory) from everyone
 * else's.
 */

export interface UseLine {
  t: 'use';
  ts: string;
  src: string;
  model: string;
  in: number;
  out: number;
  cost: number;
  hold?: string;
}

export interface HoldLine {
  t: 'hold';
  ts: string;
  src: string;
  id: string;
  cost: number;
}

export interface ReleaseLine {
  t: 'release';
  ts: string;
  src: string;
  id: string;
}

export type LedgerLine = UseLine | HoldLine | ReleaseLine;

interface Spend {
  ts: string;
  cost: number;
  src: string;
}

interface FileCursor {
  offset: number;
  remainder: Buffer;
}

function isCost(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** A line that fails validation is skipped, never trusted: negative or non-finite costs included. */
export function parseLedgerLine(raw: string): LedgerLine | null {
  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || !isStr(o.ts) || !isStr(o.src)) return null;
  if (o.t === 'use') {
    if (!isStr(o.model) || !isCount(o.in) || !isCount(o.out) || !isCost(o.cost)) return null;
    if (o.hold !== undefined && !isStr(o.hold)) return null;
    return o as UseLine;
  }
  if (o.t === 'hold') return isStr(o.id) && isCost(o.cost) ? (o as HoldLine) : null;
  if (o.t === 'release') return isStr(o.id) ? (o as ReleaseLine) : null;
  return null;
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function previousMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

export class UsageLedger {
  readonly dir: string;
  private readonly cursors = new Map<string, FileCursor>();
  private readonly uses: Spend[] = [];
  private readonly holds = new Map<string, Spend>();
  /** Ids closed before their hold line was read (possible across a month boundary). */
  private readonly closed = new Set<string>();
  private legacyLoaded = false;
  private readonly legacyPath: string;

  constructor() {
    this.dir = boardroomSubdir('usage');
    this.legacyPath = join(boardroomDir(), 'usage.json');
    this.prune();
  }

  private fileFor(d: Date): string {
    return join(this.dir, `${monthKey(d)}.jsonl`);
  }

  /** Current and previous month: enough for the 7-day weekly window on any day. */
  private liveFiles(now = new Date()): string[] {
    return [this.fileFor(previousMonth(now)), this.fileFor(now)];
  }

  /** Drop month files older than the previous month. Nothing reads them. */
  private prune(): void {
    const oldest = `${monthKey(previousMonth(new Date()))}.jsonl`;
    try {
      for (const name of readdirSync(this.dir)) {
        if (/^\d{4}-\d{2}\.jsonl$/.test(name) && name < oldest) {
          unlinkSync(join(this.dir, name));
        }
      }
    } catch (e) {
      logger.warn('Failed to prune old usage ledgers:', e instanceof Error ? e.message : e);
    }
  }

  append(line: LedgerLine): void {
    const path = this.fileFor(new Date(line.ts));
    try {
      const existed = existsSync(path);
      appendFileSync(path, JSON.stringify(line) + '\n', { mode: 0o600 });
      if (!existed) chmodSync(path, 0o600);
    } catch (e) {
      // The in-memory totals of the writing tracker still hold this spend, so
      // its own caps stay correct; only other processes lose sight of it.
      logger.warn('Failed to append to usage ledger:', e instanceof Error ? e.message : e);
    }
  }

  /** Read whatever every writer has appended since the last refresh. */
  refresh(): void {
    this.loadLegacy();
    for (const path of this.liveFiles()) this.readNew(path);
  }

  private readNew(path: string): void {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return; // not created yet
    }
    try {
      const cursor = this.cursors.get(path) ?? { offset: 0, remainder: Buffer.alloc(0) };
      const size = fstatSync(fd).size;
      if (size < cursor.offset) {
        // Replaced or truncated underneath us. Nothing this code writes does
        // that, so read it afresh rather than guess.
        cursor.offset = 0;
        cursor.remainder = Buffer.alloc(0);
      }
      if (size === cursor.offset) {
        this.cursors.set(path, cursor);
        return;
      }
      const chunk = Buffer.alloc(size - cursor.offset);
      let read = 0;
      while (read < chunk.length) {
        const n = readSync(fd, chunk, read, chunk.length - read, cursor.offset + read);
        if (n === 0) break;
        read += n;
      }
      cursor.offset += read;
      const data = Buffer.concat([cursor.remainder, chunk.subarray(0, read)]);
      const lastNl = data.lastIndexOf(0x0a);
      // A line still being written stays buffered until its newline lands.
      cursor.remainder = lastNl === -1 ? data : data.subarray(lastNl + 1);
      this.cursors.set(path, cursor);
      if (lastNl === -1) return;
      for (const raw of data.subarray(0, lastNl).toString('utf-8').split('\n')) {
        if (!raw.trim()) continue;
        const line = parseLedgerLine(raw);
        if (line) this.ingest(line);
      }
    } catch (e) {
      logger.warn('Failed to read usage ledger:', e instanceof Error ? e.message : e);
    } finally {
      closeSync(fd);
    }
  }

  private ingest(line: LedgerLine): void {
    switch (line.t) {
      case 'use':
        this.uses.push({ ts: line.ts, cost: line.cost, src: line.src });
        if (line.hold) this.close(line.hold);
        break;
      case 'hold':
        if (this.closed.has(line.id)) this.closed.delete(line.id);
        else this.holds.set(line.id, { ts: line.ts, cost: line.cost, src: line.src });
        break;
      case 'release':
        this.close(line.id);
        break;
    }
  }

  private close(id: string): void {
    if (!this.holds.delete(id)) this.closed.add(id);
  }

  /** usage.json from before the ledger existed: read once, validated, never written. */
  private loadLegacy(): void {
    if (this.legacyLoaded) return;
    this.legacyLoaded = true;
    if (!existsSync(this.legacyPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.legacyPath, 'utf-8'));
      const entries: unknown[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const e of entries as any[]) {
        if (isStr(e?.timestamp) && isCost(e?.cost)) {
          this.uses.push({ ts: e.timestamp, cost: e.cost, src: 'legacy' });
        }
      }
    } catch (e) {
      logger.warn('Failed to parse legacy usage.json; its history is ignored:', e instanceof Error ? e.message : e);
    }
  }

  /** Recorded spend since `cutoff` (ISO string or date prefix), excluding lines written by `exceptSrc`. */
  spendSince(cutoff: string, exceptSrc: string): number {
    let sum = 0;
    for (const u of this.uses) if (u.src !== exceptSrc && u.ts >= cutoff) sum += u.cost;
    return sum;
  }

  /**
   * Holds by other trackers that were never closed, opened since `cutoff`.
   *
   * These never expire. A hold with no settlement is either a call still in
   * flight or one whose process was interrupted or killed after the request
   * went out, and in both cases the money may be spent. It used to be dropped
   * after 15 minutes, which let an interrupted run's spend be forgotten; now
   * it counts at its worst case for as long as its window lasts.
   */
  heldSince(cutoff: string, exceptSrc: string): number {
    let sum = 0;
    for (const h of this.holds.values()) {
      if (h.src === exceptSrc || h.ts < cutoff) continue;
      sum += h.cost;
    }
    return sum;
  }
}
