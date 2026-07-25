import type { Tier } from '../cost/catalog.js';

/**
 * What shape of work a task is. Deliberately a small closed set with a rules
 * table — classifying with a model to decide which model to use is circular
 * and adds a call to every delegation.
 *
 * Seven work shapes the delegator picks between deterministically, plus an
 * internal one for verification. The measured stats in stats.ts are keyed on
 * them, so the set is deliberately small and closed — a class split too finely
 * would never gather enough samples to earn a tier change.
 */
export type TaskClass =
  | 'recon'
  | 'extract'
  | 'summarize'
  | 'draft'
  | 'code'
  | 'reason'
  | 'research'
  // Set internally when the delegator asks one model to check another's work.
  | 'review';

export const TASK_CLASSES: readonly TaskClass[] = [
  'recon', 'extract', 'summarize', 'draft', 'code', 'reason', 'research', 'review',
] as const;

export function isTaskClass(s: string): s is TaskClass {
  return (TASK_CLASSES as readonly string[]).includes(s);
}

/**
 * Starting tier before any measurement exists. stats.ts overrides these once
 * a cell has enough samples, which is what keeps this table a starting point
 * rather than a permanent guess.
 */
export const TIER_PRIORS: Record<TaskClass, Tier> = {
  recon: 'cheap',
  extract: 'cheap',
  summarize: 'cheap',
  draft: 'cheap',
  code: 'mid',
  reason: 'mid',
  research: 'mid',
  review: 'cheap',
};

interface Rule {
  cls: TaskClass;
  why: string;
  test: (task: string) => boolean;
}

// First match wins, so the order here is the priority order.
const RULES: Rule[] = [
  {
    cls: 'code',
    why: 'contains a code fence or a file path',
    test: t => /```/.test(t) || /(^|\s)[\w./-]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|c|cpp|h|json|ya?ml|sh|md)\b/.test(t),
  },
  {
    cls: 'research',
    why: 'asks for current or recent information',
    test: t => /\b(latest|current|as of|right now|recent(ly)?|news|today|this (week|month|year)|20[2-9]\d)\b/i.test(t),
  },
  {
    cls: 'reason',
    why: 'asks for a judgment or comparison',
    test: t => /\b(should (we|i)|trade.?offs?|compare|pros and cons|why (do|does|is|are)|worth it|better than|decide)\b/i.test(t),
  },
  {
    cls: 'code',
    why: 'names a code-editing action',
    test: t => /\b(refactor|implement|debug|stack trace|compile|unit test|patch|migrate|type error)\b/i.test(t),
  },
  {
    cls: 'summarize',
    why: 'asks for a condensed version of given text',
    test: t => /\b(summari[sz]e|tl;?dr|condense|shorten|key takeaways|in brief)\b/i.test(t),
  },
  {
    cls: 'extract',
    why: 'asks for structured output pulled from given text',
    test: t => /\b(extract|parse|pull out|into json|as json|list the|tabulate|enumerate)\b/i.test(t),
  },
  {
    cls: 'recon',
    why: 'asks where something is or whether it exists',
    test: t => /\b(where is|which file|find the|locate|look up|does .* exist|what is the name)\b/i.test(t),
  },
];

export interface Classification {
  cls: TaskClass;
  why: string;
}

/** Rules first, explicit override always wins. */
export function classify(task: string, override?: TaskClass): Classification {
  if (override) return { cls: override, why: 'set by --class' };
  for (const rule of RULES) {
    if (rule.test(task)) return { cls: rule.cls, why: rule.why };
  }
  return { cls: 'draft', why: 'no rule matched; default' };
}
