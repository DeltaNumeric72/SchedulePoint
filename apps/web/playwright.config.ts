import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs against the **production build**, served by `vite preview`.
 *
 * Testing the dev server would test a bundle that never ships: the dev server
 * injects HMR machinery and unminified React, which changes both the
 * accessibility tree's stability and the request count. The gates that matter
 * (axe, request budget) must see what a user sees.
 *
 * ## The preview port is DERIVED per worktree (OPUS-M3-008, closing E-2)
 *
 * It was hard-coded at `4173` with `--strictPort` and `reuseExistingServer:
 * false`, so **two concurrent worktrees could not both run the `axe` gate** and
 * there was no variable to separate them — measured while OPUS-M2-002 and
 * OPUS-M2-003 ran in parallel (`docs/evidence/EV-M2-PROFILES/INDEX.md` §1a E-2).
 * The same diagnosis turned up a `vite preview` still holding 4173 from a
 * worktree deleted two days earlier, which is why the runbook's port-hygiene
 * discipline covers the preview server as well as the database cluster.
 *
 * OPUS-M2-004 answered E-2 with `SP_TEST_PREVIEW_PORT` and kept `4173` as the
 * default, arguing that a preview collision is loud and harmless while a
 * database collision is silent and destructive. **The argument held and the
 * conclusion still failed**: OPUS-M3-004 recorded two red-case arms as "not
 * proven", and the cause was this collision. The failure IS loud — in the
 * preview server's own output — and by the time it reaches a red-case summary
 * line it is indistinguishable from the gate under test not firing, which is
 * how an agent ends up debugging the wrong thing for an hour.
 *
 * So the default is now derived from the worktree path, exactly as the database
 * port is, by `scripts/sbx/test-port.mjs`'s `deriveTestPreviewPort`. The
 * arithmetic is mirrored below because `scripts/` is outside every TypeScript
 * project here; `apps/api/test/architecture/derived-test-port.test.ts` executes
 * the JavaScript module and fails if the two ever disagree.
 *
 * `SP_TEST_PREVIEW_PORT` still wins, and a malformed value still throws rather
 * than falling back — a typo that silently pointed a run at another worktree's
 * server is the failure mode this module exists to remove.
 */

/** Mirrors `scripts/sbx/test-port.mjs`. See the note above. */
const DERIVED_PREVIEW_PORT_BASE = 41730;
/** Mirrors `scripts/sbx/test-port.mjs`. See the note above. */
const DERIVED_PREVIEW_PORT_SPAN = 400;

/** This worktree's root, resolved from this config file's own location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function derivePreviewPort(root: string): number {
  const digest = createHash('sha256').update(`sp.test.preview.port.v1:${root}`).digest('hex');
  return (
    DERIVED_PREVIEW_PORT_BASE +
    (Number.parseInt(digest.slice(0, 8), 16) % DERIVED_PREVIEW_PORT_SPAN)
  );
}

/** `SP_TEST_PREVIEW_PORT`, or the per-worktree derivation. Malformed throws. */
function previewPort(): number {
  const override = process.env['SP_TEST_PREVIEW_PORT'];
  if (override === undefined || override.trim() === '') return derivePreviewPort(REPO_ROOT);
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
