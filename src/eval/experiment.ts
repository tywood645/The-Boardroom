// The experiment: paired arms, rotated roles, repeated trials.
//
// runEval measures one arm. This runs the comparison the README's claim
// actually needs, and it exists because three properties have to hold at once
// and none of them survive being bolted on afterwards.
//
//   Pairing. Both arms answer the same question in the same trial, and a
//   question is compared only when BOTH arms scored it. Dropping unpaired
//   questions costs sample size and buys the right to use a paired test.
//
//   Rotation. Every trial sweeps a full Latin square, so no vendor is measured
//   only in the seat it was hand-assigned.
//
//   Repetition. Trials are independent repetitions of the whole square, because
//   one pass gives a point estimate with no way to see run-to-run variance.
//
// The unit of analysis is (trial, rotation, question). That triple is what gets
// paired across arms, so a question contributes once per rotation per trial
// rather than being silently averaged first, which would understate variance.

import type { ProviderConfig } from '../provider/factory.js';
import { askPanel } from '../boardroom/panel.js';
import { ROUND1_BASE } from '../boardroom/protocol.js';
import { CostTracker } from '../cost/tracker.js';
import type { RunContext } from '../provider/collect.js';
import { selectQuestions, forcedChoiceSuffix, type Category, type EvalQuestion } from './corpus.js';
import { extractVote } from './extract.js';
import { scoreQuestion, buildReport, type DivergenceReport, type QuestionScore, type Vote } from './divergence.js';
import {
  buildRotatedSeats, buildControlRotationSeats, rotationAssignment,
  fullRotationCount, isLatinSquare, type RotationSeat,
} from './rotation.js';
import { checkPremise, type PremiseCheck } from './stats.js';

export interface ExperimentOptions {
  category?: Category;
  limit?: number;
  maxTokens?: number;
  /** Vendor seated in all roles for the control arm. */
  control: string;
  /** Independent repetitions of the full rotation sweep. Default 1. */
  trials?: number;
  /** Rotations per trial. Defaults to a full Latin square over the vendors. */
  rotations?: number;
  /** Practical significance floor, in rate points. Default 0.10. */
  threshold?: number;
  ctx?: RunContext;
  onProgress?: (done: number, total: number, label: string) => void;
}

/** One question, in one rotation, in one trial, as seen by one arm. */
export interface CellResult {
  trial: number;
  rotation: number;
  questionId: string;
  score: QuestionScore;
}

export interface ArmResult {
  label: string;
  report: DivergenceReport;
  cells: CellResult[];
  costUsd: number;
}

/** Divergence attributable to a role, pooled across every vendor that held it. */
export interface RoleEffect {
  role: string;
  /** Times a holder of this role landed outside the plurality. */
  minority: number;
  participated: number;
  minorityRate: number;
}

/** Divergence attributable to a vendor, pooled across every role it held. */
export interface VendorEffect {
  vendor: string;
  minority: number;
  participated: number;
  minorityRate: number;
  /** Distinct roles this vendor actually occupied. */
  rolesHeld: number;
}

export interface ExperimentResult {
  treatment: ArmResult;
  control: ArmResult;
  /** Questions scored by BOTH arms in the same trial and rotation. */
  pairedQuestions: number;
  premise: PremiseCheck;
  /** Vendor and role effects, only when the design was actually balanced. */
  vendorEffects: VendorEffect[];
  roleEffects: RoleEffect[];
  /** True when every trial swept a complete Latin square. */
  balanced: boolean;
  trials: number;
  rotations: number;
  totalCostUsd: number;
  /** Per-trial treatment divergence rate, to expose run-to-run variance. */
  perTrialTreatmentRate: number[];
  perTrialControlRate: number[];
}

const cellKey = (c: { trial: number; rotation: number; questionId: string }) =>
  `${c.trial}:${c.rotation}:${c.questionId}`;

async function runArm(
  label: string,
  seatsFor: (rotation: number) => ReturnType<typeof buildRotatedSeats>,
  questions: EvalQuestion[],
  trials: number,
  rotations: number,
  maxTokens: number,
  tracker: CostTracker,
  ctx: RunContext | undefined,
  onCell: (label: string) => void,
): Promise<ArmResult> {
  const cells: CellResult[] = [];
  const allScores: QuestionScore[] = [];
  let costUsd = 0;
  let panelSize = 0;

  for (let trial = 0; trial < trials; trial++) {
    for (let rotation = 0; rotation < rotations; rotation++) {
      const seats = seatsFor(rotation);
      panelSize = seats.length;
      for (const question of questions) {
        const prompt = question.prompt + forcedChoiceSuffix(question);
        const answers = await askPanel(seats, prompt, maxTokens, ctx);

        for (const a of answers) {
          if (!a.error) costUsd += tracker.recordUsage(a.model, a.inputTokens, a.outputTokens).cost;
        }

        const votes: Vote[] = answers.map(a =>
          a.error
            ? { panelist: a.panelist, role: a.role, extract: { status: 'no_match' as const }, error: a.error }
            : { panelist: a.panelist, role: a.role, extract: extractVote(a.text, question) });

        const score = scoreQuestion(question, votes);
        cells.push({ trial, rotation, questionId: question.id, score });
        allScores.push(score);
        onCell(`${label} t${trial + 1}/r${rotation + 1} ${question.id}`);
      }
    }
  }

  return { label, report: buildReport(label, panelSize, allScores), cells, costUsd };
}

/**
 * Pool minority counts by vendor and by role.
 *
 * Only meaningful on a balanced design: pooling by vendor across a rotation
 * sweep averages over every role, and pooling by role averages over every
 * vendor, so each effect is estimated free of the other. On an unbalanced run
 * these would still compute, which is why the caller gates on `balanced`.
 */
function decompose(cells: CellResult[]): { vendorEffects: VendorEffect[]; roleEffects: RoleEffect[] } {
  const vendors = new Map<string, { minority: number; participated: number; roles: Set<string> }>();
  const roles = new Map<string, { minority: number; participated: number }>();

  for (const cell of cells) {
    if (!cell.score.scored) continue;
    for (const vote of cell.score.votes) {
      if (vote.error || vote.extract.status !== 'matched' || !vote.extract.optionId) continue;

      if (!vendors.has(vote.panelist)) vendors.set(vote.panelist, { minority: 0, participated: 0, roles: new Set() });
      if (!roles.has(vote.role)) roles.set(vote.role, { minority: 0, participated: 0 });

      const v = vendors.get(vote.panelist)!;
      const r = roles.get(vote.role)!;
      const outsidePlurality = !cell.score.topOptionIds.includes(vote.extract.optionId);

      v.participated++; r.participated++;
      v.roles.add(vote.role);
      if (outsidePlurality) { v.minority++; r.minority++; }
    }
  }

  return {
    vendorEffects: [...vendors.entries()]
      .map(([vendor, s]) => ({
        vendor, minority: s.minority, participated: s.participated,
        minorityRate: s.participated ? s.minority / s.participated : 0,
        rolesHeld: s.roles.size,
      }))
      .sort((a, b) => b.minorityRate - a.minorityRate),
    roleEffects: [...roles.entries()]
      .map(([role, s]) => ({
        role, minority: s.minority, participated: s.participated,
        minorityRate: s.participated ? s.minority / s.participated : 0,
      }))
      .sort((a, b) => b.minorityRate - a.minorityRate),
  };
}

function rateOf(cells: CellResult[], trial: number): number {
  const scored = cells.filter(c => c.trial === trial && c.score.scored);
  if (scored.length === 0) return 0;
  return scored.filter(c => c.score.divergent).length / scored.length;
}

export async function runExperiment(
  configs: ProviderConfig[],
  opts: ExperimentOptions,
): Promise<ExperimentResult> {
  // 1500, not 512. A reasoning model spends its budget on hidden reasoning
  // before emitting any visible text: measured against real vendors, one model
  // hit finish_reason=length after 1400 output tokens having produced 6425
  // characters of reasoning and ZERO content. At 1500 the same model answers
  // normally. A budget that silently starves a whole class of model does not
  // measure the board, it measures the budget.
  const maxTokens = opts.maxTokens ?? 1500;
  const trials = Math.max(1, opts.trials ?? 1);
  const questions = selectQuestions(opts.category, opts.limit);
  if (questions.length === 0) throw new Error('No questions selected.');

  const controlConfig = configs.find(c => c.name === opts.control);
  if (!controlConfig) {
    throw new Error(
      `Control vendor "${opts.control}" is not available. Detected: ${configs.map(c => c.name).join(', ') || 'none'}`,
    );
  }
  if (configs.length < 2) throw new Error('Need at least 2 vendors to compare arms.');

  const rotations = Math.max(1, opts.rotations ?? fullRotationCount(configs.length));
  const vendorNames = configs.map(c => c.name);

  // Balance is a property of the rotations actually run, not of the intent.
  const sweep: RotationSeat[][] = Array.from({ length: rotations }, (_, r) =>
    rotationAssignment(vendorNames, r));
  const balanced = rotations === fullRotationCount(configs.length) && isLatinSquare(sweep);

  const tracker = opts.ctx?.tracker ?? new CostTracker();
  const ownsTracker = !opts.ctx?.tracker;

  const roleCount = configs.length;
  const totalCells = trials * rotations * questions.length * 2;
  let done = 0;
  const onCell = (label: string) => {
    done++;
    opts.onProgress?.(done, totalCells, label);
  };

  const treatment = await runArm(
    `multi-vendor panel (${configs.length} vendors)`,
    rotation => buildRotatedSeats(configs, ROUND1_BASE, rotation),
    questions, trials, rotations, maxTokens, tracker, opts.ctx, onCell,
  );

  const control = await runArm(
    `single-vendor control (${opts.control})`,
    () => buildControlRotationSeats(controlConfig, ROUND1_BASE, roleCount),
    questions, trials, rotations, maxTokens, tracker, opts.ctx, onCell,
  );

  if (ownsTracker) tracker.flush();

  // Pair on (trial, rotation, question), keeping only cells both arms scored.
  const controlByKey = new Map(control.cells.map(c => [cellKey(c), c]));
  let treatmentDivergent = 0;
  let controlDivergent = 0;
  let treatmentOnly = 0;
  let controlOnly = 0;
  let concordant = 0;
  let pairedQuestions = 0;

  for (const t of treatment.cells) {
    const c = controlByKey.get(cellKey(t));
    if (!c || !t.score.scored || !c.score.scored) continue;
    pairedQuestions++;
    if (t.score.divergent) treatmentDivergent++;
    if (c.score.divergent) controlDivergent++;
    if (t.score.divergent && !c.score.divergent) treatmentOnly++;
    else if (!t.score.divergent && c.score.divergent) controlOnly++;
    else concordant++;
  }

  const premise = checkPremise({
    treatmentDivergent, controlDivergent, pairedQuestions,
    treatmentOnly, controlOnly, concordant,
    threshold: opts.threshold,
  });

  const { vendorEffects, roleEffects } = decompose(treatment.cells);

  return {
    treatment, control, pairedQuestions, premise,
    // A decomposition from an unbalanced sweep would re-confound vendor and
    // role, which is the exact defect rotation exists to remove.
    vendorEffects: balanced ? vendorEffects : [],
    roleEffects: balanced ? roleEffects : [],
    balanced, trials, rotations,
    totalCostUsd: treatment.costUsd + control.costUsd,
    perTrialTreatmentRate: Array.from({ length: trials }, (_, t) => rateOf(treatment.cells, t)),
    perTrialControlRate: Array.from({ length: trials }, (_, t) => rateOf(control.cells, t)),
  };
}
