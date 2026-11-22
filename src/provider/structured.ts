import type { ProviderConfig } from './factory.js';
import { createProvider } from './factory.js';
import { collectStream, type Collected, type RunContext } from './collect.js';
import type { ResponseFormat, StructuredMode } from './types.js';
import { BoardRoomError, ProviderError } from '../util/error.js';
import { logger } from '../util/logger.js';

/**
 * Structured replies for the protocol's small, fixed-shape answers.
 *
 * A vote, a stance, a second and a verdict are each one choice from a short
 * list plus one piece of text. They used to be read out of free text
 * (`VOTE: AYE`), which is where misreads came from. Where a vendor can be made
 * to return a JSON object of a given shape, it is asked to; the reply is then
 * validated against the list of choices, and anything that does not validate
 * falls back to the strict line parser (util/fields.ts). Nothing here can make
 * a reply count that the line parser would have refused: an unreadable reply
 * is still an abstention.
 *
 * Vendor support was taken from each vendor's public documentation, not from
 * live calls. So every structured request is guarded: a vendor that rejects
 * one is retried in the plain line format and not asked again in this run.
 */

/** One choice from a fixed list, plus one free-text field. */
export interface Shape {
  /** Schema or tool name: letters, digits and underscores. */
  name: string;
  choiceKey: string;
  choices: readonly string[];
  textKey: string;
}

export function schemaFor(shape: Shape): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      [shape.choiceKey]: { type: 'string', enum: [...shape.choices] },
      [shape.textKey]: { type: 'string' },
    },
    required: [shape.choiceKey, shape.textKey],
    additionalProperties: false,
  };
}

/**
 * What each vendor's API is documented to accept.
 *  - anthropic: forced tool call.
 *  - openai, xai: JSON Schema with `strict`.
 *  - google, perplexity: JSON Schema; their examples do not use `strict`.
 *  - deepseek: JSON mode only on chat completions; the shape goes in the prompt.
 */
const BY_VENDOR: Record<string, { mode: StructuredMode; strict?: boolean }> = {
  anthropic: { mode: 'tool' },
  openai: { mode: 'json_schema', strict: true },
  xai: { mode: 'json_schema', strict: true },
  google: { mode: 'json_schema' },
  perplexity: { mode: 'json_schema' },
  deepseek: { mode: 'json_object' },
};

/** Vendors that rejected a structured request in this process. Not asked again. */
const refused = new Set<string>();
const keyOf = (c: ProviderConfig) => `${c.name}|${c.baseUrl ?? ''}`;

/** For tests: forget which vendors refused. */
export function resetStructuredRefusals(): void {
  refused.clear();
}

/** BOARDROOM_STRUCTURED: "auto" (default) or "off". Anything else is an error. */
export function structuredEnabled(raw: string | undefined = undefined): boolean {
  const v = (raw ?? process.env.BOARDROOM_STRUCTURED ?? 'auto').trim().toLowerCase();
  if (v === 'auto' || v === '') return true;
  if (v === 'off') return false;
  throw new BoardRoomError(`BOARDROOM_STRUCTURED must be "auto" or "off", got "${raw ?? process.env.BOARDROOM_STRUCTURED}"`, 'INVALID_ARGUMENT');
}

/**
 * How to ask this seat for structured output, or null to use the line format.
 *
 * Only per-vendor keys are covered. Through OpenRouter or Ollama the model
 * behind a seat is whatever the user configured, with unknown support, so
 * those backends stay on the line format.
 */
export function structuredFormat(config: ProviderConfig, shape: Shape): ResponseFormat | null {
  if (!structuredEnabled()) return null;
  if (config.backend && config.backend !== 'keys') return null;
  if (refused.has(keyOf(config))) return null;
  const entry = BY_VENDOR[config.name];
  if (!entry) return null;
  // The tool form is Anthropic's API; the others are OpenAI-compatible fields.
  if ((entry.mode === 'tool') !== (config.type === 'anthropic')) return null;
  return { mode: entry.mode, name: shape.name, schema: schemaFor(shape), ...(entry.strict ? { strict: true } : {}) };
}

/** Statuses that mean "this request shape is not accepted", as opposed to auth, rate or server trouble. */
const UNSUPPORTED = new Set([400, 404, 415, 422, 501]);

export interface StructuredCall {
  /** The system prompt, fixed or depending on which reply format is asked for. */
  system: string | ((structured: boolean) => string);
  /** The user prompt. `structured` says which reply format to ask for. */
  prompt: (structured: boolean) => string;
  maxTokens: number;
  shape: Shape;
}

/**
 * One provider call, structured where the vendor supports it.
 *
 * If the vendor rejects the structured request outright, the call is made
 * again in the line format and the vendor is remembered as not supporting it.
 * A rejected request is not billed, and collectStream releases its budget
 * hold, so the retry costs nothing extra.
 */
export async function collectStructured(
  config: ProviderConfig,
  call: StructuredCall,
  ctx: RunContext = {},
): Promise<Collected & { structured: boolean }> {
  const run = (responseFormat: ResponseFormat | null) =>
    collectStream(
      createProvider(config),
      {
        system: typeof call.system === 'function' ? call.system(responseFormat !== null) : call.system,
        messages: [{ role: 'user', content: call.prompt(responseFormat !== null) }],
        tools: [],
        maxTokens: call.maxTokens,
        model: config.model,
        ...(responseFormat ? { responseFormat } : {}),
      },
      ctx,
    );

  const format = structuredFormat(config, call.shape);
  if (!format) return { ...(await run(null)), structured: false };

  try {
    return { ...(await run(format)), structured: true };
  } catch (e) {
    if (!(e instanceof ProviderError) || e.statusCode === undefined || !UNSUPPORTED.has(e.statusCode)) throw e;
    refused.add(keyOf(config));
    logger.warn(
      `${config.name} rejected a structured-output request (HTTP ${e.statusCode}); ` +
        `using the plain reply format for it from here on.`,
    );
    return { ...(await run(null)), structured: false };
  }
}

/** The first JSON object in a reply, tolerating a reasoning preamble and a code fence. */
function extractObject(text: string): Record<string, unknown> | null {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(candidate);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  const whole = tryParse(s);
  if (whole) return whole;
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  return open !== -1 && close > open ? tryParse(s.slice(open, close + 1)) : null;
}

/**
 * Read a reply as the shape's JSON object. Null unless the choice is exactly
 * one of the allowed values (case aside); the caller then tries the line
 * format. An echoed template such as `{"vote": "<AYE, NAY or ABSTAIN>"}` is
 * valid JSON but not a valid choice, so it is refused here.
 */
export function parseStructured(text: string, shape: Shape): { choice: string; text: string } | null {
  const obj = extractObject(text);
  if (!obj) return null;
  const raw = obj[shape.choiceKey];
  if (typeof raw !== 'string') return null;
  const choice = shape.choices.find(c => c.toLowerCase() === raw.trim().toLowerCase());
  if (!choice) return null;
  const body = obj[shape.textKey];
  return { choice, text: typeof body === 'string' ? body : '' };
}

/** The reply-format paragraph for a structured prompt. */
export function jsonInstruction(shape: Shape, textHint: string): string {
  return (
    `Reply with a single JSON object and nothing else, in this form:\n` +
    `{"${shape.choiceKey}": "<${shape.choices.join(', ').replace(/, ([^,]*)$/, ' or $1')}>", ` +
    `"${shape.textKey}": "<${textHint}>"}`
  );
}
