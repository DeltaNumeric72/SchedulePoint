import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

/**
 * The shell smoke test.
 *
 * Runs at both configured viewports (desktop 1280x800, mobile 390x844). Three
 * things are asserted, in order of how load-bearing they are:
 *
 *  1. **axe-core finds zero violations.** CAP-066 / I-12. A failing axe check is
 *     a defect, not an obstacle, and this test may not be weakened to ship.
 *  2. **The shell actually renders** — landmarks, heading order, skip link, and
 *     the Radix primitive are all present, so the axe pass is a pass over real
 *     structure rather than over an empty page.
 *  3. **One user action produces one request** (I-10), recorded for the
 *     requests-per-interaction budget gate.
 */

test.describe('application shell', () => {
  test('renders the shell structure', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'Application shell' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeAttached();
    await expect(page.getByTestId('shell-separator')).toBeAttached();

    // The connection panel resolves to one of its terminal states; without an
    // API behind the preview server that state is the error state, which is a
    // rendered state like any other and must be accessible too.
    await expect(page.getByTestId('connection-status')).toContainText(
      /API (reachable|unreachable)/,
    );
  });

  test('has no axe-core violations', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('connection-status')).toContainText(
      /API (reachable|unreachable)/,
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();

    // Print the offending selectors rather than just a count — a bare count is
    // useless in CI output.
    expect(
      results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
  });

  test('keeps the shell within its request budget', async ({ page }, testInfo) => {
    const initial = await recordRequests(
      page,
      'shell-initial-load',
      testInfo.project.name,
      async () => {
        await page.goto('/');
        await expect(page.getByTestId('connection-status')).toContainText(
          /API (reachable|unreachable)/,
        );
      },
    );
    expect(initial.requests.length).toBeGreaterThan(0);

    const retry = await recordRequests(
      page,
      'health-retry-click',
      testInfo.project.name,
      async () => {
        const before = page.waitForRequest((r) => r.url().includes('/api/health'));
        await page.getByTestId('retry-health').click();
        await before;
        // Give any (forbidden) amplification a chance to show up before we stop
        // listening; a budget that stops counting too early proves nothing.
        await page.waitForTimeout(500);
      },
    );

    // I-10 in its strictest form: one click, one request.
    expect(retry.requests.map((r) => r.url)).toHaveLength(1);
  });
});
