/**
 * Make text from a provider (or anything else untrusted) inert on a terminal.
 *
 * Model output, vendor error bodies and vendor-supplied model ids were written
 * to the terminal verbatim. A response containing ANSI control sequences could
 * clear the screen and print a forged status line, rewrite earlier output with
 * carriage returns, plant deceptive OSC 8 hyperlinks, or, on terminals that
 * allow OSC 52, replace the clipboard.
 *
 * Every control character except newline and tab is replaced with a visible
 * escape such as `\x1b`, so an attempt is shown rather than executed or
 * silently dropped. That covers ESC, which starts every CSI, OSC and DCS
 * sequence, and the C1 controls (U+0080 to U+009F), which some terminals act
 * on directly. Unicode bidirectional overrides and isolates are escaped too:
 * they do not drive the terminal, but they can make displayed text read
 * differently from what it contains.
 *
 * Raw text is kept only where it is explicitly machine-readable: `--json`
 * output, where JSON.stringify escapes control characters itself.
 */

// C0 except \t (09) and \n (0a), then DEL and C1.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// LRE RLE PDF LRO RLO, LRI RLI FSI PDI, and the implicit marks ALM LRM RLM.
const BIDI = /[\u202a-\u202e\u2066-\u2069\u061c\u200e\u200f]/g;

function hex(c: string, width: number): string {
  return c.charCodeAt(0).toString(16).padStart(width, '0');
}

export function safeForTerminal(text: unknown): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(CONTROL, c => `\\x${hex(c, 2)}`)
    .replace(BIDI, c => `\\u${hex(c, 4)}`);
}

/**
 * A copy of `value` with every string inside it passed through
 * safeForTerminal. Renderers call this once on the whole result they are
 * about to print, so no individual field can be forgotten.
 */
export function safeDeep<T>(value: T): T {
  if (typeof value === 'string') return safeForTerminal(value) as T;
  if (Array.isArray(value)) return value.map(v => safeDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = safeDeep(v);
    return out as T;
  }
  return value;
}
