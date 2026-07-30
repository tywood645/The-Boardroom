import type { ProviderConfig } from '../provider/factory.js';
import { createProvider } from '../provider/factory.js';
import { collectStream } from '../provider/collect.js';
import type { RunContext } from '../provider/collect.js';

export interface Seat {
  config: ProviderConfig;
  role: string;          // display name e.g. "CEO"
  system: string;        // role-specific system prompt
}

export interface PanelistAnswer {
  panelist: string;      // vendor name
  role: string;          // role name
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  error?: string;
}

export async function askPanel(
  seats: Seat[],
  question: string,
  maxTokens = 2048,
  ctx?: RunContext,
): Promise<PanelistAnswer[]> {
  return Promise.all(seats.map(seat => askOne(seat, question, maxTokens, ctx)));
}

async function askOne(
  seat: Seat,
  question: string,
  maxTokens: number,
  ctx?: RunContext,
): Promise<PanelistAnswer> {
  const start = Date.now();
  try {
    const collected = await collectStream(
      createProvider(seat.config),
      {
        system: seat.system,
        messages: [{ role: 'user', content: question }],
        tools: [],
        maxTokens,
        model: seat.config.model,
      },
      ctx,
    );

    return {
      panelist: seat.config.name,
      role: seat.role,
      model: seat.config.model,
      text: collected.text,
      inputTokens: collected.inputTokens,
      outputTokens: collected.outputTokens,
      cost: collected.cost,
      durationMs: collected.durationMs,
    };
  } catch (e: any) {
    return {
      panelist: seat.config.name,
      role: seat.role,
      model: seat.config.model,
      text: '',
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      durationMs: Date.now() - start,
      error: e?.message || String(e),
    };
  }
}
