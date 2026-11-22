import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { boardroomDir } from '../util/paths.js';
import type { MotionResult, FinalVote } from '../motion/types.js';
import { logger } from '../util/logger.js';
import { sanitizeForRecall } from '../util/sanitize.js';
import { withFileLock } from '../util/lock.js';

export interface DecisionRecord {
  id: string;                   // motion id (timestamp)
  motion: string;
  outcome: MotionResult['outcome'];
  tally: { aye: number; nay: number; abstain: number };
  dissents: { role: string; reason: string }[];
  startedAt: string;
}

export interface StateData {
  decisions: DecisionRecord[];
}

const MAX_DECISIONS = 20;       // keep last N to bound briefing size

/** Bounds on what is persisted. These records are replayed into every later prompt. */
export const RECALL_LIMITS = { motion: 500, role: 40, reason: 300, id: 40 } as const;

const DEFAULT_CONTEXT_TEMPLATE = `# Standing Board Context

*This file is yours to edit. Anything in here is loaded into every board meeting as background context. Keep it short, long context dilutes the advisors' focus.*

## Founder
(your name, role, anything the board should know about you)

## Company
(what the company is, what it ships, who pays you)

## Current Constraints
(runway, team size, hard deadlines, anything the board must factor into every recommendation)

## Currently Building
(active products and where each one is)

## What the Board Should NOT Re-Litigate
(decisions you've already made and don't want to keep debating)
`;

export { boardroomDir };

export function contextPath(): string {
  return join(boardroomDir(), 'context.md');
}

export function statePath(): string {
  return join(boardroomDir(), 'state.json');
}

export function loadContext(): string | null {
  const path = contextPath();
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function ensureContextStub(): void {
  const path = contextPath();
  if (existsSync(path)) return;
  writeFileSync(path, DEFAULT_CONTEXT_TEMPLATE, { mode: 0o600 });
}

export function loadState(): StateData {
  const path = statePath();
  if (!existsSync(path)) return { decisions: [] };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!data.decisions || !Array.isArray(data.decisions)) {
      logger.warn('state.json has no decisions array; prior decision history is unavailable.');
      return { decisions: [] };
    }
    return data as StateData;
  } catch (e: any) {
    logger.warn('Failed to load state.json, prior decision history is unavailable:', e?.message || e);
    // Preserve the unreadable file so the next appendDecision does not
    // overwrite it and permanently destroy recoverable history.
    try {
      renameSync(path, path + '.corrupt');
      logger.warn('Backed up unreadable state file to ' + path + '.corrupt');
    } catch (e2: any) {
      logger.warn('Could not back up unreadable state file:', e2?.message || e2);
    }
    return { decisions: [] };
  }
}

/**
 * Load, prepend and write back under a lock, via a temp file and rename, so
 * two motions finishing together cannot drop one another's decision and a
 * crash mid-write cannot leave a truncated state.json.
 */
export function appendDecision(result: MotionResult): void {
  withFileLock(statePath(), () => appendDecisionLocked(result));
}

function appendDecisionLocked(result: MotionResult): void {
  const data = loadState();

  const dissents = collectDissents(result.votes, result.outcome);
  const record: DecisionRecord = {
    id: result.id,
    motion: sanitizeForRecall(result.motion, RECALL_LIMITS.motion),
    outcome: result.outcome,
    tally: result.tally,
    dissents,
    startedAt: result.startedAt,
  };

  // Newest first; trim to MAX_DECISIONS.
  data.decisions = [record, ...data.decisions].slice(0, MAX_DECISIONS);
  const target = statePath();
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  // A fresh file, so mode 0o600 applies; rename keeps it.
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, target);
}

function collectDissents(
  votes: FinalVote[],
  outcome: MotionResult['outcome'],
): { role: string; reason: string }[] {
  if (outcome !== 'passed' && outcome !== 'failed') return [];
  const losingVote = outcome === 'passed' ? 'NAY' : 'AYE';
  return votes
    .filter(v => !v.error && v.vote === losingVote)
    .map(v => ({
      role: sanitizeForRecall(v.role, RECALL_LIMITS.role),
      reason: sanitizeForRecall(v.reason, RECALL_LIMITS.reason),
    }));
}
