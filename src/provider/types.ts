export interface ContentBlockText {
  type: 'text';
  text: string;
}

export interface ContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = ContentBlockText | ContentBlockToolUse | ContentBlockToolResult;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MessageCreateParams {
  system: string;
  messages: ConversationMessage[];
  tools: ToolSchema[];
  maxTokens: number;
  model: string;
  /** Run-level wall-clock deadline. Aborts connect and body alike. */
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'content_block_start'; index: number; content_block: { type: 'text' } | { type: 'tool_use'; id: string; name: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_start'; message: { id: string; model: string; usage: { input_tokens: number } } }
  // input_tokens is optional and authoritative when present. OpenAI-compatible
  // streams report usage only at the end, after message_start has already been
  // emitted, so the terminal message_delta is the only place they can carry it.
  //
  // Both counts are untrusted: collectStream validates them, and an absent or
  // invalid output_tokens means "not reported", never "zero".
  | { type: 'message_delta'; delta: { stop_reason: string }; usage: { output_tokens?: number; input_tokens?: number } }
  | { type: 'message_stop' }
  // A started attempt (the vendor accepted the request and opened a stream)
  // that ended before any content and is being retried or abandoned. The
  // vendor may already have billed its input, so collectStream charges for it.
  | { type: 'attempt_abandoned'; attempt: number }
  | { type: 'error'; error: { type: string; message: string } };
