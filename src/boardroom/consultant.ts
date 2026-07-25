import type { ProviderConfig } from '../provider/factory.js';
import { createProvider } from '../provider/factory.js';
import { collectStream } from '../provider/collect.js';
import type { CostTracker } from '../cost/tracker.js';

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
  tracker?: CostTracker,
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
      { tracker },
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

export function applyBriefing(question: string, briefing: ConsultantBriefing | null): string {
  if (!briefing) return question;
  return (
    `CONSULTANT BRIEFING (current, prepared by the board's consultant via web search):\n` +
    `${briefing.text}\n\n` +
    `--- end briefing ---\n\n` +
    `QUESTION:\n${question}`
  );
}
