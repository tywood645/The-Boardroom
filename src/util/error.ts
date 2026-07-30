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

/** Raised when a run exceeds its wall-clock budget. Never retried. */
export class DeadlineError extends BoardRoomError {
  constructor(message: string, public readonly deadlineMs: number) {
    super(message, 'DEADLINE_EXCEEDED');
    this.name = 'DeadlineError';
  }
}

/** Thrown by the pre-dispatch budget gate, before any request is sent. */
export class BudgetError extends BoardRoomError {
  constructor(message: string, public readonly currentSpend: number, public readonly cap: number) {
    super(message, 'BUDGET_EXCEEDED');
    this.name = 'BudgetError';
  }
}

export class ToolError extends BoardRoomError {
  constructor(message: string, public readonly toolName: string) {
    super(message, 'TOOL_ERROR');
    this.name = 'ToolError';
  }
}
