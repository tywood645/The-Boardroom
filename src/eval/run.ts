// The eval runner: corpus -> panel -> extractor -> scorer.
//
// Two deliberate omissions. Eval runs never fetch a consultant briefing and
// never load prior-decision recall. Both inject text that changes between runs,
// and a divergence number you cannot reproduce next week is not a measurement.

import type { ProviderConfig } from '../provider/factory.js';
import { askPanel, type PanelistAnswer, type Seat } from '../boardroom/panel.js';
import { buildSeats, ROUND1_BASE } from '../boardroom/protocol.js';
import { ROLES } from '../boardroom/roles.js';
import { CostTracker } from '../cost/tracker.js';
import type { RunContext } from '../provider/collect.js';
import { selectQuestions, forcedChoiceSuffix, type Category, type EvalQuestion } from './corpus.js';
import { extractVote } from './extract.js';
import { scoreQuestion, buildReport, type DivergenceReport, type Vote } from './divergence.js';

export interface EvalOptions {
  category?: Category;
  limit?: number;
  maxTokens?: number;
  /** Vendor name to seat in all six roles. Omit for the real multi-vendor panel. */
  control?: string;
  /**
   * Budget gate, concurrency cap and deadline. Threaded through to every
   * provider call so a 180-call eval cannot bypass the spend limit that the
   * board itself respects. Omit and the run gets its own tracker.
   */
  ctx?: RunContext;
  /** Called after each question so a long run shows progress. */
  onProgress?: (done: number, total: number, questionId: string) => void;
}

export interface EvalRunResult {
  report: DivergenceReport;
  costUsd: number;
}

/** Seats every role on a single provider — the control arm of the experiment. */
export function buildControlSeats(config: ProviderConfig, roundBase: string): Seat[] {
  return Object.values(ROLES).map(role => ({
    config,
    role: role.name,
    system: roundBase + role.mindset,
  }));
}

function toVote(answer: PanelistAnswer, question: EvalQuestion): Vote {
  if (answer.error) {
    return {
      panelist: answer.panelist,
      role: answer.role,
      extract: { status: 'no_match' },
      error: answer.error,
    };
  }
  return {
    panelist: answer.panelist,
    role: answer.role,
    extract: extractVote(answer.text, question),
  };
}

export async function runEval(
  configs: ProviderConfig[],
  opts: EvalOptions = {},
): Promise<EvalRunResult> {
  const maxTokens = opts.maxTokens ?? 512;
  const questions = selectQuestions(opts.category, opts.limit);
  if (questions.length === 0) throw new Error('No questions selected.');

  let seats: Seat[];
  let label: string;

  if (opts.control) {
    const config = configs.find(c => c.name === opts.control);
    if (!config) {
      throw new Error(
        `Control vendor "${opts.control}" is not available. Detected: ${configs.map(c => c.name).join(', ') || 'none'}`,
      );
    }
    seats = buildControlSeats(config, ROUND1_BASE);
    label = `single-vendor control (${opts.control})`;
  } else {
    seats = buildSeats(configs, ROUND1_BASE);
    label = `multi-vendor panel (${seats.length} vendors)`;
  }

  if (seats.length < 2) {
    throw new Error('Need at least 2 seats to measure divergence.');
  }

  // Share the caller's tracker when there is one, so both arms of a --compare
  // draw down the same budget. Cost is summed per call rather than read from
  // session totals, so each arm reports only its own spend.
  const ownsTracker = !opts.ctx?.tracker;
  const tracker = opts.ctx?.tracker ?? new CostTracker();
  const scores = [];
  let costUsd = 0;

  // Questions run sequentially; the six seats within a question run in
  // parallel. Fanning out across questions too would trip vendor rate limits
  // on a 30-question run.
  let done = 0;
  for (const question of questions) {
    const prompt = question.prompt + forcedChoiceSuffix(question);
    const answers = await askPanel(seats, prompt, maxTokens, opts.ctx);

    for (const a of answers) {
      if (!a.error) costUsd += tracker.recordUsage(a.model, a.inputTokens, a.outputTokens).cost;
    }

    scores.push(scoreQuestion(question, answers.map(a => toVote(a, question))));
    done++;
    opts.onProgress?.(done, questions.length, question.id);
  }

  // The CLI flushes the tracker it owns; flush ours so a library caller still
  // gets the usage log written.
  if (ownsTracker) tracker.flush();

  return { report: buildReport(label, seats.length, scores), costUsd };
}
