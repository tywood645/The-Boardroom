import { safeForTerminal } from './terminal.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = 'info';

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] >= LEVELS[currentLevel]) {
    const prefix = `[${level.toUpperCase()}]`;
    // Log lines carry vendor error text, SSE data and model ids from config.
    // Strings and errors are made inert; other values are printed as-is.
    const safe = args.map(a =>
      typeof a === 'string' ? safeForTerminal(a) : a instanceof Error ? safeForTerminal(a.message) : a,
    );
    console.error(prefix, ...safe);
  }
}

export const logger = {
  debug: (...args: unknown[]) => log('debug', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  error: (...args: unknown[]) => log('error', ...args),
  setLevel: (level: Level) => { currentLevel = level; },
};
