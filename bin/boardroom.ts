#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';

// Load environment variables from a project-root .env file (see .env.example).
loadDotenv();

import { main } from '../src/cli.js';

main().catch((e: unknown) => {
  console.error('Fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
