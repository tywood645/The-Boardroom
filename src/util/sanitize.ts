/**
 * Flatten model- or user-authored text into one bounded, inert line before it
 * is persisted or replayed into a later prompt.
 *
 * The recall block quotes past motions and dissent reasons back to every
 * vendor in every later meeting. Unbounded multi-line text there let one
 * response close the block with a forged "--- end prior context ---" marker
 * and append its own instructions, outside the quoted section, permanently.
 *
 * Newlines and control characters (C0, C1, line/paragraph separators) become
 * spaces, runs of three or more dashes collapse so no delimiter can be forged,
 * double quotes become single quotes so a quoted field cannot be closed early,
 * and the result is truncated to `max` characters.
 */
export function sanitizeForRecall(text: unknown, max: number): string {
  const flat = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[-\u2010-\u2015\u2212]{3,}/g, '-')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '\u2026' : flat;
}
