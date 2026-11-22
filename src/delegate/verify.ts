import { parseChoice, parseLine } from '../util/fields.js';

/**
 * The refutation contract.
 *
 * The checker runs at the *same* tier as the attempt but on a different
 * vendor, so a cheap answer costs roughly one more cheap call to check rather
 * than one frontier call. Independence matters more than capability here: a
 * different vendor brings genuinely different priors, where a larger sibling
 * from the same family tends to share the blind spot that produced the error.
 */

export const VERIFY_SYSTEM = `You are checking another model's answer. You are not improving it, rewriting it, or being polite about it.

Decide one thing: does the answer actually do what the task asked, correctly?

Reply in this EXACT format, no markdown, no preamble:
VERDICT: CONFIRMED
DEFECT: none

OR:
VERDICT: REFUTED
DEFECT: <one sentence naming a specific, concrete defect>

Rules you must follow:
- REFUTED requires a concrete named defect. If you cannot name one, the verdict is CONFIRMED.
- Style, tone, and things you would have phrased differently are NOT defects.
- Judge only what was asked. Do not invent extra requirements.`;

export function buildVerifyPrompt(task: string, answer: string): string {
  return (
    `TASK THAT WAS GIVEN:\n${task}\n\n` +
    `--- end task ---\n\n` +
    `ANSWER TO CHECK:\n${answer}\n\n` +
    `--- end answer ---\n\n` +
    `Return your verdict in the exact format specified.`
  );
}

export type VerdictKind = 'confirmed' | 'refuted' | 'unparseable';

export interface Verdict {
  kind: VerdictKind;
  defect: string;
  /** Why the raw text produced this verdict; surfaced by --explain. */
  why: string;
}

const EMPTY_DEFECT = /^(none|n\/a|na|-|nothing|no defects?)\.?$/i;
/** The prompt's own placeholder echoed back: "<one sentence naming ...>". Not a defect. */
const PLACEHOLDER_DEFECT = /^<[^>]*>$/;

/**
 * Parsed in the same strict style as the motion protocol's parseSecond /
 * parseDebate / parseVote, with two deliberate fail-safes:
 *
 *  - A REFUTED with no named defect becomes CONFIRMED. Otherwise a model that
 *    reflexively refuses to approve anything drives the escalation ladder to
 *    the most expensive tier for free.
 *  - Unparseable output does not escalate. Failing open on escalation while
 *    failing closed on budget is the right asymmetry: a parser miss must never
 *    be able to spend frontier money.
 */
export function parseVerdict(text: string): Verdict {
  const cleaned = text.trim();
  // Line-leading, unambiguous and not the format echoed back (util/fields.ts).
  // A checker that restated "VERDICT: CONFIRMED ... OR: VERDICT: REFUTED"
  // before answering used to be read as CONFIRMED, because it came first.
  const kind = parseChoice(cleaned, 'VERDICT', ['CONFIRMED', 'REFUTED']);
  if (!kind) {
    return { kind: 'unparseable', defect: '', why: 'no single, unambiguous VERDICT line found' };
  }

  if (kind === 'CONFIRMED') {
    return { kind: 'confirmed', defect: '', why: 'checker confirmed the answer' };
  }

  const defect = parseLine(cleaned, 'DEFECT', 200) ?? '';
  if (!defect || EMPTY_DEFECT.test(defect) || PLACEHOLDER_DEFECT.test(defect)) {
    return {
      kind: 'confirmed',
      defect: '',
      why: 'refuted without naming a defect, so treated as confirmed',
    };
  }

  return {
    kind: 'refuted',
    defect: defect.slice(0, 200),
    why: 'checker named a concrete defect',
  };
}
