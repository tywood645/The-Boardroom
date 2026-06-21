import { loadContext, loadState, ensureContextStub } from './store.js';

const RECENT_DECISIONS_TO_INCLUDE = 8;

/**
 * Build the PRIOR BOARD CONTEXT block to prepend to advisor briefings.
 *
 * Returns null if there's nothing to include (both files empty/missing)
 * so callers can skip the prefix entirely instead of injecting an empty block.
 */
export function buildRecallBlock(): string | null {
  ensureContextStub();
  const context = loadContext();
  const state = loadState();

  const hasContext = context && context.length > 0 && !isStubOnly(context);
  const hasDecisions = state.decisions.length > 0;

  if (!hasContext && !hasDecisions) return null;

  const lines: string[] = [];
  lines.push('PRIOR BOARD CONTEXT (do not re-debate decisions already settled):');
  lines.push('');

  if (hasContext && context) {
    lines.push('--- Standing Context ---');
    lines.push(context);
    lines.push('');
  }

  if (hasDecisions) {
    lines.push('--- Recent Board Decisions (most recent first) ---');
    const recent = state.decisions.slice(0, RECENT_DECISIONS_TO_INCLUDE);
    for (const d of recent) {
      const tally = `${d.tally.aye}-${d.tally.nay}${d.tally.abstain ? ` (${d.tally.abstain} abstain)` : ''}`;
      lines.push(`- [${d.id}] ${outcomeLabel(d.outcome)} (${tally}): "${d.motion}"`);
      if (d.dissents.length > 0) {
        for (const dis of d.dissents) {
          lines.push(`    - ${dis.role} dissented: ${dis.reason}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('--- end prior context ---');
  lines.push('');
  return lines.join('\n');
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'passed': return 'PASSED';
    case 'failed': return 'FAILED';
    case 'tied': return 'TIED';
    case 'died_for_lack_of_second': return 'DIED (no second)';
    default: return outcome.toUpperCase();
  }
}

/**
 * Heuristic: detect if context.md is still the unedited stub. We don't want
 * to inject the placeholder template into briefings, it's noise that would
 * confuse advisors with parenthetical instructions written for the user.
 */
function isStubOnly(context: string): boolean {
  // The default template uses parenthetical placeholders. If most lines are
  // just placeholders or section headers, treat it as unedited.
  const lines = context.split('\n').map(l => l.trim()).filter(Boolean);
  const realLines = lines.filter(
    l => !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('(') && !l.endsWith(')'),
  );
  return realLines.length === 0;
}

export function applyRecall(question: string, recall: string | null): string {
  if (!recall) return question;
  return `${recall}${question}`;
}
