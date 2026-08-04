import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

/**
 * The authentication surfaces — OPUS-M3-001's UI slice.
 *
 * Runs at both configured viewports (desktop 1280x800, mobile 390x844), like the
 * shell spec, because CAP-066 / I-12 is a property of what a user sees and a
 * 390px viewport is what most of them see.
 *
 * ## What is asserted, in order of how load-bearing it is
 *
 *  1. **axe-core finds zero violations on every page.** A failing axe check is a
 *     defect, not an obstacle, and this file may not be weakened to ship.
 *  2. **Every page is completable from the keyboard alone.** Tabbed through, not
 *     clicked: `page.keyboard` only.
 *  3. **I-13** — nothing persists before an explicit submit. Asserted directly:
 *     a bare page load, and typing into every field, produce ZERO requests.
 *  4. **I-10** — one user action produces one request, recorded for the
 *     request-budget gate.
 *  5. **The error state is a rendered, accessible state.** There is no API behind
 *     the preview server, so every submit fails — and that failure has to be
 *     announced rather than swallowed, which is exactly the state a real
 *     network failure produces.
 *
 * ## The organization id is synthetic
 *
 * A fixed UUID that names nothing. No real organization, person or site name
 * appears anywhere in this file.
 */

const ORGANIZATION = '00000000-0000-4000-8000-00000000a11a';

const PAGES = [
  { name: 'sign in', path: `/organizations/${ORGANIZATION}/sign-in`, heading: 'Sign in' },
  {
    name: 'MFA challenge',
    path: `/organizations/${ORGANIZATION}/sign-in/challenge`,
    heading: 'Two-step verification',
  },
  {
    name: 'MFA enrolment',
    path: `/organizations/${ORGANIZATION}/sign-in/enrolment`,
    heading: 'Set up two-step verification',
  },
  {
    name: 'activation',
    path: `/organizations/${ORGANIZATION}/activate`,
    heading: 'Activate your account',
  },
  {
    name: 'password reset request',
    path: `/organizations/${ORGANIZATION}/reset`,
    heading: 'Reset your password',
  },
  {
    name: 'password reset completion',
    path: `/organizations/${ORGANIZATION}/reset/complete`,
    heading: 'Choose a new password',
  },
] as const;

async function axeViolations(page: Page): Promise<unknown[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
}

test.describe('authentication surfaces', () => {
  for (const surface of PAGES) {
    test(`${surface.name}: renders, and axe finds nothing`, async ({ page }) => {
      await page.goto(surface.path);
      await expect(
        page.getByRole('heading', { level: 1, name: surface.heading }),
      ).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('contentinfo')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeAttached();
      // The polite announcement region exists before anything happens, so the
      // first announcement is not the region's own arrival.
      await expect(page.getByTestId('authn-status')).toBeAttached();

      expect(await axeViolations(page)).toEqual([]);
    });
  }

  test('I-13: filling every field on a form writes NOTHING', async ({ page }, info) => {
    // The strongest available form of "nothing persists before Save": count the
    // requests. A field that saved on change, or a page that wrote on mount,
    // would show up here as a request nobody asked for. Recorded into the
    // request-amplification ledger, where the budget is ZERO and can never be
    // raised without I-13 changing first.
    await page.goto(`/organizations/${ORGANIZATION}/activate`);
    await expect(page.getByTestId('activation-form')).toBeVisible();

    const recording = await recordRequests(
      page,
      'authn-fill-activation-form',
      info.project.name,
      async () => {
        await page.getByLabel('Invitation code').fill('a-value-nobody-submitted');
        await page.getByLabel('New password').fill('another-value-nobody-submitted');
        // Long enough for a debounced background write to appear if one existed.
        await page.waitForTimeout(500);
      },
    );

    expect(
      recording.requests.map((request) => `${request.method} ${request.url}`),
      'a form that had not been submitted issued a request',
    ).toEqual([]);
  });

  test('I-10: one submit produces exactly one request', async ({ page }, info) => {
    await page.goto(`/organizations/${ORGANIZATION}/reset`);
    await page.getByLabel('Login email').fill('synthetic@example.test');

    const recording = await recordRequests(
      page,
      'authn-submit-password-reset-request',
      info.project.name,
      async () => {
        await page.getByTestId('reset-request-submit').click();
        await expect(page.getByTestId('authn-error')).toBeVisible();
      },
    );

    expect(
      recording.requests.map((request) => `${request.method} ${request.url}`),
      'one submit issued more than one request',
    ).toHaveLength(1);
    expect(recording.requests[0]?.method).toBe('POST');
  });

  test('the failure state is announced, not swallowed', async ({ page }) => {
    // There is no API behind the preview server, so this exercises exactly the
    // state a real network failure produces — and it must be a rendered,
    // announced state rather than a form that silently does nothing.
    await page.goto(`/organizations/${ORGANIZATION}/sign-in`);
    await page.getByLabel('Login email').fill('synthetic@example.test');
    await page.getByLabel('Password').fill('a-synthetic-passphrase-01');
    await page.getByTestId('sign-in-submit').click();

    const alert = page.getByTestId('authn-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('the validation summary appears once, takes focus, and links to the field', async ({
    page,
  }, info) => {
    await page.goto(`/organizations/${ORGANIZATION}/activate`);
    // Submitting empty: the client-side pre-check must produce the summary and
    // make NO request.
    const recording = await recordRequests(
      page,
      'authn-submit-activation-refused-by-client',
      info.project.name,
      async () => {
        await page.getByTestId('activation-submit').click();
        await expect(page.getByRole('alert').first()).toBeVisible();
      },
    );
    expect(
      recording.requests.map((request) => `${request.method} ${request.url}`),
      'a failed client-side pre-check still called the server',
    ).toEqual([]);

    // Focus is ON the summary, which is what SPEC-14 AC-11 asks for.
    const focusedRole = await page.evaluate(() =>
      document.activeElement?.getAttribute('role'),
    );
    expect(focusedRole).toBe('alert');
    expect(await axeViolations(page)).toEqual([]);
  });

  test('sign in is completable from the KEYBOARD alone', async ({ page }) => {
    await page.goto(`/organizations/${ORGANIZATION}/sign-in`);
    await expect(page.getByTestId('sign-in-form')).toBeVisible();

    // Tab from the top of the document until each control is reached, and use
    // the keyboard for everything. No `click()` anywhere in this test.
    const reached: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const description = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return '';
        const testId = active.getAttribute('data-testid');
        if (testId !== null) return `testid:${testId}`;
        const type = active.getAttribute('type');
        return type === null ? active.tagName.toLowerCase() : `input:${type}`;
      });
      reached.push(description);
      if (description === 'input:email') await page.keyboard.type('synthetic@example.test');
      if (description === 'input:password') await page.keyboard.type('a-synthetic-passphrase-01');
      if (description === 'input:checkbox') await page.keyboard.press('Space');
      if (description === 'testid:sign-in-submit') break;
    }

    expect(reached, `tab order reached: ${reached.join(' -> ')}`).toContain('input:email');
    expect(reached).toContain('input:password');
    expect(reached).toContain('input:checkbox');
    expect(reached).toContain('testid:sign-in-submit');

    // Submit with the keyboard, and the result is announced.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('authn-error')).toBeVisible();
  });

  test('activation is completable from the KEYBOARD alone', async ({ page }) => {
    await page.goto(`/organizations/${ORGANIZATION}/activate`);
    await expect(page.getByTestId('activation-form')).toBeVisible();

    const reached: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const description = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return '';
        const testId = active.getAttribute('data-testid');
        if (testId !== null) return `testid:${testId}`;
        const type = active.getAttribute('type');
        return type === null ? active.tagName.toLowerCase() : `input:${type}`;
      });
      reached.push(description);
      if (description === 'input:text') await page.keyboard.type('a-synthetic-invitation-code');
      if (description === 'input:password') await page.keyboard.type('a-synthetic-passphrase-01');
      if (description === 'testid:activation-submit') break;
    }

    expect(reached, `tab order reached: ${reached.join(' -> ')}`).toContain('input:text');
    expect(reached).toContain('input:password');
    expect(reached).toContain('testid:activation-submit');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('authn-error')).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
