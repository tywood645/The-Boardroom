export class BoardRoomError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'BoardRoomError';
  }
}

export class ProviderError extends BoardRoomError {
  constructor(message: string, public readonly statusCode?: number) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'ProviderError';
  }
}

export class ToolError extends BoardRoomError {
  constructor(message: string, public readonly toolName: string) {
    super(message, 'TOOL_ERROR');
    this.name = 'ToolError';
  }
}
