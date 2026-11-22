import type { MessageCreateParams, StreamEvent } from './types.js';
import { ProviderError } from '../util/error.js';

export abstract class LLMProvider {
  abstract get name(): string;
  abstract get modelId(): string;
  abstract createMessage(params: MessageCreateParams): AsyncGenerator<StreamEvent>;
}

/**
 * Bounds on what a provider response may make this process hold.
 *
 * Nothing limited these before: an endpoint that streamed without a newline,
 * or returned an endless error body, grew a buffer until the run deadline or
 * until Node ran out of string. A vendor is a network peer, not a trusted one.
 */

/** Longest single SSE line or event accepted. Real ones are a few KB. */
export const MAX_SSE_BUFFER_CHARS = 1_000_000;

/** How much of an error body is read. Enough for any real error message. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * Throw if the pending SSE buffer has outgrown any plausible event. Carries a
 * 4xx status so the provider's retry loop treats it as final, not transient.
 */
export function assertSseBufferBounded(buffer: string, vendor: string): void {
  if (buffer.length > MAX_SSE_BUFFER_CHARS) {
    throw new ProviderError(
      `${vendor} sent more than ${MAX_SSE_BUFFER_CHARS} characters without completing an event; aborting the stream`,
      413,
    );
  }
}

/** Read at most `maxBytes` of a response body as text, then stop the transfer. */
export async function readTextCapped(response: Response, maxBytes = MAX_ERROR_BODY_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  let seen = 0;
  try {
    while (seen < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return out + decoder.decode();
      const take = value.subarray(0, maxBytes - seen);
      seen += take.length;
      out += decoder.decode(take, { stream: true });
    }
    return out + decoder.decode() + ' [truncated]';
  } finally {
    reader.cancel().catch(() => {});
  }
}
