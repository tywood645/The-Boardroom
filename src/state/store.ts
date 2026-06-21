import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { MotionResult, FinalVote } from '../motion/types.js';
import { logger } from '../util/logger.js';

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

export function boardroomDir(): string {
  const dir = join(homedir(), '.boardroom');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

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

export function appendDecision(result: MotionResult): void {
  const data = loadState();

  const dissents = collectDissents(result.votes, result.outcome);
  const record: DecisionRecord = {
    id: result.id,
    motion: result.motion,
    outcome: result.outcome,
    tally: result.tally,
    dissents,
    startedAt: result.startedAt,
  };

  // Newest first; trim to MAX_DECISIONS.
  data.decisions = [record, ...data.decisions].slice(0, MAX_DECISIONS);
  // mode applies only at creation; chmod also tightens pre-existing files.
  writeFileSync(statePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(statePath(), 0o600);
}

function collectDissents(
  votes: FinalVote[],
  outcome: MotionResult['outcome'],
): { role: string; reason: string }[] {
  if (outcome !== 'passed' && outcome !== 'failed') return [];
  const losingVote = outcome === 'passed' ? 'NAY' : 'AYE';
  return votes
    .filter(v => !v.error && v.vote === losingVote)
    .map(v => ({ role: v.role, reason: v.reason }));
}
