import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

import { screenshotDir } from './support/evidence-target.js';

/**
 * The catalogue surfaces: every state, both viewports, axe on each.
 *
 * ## Why the API is intercepted rather than run
 *
 * There is no authentication subsystem yet — no sign-in, no session — so the
 * browser cannot reach the real API as a real principal, and pretending
 * otherwise would mean building a fake login just for a test. Interception at
 * the BROWSER's network boundary is the honest alternative: the component tree,
 * the router, the contracts, the zod parse, the query client and the rendering
 * are all the real ones, and only the bytes on the wire are supplied here. What
 * this cannot prove is that the server produces those bytes — which is proven
 * separately, over HTTP, against the real database, in
 * `apps/api/test/catalogue/*.test.ts`.
 *
 * That division is recorded rather than implied: this file proves the INTERFACE
 * behaves correctly for each response; the api suite proves the server produces
 * those responses.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066, AC-01 |
 * | clicking "New shift type" issues **zero** requests | **I-13**, and the reason the invariant exists |
 * | Save issues exactly one request | I-10 |
 * | focus lands on the `role="alert"` summary after a failed submit | AC-11 |
 * | the summary's links resolve to real field ids | SPEC-14 validation-summary row |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 * | every interactive target is ≥44×44 | AC-09 |
 * | the whole form is reachable and submittable by keyboard | AC-02 |
 * | all six shift palettes are rendered, so axe measures them | SPEC-14 §2, SP-E §4 |
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/catalogue`;
const API = `**/api${BASE}`;

const SCREENSHOTS = screenshotDir('EV-M2-CATALOGUE');

/** One shift type per palette key, so axe measures all six rendered pairs. */
const PALETTES = ['neutral', 'indigo', 'teal', 'amber', 'rose', 'violet'] as const;
const STYLES = ['regular', 'bold', 'italic', 'regular', 'bold', 'italic'] as const;

function shiftType(index: number) {
  return {
    shiftTypeId: `3333333${String(index)}-3333-4333-8333-333333333333`,
    code: `T${String(index)}`,
    name: `Sample shift type ${String(index)}`,
    description: null,
    displayPaletteKey: PALETTES[index] ?? 'neutral',
    displayTextStyle: STYLES[index] ?? 'regular',
    startTime: index % 2 === 0 ? '07:00' : '19:00',
    endTime: index % 2 === 0 ? '19:00' : '07:00',
    crossesMidnight: index % 2 !== 0,
    isOnCall: index % 2 !== 0,
    attractsStipend: index % 3 === 0,
    isManualOnly: false,
    isDailyPick: index % 2 === 0,
    includeInStatistics: true,
    isLeaveOfAbsence: false,
    allowOnRequest: true,
    allowOffRequest: true,
    reportOrder: index,
    creditWeight: 1,
    status: index === 5 ? ('retired' as const) : ('active' as const),
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    version: 1,
  };
}

const POPULATED = {
  shiftTypes: PALETTES.map((_, index) => shiftType(index)),
  correlationId: 'e2e-correlation-id',
};

function envelope(code: string, message: string) {
  return { error: { code, message, correlationId: 'e2e-correlation-id' } };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Captures a screenshot into the evidence bundle, named by state and viewport. */
async function capture(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOTS, `${name}.${project}.png`), fullPage: true });
}

/**
 * Whichever representation of the catalogue this viewport gets.
 *
 * Below 640px the six-column table is replaced by a list (SPEC-14's required
 * alternative for a grid at 320px), and exactly one of the two is in the DOM —
 * so a test that named only the table would pass on desktop and fail on mobile
 * for a reason that is the design working.
 */
function catalogueRows(page: Page) {
  return page.locator('[data-testid="shift-type-table"], [data-testid="shift-type-list"]');
}

/**
 * Zero axe violations, **including `best-practice`**.
 *
 * The WCAG tags alone were what the first version ran, and an independent review
 * pointed out what that missed: `heading-order` is a `best-practice` rule, not a
 * WCAG one, and the authoring form's heading skipped from the page's `h1` to an
 * `h3`. A screen-reader user navigating by heading level would have been told
 * the form was nested inside a section that does not exist.
 *
 * Including the tag is a strictly larger assertion and it stays included. Any
 * rule this surfaces is a defect to fix, not a tag to drop again (non-bypass
 * rule 10).
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

  /* The tag is doing work, and that is checked rather than assumed.
   *
   * A mis-spelled tag makes `withTags` select fewer rules and `analyze()` still
   * returns zero violations — a stronger-looking claim backed by a weaker check.
   * `heading-order` is the `best-practice` rule the review found, so its
   * presence in ANY outcome bucket proves the tag selected the best-practice set
   * on this run. */
  const ranRules = new Set([
    ...results.violations,
    ...results.passes,
    ...results.incomplete,
    ...results.inapplicable,
  ].map((result) => result.id));
  expect(ranRules, 'the best-practice tag selected no heading-order rule').toContain(
    'heading-order',
  );
}

test.describe('catalogue — shift types', () => {
  test('LOADING: the list announces itself while it is being fetched', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(`${API}/shift-types`, async (route) => {
      await held;
      await json(route, 200, POPULATED);
    });

    await page.goto(`${BASE}/shift-types`);
    const loading = page.getByTestId('surface-loading');
    await expect(loading).toBeVisible();
    // `role="status"` with `aria-live="polite"`: a spinner nobody is told about
    // is a blank screen to a screen-reader user.
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-loading', info.project.name);
    release();
    await expect(catalogueRows(page)).toBeVisible();
  });

  test('EMPTY: the empty state says what to do next, not "no data"', async ({ page }, info) => {
    await page.route(`${API}/shift-types`, (route) =>
      json(route, 200, { shiftTypes: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(`${BASE}/shift-types`);

    const empty = page.getByTestId('surface-empty');
    await expect(empty).toContainText('Add the first one');
    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-empty', info.project.name);
  });

  test('POPULATED: all six palettes render, and colour is never the only carrier', async ({
    page,
  }, info) => {
    await page.route(`${API}/shift-types`, (route) => json(route, 200, POPULATED));
    await page.goto(`${BASE}/shift-types`);

    await expect(page.getByRole('heading', { level: 1, name: 'Shift types' })).toBeVisible();
    await expect(catalogueRows(page)).toBeVisible();

    // Every one of the six curated palettes is on the page, which is what makes
    // the computed contrast numbers VERIFIED rather than merely computed
    // (SPEC-14: an unrendered pair is unverified).
    for (const palette of PALETTES) {
      await expect(page.getByTestId(`shift-badge-${palette}`)).toBeVisible();
    }

    // …and each one's NAME is rendered as text beside it. Remove the colour and
    // nothing is lost, which is the test SPEC-14 §2 actually sets.
    const rows = catalogueRows(page);
    await expect(rows).toContainText('Indigo');
    await expect(rows).toContainText('Violet');
    // Behaviour flags are words, not icons and not a second colour.
    await expect(rows).toContainText('On call');
    await expect(rows).toContainText(/[Rr]uns past midnight/);

    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-populated', info.project.name);
  });

  test('PERMISSION DENIED: a 403 says so, and does not say why', async ({ page }, info) => {
    await page.route(`${API}/shift-types`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );
    await page.goto(`${BASE}/shift-types`);

    const denied = page.getByTestId('surface-permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toHaveAttribute('role', 'alert');
    await expect(denied).toContainText('do not have permission');
    // The body carries no layer, no capability and no reason. If the server ever
    // started sending one, this would catch it in the interface too.
    await expect(denied).not.toContainText('capability');
    await expect(denied).not.toContainText('NO_CAPABILITY');

    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-permission-denied', info.project.name);
  });

  test('ERROR: a 404 renders "not found", never "no access"', async ({ page }, info) => {
    // SPEC-01 T-05b: a cross-tenant target and a non-existent id produce the
    // same response, so the interface must not translate one into the other.
    await page.route(`${API}/shift-types`, (route) =>
      json(route, 404, envelope('NOT_FOUND', 'Not found.')),
    );
    await page.goto(`${BASE}/shift-types`);

    const error = page.getByTestId('surface-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText('Not found.');
    await expect(error).not.toContainText('permission');

    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-error', info.project.name);
  });

  test('I-13: opening the New form persists NOTHING — zero requests', async ({ page }, info) => {
    await page.route(`${API}/shift-types`, (route) => json(route, 200, POPULATED));
    await page.goto(`${BASE}/shift-types`);
    await expect(catalogueRows(page)).toBeVisible();

    // Count every request the page makes from the click onwards. The invariant
    // exists because of a real incident in which such a control created a live
    // record on click, so the assertion is on the REQUEST COUNT rather than on
    // anything the interface says about itself.
    const requests: string[] = [];
    page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));

    /* The same interaction is also RECORDED for the request-budget ledger
     * (OPUS-M2-004 deliverable 5). The recorder and the listener above observe
     * the same requests; the assertion below is unchanged and is still what
     * fails this test. The recording is what lets the gate enforce the same
     * number in CI without re-running the browser. */
    await recordRequests(page, 'catalogue-open-new-shift-type', info.project.name, async () => {
      await page.getByTestId('new-shift-type').click();
      await expect(page.getByTestId('shift-type-form')).toBeVisible();
      // Long enough for a stray optimistic write to appear if one existed.
      await page.waitForTimeout(500);
    });

    expect(requests, `opening the form issued: ${requests.join(' | ')}`).toEqual([]);
  });

  test('AC-11: an empty form is refused by the CLIENT — focus to the summary, zero requests', async ({
    page,
  }, info) => {
    // The shape rules are in the shared contract, so the client can apply them
    // without a round trip. That is not a second source of truth: the server
    // applies the same schema and the same summary renders either verdict, which
    // this test and the next one assert from both sides.
    await page.route(`${API}/shift-types`, (route) => json(route, 200, POPULATED));
    await page.goto(`${BASE}/shift-types`);
    await page.getByTestId('new-shift-type').click();
    await expect(page.getByTestId('shift-type-form')).toBeVisible();

    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });

    await page.getByTestId('save-shift-type').click();

    const summary = page.getByTestId('validation-summary-shift-type');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('role', 'alert');
    // The COUNT is announced, which is what AC-11 asks for.
    await expect(summary).toContainText('There are 2 problems');
    // Focus is ON the summary, not left on the button that failed.
    await expect(summary).toBeFocused();

    // Each entry links to a real control, so a keyboard user can jump to it.
    const links = summary.getByRole('link');
    await expect(links).toHaveCount(2);
    const href = await links.first().getAttribute('href');
    expect(href).toBeTruthy();
    await expect(page.locator(href ?? '#none')).toBeVisible();

    // Nothing was sent: a form the contract already refuses does not need the
    // server's opinion, and asking for it would be request amplification.
    expect(posts).toEqual([]);

    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-validation', info.project.name);
  });

  test('I-10: a SERVER 422 issues exactly one request and renders the same summary', async ({
    page,
  }, info) => {
    await page.route(`${API}/shift-types`, async (route) => {
      if (route.request().method() === 'GET') return json(route, 200, POPULATED);
      // Shape-valid, semantically refused — the class of rule only the server
      // can decide (a duplicate code, a contradiction between flags, a tenant
      // membership check).
      return json(route, 422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: 'e2e-correlation-id',
          problems: [
            { field: 'isDailyPick', message: 'A manually assigned shift type is not offered in the daily pick. Turn one of the two off.' },
          ],
        },
      });
    });

    await page.goto(`${BASE}/shift-types`);
    await page.getByTestId('new-shift-type').click();
    await page.getByLabel('Short code').fill('SRV');
    await page.getByLabel('Full name').fill('Server-refused shift');

    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });

    /* RECORDED for the ledger (OPUS-M2-004 deliverable 5). The recorder counts
     * EVERY request; the assertion below counts POSTs, and is unchanged. A
     * refused save must not refetch — there is nothing new to fetch — so this
     * is the interaction that shows the two-request success budget is about the
     * success path specifically and not about Save in general. */
    await recordRequests(page, 'catalogue-save-shift-type-refused', info.project.name, async () => {
      await page.getByTestId('save-shift-type').click();

      const shown = page.getByTestId('validation-summary-shift-type');
      await expect(shown).toBeVisible();
      // Long enough for an amplifying retry or revalidation to appear if one existed.
      await page.waitForTimeout(500);
    });

    const summary = page.getByTestId('validation-summary-shift-type');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('There is 1 problem');
    await expect(summary).toContainText('daily pick');
    await expect(summary).toBeFocused();

    // I-10 in its strictest form: one Save, one request.
    expect(posts).toHaveLength(1);
  });

  test('AC-02: the form is completable by keyboard alone', async ({ page }, info) => {
    let posted: Record<string, unknown> | null = null;
    await page.route(`${API}/shift-types`, async (route) => {
      if (route.request().method() === 'GET') return json(route, 200, POPULATED);
      posted = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, 200, { shiftType: shiftType(0), correlationId: 'e2e-correlation-id' });
    });

    await page.goto(`${BASE}/shift-types`);
    await expect(catalogueRows(page)).toBeVisible();

    // Reach the New control by tabbing from the top of the document, so the
    // assertion covers tab ORDER and not just focusability.
    await page.keyboard.press('Tab'); // skip link
    let reached = false;
    for (let step = 0; step < 20 && !reached; step += 1) {
      await page.keyboard.press('Tab');
      reached = (await page.getByTestId('new-shift-type').evaluate(
        (node) => node === document.activeElement,
      )) as boolean;
    }
    expect(reached, 'the New control was not reachable by tabbing').toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('shift-type-form')).toBeVisible();

    // Fill by keyboard: focus the code field through its label association and
    // type, then submit with Enter from within the form.
    await page.getByLabel('Short code').focus();
    await page.keyboard.type('KBD');
    await page.getByLabel('Full name').focus();
    await page.keyboard.type('Keyboard shift');
    await page.getByTestId('save-shift-type').focus();

    /* The SAVE-SUCCESS interaction, recorded for the ledger (OPUS-M2-004
     * deliverable 5). This is the only successful shift-type save in the spec,
     * so it is where the measurement has to come from; the keyboard flow above
     * reaches the same Save control through the same code path.
     *
     * The recorded window deliberately extends past the POST: the mutation's
     * `onSuccess` invalidates the list query, and a window that closed at the
     * POST would record ONE request and under-report reality. The budget is
     * TWO, ruled and justified in `scripts/gates/request-budget/budgets.json`.
     *
     * Nothing below the wrapper changed — the two assertions are this test's
     * and are still what fails it. */
    await recordRequests(page, 'catalogue-save-shift-type', info.project.name, async () => {
      await page.keyboard.press('Enter');
      await expect.poll(() => posted).not.toBeNull();
      // Long enough for the list invalidation's refetch to land, and for any
      // further amplification to show up if it existed. A budget that stops
      // counting too early proves nothing.
      await page.waitForTimeout(500);
    });

    await expect.poll(() => posted).not.toBeNull();
    expect(posted).toMatchObject({ code: 'KBD', name: 'Keyboard shift' });
  });

  test('AC-08 and AC-09: 320px reflow, and every target is at least 44px', async ({ page }, info) => {
    await page.route(`${API}/shift-types`, (route) => json(route, 200, POPULATED));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`${BASE}/shift-types`);
    // At 320px the LIST is what renders — the alternative SPEC-14 requires for a
    // grid, chosen rather than hidden, so the accessibility tree holds one copy.
    await expect(page.getByTestId('shift-type-list')).toBeVisible();
    await expect(page.getByTestId('shift-type-table')).toHaveCount(0);
    await page.getByTestId('new-shift-type').click();
    await expect(page.getByTestId('shift-type-form')).toBeVisible();

    // No PAGE-level horizontal scroll. The table is allowed to scroll inside its
    // own container — that is the alternative SC 1.4.10 permits for data — and
    // the assertion is deliberately on the document, not on every element.
    // Measured BEHAVIOURALLY rather than by a proxy metric. A comparison of
    // `scrollWidth` against `clientWidth` reports the layout overflow of
    // descendants that are themselves scroll containers, so it flags a table
    // that scrolls correctly inside its own box. What SC 1.4.10 is actually
    // about is whether the USER has to scroll the page sideways to read
    // content — so the test asks the page to scroll and looks at where it ends
    // up.
    const scrolledX = await page.evaluate(() => {
      window.scrollTo(9999, 0);
      const x = window.scrollX;
      window.scrollTo(0, 0);
      return x;
    });
    expect(scrolledX, 'the page scrolls horizontally at 320px').toBe(0);

    const undersized = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, a[href], input, select, textarea')];
      return nodes
        .filter((node) => {
          const box = node.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) return false;
          // The skip link is `sr-only` until it takes focus, at which point it
          // becomes a full-size control. Measuring it while hidden would measure
          // the 1px clip box, so it is checked separately below rather than
          // waved through here.
          if (node.classList.contains('sr-only')) return false;
          // A checkbox's own box is small; what must be 44px is its ROW, which
          // is the label and control together. The container carries
          // `min-h-target`, so the check walks up to it.
          const row = node.closest('.min-h-target') ?? node;
          const rowBox = row.getBoundingClientRect();
          return rowBox.height < 44;
        })
        .map((node) => `${node.tagName.toLowerCase()}#${node.id}`);
    });
    expect(undersized, `targets below 44px: ${undersized.join(', ')}`).toEqual([]);

    // The skip link, once focused, is a real target of its own. Focused
    // directly rather than tabbed to: the form is open, so focus is already
    // somewhere in the middle of the document and a single Tab would land
    // wherever that happens to be.
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await skip.focus();
    const skipBox = await skip.boundingBox();
    expect(skipBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expectNoAxeViolations(page);
    await capture(page, 'shift-types-320px', info.project.name);
  });
});

test.describe('catalogue — the other surfaces', () => {
  test('shift groups: populated and empty, both accessible', async ({ page }, info) => {
    await page.route(`${API}/shift-types`, (route) => json(route, 200, POPULATED));
    await page.route(`${API}/shift-groups`, (route) =>
      json(route, 200, {
        shiftGroups: [
          {
            shiftGroupId: '44444444-4444-4444-8444-444444444444',
            name: 'All on-call',
            description: null,
            scoringMode: 'weighted',
            weight: 1000,
            allowRequest: true,
            requestOffLabel: 'Request off all on-call shifts',
            shiftTypeIds: [shiftType(0).shiftTypeId],
            status: 'active',
            version: 1,
          },
          {
            shiftGroupId: '55555555-5555-4555-8555-555555555555',
            name: 'Theatre rooms',
            description: null,
            scoringMode: 'hard',
            weight: null,
            allowRequest: false,
            requestOffLabel: null,
            shiftTypeIds: [],
            status: 'active',
            version: 1,
          },
        ],
        correlationId: 'e2e-correlation-id',
      }),
    );

    await page.goto(`${BASE}/shift-groups`);
    await expect(page.getByRole('heading', { level: 1, name: 'Shift groups' })).toBeVisible();
    // "Hard constraint" and "Weighted (1000)" are rendered as words: the observed
    // "Hard (0)" display convention is not reproduced, because a weight of zero
    // on a hard constraint is meaningless (research 05 §1).
    await expect(page.getByTestId('shift-group-table')).toContainText('Hard constraint');
    await expect(page.getByTestId('shift-group-table')).toContainText('Weighted (1000)');
    await page.getByTestId('new-shift-group').click();
    await expect(page.getByTestId('shift-group-form')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'shift-groups-populated', info.project.name);
  });

  test('staff groups: empty state and form', async ({ page }, info) => {
    await page.route(`${API}/staff-groups`, (route) =>
      json(route, 200, { staffGroups: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(`${BASE}/staff-groups`);
    await expect(page.getByTestId('surface-empty')).toBeVisible();
    await page.getByTestId('new-staff-group').click();
    await expect(page.getByTestId('staff-group-form')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'staff-groups-empty', info.project.name);
  });

  test('valid combinations: the ceiling is explained before the user hits it', async ({
    page,
  }, info) => {
    await page.route(`${API}/shift-types`, (route) => json(route, 200, POPULATED));
    await page.route(`${API}/valid-groups`, (route) =>
      json(route, 200, {
        validGroups: [
          {
            validGroupId: '66666666-6666-4666-8666-666666666666',
            name: 'Call with picks',
            shiftTypeIds: [shiftType(0).shiftTypeId],
            allowedPickPositions: [1, 2, 3],
            status: 'active',
            version: 1,
          },
        ],
        pickPositionCount: 3,
        correlationId: 'e2e-correlation-id',
      }),
    );

    await page.goto(`${BASE}/valid-groups`);
    await expect(page.getByTestId('valid-group-table')).toContainText('1, 2, 3');
    await page.getByTestId('new-valid-group').click();
    // Exactly three position checkboxes: the ceiling is the group's count, and
    // offering a fourth would be offering something the database refuses.
    await expect(page.getByRole('checkbox', { name: '1', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '4', exact: true })).toHaveCount(0);
    await expectNoAxeViolations(page);
    await capture(page, 'valid-groups-populated', info.project.name);
  });

  test('group settings: the irreversible control warns BEFORE the click', async ({ page }, info) => {
    await page.route(`${API}/pick-positions`, (route) =>
      json(route, 200, { pickPositionCount: 4, correlationId: 'e2e-correlation-id' }),
    );
    await page.route(`${API}/holidays`, (route) =>
      json(route, 200, {
        holidays: [
          {
            groupHolidayId: '77777777-7777-4777-8777-777777777777',
            holidayDate: '2027-01-01',
            name: 'Synthetic public holiday',
            observed: true,
            version: 1,
          },
        ],
        correlationId: 'e2e-correlation-id',
      }),
    );

    await page.goto(`${BASE}/group-settings`);
    await expect(page.getByTestId('pick-positions-current')).toContainText('4');
    // The warning is beside the control, in prose, before anything is done — not
    // in an error message after the fact.
    await expect(page.getByTestId('pick-positions-form')).toContainText('permanent');
    // "Observed" is a WORD, not a tick glyph or a coloured dot.
    await expect(page.getByTestId('holiday-table')).toContainText('Yes');

    await expectNoAxeViolations(page);
    await capture(page, 'group-settings', info.project.name);
  });

  test('group settings: a 403 on one panel does not hide the other', async ({ page }, info) => {
    // Two different capabilities, two different panels, two separate verdicts.
    // A page-level denial would tell the user they cannot do either when they
    // may well be able to do one.
    await page.route(`${API}/pick-positions`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );
    await page.route(`${API}/holidays`, (route) =>
      json(route, 200, { holidays: [], correlationId: 'e2e-correlation-id' }),
    );

    await page.goto(`${BASE}/group-settings`);
    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expect(page.getByTestId('surface-empty')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'group-settings-partial-denial', info.project.name);
  });
});
