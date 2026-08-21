import { defineConfig, devices } from '@playwright/test';

import { REAL_STACK_ORIGIN } from './support/real-stack.js';

/**
 * The REAL-STACK Playwright configuration (FAD-48 clause (A) part 3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A second configuration rather than a flag on the first, for two reasons:
 *
 *  1. `apps/web/playwright.config.ts` is not in this packet's allowed files, and
 *     the axe/request-budget gate runs through it. A change there would change
 *     what every existing gate measures;
 *  2. the two runs are genuinely different systems. The default config serves
 *     `vite preview` and every spec intercepts the API; this one serves the same
 *     production bundle from an origin that PROXIES a real API, and **nothing is
 *     intercepted anywhere**. `globalSetup` starts a throwaway PostgreSQL
 *     cluster, migrates it, seeds it through the production write path, and runs
 *     `apps/api/src/index.ts` itself.
 *
 * Run it with:
 *
 * ```
 * corepack pnpm gate:build
 * SP_SOLVER_WORKER_COMMAND=… \
 *   node scripts/run-in-workspace.mjs apps/web playwright test --config e2e/real-stack.config.ts
 * ```
 *
 * **`SP_REAL_STACK` is set by `globalSetup`, not by the caller** (FAD-50 C-3).
 * It was previously documented as something the operator exported, and nothing
 * in the repository ever did — so this suite passed with `2 skipped` while
 * claiming to prove the critical path. `real-stack-setup.ts` now sets it once
 * the daemon is READY and the origin is listening, so the flag means the stack
 * is genuinely up; the guard in `critical-path.spec.ts` is what still makes the
 * spec decline under the DEFAULT config, where it is collected too and no stack
 * exists. `must-run-reporter.ts` fails the run outright if nothing executed.
 *
 * `workers: 1` and `fullyParallel: false` are not tuning. The critical path is
 * ONE workflow whose steps depend on each other, and it runs against one
 * database; two workers would be two schedulers racing over the same period.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'critical-path.spec.ts',
  globalSetup: './support/real-stack-setup.ts',
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  workers: 1,
  /* `list` for a human, and MustRunReporter to make a run that executed nothing
     FAIL rather than pass (FAD-50 C-3). */
  reporter: [['list'], ['./support/must-run-reporter.ts']],
  // A real solve, a real worker and a real database. The default 30s is a
  // measurement of a mocked click, not of this.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: REAL_STACK_ORIGIN,
    trace: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
  ],
});
