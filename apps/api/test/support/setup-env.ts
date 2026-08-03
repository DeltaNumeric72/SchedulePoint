import { afterAll, expect } from 'vitest';

import { assertBaselineUnchanged } from './baseline-guard.js';
import { applyHarnessEnv } from './env.js';

/**
 * Per-worker setup.
 *
 * `globalSetup` runs in Vitest's main process; test files run in a worker with
 * its own `process.env`. This file re-applies the same configuration from the
 * same constants, so the two cannot drift.
 */
applyHarnessEnv();

/**
 * FAD-15 Layer 1, enforced per test file.
 *
 * A `setupFiles` module runs once per test file, so an `afterAll` registered here
 * runs after every file — including under `--sequence.shuffle.files`, where
 * "after the last one" is not a fixed place. If a file wrote to the shared
 * read-only baseline, its own run fails and says so by name.
 *
 * This is a build-failing control, not a report: NR-13's whole finding was that
 * eleven of twenty-four files were writing to the shared fixture and nothing
 * stopped them.
 */
afterAll(async () => {
  const testPath = expect.getState().testPath;
  await assertBaselineUnchanged(testPath ?? 'this test file');
}, 60_000);
