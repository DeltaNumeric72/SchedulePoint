import { defineConfig } from 'vitest/config';

/**
 * OPUS-M2-001 phase A — MEASUREMENT ONLY. Not part of `pnpm check`.
 *
 * Identical to `vitest.config.ts` except that `globalSetup` points at
 * `test/nr13/mutation-census.ts`, which wraps the real one and reports what each
 * test file changed in the shared fixture. Nothing a test can observe differs,
 * so a timing taken here is comparable with one taken under the real config —
 * the census itself runs before the first test and after the last one, outside
 * every measured interval.
 */
export default defineConfig({
  test: {
    name: 'api-nr13',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/nr13/mutation-census.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
