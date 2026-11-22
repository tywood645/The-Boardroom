#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';

// Load environment variables from a project-root .env file (see .env.example).
// quiet: dotenv 17 otherwise prints a banner (with a promotional tip) to
// stdout on every run, which corrupts machine-readable output such as
// `delegate --json`.
loadDotenv({ quiet: true });

import { main } from '../src/cli.js';

main().catch((e: unknown) => {
  console.error('Fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
