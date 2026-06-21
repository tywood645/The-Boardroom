/**
 * Fetch interceptor for testing LLM provider code.
 * Replaces global.fetch with a mock that returns canned SSE streams.
 * Works on Node 18+ without external mocking libraries.
 */

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const handlers: Handler[] = [];
const originalFetch = globalThis.fetch;

/** Register a handler. Last registered wins (LIFO). */
export function onFetch(handler: Handler): void {
  handlers.push(handler);
}

/** Install the mock, call in test setup. */
export function installMockFetch(): void {
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (let i = handlers.length - 1; i >= 0; i--) {
      const result = handlers[i](urlStr, init);
      if (result) return result instanceof Promise ? result : result;
    }
    throw new Error(`[mock-fetch] No handler matched: ${urlStr}`);
  };
}

/** Restore real fetch and clear handlers. */
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
  handlers.length = 0;
}

// ── SSE response builders ──

/** Build an Anthropic-style SSE response from a text string. */
export function anthropicSSE(text: string, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): Response {
  const model = opts.model ?? 'claude-sonnet-4-20250514';
  const inputTokens = opts.inputTokens ?? 42;
  const outputTokens = opts.outputTokens ?? 10;

  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_mock', model, usage: { input_tokens: inputTokens } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
  ];

  return sseResponse(events.join('\n\n') + '\n\n');
}

/** Build an OpenAI-style SSE response from a text string. */
export function openaiSSE(text: string, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): Response {
  const model = opts.model ?? 'gpt-4o';
  const inputTokens = opts.inputTokens ?? 42;
  const outputTokens = opts.outputTokens ?? 10;

  const lines = [
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [{ index: 0, delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}`,
    'data: [DONE]',
  ];

  return sseResponse(lines.join('\n') + '\n');
}

/** Build an error response. */
export function errorResponse(status: number, body: string = 'error'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
