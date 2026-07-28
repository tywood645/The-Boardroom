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

/**
 * Make a canned Response respect an AbortSignal the way real fetch does.
 *
 * Without this the mock ignores init.signal entirely, so a deadline can never
 * interrupt a stalled body and such a test just hangs. Delivery stays
 * pull-based so a chunk already handed to the consumer is not discarded when
 * the stream later errors.
 */
function abortable(res: Response, signal?: AbortSignal | null): Response {
  if (!signal || !res.body) return res;
  if (signal.aborted) throw signal.reason ?? new Error('The operation was aborted');

  const reader = res.body.getReader();
  let rejectOnAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectOnAbort = reject; });
  aborted.catch(() => {}); // an abort with no read in flight must not go unhandled
  signal.addEventListener(
    'abort',
    () => rejectOnAbort(signal.reason ?? new Error('The operation was aborted')),
    { once: true },
  );

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) {
        controller.close();
        return;
      }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, { status: res.status, headers: res.headers });
}

/** Install the mock, call in test setup. */
export function installMockFetch(): void {
  (globalThis as any).fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (let i = handlers.length - 1; i >= 0; i--) {
      const result = await handlers[i](urlStr, init);
      if (result) return abortable(result, init?.signal);
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
  const model = opts.model ?? 'claude-sonnet-5';
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

/**
 * OpenAI-style SSE that reports usage but never sends the [DONE] terminator.
 * Some vendors just close the socket; the stream must still yield both counts.
 */
export function openaiSSENoDone(text: string, opts: { model?: string; inputTokens?: number; outputTokens?: number } = {}): Response {
  const model = opts.model ?? 'gpt-4o';
  const inputTokens = opts.inputTokens ?? 42;
  const outputTokens = opts.outputTokens ?? 10;

  const lines = [
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [{ index: 0, delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } })}`,
  ];

  return sseResponse(lines.join('\n') + '\n');
}

/**
 * A real ReadableStream body that can fail partway through, which a plain
 * `new Response(string)` cannot do. Needed to exercise mid-stream failure.
 */
export function streamingResponse(chunks: string[], opts: { errorAfter?: number; error?: string } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  // Delivered via pull, one chunk per read, so `errorAfter: n` fails only after
  // the consumer has actually received chunks 0..n-1. Erroring from start()
  // would discard everything already enqueued and look like a failure with no
  // content at all — the opposite of what these tests need to exercise.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.errorAfter !== undefined && i === opts.errorAfter) {
        controller.error(new Error(opts.error ?? 'socket hang up'));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** One OpenAI-style SSE data line. */
export function openaiLine(delta: Record<string, unknown>, model = 'gpt-4o'): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-mock', model, choices: [{ index: 0, delta }] })}\n`;
}

/**
 * Serve responses in order. Returns undefined once exhausted, which the
 * dispatcher above treats as "no match" so earlier handlers still get a turn.
 */
export function queue(responses: Array<Response | (() => Response)>): Handler {
  let i = 0;
  return () => {
    if (i >= responses.length) return undefined as unknown as Response;
    const next = responses[i++];
    return typeof next === 'function' ? next() : next;
  };
}

/** Wrap a handler to count how many times it was invoked. */
export function countingHandler(inner: Handler): Handler & { calls: number } {
  const wrapped = ((url: string, init?: RequestInit) => {
    wrapped.calls++;
    return inner(url, init);
  }) as Handler & { calls: number };
  wrapped.calls = 0;
  return wrapped;
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
