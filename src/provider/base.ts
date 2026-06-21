import type { MessageCreateParams, StreamEvent } from './types.js';

export abstract class LLMProvider {
  abstract get name(): string;
  abstract get modelId(): string;
  abstract createMessage(params: MessageCreateParams): AsyncGenerator<StreamEvent>;
}
