/**
 * Load `.env` before anything reads `process.env`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two problems, both of which produce the same baffling symptom — "config.ts says my
 * environment is invalid, but the values are right there in .env":
 *
 *   1. npm workspaces run scripts with cwd set to the PACKAGE directory
 *      (apps/api), while `.env` lives at the MONOREPO ROOT. dotenv's default
 *      lookup therefore misses it entirely.
 *
 *   2. ES module imports are hoisted and execute in source order. Calling
 *      `dotenv.config()` inside a module body runs AFTER every import in that file
 *      has already executed — including `config.ts`, which validates the environment
 *      at import time and exits the process on failure.
 *
 * The fix for both: this module performs the load as a SIDE EFFECT at import time,
 * and every entry point imports it FIRST, before anything else.
 *
 *   import './loadEnv.js';   // must be the first import
 *   import { env } from './config.js';
 *
 * In Docker the variables are already injected by `env_file`, so nothing is found and
 * nothing is overwritten — dotenv never overrides an existing value.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));

// Search upward for the first .env. Covers running from source (src/), from the
// build output (dist/), and from the repository root.
const candidates = [
  resolve(here, '../../../.env'), // monorepo root, from apps/api/src or apps/api/dist
  resolve(here, '../../.env'), // apps/api
  resolve(process.cwd(), '.env'), // wherever the process was launched
  resolve(process.cwd(), '../../.env'),
];

const found = candidates.find((candidate) => existsSync(candidate));

if (found) {
  config({ path: found });
} else if (!process.env['DATABASE_URL']) {
  // Only warn when the environment also looks empty. In Docker there is no .env file
  // and that is entirely correct, so warning unconditionally would be noise.
  console.warn(
    '\n⚠  No .env file found and DATABASE_URL is not set.\n' +
      '   Copy the template and fill it in:  cp .env.example .env\n',
  );
}
