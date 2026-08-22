// Scoring. Pure functions over already-extracted votes — no I/O, no network.
//
// The headline figure is the divergence rate: the share of scored questions on
// which the panel did not land unanimously. Everything else exists to keep that
// number honest, especially the parse rate, which bounds how much of the panel
// the divergence rate actually saw.

import type { Category, EvalQuestion } from './corpus.js';
import type { ExtractResult } from './extract.js';

export interface Vote {
  /** Vendor name, e.g. "anthropic". */
  panelist: string;
  /** Role name, e.g. "CEO". */
  role: string;
  extract: ExtractResult;
  /** Set when the provider call itself failed; such votes are never scored. */
  error?: string;
}

export interface QuestionScore {
  questionId: string;
  category: Category;
  votes: Vote[];
  /** Votes that produced a usable option. */
  parsedCount: number;
  /** optionId -> number of votes. */
  tally: Record<string, number>;
  /** Highest single-option count; 0 when nothing parsed. */
  topCount: number;
  /** Option ids tied at topCount. */
  topOptionIds: string[];
  /** Scored questions need at least 2 parsed votes; others are excluded. */
  scored: boolean;
  /** True when parsed votes covered more than one option. */
  divergent: boolean;
  /** (parsed - topCount) / parsed, i.e. the share of the panel on a losing side. */
  minorityShare: number;
}

export interface VendorScore {
  panelist: string;
  role: string;
  /** Questions where this vendor produced a parsed vote and the question scored. */
  participated: number;
  /** Of those, how many put it strictly outside the plurality. */
  minority: number;
  contrarianRate: number;
  parseFailures: number;
  errors: number;
}

export interface CategoryScore {
  category: Category;
  scored: number;
  divergent: number;
  divergenceRate: number;
}

export interface DivergenceReport {
  label: string;
  panelSize: number;
  questionCount: number;
  totalVotes: number;
  parsedVotes: number;
  parseRate: number;
  ambiguousVotes: number;
  noMatchVotes: number;
  /** Answers that arrived with no visible text at all. */
  emptyVotes: number;
  errorVotes: number;
  scoredQuestions: number;
  divergentQuestions: number;
  divergenceRate: number;
  meanMinorityShare: number;
  perQuestion: QuestionScore[];
  perVendor: VendorScore[];
  perCategory: CategoryScore[];
}

export function scoreQuestion(question: EvalQuestion, votes: Vote[]): QuestionScore {
  const tally: Record<string, number> = {};
  let parsedCount = 0;

  for (const v of votes) {
    if (v.error) continue;
    if (v.extract.status !== 'matched' || !v.extract.optionId) continue;
    tally[v.extract.optionId] = (tally[v.extract.optionId] ?? 0) + 1;
    parsedCount++;
  }

  const counts = Object.values(tally);
  const topCount = counts.length ? Math.max(...counts) : 0;
  const topOptionIds = Object.keys(tally).filter(id => tally[id] === topCount);
  const scored = parsedCount >= 2;
  const distinctOptions = Object.keys(tally).length;

  return {
    questionId: question.id,
    category: question.category,
    votes,
    parsedCount,
    tally,
    topCount,
    topOptionIds,
    scored,
    divergent: scored && distinctOptions > 1,
    minorityShare: scored && parsedCount > 0 ? (parsedCount - topCount) / parsedCount : 0,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function buildReport(
  label: string,
  panelSize: number,
  scores: QuestionScore[],
): DivergenceReport {
  const scored = scores.filter(s => s.scored);
  const divergent = scored.filter(s => s.divergent);

  let totalVotes = 0;
  let parsedVotes = 0;
  let ambiguousVotes = 0;
  let noMatchVotes = 0;
  let emptyVotes = 0;
  let errorVotes = 0;

  const vendorMap = new Map<string, VendorScore>();

  for (const s of scores) {
    for (const v of s.votes) {
      totalVotes++;
      const key = v.panelist;
      if (!vendorMap.has(key)) {
        vendorMap.set(key, {
          panelist: v.panelist, role: v.role,
          participated: 0, minority: 0, contrarianRate: 0,
          parseFailures: 0, errors: 0,
        });
      }
      const vs = vendorMap.get(key)!;

      if (v.error) { errorVotes++; vs.errors++; continue; }
      if (v.extract.status === 'matched') {
        parsedVotes++;
      } else {
        if (v.extract.status === 'ambiguous') ambiguousVotes++;
        else if (v.extract.status === 'empty') emptyVotes++;
        else noMatchVotes++;
        vs.parseFailures++;
        continue;
      }

      // Contrarian accounting only makes sense on questions that scored.
      if (!s.scored) continue;
      vs.participated++;
      const optionId = v.extract.optionId!;
      const isTop = s.topOptionIds.includes(optionId);
      if (!isTop) vs.minority++;
    }
  }

  for (const vs of vendorMap.values()) {
    vs.contrarianRate = vs.participated > 0 ? vs.minority / vs.participated : 0;
  }

  const byCategory = new Map<Category, CategoryScore>();
  for (const s of scored) {
    if (!byCategory.has(s.category)) {
      byCategory.set(s.category, { category: s.category, scored: 0, divergent: 0, divergenceRate: 0 });
    }
    const cs = byCategory.get(s.category)!;
    cs.scored++;
    if (s.divergent) cs.divergent++;
  }
  for (const cs of byCategory.values()) {
    cs.divergenceRate = cs.scored > 0 ? cs.divergent / cs.scored : 0;
  }

  return {
    label,
    panelSize,
    questionCount: scores.length,
    totalVotes,
    parsedVotes,
    parseRate: totalVotes > 0 ? parsedVotes / totalVotes : 0,
    ambiguousVotes,
    noMatchVotes,
    emptyVotes,
    errorVotes,
    scoredQuestions: scored.length,
    divergentQuestions: divergent.length,
    divergenceRate: scored.length > 0 ? divergent.length / scored.length : 0,
    meanMinorityShare: mean(scored.map(s => s.minorityShare)),
    perQuestion: scores,
    perVendor: [...vendorMap.values()].sort((a, b) => b.contrarianRate - a.contrarianRate),
    perCategory: [...byCategory.values()],
  };
}

/**
 * The falsification test.
 *
 * BoardRoom claims six vendors disagree more than one vendor in six roles. If
 * `delta` is not meaningfully positive, that claim is unsupported and the
 * README should say so.
 */
export interface ControlComparison {
  multiVendor: DivergenceReport;
  singleVendor: DivergenceReport;
  delta: number;
  premiseSupported: boolean;
}

export function compareToControl(
  multiVendor: DivergenceReport,
  singleVendor: DivergenceReport,
  threshold = 0.10,
): ControlComparison {
  const delta = multiVendor.divergenceRate - singleVendor.divergenceRate;
  return { multiVendor, singleVendor, delta, premiseSupported: delta >= threshold };
}
