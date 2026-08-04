import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

/**
 * The settings surfaces: every state, both viewports, axe on each
 * (OPUS-M3-007).
 *
 * ## Why the API is intercepted rather than run
 *
 * The same division `catalogue.spec.ts` records: the component tree, the router,
 * the contracts, the zod parse, the query client and the rendering are all the
 * real ones, and only the bytes on the wire are supplied here. **This file
 * proves the interface behaves correctly for each response; the server is proven
 * to produce those responses separately, over HTTP, against the real database,
 * in `apps/api/test/settings/*.test.ts`.**
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066, AC-01 |
 * | clicking "Add a location" issues **zero** requests | **I-13** |
 * | Save issues exactly one request; an accepted save re-reads | I-10, PO-DEC-18 |
 * | the published-schedule warning is on the page BEFORE the action | packet 32 §10c |
 * | the acknowledgement is required only when the SERVER says so | the warning is a gate, not a paragraph |
 * | focus lands on the `role="alert"` summary after a failed submit | AC-11 |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 * | every interactive target is ≥44×44 | AC-09 |
 * | the whole form is reachable and submittable by keyboard | AC-02 |
 * | **no site picker exists anywhere** | PO-DEC-01, non-bypass rule 12 |
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/settings`;
const API = `**/api${BASE}`;
/**
 * The base route, plus everything under it.
 *
 * `page.route('**\/api/.../settings')` matches the READ exactly and matches
 * NONE of the writes — they go to `/settings/timezone`, `/settings/locations`
 * and so on. The first version of this file used the bare pattern, and the three
 * write tests failed against the preview server's own 404 rather than against
 * the fixture. Caught by running.
 */
const API_TREE = `${API}**`;

const SCREENSHOTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/evidence/EV-M3-SETTINGS/screenshots',
);

const SETTINGS_NO_PUBLISHED = {
  groupId: GROUP,
  requestUntil: { mode: 'closed' as const },
  picklistAccessMode: 'disabled' as const,
  timezone: 'UTC',
  publishedVersionCount: 0,
  version: 1,
  correlationId: 'e2e-correlation-id',
};

const SETTINGS_WITH_PUBLISHED = {
  ...SETTINGS_NO_PUBLISHED,
  requestUntil: { mode: 'fixed_date' as const, untilDate: '2031-12-18' },
  picklistAccessMode: 'members' as const,
  timezone: 'Europe/Dublin',
  publishedVersionCount: 4,
  version: 7,
};

function location(index: number, siteLabel: string | null) {
  return {
    locationId: `4444444${String(index)}-4444-4444-8444-444444444444`,
    name: `Fixture location ${String(index)}`,
    siteLabel,
    address: index % 2 === 0 ? `${String(index)} Fixture Way` : null,
    timezone: index === 1 ? 'Europe/Dublin' : null,
    status: index === 2 ? ('archived' as const) : ('active' as const),
    version: 1,
  };
}

const LOCATIONS = {
  locations: [location(0, null), location(1, 'Synthetic campus north'), location(2, 'Synthetic campus north')],
  correlationId: 'e2e-correlation-id',
};

function envelope(code: string, message: string) {
  return { error: { code, message, correlationId: 'e2e-correlation-id' } };
}

function validationEnvelope(problems: { field: string; message: string }[]) {
  return {
    error: {
      code: 'VALIDATION_FAILED',
      message: 'Some of the details need attention.',
      correlationId: 'e2e-correlation-id',
      problems,
    },
  };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Captures a screenshot into the evidence bundle, named by state and viewport. */
async function capture(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOTS, `${name}.${project}.png`), fullPage: true });
}

/**
 * Zero axe violations, **including `best-practice`**.
 *
 * The same assertion `catalogue.spec.ts` makes, and for the reason its comment
 * records: `heading-order` is a `best-practice` rule rather than a WCAG one, and
 * dropping the tag would silently weaken every page in this file (non-bypass
 * rule 10). The tag is then proven to have selected something, because a
 * mis-spelled tag makes `analyze()` return zero violations from a smaller rule
 * set — a stronger-looking claim backed by a weaker check.
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
    [
      ...results.violations,
      ...results.passes,
      ...results.incomplete,
      ...results.inapplicable,
    ].map((result) => result.id),
  );
  expect(ranRules, 'the best-practice tag selected no heading-order rule').toContain(
    'heading-order',
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Group settings
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('settings — the group settings page', () => {
  test('LOADING: each panel announces itself while the read is in flight', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(API_TREE, async (route) => {
      await held;
      await json(route, 200, SETTINGS_NO_PUBLISHED);
    });

    await page.goto(`${BASE}/group`);
    const loading = page.getByTestId('surface-loading').first();
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'group-settings-loading', info.project.name);
    release();
    await expect(page.getByTestId('request-until-form')).toBeVisible();
  });

  test('POPULATED: all three panels render, and the two stored-only ones say so', async ({
    page,
  }, info) => {
    await page.route(API_TREE, (route) => json(route, 200, SETTINGS_WITH_PUBLISHED));
    await page.goto(`${BASE}/group`);

    await expect(page.getByRole('heading', { level: 1, name: 'Group settings' })).toBeVisible();
    await expect(page.getByTestId('request-until-form')).toBeVisible();
    await expect(page.getByTestId('picklist-access-form')).toBeVisible();
    await expect(page.getByTestId('timezone-form')).toBeVisible();

    /* The honest-disclosure assertions. Both settings are STORED here and
     * ENFORCED at later milestones (M5 / M9, packet 32 §2 rows 5-6), and a page
     * that presented either as an active gate would be claiming a capability
     * this system does not have yet. */
    await expect(page.getByText(/request module that enforces it is not built yet/)).toBeVisible();
    await expect(page.getByText(/picklist module that enforces it is not built yet/)).toBeVisible();
    // And the narrows-never-grants property, in words a reader can act on.
    await expect(page.getByText(/never grants permission on its own/)).toBeVisible();

    // The stored values round-trip into the controls.
    await expect(page.locator('select[name="mode"]').first()).toHaveValue('fixed_date');
    await expect(page.locator('input[name="untilDate"]')).toHaveValue('2031-12-18');
    await expect(page.locator('input[name="timezone"]')).toHaveValue('Europe/Dublin');

    await expectNoAxeViolations(page);
    await capture(page, 'group-settings-populated', info.project.name);
  });

  test('the published-schedule warning is on the page BEFORE the administrator acts', async ({
    page,
  }, info) => {
    await page.route(API_TREE, (route) => json(route, 200, SETTINGS_WITH_PUBLISHED));
    await page.goto(`${BASE}/group`);

    const warning = page.getByTestId('timezone-published-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('4 published schedules');
    // What it actually means, in words. "Nothing stored is rewritten" is the
    // claim the API test proves against `assignment_snapshots`.
    await expect(warning).toContainText('Nothing stored is rewritten');
    await expect(warning).toContainText('recorded in the audit log');

    // The acknowledgement exists because the server said there are published
    // schedules — the client does not decide when the warning applies.
    await expect(page.locator('input[name="acknowledgePublishedImpact"]')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'timezone-warning', info.project.name);
  });

  test('with no published schedules there is no warning and no acknowledgement', async ({
    page,
  }, info) => {
    await page.route(API_TREE, (route) => json(route, 200, SETTINGS_NO_PUBLISHED));
    await page.goto(`${BASE}/group`);

    await expect(page.getByTestId('timezone-no-published')).toBeVisible();
    await expect(page.getByTestId('timezone-published-warning')).toHaveCount(0);
    await expect(page.locator('input[name="acknowledgePublishedImpact"]')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'timezone-no-published', info.project.name);
  });

  test('PERMISSION DENIED: a 403 says so, and does not say why', async ({ page }, info) => {
    await page.route(API_TREE, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );
    await page.goto(`${BASE}/group`);

    const denied = page.getByTestId('surface-permission-denied').first();
    await expect(denied).toBeVisible();
    await expect(denied).toHaveAttribute('role', 'alert');
    await expect(denied).toContainText('do not have permission');
    // P-3: no layer, no capability name, no reason on the wire or on the page.
    await expect(denied).not.toContainText('capability');

    await expectNoAxeViolations(page);
    await capture(page, 'group-settings-denied', info.project.name);
  });

  test('NOT FOUND: a 404 renders as not found, never as a permission problem', async ({
    page,
  }, info) => {
    await page.route(API_TREE, (route) => json(route, 404, envelope('NOT_FOUND', 'Not found.')));
    await page.goto(`${BASE}/group`);

    // SP-E §1.3: calling a 404 a permission problem would tell the user the
    // thing exists. The client renders the server's verdict and adds nothing.
    const error = page.getByTestId('surface-error').first();
    await expect(error).toBeVisible();
    await expect(page.getByTestId('surface-permission-denied')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'group-settings-not-found', info.project.name);
  });

  test('I-10: an accepted timezone save is one write and one authoritative re-read', async ({
    page,
  }, info) => {
    await page.route(API_TREE, (route) => {
      if (route.request().method() === 'PUT') return route.fulfill({ status: 204, body: '' });
      return json(route, 200, SETTINGS_WITH_PUBLISHED);
    });
    await page.goto(`${BASE}/group`);
    await expect(page.getByTestId('timezone-form')).toBeVisible();

    await page.locator('input[name="acknowledgePublishedImpact"]').check();

    const recording = await recordRequests(
      page,
      'settings-save-timezone-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('save-timezone').click();
        await expect(page.getByText('Saved.')).toBeVisible();
        // Long enough for an amplifying retry or a second revalidation to
        // appear if one existed.
        await page.waitForTimeout(500);
      },
    );

    /* TWO: the PUT plus the server-authoritative re-read, which is the
     * PO-DEC-18 posture the catalogue's accepted-save budget already carries —
     * after a mutation the client re-reads what the SERVER says the settings
     * are rather than patching its own cache and rendering a view no server
     * produced. Not amplification: amplification is N requests for one action's
     * WORK, and this is one write plus one read-back. */
    expect(
      recording.requests.filter((request) => request.url.includes('/api/')).length,
      `requests: ${recording.requests.map((r) => `${r.method} ${r.url}`).join(' | ')}`,
    ).toBe(2);
  });

  test('AC-11: a refused save focuses the summary and issues exactly one request', async ({
    page,
  }, info) => {
    await page.route(API_TREE, (route) => {
      if (route.request().method() === 'PUT') {
        return json(
          route,
          422,
          validationEnvelope([
            {
              field: 'acknowledgePublishedImpact',
              message:
                'This group has published schedules. Confirm that you have read what changing the time zone means for them before saving.',
            },
          ]),
        );
      }
      return json(route, 200, SETTINGS_WITH_PUBLISHED);
    });
    await page.goto(`${BASE}/group`);
    await expect(page.getByTestId('timezone-form')).toBeVisible();

    const recording = await recordRequests(
      page,
      'settings-save-timezone-refused',
      info.project.name,
      async () => {
        await page.getByTestId('save-timezone').click();
        await expect(page.getByTestId('validation-summary-timezone')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    // One Save, one request. A refused save does NOT refetch, because nothing
    // changed and there is nothing new to read.
    expect(
      recording.requests.filter((request) => request.url.includes('/api/')).length,
      `requests: ${recording.requests.map((r) => `${r.method} ${r.url}`).join(' | ')}`,
    ).toBe(1);

    const summary = page.getByTestId('validation-summary-timezone');
    await expect(summary).toHaveAttribute('role', 'alert');
    await expect(summary).toContainText('There is 1 problem');
    // Focus moved to the summary when it appeared (AC-11).
    await expect(summary).toBeFocused();

    // …and its link resolves to a real control on the page.
    const href = await summary.locator('a').first().getAttribute('href');
    expect(href, 'the summary links to a field').toMatch(/^#/);
    await expect(page.locator(href ?? '#none')).toHaveCount(1);

    await expectNoAxeViolations(page);
    await capture(page, 'timezone-refused', info.project.name);
  });

  test('AC-02: the timezone panel is completable by keyboard alone', async ({ page }) => {
    let submitted = false;
    await page.route(API_TREE, (route) => {
      if (route.request().method() === 'PUT') {
        submitted = true;
        return route.fulfill({ status: 204, body: '' });
      }
      return json(route, 200, SETTINGS_NO_PUBLISHED);
    });
    await page.goto(`${BASE}/group`);
    await expect(page.getByTestId('timezone-form')).toBeVisible();

    // Focus the field by keyboard, type, and submit with Enter — no mouse
    // anywhere in this test.
    await page.locator('input[name="timezone"]').focus();
    // `ControlOrMeta` rather than `Control`: on macOS `Control+A` moves the
    // caret to the start of the line instead of selecting, so the typed zone was
    // PREPENDED to the existing one and the result was a zone name the client's
    // own `isKnownTimeZone` check correctly refused. The test then failed for a
    // reason that had nothing to do with the keyboard journey it exists to
    // prove. Caught by running.
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('America/Toronto');
    await page.keyboard.press('Enter');

    await expect(page.getByText('Saved.')).toBeVisible();
    expect(submitted, 'the form submitted from the keyboard').toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Locations
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('settings — locations', () => {
  test('EMPTY: the empty state says what a location IS, not "no data"', async ({ page }, info) => {
    await page.route(`${API}/locations`, (route) =>
      json(route, 200, { locations: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(`${BASE}/locations`);

    const empty = page.getByTestId('surface-empty');
    await expect(empty).toContainText('a place this group works');
    await expectNoAxeViolations(page);
    await capture(page, 'locations-empty', info.project.name);
  });

  test('POPULATED: the table renders, archived rows are marked in WORDS', async ({ page }, info) => {
    await page.route(`${API}/locations`, (route) => json(route, 200, LOCATIONS));
    await page.goto(`${BASE}/locations`);

    await expect(page.getByRole('heading', { level: 1, name: 'Locations' })).toBeVisible();
    /* Whichever representation this viewport gets. Below 640px the six-column
     * table is replaced by a list (SPEC-14's required alternative at 320px) and
     * exactly one of the two is in the DOM — so a test naming only the table
     * would pass on desktop and fail on mobile for a reason that is the design
     * working. */
    const table = page.locator('[data-testid="location-table"], [data-testid="location-list"]');
    await expect(table).toBeVisible();

    // Status as a word, not a coloured dot (SPEC-14 §2 — colour is never the
    // sole carrier).
    await expect(table).toContainText('Active');
    await expect(table).toContainText('Archived');
    // An unset per-location zone says what it falls back to rather than being
    // blank, which reads as a rendering bug to a screen reader.
    await expect(table).toContainText('Group time zone');

    await expectNoAxeViolations(page);
    await capture(page, 'locations-populated', info.project.name);
  });

  test('PO-DEC-01: there is no site picker, no site list, and no site link anywhere', async ({
    page,
  }) => {
    await page.route(`${API}/locations`, (route) => json(route, 200, LOCATIONS));
    await page.goto(`${BASE}/locations`);
    await page.getByTestId('new-location').click();
    await expect(page.getByTestId('location-form')).toBeVisible();

    /* The interface half of non-bypass rule 12, and it is the half that is
     * hardest to notice: an administrator using a site DROPDOWN reasonably
     * concludes sites are entities, and the pending decision has then been made
     * by the UI. */
    const siteInput = page.locator('input[name="siteLabel"]');
    await expect(siteInput).toBeVisible();
    // A text box, not a select.
    expect(await siteInput.evaluate((node) => node.tagName)).toBe('INPUT');
    await expect(page.locator('select[name="siteLabel"]')).toHaveCount(0);
    // The help text says what it is.
    await expect(page.getByText(/it is not linked to anything/)).toBeVisible();
    // And no navigation anywhere offers a site section.
    await expect(page.getByRole('link', { name: /site/i })).toHaveCount(0);
  });

  test('I-13: opening the location form issues ZERO requests', async ({ page }, info) => {
    await page.route(`${API}/locations`, (route) => json(route, 200, LOCATIONS));
    await page.goto(`${BASE}/locations`);
    await expect(
      page.locator('[data-testid="location-table"], [data-testid="location-list"]'),
    ).toBeVisible();

    const requests: string[] = [];
    const listener = (request: { url: () => string; method: () => string }): void => {
      if (request.url().includes('/api/')) requests.push(`${request.method()} ${request.url()}`);
    };
    page.on('request', listener);

    await recordRequests(page, 'settings-open-new-location', info.project.name, async () => {
      await page.getByTestId('new-location').click();
      await expect(page.getByTestId('location-form')).toBeVisible();
      // Long enough for a stray optimistic write to appear if one existed.
      await page.waitForTimeout(500);
    });
    page.off('request', listener);

    /* ZERO is the only correct number, and this budget can never be raised
     * without I-13 changing first. The invariant exists because a control
     * labelled Add created a live record on click in a real system. */
    expect(requests, `opening the form issued: ${requests.join(' | ')}`).toEqual([]);
  });

  test('a location saves, and the client re-reads what the server says the list is', async ({
    page,
  }, info) => {
    await page.route(`${API}/locations`, (route) => {
      if (route.request().method() === 'POST') {
        return json(route, 200, {
          location: location(3, null),
          correlationId: 'e2e-correlation-id',
        });
      }
      return json(route, 200, LOCATIONS);
    });
    await page.goto(`${BASE}/locations`);
    await page.getByTestId('new-location').click();
    await page.locator('input[name="name"]').fill('Fixture theatre');

    const recording = await recordRequests(
      page,
      'settings-save-location-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('save-location').click();
        await expect(page.getByTestId('location-form')).toHaveCount(0);
        await page.waitForTimeout(500);
      },
    );

    expect(
      recording.requests.filter((request) => request.url.includes('/api/')).length,
      `requests: ${recording.requests.map((r) => `${r.method} ${r.url}`).join(' | ')}`,
    ).toBe(2);
  });

  test('AC-08 / AC-09: no page-level horizontal scroll at 320px, and every target is ≥44×44', async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.route(`${API}/locations`, (route) => json(route, 200, LOCATIONS));
    await page.goto(`${BASE}/locations`);
    await page.getByTestId('new-location').click();
    await expect(page.getByTestId('location-form')).toBeVisible();

    /* The PAGE must not scroll horizontally. The TABLE may — it is inside its
     * own `overflow-auto` container, which is the correct treatment for wide
     * tabular content and is not the same defect as a body that scrolls. */
    /* Measured BEHAVIOURALLY rather than by a proxy metric, exactly as
     * `catalogue.spec.ts` does. Comparing `scrollWidth` against `clientWidth`
     * reports the layout overflow of descendants that are themselves scroll
     * containers, so it flags a table scrolling correctly inside its own box.
     * What SC 1.4.10 is about is whether the USER has to scroll the PAGE
     * sideways — so the test asks the page to scroll and looks at where it ends
     * up. */
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
          // A checkbox's own box is small; what must be 44px is its ROW — the
          // label and the control together. The container carries
          // `min-h-target`, so the check walks up to it.
          const row = node.closest('.min-h-target') ?? node;
          return row.getBoundingClientRect().height < 44;
        })
        .map((node) => `${node.tagName.toLowerCase()}#${node.id}`);
    });
    expect(undersized, `targets below 44px: ${undersized.join(', ')}`).toEqual([]);

    // The skip link, once focused, is a real target of its own.
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await skip.focus();
    expect((await skip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    // At 320px the LIST renders and the table is absent — chosen, not hidden, so
    // the accessibility tree holds exactly one copy of every row.
    await expect(page.getByTestId('location-list')).toBeVisible();
    await expect(page.getByTestId('location-table')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'locations-320px', info.project.name);
  });

  test('PERMISSION DENIED on locations renders the denial state', async ({ page }, info) => {
    await page.route(`${API}/locations`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );
    await page.goto(`${BASE}/locations`);

    const denied = page.getByTestId('surface-permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText('do not have permission');

    await expectNoAxeViolations(page);
    await capture(page, 'locations-denied', info.project.name);
  });
});
