import { LLMProvider } from './base.js';
import type { MessageCreateParams, StreamEvent, ConversationMessage, ContentBlock } from './types.js';
import { ProviderError } from '../util/error.js';
import { logger } from '../util/logger.js';

const MAX_RETRIES = 3;
// Covers connection + response headers only. The timer is cleared as soon
// as fetch resolves, so long streaming bodies are never aborted by it.
const CONNECT_TIMEOUT_MS = 30_000;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export class OpenAICompatProvider extends LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private providerName: string;

  constructor(opts: { apiKey: string; model: string; baseUrl: string; name: string }) {
    super();
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.providerName = opts.name;
  }

  get name(): string { return this.providerName; }
  get modelId(): string { return this.model; }

  private convertMessages(system: string, messages: ConversationMessage[]): OpenAIMessage[] {
    const result: OpenAIMessage[] = [{ role: 'system', content: system }];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
      } else {
        const blocks = msg.content as ContentBlock[];

        if (msg.role === 'assistant') {
          const textParts = blocks.filter(b => b.type === 'text').map(b => (b as any).text).join('');
          const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({
            id: (b as any).id,
            type: 'function' as const,
            function: { name: (b as any).name, arguments: JSON.stringify((b as any).input) }
          }));

          const oaiMsg: OpenAIMessage = { role: 'assistant' };
          if (textParts) oaiMsg.content = textParts;
          if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
          result.push(oaiMsg);
        } else {
          // User message with tool_results
          for (const block of blocks) {
            if (block.type === 'tool_result') {
              result.push({
                role: 'tool',
                tool_call_id: (block as any).tool_use_id,
                content: (block as any).content,
              });
            } else if (block.type === 'text') {
              result.push({ role: 'user', content: (block as any).text });
            }
          }
        }
      }
    }
    return result;
  }

  async *createMessage(params: MessageCreateParams): AsyncGenerator<StreamEvent> {
    const messages = this.convertMessages(params.system, params.messages);

    const tools = params.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));

    const body: Record<string, unknown> = {
      model: params.model || this.model,
      max_tokens: params.maxTokens,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) body.tools = tools;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
        const response = await fetch(this.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }).finally(() => clearTimeout(connectTimer));

        if (!response.ok) {
          const errBody = await response.text();
          if (response.status === 429 || response.status >= 500) {
            const delay = Math.pow(2, attempt) * 1000;
            logger.warn(this.providerName + ' API ' + response.status + ', retrying in ' + delay + 'ms...');
            await new Promise(r => setTimeout(r, delay));
            lastError = new ProviderError(errBody, response.status);
            continue;
          }
          throw new ProviderError(errBody, response.status);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError('No response body');

        const decoder = new TextDecoder();
        const self = this;
        let buffer = '';
        let blockIndex = 0;
        let currentToolCallId = '';
        let currentToolName = '';
        let hasEmittedStart = false;
        let usageInputTokens = 0;
        let usageOutputTokens = 0;
        let messageStartEmitted = false;

        // Emit message_start exactly once, before the first content event, so the
        // event order matches the Anthropic path (message_start precedes content).
        function* ensureMessageStart(): Generator<StreamEvent> {
          if (!messageStartEmitted) {
            yield { type: 'message_start', message: { id: '', model: self.model, usage: { input_tokens: usageInputTokens } } } as StreamEvent;
            messageStartEmitted = true;
          }
        }

        function* processLine(line: string): Generator<StreamEvent> {
          if (!line.startsWith('data: ')) return;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield* ensureMessageStart();
            yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usageOutputTokens } } as StreamEvent;
            yield { type: 'message_stop' } as StreamEvent;
            return;
          }

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch (e) {
            logger.debug('Failed to parse SSE data:', data, e);
            return;
          }

          // Usage chunk (sent at end when stream_options.include_usage=true).
          // Some providers send a chunk with usage but no choices.
          if (chunk.usage) {
            usageInputTokens = chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0;
            usageOutputTokens = chunk.usage.completion_tokens || chunk.usage.output_tokens || 0;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) return;

          // Text content
          if (delta.content) {
            yield* ensureMessageStart();
            if (!hasEmittedStart) {
              yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text' } } as StreamEvent;
              hasEmittedStart = true;
            }
            yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } } as StreamEvent;
          }

          // Tool calls
          if (delta.tool_calls) {
            yield* ensureMessageStart();
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                // New tool call starting
                if (hasEmittedStart) {
                  yield { type: 'content_block_stop', index: blockIndex } as StreamEvent;
                  blockIndex++;
                }
                currentToolCallId = tc.id;
                currentToolName = tc.function?.name || '';
                yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: currentToolCallId, name: currentToolName } } as StreamEvent;
                hasEmittedStart = true;
              }
              if (tc.function?.arguments) {
                yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } } as StreamEvent;
              }
            }
          }

          // Finish reason
          if (chunk.choices?.[0]?.finish_reason) {
            if (hasEmittedStart) {
              yield { type: 'content_block_stop', index: blockIndex } as StreamEvent;
            }
          }
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!;

          for (const line of lines) {
            yield* processLine(line);
          }
        }

        // Stream ended: flush the decoder, process any remaining buffered line, and
        // guarantee message_start was emitted even if the [DONE] marker never arrived.
        buffer += decoder.decode();
        if (buffer.trim()) yield* processLine(buffer);
        yield* ensureMessageStart();
        return;
      } catch (e) {
        if (e instanceof ProviderError && e.statusCode && e.statusCode < 500 && e.statusCode !== 429) throw e;
        lastError = e as Error;
      }
    }

    throw lastError || new ProviderError('Max retries exceeded');
  }
}
