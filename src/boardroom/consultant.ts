import type { ProviderConfig } from '../provider/factory.js';
import { createProvider } from '../provider/factory.js';
import { collectStream } from '../provider/collect.js';
import type { RunContext } from '../provider/collect.js';
import { quoteUntrusted, QUOTED_NOTE } from '../util/sanitize.js';

export interface ConsultantBriefing {
  text: string;
  source: string;          // vendor name that produced it (typically perplexity)
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
}

const CONSULTANT_SYSTEM =
  `You are the Consultant for a small advisory board. The board is about to discuss the question below and they need current, real-world context to make a good decision. Your job is research, not opinion.

YOUR JOB:
1. Search for the most recent and relevant facts that bear on this question.
2. Surface concrete numbers, recent events (last 6-12 months especially), competitor moves, market data, and pricing.
3. Flag any "common knowledge" that has CHANGED recently, places where an LLM trained a year ago would be wrong today.
4. Be terse. The board reads many briefings. Hard limit: 250 words.

OUTPUT FORMAT:
A numbered list of 4-8 facts. Each fact should be one or two sentences. Include dates when relevant.
Do NOT give opinions, recommendations, or framing. That is the board's job, not yours.
Do NOT restate the question.`;

export async function consultBriefing(
  consultantConfig: ProviderConfig,
  question: string,
  maxTokens = 600,
  ctx?: RunContext,
): Promise<ConsultantBriefing | null> {
  try {
    const collected = await collectStream(
      createProvider(consultantConfig),
      {
        system: CONSULTANT_SYSTEM,
        messages: [{ role: 'user', content: question }],
        tools: [],
        maxTokens,
        model: consultantConfig.model,
      },
      ctx,
    );

    if (!collected.text) return null;
    return {
      text: collected.text,
      source: consultantConfig.name,
      model: consultantConfig.model,
      inputTokens: collected.inputTokens,
      outputTokens: collected.outputTokens,
      cost: collected.cost,
      durationMs: collected.durationMs,
    };
  } catch {
    return null;
  }
}

/** Upper bound on briefing text quoted into advisor prompts. The consultant is asked for 250 words. */
const MAX_BRIEFING_CHARS = 6000;

/**
 * The briefing as a block for an advisor's prompt. Its text comes from a model
 * summarising web pages, so it is quoted line by line (see quoteUntrusted) and
 * cannot close the block or pose as the question that follows it.
 */
export function briefingBlock(briefing: ConsultantBriefing | null, heading: string): string {
  if (!briefing) return '';
  return `${heading}\n${QUOTED_NOTE}\n${quoteUntrusted(briefing.text, MAX_BRIEFING_CHARS)}\n\n--- end briefing ---\n\n`;
}

export function applyBriefing(question: string, briefing: ConsultantBriefing | null): string {
  if (!briefing) return question;
  return (
    briefingBlock(briefing, `CONSULTANT BRIEFING (current, prepared by the board's consultant via web search):`) +
    `QUESTION:\n${question}`
  );
}
