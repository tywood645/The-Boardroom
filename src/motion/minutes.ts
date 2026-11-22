import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardroomSubdir } from '../util/paths.js';
import type { MotionResult } from './types.js';

export function meetingsDir(): string {
  return boardroomSubdir('meetings');
}

/**
 * Minutes are a record: never replace an existing file. 'wx' fails if the path
 * exists, in which case a numbered sibling is written instead.
 */
export function writeMinutes(result: MotionResult): string {
  const dir = meetingsDir();
  const md = renderMinutes(result);
  for (let n = 0; ; n++) {
    const path = join(dir, n === 0 ? `${result.id}.md` : `${result.id}-${n}.md`);
    try {
      writeFileSync(path, md, { mode: 0o600, flag: 'wx' });
      return path;
    } catch (e: any) {
      if (e?.code !== 'EEXIST' || n >= 100) throw e;
    }
  }
}

function renderMinutes(r: MotionResult): string {
  const lines: string[] = [];

  lines.push(`# Board Meeting: ${r.id}`);
  lines.push('');
  lines.push(`**Started:** ${r.startedAt}`);
  lines.push(`**Mover:** ${r.mover}`);
  lines.push(`**Outcome:** ${outcomeLabel(r.outcome)}`);
  lines.push('');
  lines.push(`## Motion`);
  lines.push('');
  lines.push(`> ${r.motion}`);
  lines.push('');

  if (r.briefing) {
    lines.push(`## Consultant Briefing`);
    lines.push(`*Source: ${r.briefing.source} / ${r.briefing.model}*`);
    lines.push('');
    lines.push(r.briefing.text);
    lines.push('');
  } else {
    lines.push(`## Consultant Briefing`);
    lines.push(`*(none: disabled or unavailable)*`);
    lines.push('');
  }

  lines.push(`## Seconds`);
  lines.push('');
  for (const s of r.seconds) {
    if (s.error) {
      lines.push(`- **${s.role}** (${s.panelist}): ERROR: ${s.error}`);
      continue;
    }
    const mark = s.seconded ? '✓ SECONDED' : '✗ DECLINED';
    lines.push(`- **${s.role}** (${s.panelist}): ${mark}: ${s.reason}`);
  }
  const validSeconds = r.seconds.filter(s => s.seconded && !s.error).length;
  lines.push('');
  lines.push(`**Total seconds: ${validSeconds}**`);
  lines.push('');

  if (r.outcome === 'died_for_lack_of_second') {
    lines.push(`## Result`);
    lines.push('');
    lines.push(`Motion died for lack of a second (need at least 2). No debate or vote held.`);
    lines.push('');
    return lines.join('\n');
  }
  if (r.outcome === 'no_quorum' && r.quorum?.phase === 'second') {
    lines.push(`## Result`);
    lines.push('');
    lines.push(`${quorumStatement(r)} No debate or vote held.`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push(`## Debate`);
  lines.push('');
  for (const d of r.debate) {
    if (d.error) {
      lines.push(`### ${d.role} (${d.panelist}): ERROR`);
      lines.push(`> ${d.error}`);
      lines.push('');
      continue;
    }
    lines.push(`### ${d.role} (${d.panelist}): **${d.stance}**`);
    lines.push('');
    lines.push(d.case);
    lines.push('');
  }

  lines.push(`## Final Vote`);
  lines.push('');
  lines.push(`| Advisor | Role | Vote | Flipped? | Reason |`);
  lines.push(`|---|---|---|---|---|`);
  for (const v of r.votes) {
    if (v.error) {
      lines.push(`| ${v.panelist} | ${v.role} | ERROR | n/a | ${v.error} |`);
      continue;
    }
    const flipMark = v.flipped ? 'YES' : '';
    const safeReason = v.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${v.panelist} | ${v.role} | **${v.vote}** | ${flipMark} | ${safeReason} |`);
  }
  lines.push('');
  lines.push(`**Tally:** AYE ${r.tally.aye} · NAY ${r.tally.nay} · ABSTAIN ${r.tally.abstain}`);
  lines.push('');

  lines.push(`## Result`);
  lines.push('');
  lines.push(outcomeStatement(r));
  lines.push('');

  const dissents = r.votes.filter(v => !v.error && (
    (r.outcome === 'passed' && v.vote === 'NAY') ||
    (r.outcome === 'failed' && v.vote === 'AYE')
  ));
  if (dissents.length > 0) {
    lines.push(`## Dissents on Record`);
    lines.push('');
    for (const d of dissents) {
      lines.push(`- **${d.role}** (${d.panelist}): ${d.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function outcomeLabel(outcome: MotionResult['outcome']): string {
  switch (outcome) {
    case 'passed': return 'PASSED';
    case 'failed': return 'FAILED';
    case 'tied': return 'TIED: chair (founder) must break';
    case 'died_for_lack_of_second': return 'DIED FOR LACK OF SECOND';
    case 'no_quorum': return 'NO QUORUM: nothing decided';
  }
}

/** One sentence on why there was no quorum. Shared by the minutes and the terminal render. */
export function quorumStatement(r: MotionResult): string {
  const q = r.quorum;
  if (!q) return 'No quorum: too few advisors answered, so nothing was decided.';
  const what = q.phase === 'second' ? 'the call for a second' : 'the final vote';
  return (
    `No quorum: ${q.present} of ${q.seated} advisors answered ${what} and ${q.needed} are needed. ` +
    `Nothing was decided and nothing was recorded as a decision.`
  );
}

function outcomeStatement(r: MotionResult): string {
  switch (r.outcome) {
    case 'passed':
      return `The motion **PASSED** ${r.tally.aye}-${r.tally.nay}${r.tally.abstain ? ` (${r.tally.abstain} abstain)` : ''}.`;
    case 'failed':
      return `The motion **FAILED** ${r.tally.nay}-${r.tally.aye}${r.tally.abstain ? ` (${r.tally.abstain} abstain)` : ''}.`;
    case 'tied':
      return `The motion is **TIED** ${r.tally.aye}-${r.tally.nay}. The chair (founder) must cast the deciding vote.`;
    case 'died_for_lack_of_second':
      return `The motion died for lack of a second.`;
    case 'no_quorum':
      return quorumStatement(r);
  }
}
