import { LLMProvider } from './base.js';
import type { MessageCreateParams, StreamEvent } from './types.js';
import { ProviderError } from '../util/error.js';
import { linkAbort, isDeadlineAbort } from '../util/abort.js';
import { logger } from '../util/logger.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_RETRIES = 3;
// Covers connection + response headers only. The timer is cleared as soon
// as fetch resolves, so long streaming bodies are never aborted by it.
const CONNECT_TIMEOUT_MS = 30_000;

// Parse one SSE chunk and yield a validated event. Malformed events (missing the
// fields consumers dereference) are dropped rather than crashing downstream code.
function* parseAnthropicChunk(chunk: string): Generator<StreamEvent> {
  const eventMatch = chunk.match(/^event:\s*(.+)$/m);
  const dataMatch = chunk.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;
  const eventType = eventMatch[1].trim();
  let data: any;
  try {
    data = JSON.parse(dataMatch[1]);
  } catch {
    logger.debug('Failed to parse SSE data:', dataMatch[1]);
    return;
  }
  if (eventType === 'message_start' && !data.message) return;
  if (eventType === 'content_block_delta' && !data.delta) return;
  if (eventType === 'message_delta' && !data.usage) return;
  if (eventType === 'error' && !data.error) return;
  yield { type: eventType, ...data } as StreamEvent;
}

export class AnthropicProvider extends LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    super();
    this.apiKey = apiKey;
    this.model = model;
  }

  get name(): string { return 'anthropic'; }
  get modelId(): string { return this.model; }

  async *createMessage(params: MessageCreateParams): AsyncGenerator<StreamEvent> {
    const body = {
      model: params.model || this.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages,
      tools: params.tools.length > 0 ? params.tools : undefined,
      stream: true,
    };

    let lastError: Error | null = null;
    // Retrying is only safe before the first content delta reaches the consumer.
    // Consumers accumulate text outside this generator, so a retry after partial
    // output would leave them holding attempt-1's prefix plus all of attempt 2.
    let yieldedContent = false;
    // Set once a response is accepted and its body opened, per attempt.
    let streamStarted = false;
    let unlink: () => void = () => {};

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      streamStarted = false;
      try {
        const controller = new AbortController();
        // The run deadline aborts connect and body alike; the connect timer is
        // cleared once headers land so a long stream is never truncated.
        unlink = linkAbort(controller, params.signal);
        const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }).finally(() => clearTimeout(connectTimer));

        if (!response.ok) {
          const errBody = await response.text();
          if (response.status === 429 || response.status >= 500) {
            const delay = Math.pow(2, attempt) * 1000;
            logger.warn('API ' + response.status + ', retrying in ' + delay + 'ms...');
            await new Promise(r => setTimeout(r, delay));
            lastError = new ProviderError('API error: ' + response.status + ' ' + errBody, response.status);
            continue;
          }
          throw new ProviderError('API error: ' + response.status + ' ' + errBody, response.status);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError('No response body');
        streamStarted = true;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop()!;

          for (const chunk of chunks) {
            for (const ev of parseAnthropicChunk(chunk)) {
              if (ev.type === 'content_block_delta') yieldedContent = true;
              yield ev;
            }
          }
        }

        // Stream ended: flush the decoder (recovers a trailing multi-byte char) and
        // emit any final event still buffered without a blank-line terminator.
        buffer += decoder.decode();
        for (const chunk of buffer.split('\n\n')) {
          for (const ev of parseAnthropicChunk(chunk)) {
            if (ev.type === 'content_block_delta') yieldedContent = true;
            yield ev;
          }
        }
        return;
      } catch (e) {
        if (isDeadlineAbort(e)) throw e;
        if (e instanceof ProviderError && e.statusCode && e.statusCode < 500 && e.statusCode !== 429) {
          throw e;
        }
        lastError = e as Error;
        if (yieldedContent) throw lastError;
        // The vendor accepted this attempt and may have billed its input.
        if (streamStarted) yield { type: 'attempt_abandoned', attempt } as StreamEvent;
      } finally {
        unlink();
        unlink = () => {};
      }
    }

    throw lastError || new ProviderError('Max retries exceeded');
  }
}
