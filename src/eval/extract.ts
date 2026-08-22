// Deterministic vote extraction.
//
// This file is the whole reason the eval is an eval. Nothing here calls a
// model, and nothing here asks a human. Given an advisor's answer text and a
// question's option aliases, it returns exactly one of: a matched option, or a
// refusal to classify. It never guesses.
//
// The refusal cases are the important ones. An eval that quietly resolves
// ambiguity in favour of one option manufactures agreement or disagreement it
// did not measure, so ambiguity is surfaced as a reported parse rate instead.

import type { EvalQuestion } from './corpus.js';

export type ExtractStatus = 'matched' | 'no_match' | 'ambiguous' | 'empty';

export interface ExtractResult {
  status: ExtractStatus;
  /** Set only when status === 'matched'. */
  optionId?: string;
  /** Why the extractor refused, when it did. */
  reason?: 'multiple_options' | 'negated_only';
  /** Which window produced the match, for debugging low parse rates. */
  window?: 'first_sentence' | 'first_two_sentences';
  /** The exact alias text that matched, for auditing a run. */
  matchedAlias?: string;
  /**
   * Set when a sentence named both options and the vote was taken from the
   * main clause. Recorded so a run can be audited for how often this fired.
   */
  resolvedBy?: 'main_clause';
}

/**
 * Words that flip the meaning of an alias that follows them. If one of these
 * sits within NEGATION_LOOKBACK tokens ahead of an alias, that alias hit is
 * treated as negated rather than as a vote.
 *
 * A negated hit is deliberately NOT inverted into a vote for the other option.
 * "Not because of cost, hire the VP" would invert wrongly, and a measurement
 * that is confidently wrong is worse than one that abstains.
 */
const NEGATION_TOKENS = new Set([
  'not', 'no', 'never', 'avoid', 'skip', 'reject', 'against', 'without',
  'dont', "don't", 'doesnt', "doesn't", 'shouldnt', "shouldn't",
  'wouldnt', "wouldn't", 'cant', "can't", 'stop', 'forget', 'refuse',
]);

/** Multi-word negation phrases checked against the text immediately preceding an alias. */
const NEGATION_PHRASES = ['rather than', 'instead of', 'as opposed to', 'far from'];

const NEGATION_LOOKBACK = 3;

/** Abbreviations whose trailing period must not end a sentence. */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'vs', 'inc', 'corp', 'co', 'ltd', 'approx', 'etc',
  'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'fig', 'al',
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")   // curly single quotes
    .replace(/[“”]/g, '"')   // curly double quotes
    .replace(/[‐-―]/g, '-')  // unicode dashes to ascii hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split normalized text into sentences. Deliberately simple: the panel is
 * instructed to lead with a single declarative recommendation, so this only
 * has to survive ordinary prose plus a short abbreviation list.
 */
export function splitSentences(normalized: string): string[] {
  if (!normalized) return [];
  const out: string[] = [];
  let buf = '';

  const parts = normalized.split(/([.!?]+\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = parts[i] ?? '';
    const delim = parts[i + 1] ?? '';
    buf += chunk + delim;

    const lastWord = chunk.split(' ').pop() ?? '';
    const isAbbrev = ABBREVIATIONS.has(lastWord.replace(/[^a-z.]/g, '').replace(/\.$/, ''));
    if (!isAbbrev && delim) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(s => s.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the text immediately preceding `index` negates what follows. */
function isNegated(haystack: string, index: number): boolean {
  const before = haystack.slice(0, index).trimEnd();
  if (!before) return false;

  for (const phrase of NEGATION_PHRASES) {
    if (before.endsWith(phrase)) return true;
  }

  const tokens = before.split(' ').filter(Boolean);
  const window = tokens.slice(-NEGATION_LOOKBACK);
  return window.some(t => NEGATION_TOKENS.has(t.replace(/[^a-z']/g, '')));
}

interface AliasHit {
  optionId: string;
  alias: string;
  negated: boolean;
  /** Character offset of the match, used to resolve a two-option sentence. */
  index: number;
  /** True when the hit sits in a trailing clause after a dash, colon or comma. */
  subordinate: boolean;
}

/**
 * Where the main clause of a sentence ends.
 *
 * The forced-choice instruction tells an advisor to open with one option, and a
 * good comparative answer then names the option it rejected in a trailing
 * clause: "Financial VC - the burden of proof sits on the strategic to overcome
 * it." Both options appear, but only one is the vote, and it is the one in the
 * main clause.
 *
 * Splitting on the first dash, colon or semicolon captures that shape. A comma
 * is deliberately NOT a boundary: commas appear inside main clauses far too
 * often ("Raise now, before revenue slips") and treating one as a clause break
 * would discard real votes.
 */
function mainClauseEnd(window: string): number {
  const m = window.match(/\s+[-–—]\s+|\s*[:;]\s+/);
  return m && m.index !== undefined ? m.index : window.length;
}

function findHits(window: string, question: EvalQuestion): AliasHit[] {
  const hits: AliasHit[] = [];
  const clauseEnd = mainClauseEnd(window);
  for (const option of question.options) {
    for (const alias of option.aliases) {
      const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(normalize(alias))}(?![a-z0-9])`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(window)) !== null) {
        hits.push({
          optionId: option.id,
          alias,
          negated: isNegated(window, m.index),
          index: m.index,
          subordinate: m.index >= clauseEnd,
        });
      }
    }
  }
  return hits;
}

function classify(window: string, question: EvalQuestion): ExtractResult | null {
  const hits = findHits(window, question);
  if (hits.length === 0) return null;

  const positive = hits.filter(h => !h.negated);
  const positiveOptions = new Set(positive.map(h => h.optionId));

  if (positiveOptions.size === 1) {
    const first = positive[0];
    return { status: 'matched', optionId: first.optionId, matchedAlias: first.alias };
  }
  if (positiveOptions.size > 1) {
    // Two options named in one sentence. Measured against six real vendors this
    // is the single largest source of discarded votes, and most of those votes
    // are not actually ambiguous to a reader: the advisor complied, opened with
    // its choice, and then named the option it rejected in a trailing clause.
    //
    // Resolve it ONLY in that unambiguous shape: exactly one option in the main
    // clause, every mention of the other confined to the subordinate clause.
    // Anything else stays ambiguous, because guessing between two options in a
    // single main clause would manufacture a vote that was never cast.
    const mainClause = positive.filter(h => !h.subordinate);
    const mainOptions = new Set(mainClause.map(h => h.optionId));
    if (mainOptions.size === 1) {
      const first = mainClause.reduce((a, b) => (a.index <= b.index ? a : b));
      return {
        status: 'matched',
        optionId: first.optionId,
        matchedAlias: first.alias,
        resolvedBy: 'main_clause',
      };
    }
    return { status: 'ambiguous', reason: 'multiple_options' };
  }
  // Every hit was negated. Refuse rather than invert.
  return { status: 'ambiguous', reason: 'negated_only' };
}

/**
 * Extract a vote from one advisor's answer.
 *
 * Reads the first sentence only. The round-1 format mandates a closing
 * counterargument, and that sentence names the option the advisor rejected, so
 * widening to the full answer would match both options on nearly every
 * question. If the first sentence yields nothing at all (a throat-clearing
 * opener), the window widens to the first two sentences once.
 */
export function extractVote(answerText: string, question: EvalQuestion): ExtractResult {
  const normalized = normalize(answerText);
  // An empty answer is reported separately from an unparseable one. A reasoning
  // model can spend its entire token budget on hidden reasoning and return no
  // visible content, and folding that into no_match hides a silently absent
  // seat inside a statistic about extractor coverage. They are different
  // failures: one is a panelist not speaking, the other is this code not
  // understanding what it said.
  if (!normalized) return { status: 'empty' };

  const sentences = splitSentences(normalized);
  if (sentences.length === 0) return { status: 'empty' };

  const first = classify(sentences[0], question);
  if (first) return { ...first, window: 'first_sentence' };

  if (sentences.length > 1) {
    const widened = classify(sentences.slice(0, 2).join(' '), question);
    if (widened) return { ...widened, window: 'first_two_sentences' };
  }

  return { status: 'no_match' };
}
