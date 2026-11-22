/**
 * CLI number parsing.
 *
 * parseInt('abc') is NaN, and NaN passes every `spend >= cap` comparison in
 * the budget gate (all comparisons with NaN are false) and serialises to
 * `max_tokens: null` on the wire. Values that bound spend are therefore
 * validated here and rejected loudly, never coerced or defaulted.
 */

/** A positive finite number, or the fallback. For tuning knobs whose default is always safe. */
export function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse a strictly positive decimal integer; null for anything else ("1e3", "12abc", "-1", ""). */
export function parsePositiveInt(raw: string | undefined): number | null {
  const s = (raw ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Parse a flag that bounds spend. Exits the process on a bad value rather than run unbounded. */
export function positiveInt(raw: string | undefined, flag: string): number {
  const n = parsePositiveInt(raw);
  if (n === null) {
    console.error(`${flag} must be a positive integer, got "${raw ?? ''}"`);
    process.exit(1);
  }
  return n;
}
