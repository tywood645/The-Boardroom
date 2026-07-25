import type { ProviderConfig } from '../provider/factory.js';
import { askPanel, PanelistAnswer, Seat } from './panel.js';
import { roleForVendor, ROLES } from './roles.js';
import { consultBriefing, applyBriefing, ConsultantBriefing } from './consultant.js';
import type { RunContext } from '../provider/collect.js';

export interface BoardroomResult {
  question: string;
  briefing: ConsultantBriefing | null;
  round1: PanelistAnswer[];
  round2?: PanelistAnswer[];
}

const ROUND1_BASE = `You are a member of a small advisory board for a solo founder. You have a specific role on this board (described below). Stay strictly in that role, do not pretend to be a generalist.

ANSWER FORMAT:
- First sentence: your recommendation, in plain language. No markdown headers.
- Next 2-4 sentences: reasoning FROM YOUR ROLE'S POINT OF VIEW.
- Final sentence: the strongest counterargument to your own position.
- Hard limit: 220 words total.

DO NOT hedge to please the founder. Disagreement is more valuable than safe consensus. The other advisors will cover the angles your role does not care about, so do not try to cover everything yourself.

YOUR ROLE:
`;

const ROUND2_BASE = `You are a member of an advisory board reviewing the other advisors' independent answers to a question you already answered. Each advisor wears a different hat (CEO, COO, CFO, CTO, CMO, Devil's Advocate).

YOUR TASK:
- Identify where you disagree with the other advisors and why, speaking strictly from YOUR role's perspective.
- If another advisor's reasoning has changed your mind, say so explicitly and explain what convinced you.
- If you still hold your original position, defend it concisely against the strongest opposing point.
- Hard limit: 180 words.

YOUR ROLE:
`;

export interface BoardroomOptions {
  rounds: 1 | 2;
  maxTokens?: number;
  consultant?: boolean;     // default true; false to skip the Consultant briefing entirely
  recall?: string | null;   // PRIOR BOARD CONTEXT block to prepend to the question
  ctx?: RunContext;         // budget gate, concurrency cap and deadline
}

export function buildSeats(configs: ProviderConfig[], roundBase: string): Seat[] {
  return configs
    .map(cfg => {
      const role = roleForVendor(cfg.name);
      if (!role) return null;
      return {
        config: cfg,
        role: role.name,
        system: roundBase + role.mindset,
      };
    })
    .filter((s): s is Seat => s !== null);
}

export async function runBoardroom(
  configs: ProviderConfig[],
  question: string,
  opts: BoardroomOptions = { rounds: 1 },
): Promise<BoardroomResult> {
  const maxTokens = opts.maxTokens ?? 1024;
  const consultantEnabled = opts.consultant !== false;

  // Step 1: Consultant briefing (typically Perplexity, web-grounded).
  // The briefing gives every advisor current real-world context so judgment
  // disagreements are about judgment, not stale training data.
  // Skipped entirely if --no-consultant is set, isolating vendor priors.
  const consultant = configs.find(c => c.name === 'perplexity');
  const briefing =
    consultantEnabled && consultant
      ? await consultBriefing(consultant, question, undefined, opts.ctx)
      : null;

  // Step 2: build the briefing-augmented question that every advisor will see.
  // Recall (institutional memory) prefixes everything so advisors read prior
  // context first, then the consultant briefing, then the actual question.
  const briefingAugmented = applyBriefing(question, briefing);
  const augmentedQuestion = opts.recall ? `${opts.recall}${briefingAugmented}` : briefingAugmented;

  // Step 3: round 1, sealed-bid independent answers.
  const round1Seats = buildSeats(configs, ROUND1_BASE);
  if (round1Seats.length === 0) {
    throw new Error('No seats could be assigned. Check provider names match DEFAULT_ASSIGNMENT in roles.ts.');
  }

  const round1 = await askPanel(round1Seats, augmentedQuestion, maxTokens, opts.ctx);
  const result: BoardroomResult = { question, briefing, round1 };

  // Step 4: optional round 2, cross-examination.
  if (opts.rounds >= 2) {
    const compiled = formatPanelForReview(round1);
    const round2Question =
      (opts.recall || '') +
      (briefing
        ? `RESEARCH BRIEFING (still current):\n${briefing.text}\n\n--- end briefing ---\n\n`
        : '') +
      `ORIGINAL QUESTION:\n${question}\n\n` +
      `INDEPENDENT ANSWERS FROM YOUR FELLOW ADVISORS (sealed-bid, no advisor saw any other answer before responding):\n\n${compiled}\n\n` +
      `Where do you disagree, and why? Stay in your role.`;

    const round2Seats = buildSeats(configs, ROUND2_BASE);
    result.round2 = await askPanel(round2Seats, round2Question, maxTokens, opts.ctx);
  }

  return result;
}

function formatPanelForReview(answers: PanelistAnswer[]): string {
  return answers
    .filter(a => !a.error && a.text.length > 0)
    .map(a => `### ${a.role} (${a.panelist})\n${a.text}`)
    .join('\n\n');
}

export function describeAssignment(configs: ProviderConfig[]): string {
  return configs
    .map(cfg => {
      const role = roleForVendor(cfg.name);
      return role ? `${role.name}=${cfg.name}` : `??=${cfg.name}`;
    })
    .join(', ');
}

export { ROLES };
