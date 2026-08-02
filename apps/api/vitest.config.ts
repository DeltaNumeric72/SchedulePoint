import { defineConfig } from 'vitest/config';

/**
 * The `api` test project.
 *
 * Three settings are load-bearing rather than tuning:
 *
 *  - **`globalSetup`** starts ONE embedded PostgreSQL cluster for the whole
 *    project, bootstraps the five roles, runs the migration cycle up → down → up
 *    and seeds the MULTI fixture through the unit of work.
 *  - **`singleFork` / `fileParallelism: false`** because every test file shares
 *    that one cluster and one fixture. Parallel files would interleave writes to
 *    the same rows and turn a deterministic isolation harness into a flaky one —
 *    and a concurrency claim backed by wall-clock luck is worth nothing
 *    (execution standards §F item 7). The T-15 storm creates its *own*
 *    concurrency, deterministically, inside one file.
 *  - **`testTimeout`** because the storm and the fault-injection tests wait on
 *    real server round trips, cancellations and backend terminations.
 */
export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
