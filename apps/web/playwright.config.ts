import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs against the **production build**, served by `vite preview`.
 *
 * Testing the dev server would test a bundle that never ships: the dev server
 * injects HMR machinery and unminified React, which changes both the
 * accessibility tree's stability and the request count. The gates that matter
 * (axe, request budget) must see what a user sees.
 *
 * ## The preview port is overridable (OPUS-M2-004, finding E-2)
 *
 * It was hard-coded at `4173` with `--strictPort` and `reuseExistingServer:
 * false`, so **two concurrent worktrees could not both run the `axe` gate** and
 * there was no variable to separate them — measured while OPUS-M2-002 and
 * OPUS-M2-003 ran in parallel (`docs/evidence/EV-M2-PROFILES/INDEX.md` §1a E-2).
 * The same diagnosis turned up a `vite preview` still holding 4173 from a
 * worktree deleted two days earlier, which is why the runbook's port-hygiene
 * discipline now covers the preview server as well as the database cluster.
 *
 * `SP_TEST_PREVIEW_PORT` moves it. The **default stays 4173**, and the reason is
 * not the one an earlier version of this comment gave. That version said the
 * committed request-budget recordings carry the preview origin, so a derived
 * default would dirty the tree — which is simply untrue: `.gitignore:15` ignores
 * `scripts/gates/request-budget/recordings/` entirely. They are run artifacts.
 *
 * The real reason is the difference in FAILURE MODE. A database-port collision
 * is silent and destructive: two worktrees derived the same port AND the same
 * data directory, and each agent's suite deleted the other's cluster while
 * reporting whole files failing with **zero tests failed** (E-1). A preview-port
 * collision is loud and harmless — `--strictPort` refuses to start and says so.
 * Deriving the database port removes a trap; deriving this one would only change
 * a number that appears in `apps/web/package.json`, in this file, and in
 * everyone's habits, to prevent a failure that already announces itself. An
 * override is the proportionate fix, and it is what E-2 asked for.
 */

/** `SP_TEST_PREVIEW_PORT`, or 4173. A malformed value throws rather than falling back. */
function previewPort(): number {
  const override = process.env['SP_TEST_PREVIEW_PORT'];
  if (override === undefined || override.trim() === '') return 4173;
  const parsed = Number.parseInt(override, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(
      `SP_TEST_PREVIEW_PORT is "${override}", which is not a port number between 1024 and 65535.`,
    );
  }
  return parsed;
}

const PREVIEW_PORT = previewPort();
const PREVIEW_ORIGIN = `http://127.0.0.1:${String(PREVIEW_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: PREVIEW_ORIGIN,
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
  webServer: {
    // The local binary directly: `pnpm exec` is unavailable when the outer
    // command came through corepack (see scripts/run-in-workspace.mjs).
    command: `./node_modules/.bin/vite preview --port ${String(PREVIEW_PORT)} --strictPort`,
    url: PREVIEW_ORIGIN,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
