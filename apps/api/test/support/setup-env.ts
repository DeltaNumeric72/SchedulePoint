import { applyHarnessEnv } from './env.js';

/**
 * Per-worker setup.
 *
 * `globalSetup` runs in Vitest's main process; test files run in a worker with
 * its own `process.env`. This file re-applies the same configuration from the
 * same constants, so the two cannot drift.
 */
applyHarnessEnv();
