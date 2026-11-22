import { randomBytes } from 'node:crypto';
import type { ProviderConfig } from '../provider/factory.js';
import { createProvider } from '../provider/factory.js';
import { collectStream } from '../provider/collect.js';
import type { RunContext } from '../provider/collect.js';
import { roleForVendor } from '../boardroom/roles.js';
import { consultBriefing } from '../boardroom/consultant.js';
import type { ConsultantBriefing } from '../boardroom/consultant.js';
import type {
  SecondVote,
  DebateSpeech,
  FinalVote,
  Stance,
  Vote,
  MotionResult,
} from './types.js';

export interface MotionOptions {
  consultant?: boolean;
  maxTokens?: number;
  recall?: string | null;       // PRIOR BOARD CONTEXT block prepended to every phase
  ctx?: RunContext;             // budget gate, concurrency cap and deadline
}

/** Every phase prefixes the same briefing block. */
function briefingBlockOf(briefing: ConsultantBriefing | null): string {
  return briefing
    ? `CONSULTANT BRIEFING (current research):\n${briefing.text}\n\n--- end briefing ---\n\n`
    : '';
}

/** Every advisor gets the same role preamble in every phase. */
function systemFor(roleName: string, mindset: string): string {
  return `You are the ${roleName} on a small advisory board. Stay in role.\n\n${mindset}`;
}

const SECOND_THRESHOLD = 2;     // need at least 2 seconds to proceed
const DEFAULT_MAX_TOKENS = 600;

export async function runMotion(
  configs: ProviderConfig[],
  motion: string,
  opts: MotionOptions = {},
): Promise<MotionResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const consultantEnabled = opts.consultant !== false;
  const recall = opts.recall || null;
  const startedAt = new Date().toISOString();
  // Minute resolution let two motions share an id, and the second's minutes
  // replaced the first's. Seconds plus a random suffix cannot collide in practice.
  const id = `${startedAt.slice(0, 19).replace(/[T:]/g, '-')}-${randomBytes(2).toString('hex')}`;

  // Phase 1: Consultant briefing. Recall is also given to the consultant so
  // its research call is grounded in what the board has already settled.
  const consultant = configs.find(c => c.name === 'perplexity');
  const consultantInput = recall ? `${recall}MOTION:\n${motion}` : motion;
  const briefing =
    consultantEnabled && consultant
      ? await consultBriefing(consultant, consultantInput, undefined, opts.ctx)
      : null;

  // Phase 2: SECOND
  const seconds = await runSecondPhase(configs, motion, briefing, maxTokens, recall, opts.ctx);
  const validSeconds = seconds.filter(s => !s.error && s.seconded).length;

  if (validSeconds < SECOND_THRESHOLD) {
    return {
      id,
      motion,
      mover: 'the founder',
      startedAt,
      briefing,
      seconds,
      debate: [],
      votes: [],
      tally: { aye: 0, nay: 0, abstain: 0 },
      outcome: 'died_for_lack_of_second',
    };
  }

  // Phase 3: DEBATE
  const debate = await runDebatePhase(configs, motion, briefing, seconds, maxTokens, recall, opts.ctx);

  // Phase 4: VOTE
  const votes = await runVotePhase(configs, motion, briefing, debate, maxTokens, recall, opts.ctx);

  // Tally
  const tally = {
    aye: votes.filter(v => !v.error && v.vote === 'AYE').length,
    nay: votes.filter(v => !v.error && v.vote === 'NAY').length,
    abstain: votes.filter(v => !v.error && v.vote === 'ABSTAIN').length,
  };
  let outcome: MotionResult['outcome'];
  if (tally.aye > tally.nay) outcome = 'passed';
  else if (tally.nay > tally.aye) outcome = 'failed';
  else outcome = 'tied';

  return {
    id,
    motion,
    mover: 'the founder',
    startedAt,
    briefing,
    seconds,
    debate,
    votes,
    tally,
    outcome,
  };
}

// ---------------------------------------------------------------------------
// PHASE 2: SECOND
// ---------------------------------------------------------------------------

async function runSecondPhase(
  configs: ProviderConfig[],
  motion: string,
  briefing: ConsultantBriefing | null,
  maxTokens: number,
  recall: string | null,
  ctx?: RunContext,
): Promise<SecondVote[]> {
  const briefingBlock = briefingBlockOf(briefing);

  const userPrompt =
    (recall || '') +
    briefingBlock +
    `MOTION BEFORE THE BOARD:\n"${motion}"\n\n` +
    `This is the SECOND phase. You are NOT voting on the merits of the motion, you are voting only on whether this motion is worth the board's time to debate. Even if you personally disagree with the motion, you should second it if it raises a real question worth resolving.\n\n` +
    `Reply in this EXACT format (no markdown, no preamble):\n` +
    `SECOND: yes\n` +
    `REASON: <one sentence>\n\n` +
    `OR:\n` +
    `SECOND: no\n` +
    `REASON: <one sentence>`;

  const results = await Promise.all(
    configs.map(async (cfg): Promise<SecondVote> => {
      const role = roleForVendor(cfg.name);
      if (!role) {
        return makeErrorSecond(cfg, 'no role assigned');
      }
      const system = systemFor(role.name, role.mindset);
      try {
        const result = await callAndCollect(cfg, system, userPrompt, maxTokens, ctx);
        const parsed = parseSecond(result.text);
        return {
          panelist: cfg.name,
          role: role.name,
          model: cfg.model,
          seconded: parsed.seconded,
          reason: parsed.reason,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: result.cost,
          durationMs: result.durationMs,
        };
      } catch (e: any) {
        return makeErrorSecond(cfg, e?.message || String(e));
      }
    }),
  );
  return results;
}

/** The format asks for one sentence; anything past the first line or this length is not a reason. */
const MAX_REASON_CHARS = 300;

/** First line after "REASON:", bounded. Never multi-line, so it cannot carry a payload past itself. */
function parseReason(cleaned: string): string {
  const m = cleaned.match(/REASON:[ \t]*([^\n]*)/i);
  const reason = m && m[1].trim() ? m[1].trim() : cleaned.split('\n')[0].trim();
  return reason.slice(0, MAX_REASON_CHARS);
}

function parseSecond(text: string): { seconded: boolean; reason: string } {
  const cleaned = text.trim();
  const secondMatch = cleaned.match(/SECOND:\s*(yes|no)/i);
  const seconded = secondMatch ? secondMatch[1].toLowerCase() === 'yes' : false;
  return { seconded, reason: parseReason(cleaned) };
}

function makeErrorSecond(cfg: ProviderConfig, error: string): SecondVote {
  const role = roleForVendor(cfg.name);
  return {
    panelist: cfg.name,
    role: role?.name || '?',
    model: cfg.model,
    seconded: false,
    reason: '',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// PHASE 3: DEBATE
// ---------------------------------------------------------------------------

async function runDebatePhase(
  configs: ProviderConfig[],
  motion: string,
  briefing: ConsultantBriefing | null,
  seconds: SecondVote[],
  maxTokens: number,
  recall: string | null,
  ctx?: RunContext,
): Promise<DebateSpeech[]> {
  const briefingBlock = briefingBlockOf(briefing);

  const secondedBy = seconds.filter(s => s.seconded && !s.error).map(s => s.role).join(', ');

  const userPrompt =
    (recall || '') +
    briefingBlock +
    `MOTION BEFORE THE BOARD:\n"${motion}"\n\n` +
    `The motion was seconded by: ${secondedBy || '(none)'}\n\n` +
    `This is the DEBATE phase. Take a CLEAR stance on the motion and argue your case from your role's perspective. No hedging. No "on one hand / on the other hand." Pick a side or explicitly state UNDECIDED.\n\n` +
    `Reply in this EXACT format (no markdown, no preamble):\n` +
    `STANCE: SUPPORT | OPPOSE | UNDECIDED\n` +
    `CASE: <2-4 sentences arguing your position. Hard limit 150 words.>`;

  return Promise.all(
    configs.map(async (cfg): Promise<DebateSpeech> => {
      const role = roleForVendor(cfg.name);
      if (!role) return makeErrorDebate(cfg, 'no role assigned');
      const system = systemFor(role.name, role.mindset);
      try {
        const result = await callAndCollect(cfg, system, userPrompt, maxTokens, ctx);
        const parsed = parseDebate(result.text);
        return {
          panelist: cfg.name,
          role: role.name,
          model: cfg.model,
          stance: parsed.stance,
          case: parsed.case,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: result.cost,
          durationMs: result.durationMs,
        };
      } catch (e: any) {
        return makeErrorDebate(cfg, e?.message || String(e));
      }
    }),
  );
}

function parseDebate(text: string): { stance: Stance; case: string } {
  const cleaned = text.trim();
  const stanceMatch = cleaned.match(/STANCE:\s*(SUPPORT|OPPOSE|UNDECIDED)/i);
  const caseMatch = cleaned.match(/CASE:\s*([\s\S]+)$/i);
  const stance = (stanceMatch ? stanceMatch[1].toUpperCase() : 'UNDECIDED') as Stance;
  const caseText = caseMatch ? caseMatch[1].trim() : cleaned;
  return { stance, case: caseText };
}

function makeErrorDebate(cfg: ProviderConfig, error: string): DebateSpeech {
  const role = roleForVendor(cfg.name);
  return {
    panelist: cfg.name,
    role: role?.name || '?',
    model: cfg.model,
    stance: 'UNDECIDED',
    case: '',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// PHASE 4: VOTE
// ---------------------------------------------------------------------------

async function runVotePhase(
  configs: ProviderConfig[],
  motion: string,
  briefing: ConsultantBriefing | null,
  debate: DebateSpeech[],
  maxTokens: number,
  recall: string | null,
  ctx?: RunContext,
): Promise<FinalVote[]> {
  const briefingBlock = briefingBlockOf(briefing);
  const recallBlock = recall || '';

  const debateBlock = debate
    .filter(d => !d.error && d.case)
    .map(d => `### ${d.role} (${d.panelist}): ${d.stance}\n${d.case}`)
    .join('\n\n');

  return Promise.all(
    configs.map(async (cfg): Promise<FinalVote> => {
      const role = roleForVendor(cfg.name);
      if (!role) return makeErrorVote(cfg, 'no role assigned', 'UNDECIDED');
      const myDebate = debate.find(d => d.panelist === cfg.name);
      const myStance: Stance = myDebate?.stance || 'UNDECIDED';

      const system = systemFor(role.name, role.mindset);
      const userPrompt =
        recallBlock +
        briefingBlock +
        `MOTION BEFORE THE BOARD:\n"${motion}"\n\n` +
        `DEBATE TRANSCRIPT (all advisors, including your own ${myStance} stance):\n\n${debateBlock}\n\n` +
        `This is the FINAL VOTE. Cast your ballot AS THE ${role.name}. You may flip your stance from the debate if other advisors' arguments have persuaded you, that is the entire point of debate. If you flip, say so explicitly.\n\n` +
        `Reply in this EXACT format (no markdown, no preamble):\n` +
        `VOTE: AYE | NAY | ABSTAIN\n` +
        `REASON: <one sentence in your role's voice>`;

      try {
        const result = await callAndCollect(cfg, system, userPrompt, maxTokens, ctx);
        const parsed = parseVote(result.text);
        const flipped = stanceVsVote(myStance, parsed.vote);
        return {
          panelist: cfg.name,
          role: role.name,
          model: cfg.model,
          vote: parsed.vote,
          reason: parsed.reason,
          flipped,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cost: result.cost,
          durationMs: result.durationMs,
        };
      } catch (e: any) {
        return makeErrorVote(cfg, e?.message || String(e), myStance);
      }
    }),
  );
}

function parseVote(text: string): { vote: Vote; reason: string } {
  const cleaned = text.trim();
  const voteMatch = cleaned.match(/VOTE:\s*(AYE|NAY|ABSTAIN)/i);
  const vote = (voteMatch ? voteMatch[1].toUpperCase() : 'ABSTAIN') as Vote;
  return { vote, reason: parseReason(cleaned) };
}

function stanceVsVote(stance: Stance, vote: Vote): boolean {
  // A flip is voting the opposite of your debate stance. Abstaining is not a flip.
  if (stance === 'SUPPORT' && vote === 'NAY') return true;
  if (stance === 'OPPOSE' && vote === 'AYE') return true;
  return false;
}

function makeErrorVote(cfg: ProviderConfig, error: string, stance: Stance): FinalVote {
  const role = roleForVendor(cfg.name);
  return {
    panelist: cfg.name,
    role: role?.name || '?',
    model: cfg.model,
    vote: 'ABSTAIN',
    reason: '',
    flipped: false,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    durationMs: 0,
    error,
  };
}

// ---------------------------------------------------------------------------
// Provider call helper
// ---------------------------------------------------------------------------

async function callAndCollect(
  cfg: ProviderConfig,
  system: string,
  userPrompt: string,
  maxTokens: number,
  ctx?: RunContext,
) {
  return collectStream(
    createProvider(cfg),
    {
      system,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [],
      maxTokens,
      model: cfg.model,
    },
    ctx,
  );
}
