/**
 * Strict parsing of `NAME: value` lines in model replies.
 *
 * The protocols ask for replies like `VOTE: AYE`. Taking the first match
 * anywhere in the text got this wrong in a way that changed outcomes: a model
 * that restated the format line (`VOTE: AYE | NAY | ABSTAIN`) before voting
 * NAY was counted as AYE, because AYE is listed first. Five such NAYs were
 * recorded as a 5-0 pass.
 *
 * A field counts only when it starts a line, is not the format line echoed
 * back, and every such line agrees. Anything else is "no answer", which each
 * caller maps to its safe default (abstain, undecided, not seconded,
 * unparseable).
 */

/** Markdown decoration models add despite "no markdown": quote marks, list bullets, bold, headers. */
const LEAD = String.raw`^[ \t>*#_\-]*`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The single value given for `name`, or null when it is missing, ambiguous or
 * contradictory. Matching is case-insensitive; the returned value is the
 * spelling from `choices`.
 */
export function parseChoice<T extends string>(text: string, name: string, choices: readonly T[]): T | null {
  const alt = choices.map(escapeRe).join('|');
  const line = new RegExp(`${LEAD}${escapeRe(name)}\\**[ \\t]*:\\**[ \\t]*\\**(${alt})\\b([^\\n]*)$`, 'gim');
  // The format line lists its alternatives: "AYE | NAY | ABSTAIN", "yes/no", "SUPPORT or OPPOSE".
  const listsAlternatives = new RegExp(`^\\**[ \\t]*(?:\\||/|,|or\\b)[ \\t]*\\**(?:${alt})\\b`, 'i');

  // ...or names the field a second time on the same line: "VERDICT: A or VERDICT: B".
  const repeatsField = new RegExp(`\\b${escapeRe(name)}\\**[ \\t]*:`, 'i');

  const found = new Set<string>();
  for (const m of text.matchAll(line)) {
    const rest = m[2];
    if (rest.includes('|') || listsAlternatives.test(rest) || repeatsField.test(rest)) continue;
    found.add(m[1].toLowerCase());
  }
  if (found.size !== 1) return null;
  const [value] = found;
  return choices.find(c => c.toLowerCase() === value) ?? null;
}

/**
 * The text of the last `name:` line, bounded to `max` characters, or null.
 * The last one, because an echoed format line (`REASON: <one sentence>`)
 * comes before the real answer. Never spans lines.
 */
export function parseLine(text: string, name: string, max: number): string | null {
  const line = new RegExp(`${LEAD}${escapeRe(name)}\\**[ \\t]*:\\**[ \\t]*([^\\n]*)$`, 'gim');
  let last: string | null = null;
  for (const m of text.matchAll(line)) {
    const value = m[1].trim();
    if (value) last = value;
  }
  return last === null ? null : last.slice(0, max);
}
