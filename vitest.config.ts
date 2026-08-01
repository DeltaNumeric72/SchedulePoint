import { defineConfig } from 'vitest/config';

/**
 * One test run for the whole workspace.
 *
 * Vitest projects rather than per-package invocations: a single `vitest run`
 * cannot silently skip a package, and the gate cannot be satisfied by a subset.
 */
export default defineConfig({
  test: {
    projects: [
      './packages/contracts/vitest.config.ts',
      './packages/domain/vitest.config.ts',
      './apps/api/vitest.config.ts',
      './apps/web/vite.config.ts',
      './scripts/gates/vitest.config.ts',
    ],
  },
});
