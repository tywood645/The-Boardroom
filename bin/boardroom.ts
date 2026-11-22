#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrustedEnv } from '../src/util/env.js';
import { safeForTerminal } from '../src/util/terminal.js';

// Settings come from the environment, ~/.boardroom/.env and BoardRoom's own
// project root, never from the directory the command runs in. See
// src/util/env.ts for why.
loadTrustedEnv({ binDir: dirname(fileURLToPath(import.meta.url)) });

import { main } from '../src/cli.js';

main().catch((e: unknown) => {
  console.error('Fatal:', safeForTerminal(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
