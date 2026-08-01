import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs against the **production build**, served by `vite preview`.
 *
 * Testing the dev server would test a bundle that never ships: the dev server
 * injects HMR machinery and unminified React, which changes both the
 * accessibility tree's stability and the request count. The gates that matter
 * (axe, request budget) must see what a user sees.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: process.env['CI'] === 'true',
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
    command: './node_modules/.bin/vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
