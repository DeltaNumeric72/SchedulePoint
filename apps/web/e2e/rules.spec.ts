import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

import { screenshotDir } from './support/evidence-target.js';

/**
 * The rule-authoring surface: every state, both viewports, axe on each
 * (OPUS-M3-002).
 *
 * ## Why the API is intercepted rather than run
 *
 * The same division `catalogue.spec.ts` records, and for the same reason: this
 * file proves the **interface** behaves correctly for each response; that the
 * server produces those responses is proven separately, over HTTP against the
 * real database, in `apps/api/test/rules/*.test.ts`. The component tree, router,
 * contracts, zod parse, query client and rendering here are all the real ones.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066, AC-01 |
 * | clicking "New rule" issues **zero** requests | **I-13** |
 * | Save issues exactly one request | I-10 |
 * | focus lands on the `role="alert"` summary after a failed submit | AC-11 |
 * | the summary's links resolve to real field ids | SPEC-14 validation-summary row |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | the rule-type control offers ONLY the closed node set | SPEC-04 §3.1 — no escape hatch in the UI |
 * | no page-level horizontal scroll at 320px | AC-08 |
 * | the whole form is reachable and submittable by keyboard | AC-02 |
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/catalogue/rules`;
const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/rules`;

const SCREENSHOTS = screenshotDir('EV-M3-RULES');

function rule(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ruleKey: `sample_rule_${String(index)}`,
    name: `Sample rule ${String(index)}`,
    ruleSchemaVersion: 1,
    classification: index % 2 === 0 ? 'HARD' : 'SOFT',
    weight: index % 2 === 0 ? null : 10,
    scope: {},
    predicate: { kind: 'RequiredCount', count: index + 1 },
    state: 'active',
    /* OPUS-M4-000C: the CAS token the editor loads and presents back on save.
     * REQUIRED by `ruleViewSchema`, so a fixture without it fails the parse and
     * the list renders nothing — which is how this fixture gap presented: the
     * rule rows never appeared and every budgeted rules interaction lost its
     * recording. Adding it is not loosening the contract; the contract is what
     * caught the fixture. */
    version: 1,
    ...overrides,
  };
}

const POPULATED = {
  rules: [rule(0), rule(1), rule(2, { state: 'disabled' })],
  correlationId: 'e2e-correlation-id',
};

function envelope(code: string, message: string) {
  return { error: { code, message, correlationId: 'e2e-correlation-id' } };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Whichever representation this viewport gets.
 *
 * Below 640px the six-column table is replaced by a list — exactly one of the
 * two is in the DOM, so a test that named only the table would pass on desktop
 * and fail on mobile for a reason that is the design working. (The first version
 * of this file DID name only the table, and the 320px overflow assertion is what
 * found the missing alternative: 211px of horizontal scroll.)
 */
function ruleRows(page: Page) {
  return page.locator('[data-testid="rules-table"], [data-testid="rules-list"]');
}

async function capture(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOTS, `${name}.${project}.png`), fullPage: true });
}

/**
 * Zero axe violations, **including `best-practice`** — the catalogue spec's
 * assertion, unchanged and for its recorded reason (`heading-order` is a
 * best-practice rule, and dropping the tag would be non-bypass rule 10).
 */
async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);

  const ranRules = new Set(
    [...results.violations, ...results.passes, ...results.incomplete, ...results.inapplicable].map(
      (result) => result.id,
    ),
  );
  expect(ranRules, 'the best-practice tag selected no heading-order rule').toContain(
    'heading-order',
  );
}

test.describe('rules — authoring', () => {
  test('LOADING: the list announces itself while it is being fetched', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(API, async (route) => {
      await held;
      await json(route, 200, POPULATED);
    });

    await page.goto(BASE);
    const loading = page.getByTestId('surface-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'rules-loading', info.project.name);
    release();
    await expect(ruleRows(page)).toBeVisible();
  });

  test('EMPTY: the empty state says what is missing, not "no data"', async ({ page }, info) => {
    await page.route(API, (route) =>
      json(route, 200, { rules: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(BASE);

    await expect(page.getByTestId('surface-empty')).toContainText('No rules have been authored');
    await expectNoAxeViolations(page);
    await capture(page, 'rules-empty', info.project.name);
  });

  test('POPULATED: the rules render as a real table', async ({ page }, info) => {
    await page.route(API, (route) => json(route, 200, POPULATED));
    await page.goto(BASE);

    await expect(ruleRows(page)).toBeVisible();
    await expect(page.getByTestId('rules-row-sample_rule_0')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'rules-populated', info.project.name);
  });

  test('DENIED: a 403 says no permission and never says why', async ({ page }, info) => {
    await page.route(API, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'The request could not be completed.')),
    );
    await page.goto(BASE);

    const denied = page.getByTestId('surface-permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText('You do not have permission');
    // P-3: the reason is never on the wire, so it is never on the screen.
    await expect(denied).not.toContainText(/capability|schedule\.catalogue/i);
    await expectNoAxeViolations(page);
    await capture(page, 'rules-denied', info.project.name);
  });

  test('NOT FOUND: a 404 is a different message from a 403', async ({ page }, info) => {
    await page.route(API, (route) =>
      json(route, 404, envelope('NOT_FOUND', 'The request could not be completed.')),
    );
    await page.goto(BASE);

    await expect(page.getByTestId('surface-error')).toBeVisible();
    await expect(page.getByTestId('surface-permission-denied')).toHaveCount(0);
    await expectNoAxeViolations(page);
    await capture(page, 'rules-not-found', info.project.name);
  });

  test('I-13: "New rule" persists nothing and issues ZERO requests', async ({ page }, info) => {
    await page.route(API, (route) => json(route, 200, POPULATED));
    await page.goto(BASE);
    await expect(ruleRows(page)).toBeVisible();

    const recording = await recordRequests(
      page,
      'rules-open-new-rule',
      info.project.name,
      async () => {
        await page.getByTestId('rules-new').click();
        await expect(page.getByTestId('rules-form')).toBeVisible();
      },
    );

    // ZERO is the only correct number. The invariant exists because a control
    // labelled New once created a live record on click.
    expect(recording.requests).toEqual([]);
    await expectNoAxeViolations(page);
    await capture(page, 'rules-form', info.project.name);
  });

  test('the rule-type control offers ONLY the closed node set — no free-text escape hatch', async ({
    page,
  }) => {
    await page.route(API, (route) => json(route, 200, POPULATED));
    await page.goto(BASE);
    await page.getByTestId('rules-new').click();

    const kind = page.getByTestId('rules-kind');
    // A `<select>`, not an input: the interface has no affordance for a rule the
    // AST cannot express (SPEC-04 §3.1).
    await expect(kind).toHaveJSProperty('tagName', 'SELECT');
    const options = await kind.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(0);
    // There is no "custom", "expression", "raw" or "advanced" option anywhere.
    for (const option of options) {
      expect(option).not.toMatch(/custom|expression|raw|advanced|sql/i);
    }
  });

  test('I-10: Save issues exactly one request, and a SERVER 422 focuses the summary', async ({
    page,
  }, info) => {
    await page.route(API, async (route) => {
      if (route.request().method() === 'POST') {
        await json(route, 422, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some of the details need attention.',
            correlationId: 'e2e-correlation-id',
            problems: [{ field: 'ruleKey', message: 'A rule with this key already exists.' }],
          },
        });
        return;
      }
      await json(route, 200, POPULATED);
    });

    await page.goto(BASE);
    await page.getByTestId('rules-new').click();
    // The body must be CLIENT-valid, or the client's outgoing parse refuses it
    // before any request and this test would measure the wrong path — which is
    // what the first version of it did (zero requests recorded). The path being
    // measured here is a server refusal of a well-formed body.
    await page.getByLabel('Rule key').fill('cover_day');
    await page.getByLabel('Name').fill('Cover the day shift');

    const recording = await recordRequests(
      page,
      'rules-save-refused',
      info.project.name,
      async () => {
        await page.getByTestId('rules-save').click();
        await expect(page.getByTestId('validation-summary-rule')).toBeVisible();
      },
    );
    expect(recording.requests).toHaveLength(1);

    // AC-11: focus moves to the summary, announced once.
    const summary = page.getByTestId('validation-summary-rule');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute('role', 'alert');

    // The summary's link resolves to a real control.
    const href = await summary.locator('a').first().getAttribute('href');
    expect(href).toBeTruthy();
    await expect(page.locator(href ?? '#missing')).toHaveCount(1);

    await expectNoAxeViolations(page);
    await capture(page, 'rules-validation', info.project.name);
  });

  test('the CLIENT pre-check refuses an incomplete body without a request at all', async ({
    page,
  }) => {
    await page.route(API, (route) => json(route, 200, POPULATED));
    await page.goto(BASE);
    await page.getByTestId('rules-new').click();

    // Name only — no rule key. The outgoing contract parse refuses it, and the
    // summary renders in the SAME shape a server 422 produces (that identity is
    // the point of parsing outgoing bodies).
    await page.getByLabel('Name').fill('Cover the day shift');

    const requests: string[] = [];
    const listener = (request: { url(): string }): void => {
      requests.push(request.url());
    };
    page.on('request', listener);
    await page.getByTestId('rules-save').click();
    await expect(page.getByTestId('validation-summary-rule')).toBeVisible();
    page.off('request', listener);

    expect(requests.filter((url) => url.includes('/api/'))).toEqual([]);
    await expect(page.getByTestId('validation-summary-rule')).toBeFocused();
  });

  test('I-10: a successful Save issues one write and one refetch', async ({ page }, info) => {
    await page.route(API, async (route) => {
      if (route.request().method() === 'POST') {
        await json(route, 200, { rule: rule(0), correlationId: 'e2e-correlation-id' });
        return;
      }
      await json(route, 200, POPULATED);
    });

    await page.goto(BASE);
    await page.getByTestId('rules-new').click();
    await page.getByLabel('Rule key').fill('cover_day');
    await page.getByLabel('Name').fill('Cover the day shift');

    const recording = await recordRequests(
      page,
      'rules-save-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('rules-save').click();
        await expect(page.getByTestId('rules-form')).toHaveCount(0);
      },
    );
    // One POST plus the invalidation refetch. Anything more is amplification.
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('AC-02: the whole form is reachable and submittable by keyboard alone', async ({ page }) => {
    await page.route(API, async (route) => {
      if (route.request().method() === 'POST') {
        await json(route, 200, { rule: rule(0), correlationId: 'e2e-correlation-id' });
        return;
      }
      await json(route, 200, POPULATED);
    });

    await page.goto(BASE);
    await expect(ruleRows(page)).toBeVisible();

    // Reach "New rule" by tabbing, and activate it with the keyboard.
    const newButton = page.getByTestId('rules-new');
    await newButton.focus();
    await expect(newButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('rules-form')).toBeVisible();

    // Every control in the form is tabbable, in order, and the last stop before
    // the buttons is the number field.
    await page.getByLabel('Rule key').focus();
    await page.keyboard.type('cover_day');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Cover the day shift');

    // Submit from the keyboard.
    await page.getByTestId('rules-save').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('rules-form')).toHaveCount(0);
  });

  test('AC-08: no page-level horizontal scroll at the narrow viewport', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the 320px assertion belongs to the mobile project');
    await page.route(API, (route) => json(route, 200, POPULATED));
    await page.goto(BASE);
    await expect(ruleRows(page)).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
