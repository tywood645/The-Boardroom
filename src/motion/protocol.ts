import { randomBytes } from 'node:crypto';
import type { ProviderConfig } from '../provider/factory.js';
import { collectStructured, parseStructured, jsonInstruction, type Shape } from '../provider/structured.js';
import type { RunContext } from '../provider/collect.js';
import { roleForVendor } from '../boardroom/roles.js';
import { consultBriefing, briefingBlock } from '../boardroom/consultant.js';
import { quoteUntrusted, QUOTED_NOTE } from '../util/sanitize.js';
import type { ConsultantBriefing } from '../boardroom/consultant.js';
import { parseChoice, parseLine } from '../util/fields.js';
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
  return briefingBlock(briefing, 'CONSULTANT BRIEFING (current research):');
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

  // A motion is decided by the board, not by whichever seats happened to
  // answer. An advisor whose call failed (vendor error, budget block,
  // deadline) is absent, and without a majority of the seated board present
  // there is no decision to record: not "died", not "passed 1-0".
  const seated = configs.length;
  const quorumNeeded = Math.floor(seated / 2) + 1;
  const stopped = (
    outcome: MotionResult['outcome'],
    quorum?: MotionResult['quorum'],
  ): MotionResult => ({
    id,
    motion,
    mover: 'the founder',
    startedAt,
    briefing,
    seconds,
    debate: [],
    votes: [],
    tally: { aye: 0, nay: 0, abstain: 0 },
    outcome,
    ...(quorum ? { quorum } : {}),
  });

  const presentForSecond = seconds.filter(s => !s.error).length;
  if (presentForSecond < quorumNeeded) {
    return stopped('no_quorum', { phase: 'second', present: presentForSecond, needed: quorumNeeded, seated });
  }
  if (validSeconds < SECOND_THRESHOLD) return stopped('died_for_lack_of_second');

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
  const presentForVote = votes.filter(v => !v.error).length;
  let outcome: MotionResult['outcome'];
  if (presentForVote < quorumNeeded) outcome = 'no_quorum';
  else if (tally.aye > tally.nay) outcome = 'passed';
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
    ...(outcome === 'no_quorum'
      ? { quorum: { phase: 'vote' as const, present: presentForVote, needed: quorumNeeded, seated } }
      : {}),
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
    `This is the SECOND phase. You are NOT voting on the merits of the motion, you are voting only on whether this motion is worth the board's time to debate. Even if you personally disagree with the motion, you should second it if it raises a real question worth resolving.\n\n`;
  const prompt = (structured: boolean) =>
    userPrompt +
    (structured
      ? jsonInstruction(SECOND_SHAPE, 'one sentence')
      : `Reply in this EXACT format (no markdown, no preamble):\n` +
        `SECOND: yes\n` +
        `REASON: <one sentence>\n\n` +
        `OR:\n` +
        `SECOND: no\n` +
        `REASON: <one sentence>`);

  const results = await Promise.all(
    configs.map(async (cfg): Promise<SecondVote> => {
      const role = roleForVendor(cfg.name);
      if (!role) {
        return makeErrorSecond(cfg, 'no role assigned');
      }
      const system = systemFor(role.name, role.mindset);
      try {
        const result = await callAndCollect(cfg, system, prompt, maxTokens, SECOND_SHAPE, ctx);
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

/** The REASON line, bounded. Never multi-line, so it cannot carry a payload past itself. */
function parseReason(cleaned: string): string {
  return parseLine(cleaned, 'REASON', MAX_REASON_CHARS) ?? cleaned.split('\n')[0].trim().slice(0, MAX_REASON_CHARS);
}

// Each parser below reads its field with parseChoice (util/fields.ts): the
// field must start a line, must not be the format line echoed back, and must
// not contradict itself. Anything else falls to the safe default.

//
// Each first tries the reply as the phase's JSON object (provider/structured.ts),
// which is what a vendor asked for structured output returns. The same bounds
// apply to text from either form.

export const SECOND_SHAPE: Shape = { name: 'second_motion', choiceKey: 'second', choices: ['yes', 'no'], textKey: 'reason' };
export const DEBATE_SHAPE: Shape = {
  name: 'debate_stance', choiceKey: 'stance', choices: ['SUPPORT', 'OPPOSE', 'UNDECIDED'], textKey: 'case',
};
export const VOTE_SHAPE: Shape = { name: 'cast_vote', choiceKey: 'vote', choices: ['AYE', 'NAY', 'ABSTAIN'], textKey: 'reason' };

/** A reason from a JSON reply: one line, bounded, like one read from a REASON line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS);
}

export function parseSecond(text: string): { seconded: boolean; reason: string } {
  const cleaned = text.trim();
  const json = parseStructured(cleaned, SECOND_SHAPE);
  if (json) return { seconded: json.choice === 'yes', reason: oneLine(json.text) };
  return { seconded: parseChoice(cleaned, 'SECOND', ['yes', 'no']) === 'yes', reason: parseReason(cleaned) };
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
    `This is the DEBATE phase. Take a CLEAR stance on the motion and argue your case from your role's perspective. No hedging. No "on one hand / on the other hand." Pick a side or explicitly state UNDECIDED.\n\n`;
  const prompt = (structured: boolean) =>
    userPrompt +
    (structured
      ? jsonInstruction(DEBATE_SHAPE, '2-4 sentences arguing your position. Hard limit 150 words.')
      : `Reply in this EXACT format (no markdown, no preamble):\n` +
        `STANCE: SUPPORT | OPPOSE | UNDECIDED\n` +
        `CASE: <2-4 sentences arguing your position. Hard limit 150 words.>`);

  return Promise.all(
    configs.map(async (cfg): Promise<DebateSpeech> => {
      const role = roleForVendor(cfg.name);
      if (!role) return makeErrorDebate(cfg, 'no role assigned');
      const system = systemFor(role.name, role.mindset);
      try {
        const result = await callAndCollect(cfg, system, prompt, maxTokens, DEBATE_SHAPE, ctx);
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

/** The format asks for 150 words; this is several times that. */
const MAX_CASE_CHARS = 2000;

export function parseDebate(text: string): { stance: Stance; case: string } {
  const cleaned = text.trim();
  const json = parseStructured(cleaned, DEBATE_SHAPE);
  if (json) return { stance: json.choice as Stance, case: json.text.trim().slice(0, MAX_CASE_CHARS) };
  const stance: Stance = parseChoice(cleaned, 'STANCE', ['SUPPORT', 'OPPOSE', 'UNDECIDED']) ?? 'UNDECIDED';
  // Everything after the last line-leading "CASE:"; the last, so an echoed
  // format line is not taken for the argument.
  const starts = [...cleaned.matchAll(/^[ \t>*#_\-]*CASE\**[ \t]*:\**[ \t]*/gim)];
  const last = starts[starts.length - 1];
  const caseText = last ? cleaned.slice(last.index! + last[0].length).trim() : cleaned;
  return { stance, case: caseText.slice(0, MAX_CASE_CHARS) };
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
    .map(d => `### ${d.role} (${d.panelist}): ${d.stance}\n${quoteUntrusted(d.case, MAX_CASE_CHARS)}`)
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
        `DEBATE TRANSCRIPT (all advisors, including your own ${myStance} stance):\n${QUOTED_NOTE}\n\n${debateBlock}\n\n` +
        `This is the FINAL VOTE. Cast your ballot AS THE ${role.name}. You may flip your stance from the debate if other advisors' arguments have persuaded you, that is the entire point of debate. If you flip, say so explicitly.\n\n`;
      const prompt = (structured: boolean) =>
        userPrompt +
        (structured
          ? jsonInstruction(VOTE_SHAPE, "one sentence in your role's voice")
          : `Reply in this EXACT format (no markdown, no preamble):\n` +
            `VOTE: AYE | NAY | ABSTAIN\n` +
            `REASON: <one sentence in your role's voice>`);

      try {
        const result = await callAndCollect(cfg, system, prompt, maxTokens, VOTE_SHAPE, ctx);
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

export function parseVote(text: string): { vote: Vote; reason: string } {
  const cleaned = text.trim();
  const json = parseStructured(cleaned, VOTE_SHAPE);
  if (json) return { vote: json.choice as Vote, reason: oneLine(json.text) };
  const vote: Vote = parseChoice(cleaned, 'VOTE', ['AYE', 'NAY', 'ABSTAIN']) ?? 'ABSTAIN';
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

/**
 * One phase call. The reply is asked for as a JSON object where the vendor
 * supports that, and in the line format otherwise (provider/structured.ts
 * decides, and falls back by itself if a vendor refuses).
 */
async function callAndCollect(
  cfg: ProviderConfig,
  system: string,
  prompt: (structured: boolean) => string,
  maxTokens: number,
  shape: Shape,
  ctx?: RunContext,
) {
  return collectStructured(cfg, { system, prompt, maxTokens, shape }, ctx);
}
