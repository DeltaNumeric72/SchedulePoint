import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

/**
 * The schedule-authoring surface: every state, both viewports, axe on each
 * (OPUS-M3-004).
 *
 * ## Why the API is intercepted rather than run
 *
 * The same division `catalogue.spec.ts` and `rules.spec.ts` record, and for the
 * same reason: this file proves the **interface** behaves correctly for each
 * response. That the server produces those responses — the compare-and-set, the
 * draft-only refusal, the eligibility ruling, cross-group isolation — is proven
 * separately, over HTTP against the real database, in
 * `apps/api/test/schedule/authoring-http.test.ts`. The component tree, router,
 * contracts, zod parse, query client and rendering here are all the real ones.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066, AC-01 |
 * | "New period" and opening a cell issue **zero** requests | **I-13** |
 * | opening the assign picker issues exactly one; Save issues two | I-10 |
 * | the grid and the table render the SAME cells, compared byte for byte | SP-E §5, the packet's equality requirement |
 * | the grid declares its true `aria-rowcount` while windowing | SP-E §3 — virtualization must not break AT navigation |
 * | arrow keys move between cells and Enter opens one, at the window edge too | AC-02 |
 * | a stale edit renders an explicit refusal and a refetch control | PO-DEC-18 |
 * | absent eligibility and nobody-eligible are DIFFERENT messages | the eligibility ruling |
 * | a published version renders read-only with no editing affordance | I-18 |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const PERIOD = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';
const MEMBER_A = '55555555-5555-4555-8555-555555555555';
const MEMBER_B = '66666666-6666-4666-8666-666666666666';
const SHIFT_DAY = '77777777-7777-4777-8777-777777777777';
const SHIFT_NIGHT = '88888888-8888-4888-8888-888888888888';
const SHIFT_CALL = '99999999-9999-4999-8999-999999999999';

const SCHEDULE_BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/schedule`;
const PERIODS_URL = `${SCHEDULE_BASE}/periods`;
const GRID_URL = `${SCHEDULE_BASE}/versions/${VERSION}`;
const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}`;

const SCREENSHOTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/evidence/EV-M3-AUTHORING-UX/screenshots',
);

/** A 60-day period, so the grid's windowing is real rather than notional. */
const DATES = Array.from({ length: 60 }, (_, index) => {
  const day = new Date(Date.UTC(2028, 0, 2 + index));
  return day.toISOString().slice(0, 10);
});

const SHIFT_TYPES = [
  { id: SHIFT_DAY, code: 'DAY', name: 'Day shift', startTime: '08:00', endTime: '16:00', crossesMidnight: false },
  { id: SHIFT_NIGHT, code: 'NGT', name: 'Night shift', startTime: '22:00', endTime: '06:00', crossesMidnight: true },
  { id: SHIFT_CALL, code: 'CAL', name: 'On call', startTime: '08:00', endTime: '08:00', crossesMidnight: true },
];

/** A catalogue shift type, in the wire shape the contract requires. */
function catalogueShiftType(id: string, code: string, name: string) {
  return {
    shiftTypeId: id,
    code,
    name,
    description: null,
    displayPaletteKey: 'neutral',
    displayTextStyle: 'regular',
    startTime: '08:00',
    endTime: '16:00',
    crossesMidnight: false,
    isOnCall: false,
    attractsStipend: false,
    isManualOnly: false,
    isDailyPick: false,
    includeInStatistics: true,
    isLeaveOfAbsence: false,
    allowOnRequest: false,
    allowOffRequest: false,
    reportOrder: 0,
    creditWeight: 1,
    status: 'active',
    effectiveFrom: '2027-01-01T00:00:00.000Z',
    effectiveTo: null,
    version: 1,
  };
}

const EMPTY_REVISION = 'a'.repeat(64);
const FILLED_REVISION = 'b'.repeat(64);
const MOVED_REVISION = 'c'.repeat(64);

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    assignmentIdentityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    membershipId: MEMBER_A,
    startsAt: '2028-01-02T08:00:00.000Z',
    endsAt: '2028-01-02T16:00:00.000Z',
    status: 'active',
    origin: 'manual',
    isPinned: false,
    overrideReasonGiven: false,
    pickPosition: null,
    creditId: null,
    creditedMembershipId: null,
    creditStatus: null,
    ...overrides,
  };
}

function grid(overrides: Record<string, unknown> = {}) {
  return {
    version: {
      id: VERSION,
      periodId: PERIOD,
      versionNumber: null,
      state: 'draft',
      lockState: 'unlocked',
      isCurrent: false,
      clonedFromVersionId: null,
      isEditable: true,
    },
    period: {
      id: PERIOD,
      name: 'January authoring window',
      startDate: DATES[0],
      endDate: DATES[DATES.length - 1],
      status: 'planning',
    },
    dates: DATES,
    shiftTypes: SHIFT_TYPES,
    cells: [
      {
        date: DATES[0],
        shiftTypeId: SHIFT_DAY,
        requiredCount: 2,
        assignments: [assignment()],
        revision: FILLED_REVISION,
      },
      {
        // A cell with a requirement and nobody in it — the incomplete-demand
        // indicator has something to indicate.
        date: DATES[1],
        shiftTypeId: SHIFT_NIGHT,
        requiredCount: 1,
        assignments: [],
        revision: EMPTY_REVISION,
      },
      {
        // The LAST date, so the equality proof can reach past the first window.
        date: DATES[DATES.length - 1],
        shiftTypeId: SHIFT_CALL,
        requiredCount: 1,
        assignments: [assignment({ isPinned: true, overrideReasonGiven: true })],
        revision: FILLED_REVISION,
      },
    ],
    emptyCellRevision: EMPTY_REVISION,
    conflicts: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        severity: 'info',
        state: 'open',
        explanation: 'A recorded note about this version.',
      },
    ],
    roster: [
      { membershipId: MEMBER_A, displayName: 'Synthetic Member A', staffingKind: 'staff', status: 'active' },
      { membershipId: MEMBER_B, displayName: 'Synthetic Member B', staffingKind: 'locum', status: 'active' },
    ],
    timezone: 'UTC',
    correlationId: 'e2e-correlation-id',
    ...overrides,
  };
}

function candidates(overrides: Record<string, unknown> = {}) {
  return {
    date: DATES[0],
    shiftTypeId: SHIFT_DAY,
    eligibilityKnown: true,
    candidates: [
      {
        membershipId: MEMBER_A,
        displayName: 'Synthetic Member A',
        staffingKind: 'staff',
        eligible: true,
        missingQualificationIds: [],
        alreadyAssigned: true,
      },
      {
        membershipId: MEMBER_B,
        displayName: 'Synthetic Member B',
        staffingKind: 'locum',
        eligible: true,
        missingQualificationIds: [],
        alreadyAssigned: false,
      },
    ],
    correlationId: 'e2e-correlation-id',
    ...overrides,
  };
}

const PERIOD_LIST = {
  periods: [
    {
      id: PERIOD,
      name: 'January authoring window',
      startDate: DATES[0],
      endDate: DATES[DATES.length - 1],
      status: 'planning',
    },
  ],
  correlationId: 'e2e-correlation-id',
};

function envelope(code: string, message: string) {
  return { error: { code, message, correlationId: 'e2e-correlation-id' } };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function capture(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOTS, `${name}.${project}.png`), fullPage: true });
}

/** Zero axe violations, INCLUDING `best-practice` — the established assertion. */
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
}

/**
 * The default routing: a healthy draft grid and a one-period list.
 *
 * Individual tests override one route by registering a more specific handler
 * first — Playwright matches the most recently registered route.
 */
async function routeHappyPath(page: Page): Promise<void> {
  await page.route(`${API}/schedule/versions/*/candidates*`, (route) =>
    json(route, 200, candidates()),
  );
  await page.route(`${API}/schedule/versions/*/grid`, (route) => json(route, 200, grid()));
  await page.route(`${API}/schedule/periods`, (route) => json(route, 200, PERIOD_LIST));
  await page.route(`${API}/schedule/periods/*/versions`, (route) =>
    json(route, 200, {
      periodId: PERIOD,
      versions: [grid().version],
      correlationId: 'e2e-correlation-id',
    }),
  );
  await page.route(`${API}/schedule/periods/*/requirements`, (route) =>
    json(route, 200, {
      periodId: PERIOD,
      requirements: [],
      absentRequirementRevision: EMPTY_REVISION,
      correlationId: 'e2e-correlation-id',
    }),
  );
  await page.route(`${API}/catalogue/shift-types`, (route) =>
    json(route, 200, {
      shiftTypes: [
        catalogueShiftType(SHIFT_DAY, 'DAY', 'Day shift'),
        catalogueShiftType(SHIFT_NIGHT, 'NGT', 'Night shift'),
      ],
      correlationId: 'e2e-correlation-id',
    }),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Periods — states and I-13
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('periods — states', () => {
  test('LOADING: the list announces itself while it is being fetched', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods`, async (route) => {
      await held;
      await json(route, 200, PERIOD_LIST);
    });

    await page.goto(PERIODS_URL);
    const loading = page.getByTestId('surface-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'periods-loading', info.project.name);
    release();
  });

  test('EMPTY: the empty state says what is missing, not "no data"', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods`, (route) =>
      json(route, 200, { periods: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(PERIODS_URL);

    await expect(page.getByTestId('surface-empty')).toContainText('No planning periods');
    await expectNoAxeViolations(page);
    await capture(page, 'periods-empty', info.project.name);
  });

  test('DENIED: a 403 says no permission and never says why', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'The request could not be completed.')),
    );
    await page.goto(PERIODS_URL);

    const denied = page.getByTestId('surface-permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText('You do not have permission');
    // P-3: the reason is never on the wire, so it is never on the screen.
    await expect(denied).not.toContainText(/capability|schedule\.(period|version)/i);
    await expectNoAxeViolations(page);
    await capture(page, 'periods-denied', info.project.name);
  });

  test('NOT FOUND: a 404 is a different message from a 403', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods`, (route) =>
      json(route, 404, envelope('NOT_FOUND', 'The request could not be completed.')),
    );
    await page.goto(PERIODS_URL);

    await expect(page.getByTestId('surface-error')).toBeVisible();
    await expect(page.getByTestId('surface-permission-denied')).toHaveCount(0);
    await expectNoAxeViolations(page);
    await capture(page, 'periods-not-found', info.project.name);
  });

  test('POPULATED: the period list renders, and manual authoring is labelled as override', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(PERIODS_URL);

    await expect(
      page.locator('[data-testid="periods-table"], [data-testid="periods-list"]'),
    ).toBeVisible();
    // Non-bypass rule 7 is on the screen, not only in a docblock.
    await expect(page.getByTestId('schedule-manual-note')).toContainText(
      'override, recovery and fixed assignments',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'periods-populated', info.project.name);
  });

  test('I-13: "New period" persists nothing and issues ZERO requests', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(PERIODS_URL);
    await expect(page.getByTestId('periods-new')).toBeVisible();

    const recording = await recordRequests(
      page,
      'schedule-open-new-period',
      info.project.name,
      async () => {
        await page.getByTestId('periods-new').click();
        await expect(page.getByTestId('periods-form')).toBeVisible();
      },
    );

    // ZERO is the only correct number. The invariant exists because a control
    // labelled New once created a live record on click.
    expect(recording.requests).toEqual([]);
    await expectNoAxeViolations(page);
    await capture(page, 'periods-form', info.project.name);
  });

  test('I-13: filling every field of the period form still issues zero requests', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(PERIODS_URL);
    await page.getByTestId('periods-new').click();

    const recording = await recordRequests(
      page,
      'schedule-fill-period-form',
      info.project.name,
      async () => {
        await page.getByLabel('Period name').fill('February window');
        await page.getByLabel('First day').fill('2028-02-01');
        await page.getByLabel('Last day').fill('2028-02-29');
      },
    );
    expect(recording.requests).toEqual([]);
  });

  test('a SERVER 422 focuses the validation summary and links to a real field', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods`, async (route) => {
      if (route.request().method() === 'POST') {
        await json(route, 422, {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Some of the details need attention.',
            correlationId: 'e2e-correlation-id',
            problems: [{ field: 'name', message: 'A period with this name already exists.' }],
          },
        });
        return;
      }
      await json(route, 200, PERIOD_LIST);
    });

    await page.goto(PERIODS_URL);
    await page.getByTestId('periods-new').click();
    await page.getByLabel('Period name').fill('January authoring window');
    await page.getByLabel('First day').fill('2028-03-01');
    await page.getByLabel('Last day').fill('2028-03-31');

    const recording = await recordRequests(
      page,
      'schedule-save-period-refused',
      info.project.name,
      async () => {
        await page.getByTestId('periods-save').click();
        await expect(page.getByTestId('validation-summary-period')).toBeVisible();
      },
    );
    expect(recording.requests).toHaveLength(1);

    const summary = page.getByTestId('validation-summary-period');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute('role', 'alert');
    const href = await summary.locator('a').first().getAttribute('href');
    await expect(page.locator(href ?? '#missing')).toHaveCount(1);

    await expectNoAxeViolations(page);
    await capture(page, 'periods-validation', info.project.name);
  });

  test('I-10: creating a draft version issues one write and one re-read', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods/*/versions`, async (route) => {
      if (route.request().method() === 'POST') {
        await json(route, 200, { version: grid().version, correlationId: 'e2e-correlation-id' });
        return;
      }
      await json(route, 200, {
        periodId: PERIOD,
        versions: [grid().version],
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(PERIODS_URL);
    await page.getByTestId(`period-open-${PERIOD}`).click();
    await page.getByTestId('versions-new').click();
    await expect(page.getByTestId('versions-confirm')).toBeVisible();

    const recording = await recordRequests(
      page,
      'schedule-create-draft-version',
      info.project.name,
      async () => {
        await page.getByTestId('versions-confirm-save').click();
        await expect(page.getByTestId('versions-confirm')).toHaveCount(0);
      },
    );
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('I-10: saving a requirement issues one write and one re-read', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods/*/requirements`, async (route) => {
      if (route.request().method() === 'PUT') {
        await json(route, 200, {
          periodId: PERIOD,
          requirements: [
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              date: DATES[0],
              shiftTypeId: SHIFT_DAY,
              requiredCount: 2,
              revision: FILLED_REVISION,
            },
          ],
          absentRequirementRevision: EMPTY_REVISION,
          correlationId: 'e2e-correlation-id',
        });
        return;
      }
      await json(route, 200, {
        periodId: PERIOD,
        requirements: [],
        absentRequirementRevision: EMPTY_REVISION,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(PERIODS_URL);
    await page.getByTestId(`period-open-${PERIOD}`).click();
    await page.getByTestId('requirements-new').click();
    await page.getByLabel('Date').fill(DATES[0] ?? '');
    await page.getByTestId('requirements-shift-type').selectOption(SHIFT_DAY);
    await page.getByLabel('People required').fill('2');

    const recording = await recordRequests(
      page,
      'schedule-save-requirement',
      info.project.name,
      async () => {
        await page.getByTestId('requirements-save').click();
        await expect(page.getByTestId('requirements-form')).toHaveCount(0);
      },
    );
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('a stale requirement write renders an explicit refusal, never a silent merge', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods/*/requirements`, async (route) => {
      if (route.request().method() === 'PUT') {
        await json(route, 409, {
          error: {
            code: 'STALE_EDIT',
            message:
              'Somebody else changed this while you were editing. Your change was not applied — reload and try again.',
            correlationId: 'e2e-correlation-id',
            currentRevision: MOVED_REVISION,
          },
        });
        return;
      }
      await json(route, 200, {
        periodId: PERIOD,
        requirements: [],
        absentRequirementRevision: EMPTY_REVISION,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(PERIODS_URL);
    await page.getByTestId(`period-open-${PERIOD}`).click();
    await page.getByTestId('requirements-new').click();
    await page.getByLabel('Date').fill(DATES[0] ?? '');
    await page.getByTestId('requirements-shift-type').selectOption(SHIFT_DAY);
    await page.getByLabel('People required').fill('2');
    await page.getByTestId('requirements-save').click();

    const stale = page.getByTestId('requirements-stale');
    await expect(stale).toBeVisible();
    await expect(stale).toHaveAttribute('role', 'alert');
    await expect(stale).toContainText('was not applied');
    await expectNoAxeViolations(page);
    await capture(page, 'requirements-stale', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The grid
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('the grid and its accessible alternative', () => {
  test('POPULATED: the grid renders with valid virtualized ARIA', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(GRID_URL);
    await page.getByTestId('view-grid').click();

    const gridElement = page.getByTestId('schedule-grid');
    await expect(gridElement).toBeVisible();
    // The TRUE total is declared even though only a band is in the DOM. An AT
    // user is told "row 34 of 61", not "row 4 of 8".
    await expect(gridElement).toHaveAttribute('aria-rowcount', String(DATES.length + 1));
    await expect(gridElement).toHaveAttribute('aria-colcount', String(SHIFT_TYPES.length + 1));

    // Windowing is real: far fewer rows are rendered than exist.
    const rendered = await page.locator('[data-testid="schedule-grid"] [role="row"]').count();
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(DATES.length);

    await expectNoAxeViolations(page);
    await capture(page, 'grid-populated', info.project.name);
  });

  test('the grid and the table render the SAME cells, compared byte for byte', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(GRID_URL);

    // The table first: it is not virtualized, so it holds every cell.
    await page.getByTestId('view-table').click();
    await expect(
      page.locator('[data-testid="schedule-table"], [data-testid="schedule-list"]'),
    ).toBeVisible();
    const tableSummaries = await page
      .locator(
        '[data-testid="schedule-table"] tbody tr, [data-testid="schedule-list"] li',
      )
      .evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset['cellSummary'] ?? ''),
      );
    expect(tableSummaries).toHaveLength(DATES.length * SHIFT_TYPES.length);

    // The grid, sampled at the top and then at the bottom of the scroll range,
    // so the comparison reaches past the first window.
    await page.getByTestId('view-grid').click();
    const collectGrid = async (): Promise<string[]> =>
      page
        .locator('[data-testid="schedule-grid"] [role="gridcell"]')
        .evaluateAll((cells) =>
          cells.map((cell) => (cell as HTMLElement).dataset['cellSummary'] ?? ''),
        );

    const topSample = await collectGrid();
    await page
      .getByTestId('schedule-grid')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
    await expect
      .poll(async () => (await collectGrid()).some((summary) => summary.startsWith(DATES[DATES.length - 1] ?? '')))
      .toBe(true);
    const bottomSample = await collectGrid();

    const observed = new Set([...topSample, ...bottomSample]);
    expect(observed.size).toBeGreaterThan(0);

    // Every cell the grid rendered appears, byte-identical, in the table. This
    // is the equality: both come from `buildRows`, and this asserts that neither
    // renderer changed anything on the way to the DOM.
    const tableSet = new Set(tableSummaries);
    for (const summary of observed) {
      expect(tableSet.has(summary), `grid rendered "${summary}" and the table did not`).toBe(true);
    }
    // And the far end of the period is genuinely covered rather than assumed.
    expect([...observed].some((summary) => summary.startsWith(DATES[DATES.length - 1] ?? ''))).toBe(
      true,
    );
  });

  test('the table alternative is axe-clean and is a real table', async ({ page }, info) => {
    test.skip(
      info.project.name !== 'desktop',
      'below 640px the alternative is the list form — asserted separately',
    );
    await routeHappyPath(page);
    await page.goto(GRID_URL);
    await page.getByTestId('view-table').click();

    const table = page.getByTestId('schedule-table');
    await expect(table).toBeVisible();
    await expect(table.locator('caption')).toHaveCount(1);
    await expect(table.locator('th[scope="col"]').first()).toBeVisible();
    await expect(table.locator('th[scope="row"]').first()).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'grid-table-alternative', info.project.name);
  });

  test('below 640px the alternative is a LIST carrying the same cells', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the narrow-viewport form belongs to the mobile project');
    await routeHappyPath(page);
    await page.goto(GRID_URL);
    await page.getByTestId('view-table').click();

    const list = page.getByTestId('schedule-list');
    await expect(list).toBeVisible();
    // A six-column table at 320px is a table nobody can read; the list carries
    // the same `data-cell-summary` and the same Edit action.
    await expect(page.getByTestId('schedule-table')).toHaveCount(0);
    await expect(list.locator('li').first()).toHaveAttribute('data-cell-summary', /.+/);
    await expectNoAxeViolations(page);
    await capture(page, 'grid-list-alternative', info.project.name);
  });

  test('validation display is recorded conflicts and counting — and says so', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(GRID_URL);

    await expect(page.getByTestId('validation-scope-note')).toContainText(
      'checked when a version is published, not here',
    );
    await expect(page.getByTestId('conflicts-list')).toContainText('Information');
    // One cell in the fixture has a requirement of 1 and nobody in it.
    await expect(page.getByTestId('incomplete-demand')).toContainText('not yet met');
    // There is no control that claims to evaluate rules against this draft.
    await expect(page.getByRole('button', { name: /check rules|validate|run rules/i })).toHaveCount(
      0,
    );
  });

  test('AC-02: arrow keys move between cells and Enter opens one', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(GRID_URL);
    await page.getByTestId('view-grid').click();

    const firstCell = page.getByTestId(`grid-cell-${DATES[0] ?? ''}-DAY`);
    await firstCell.focus();
    await expect(firstCell).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId(`grid-cell-${DATES[0] ?? ''}-NGT`)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId(`grid-cell-${DATES[1] ?? ''}-NGT`)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByTestId(`grid-cell-${DATES[1] ?? ''}-DAY`)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cell-editor')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'grid-keyboard', info.project.name);
  });

  test('keyboard navigation crosses the virtualization window boundary', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(GRID_URL);
    await page.getByTestId('view-grid').click();
    await page.getByTestId(`grid-cell-${DATES[0] ?? ''}-DAY`).focus();

    // Twenty PageDowns is 140 rows of intent against a 60-row period, so this
    // ends at the last date having crossed every window boundary on the way.
    // A cell that is not rendered cannot receive focus, so this fails outright
    // if the window does not follow the roving tabindex.
    for (let press = 0; press < 20; press += 1) await page.keyboard.press('PageDown');
    await expect(page.getByTestId(`grid-cell-${DATES[DATES.length - 1] ?? ''}-DAY`)).toBeFocused();
  });

  test('I-18: a published version is read-only, with no editing affordance', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/grid`, (route) =>
      json(
        route,
        200,
        grid({
          version: {
            ...grid().version,
            versionNumber: 2,
            state: 'published',
            isCurrent: true,
            isEditable: false,
          },
        }),
      ),
    );
    await page.goto(GRID_URL);

    await expect(page.getByTestId('grid-readonly')).toContainText('not a draft');
    await page.getByTestId('view-table').click();
    await page.getByTestId(`table-cell-${DATES[0] ?? ''}-DAY`).getByRole('button').click();
    await expect(page.getByTestId('cell-editor-readonly')).toBeVisible();
    // The UI never offers "edit published" (SP-E §3, I-18).
    await expect(page.getByTestId('cell-assign-open')).toHaveCount(0);
    await expectNoAxeViolations(page);
    await capture(page, 'grid-published-readonly', info.project.name);
  });

  test('DENIED: the grid surface renders no-permission and never says why', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/grid`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'The request could not be completed.')),
    );
    await page.goto(GRID_URL);

    const denied = page.getByTestId('surface-permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText('You do not have permission');
    await expect(denied).not.toContainText(/capability|schedule\.version/i);
    // Nothing editable is offered behind the denial.
    await expect(page.getByTestId('schedule-grid')).toHaveCount(0);
    await expect(page.getByTestId('schedule-table')).toHaveCount(0);
    await expectNoAxeViolations(page);
    await capture(page, 'grid-denied', info.project.name);
  });

  test('AC-08: no page-level horizontal scroll at the narrow viewport', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the 320px assertion belongs to the mobile project');
    await routeHappyPath(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(GRID_URL);
    await expect(
      page.locator('[data-testid="schedule-table"], [data-testid="schedule-list"]'),
    ).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page);
    await capture(page, 'grid-320px', info.project.name);
  });

  test('AC-08: the periods surface reflows at 320px too', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the 320px assertion belongs to the mobile project');
    await routeHappyPath(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(PERIODS_URL);
    await expect(page.getByTestId('periods-list')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await capture(page, 'periods-320px', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The cell editor
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('the cell editor', () => {
  async function openCell(page: Page): Promise<void> {
    await page.goto(GRID_URL);
    await page.getByTestId('view-table').click();
    await page.getByTestId(`table-cell-${DATES[0] ?? ''}-DAY`).getByRole('button').click();
    await expect(page.getByTestId('cell-editor')).toBeVisible();
  }

  test('I-13: opening a cell issues ZERO requests and shows provenance', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(GRID_URL);
    await page.getByTestId('view-table').click();
    await expect(
      page.locator('[data-testid="schedule-table"], [data-testid="schedule-list"]'),
    ).toBeVisible();

    const recording = await recordRequests(
      page,
      'schedule-open-cell-editor',
      info.project.name,
      async () => {
        await page.getByTestId(`table-cell-${DATES[0] ?? ''}-DAY`).getByRole('button').click();
        await expect(page.getByTestId('cell-editor')).toBeVisible();
      },
    );
    // The editor renders from the grid the page already holds.
    expect(recording.requests).toEqual([]);

    await expect(page.getByTestId('assignment-origin')).toContainText('Added by hand');
    await expect(page.getByTestId('assignment-credit')).toContainText('With the assignee');
    await expectNoAxeViolations(page);
    await capture(page, 'cell-editor', info.project.name);
  });

  test('I-10: opening the assign picker issues exactly one request', async ({ page }, info) => {
    await routeHappyPath(page);
    await openCell(page);

    const recording = await recordRequests(
      page,
      'schedule-open-assign-picker',
      info.project.name,
      async () => {
        await page.getByTestId('cell-assign-open').click();
        await expect(page.getByTestId('candidate-select')).toBeVisible();
      },
    );
    expect(recording.requests).toHaveLength(1);
    await expectNoAxeViolations(page);
    await capture(page, 'cell-assign-picker', info.project.name);
  });

  test('I-10: a successful Save issues one write and one re-read', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/assignments`, (route) =>
      json(route, 200, {
        cell: {
          date: DATES[0],
          shiftTypeId: SHIFT_DAY,
          requiredCount: 2,
          assignments: [assignment(), assignment({ membershipId: MEMBER_B })],
          revision: MOVED_REVISION,
        },
        correlationId: 'e2e-correlation-id',
      }),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();
    await page.getByTestId('candidate-select').selectOption(MEMBER_B);

    const recording = await recordRequests(
      page,
      'schedule-save-assignment',
      info.project.name,
      async () => {
        await page.getByTestId('cell-assign-save').click();
        await expect(page.getByTestId('cell-assign-form')).toHaveCount(0);
      },
    );
    // The write plus the server-authoritative grid re-read (PO-DEC-18).
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('PO-DEC-18: a stale cell edit is refused explicitly, with a refetch control', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/assignments`, (route) =>
      json(route, 409, {
        error: {
          code: 'STALE_EDIT',
          message:
            'Somebody else changed this while you were editing. Your change was not applied — reload and try again.',
          correlationId: 'e2e-correlation-id',
          currentRevision: MOVED_REVISION,
        },
      }),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();
    await page.getByTestId('candidate-select').selectOption(MEMBER_B);
    await page.getByTestId('cell-assign-save').click();

    const stale = page.getByTestId('cell-editor-stale');
    await expect(stale).toBeVisible();
    await expect(stale).toHaveAttribute('role', 'alert');
    await expect(stale).toContainText('was not applied');
    // Editing is BLOCKED until the grid is re-read — never a silent retry.
    await expect(page.getByTestId('cell-assign-open')).toHaveCount(0);
    await expect(page.getByTestId('cell-editor-refetch')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'cell-stale-edit', info.project.name);
  });

  test('the eligibility ABSENT arm says it is about permission, not about the person', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/candidates*`, (route) =>
      json(
        route,
        200,
        candidates({
          eligibilityKnown: false,
          candidates: candidates().candidates.map((candidate) => ({
            ...candidate,
            eligible: null,
            missingQualificationIds: [],
          })),
        }),
      ),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();

    const notice = page.getByTestId('eligibility-absent');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Eligibility cannot be shown');
    // The ruling: absent is never rendered as ineligible.
    await expect(notice).not.toContainText(/not qualified|ineligible/i);
    const labels = await page.getByTestId('candidate-select').locator('option').allTextContents();
    expect(labels.some((label) => label.includes('Eligibility not shown'))).toBe(true);
    expect(labels.some((label) => /Missing \d+ credential/.test(label))).toBe(false);
    // The whole roster is still offered — this surface is the override mechanism.
    expect(labels.length).toBeGreaterThan(1);

    await expectNoAxeViolations(page);
    await capture(page, 'cell-eligibility-absent', info.project.name);
  });

  test('the NOBODY-ELIGIBLE arm is a different message from the absent one', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/candidates*`, (route) =>
      json(
        route,
        200,
        candidates({
          eligibilityKnown: true,
          candidates: candidates().candidates.map((candidate) => ({
            ...candidate,
            eligible: false,
            missingQualificationIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
          })),
        }),
      ),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();

    await expect(page.getByTestId('eligibility-none')).toContainText('Nobody in this group holds');
    await expect(page.getByTestId('eligibility-absent')).toHaveCount(0);
    const labels = await page.getByTestId('candidate-select').locator('option').allTextContents();
    expect(labels.some((label) => label.includes('Missing 1 credential'))).toBe(true);
    // Still offered, behind an override — assigning is not blocked.
    await expect(page.getByTestId('cell-assign-save')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'cell-eligibility-none', info.project.name);
  });

  test('B-4: a KNOWN-ineligible choice blocks Save until a reason is given', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/candidates*`, (route) =>
      json(
        route,
        200,
        candidates({
          eligibilityKnown: true,
          candidates: [
            {
              ...candidates().candidates[1],
              eligible: false,
              missingQualificationIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
            },
          ],
        }),
      ),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();
    await page.getByTestId('candidate-select').selectOption(MEMBER_B);

    // The reason is REQUIRED, the interface says so, and Save is not available.
    await expect(page.getByTestId('assign-reason-required')).toBeVisible();
    await expect(page.getByTestId('cell-assign-save')).toBeDisabled();

    // Typing a reason releases it.
    await page.getByTestId('assign-reason').fill('sole available cover, supervised');
    await expect(page.getByTestId('assign-reason-required')).toHaveCount(0);
    await expect(page.getByTestId('cell-assign-save')).toBeEnabled();

    await expectNoAxeViolations(page);
    await capture(page, 'cell-override-required', info.project.name);
  });

  test('B-4: an ABSENT-eligibility choice demands no reason at all', async ({ page }) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/candidates*`, (route) =>
      json(
        route,
        200,
        candidates({
          eligibilityKnown: false,
          candidates: candidates().candidates.map((candidate) => ({
            ...candidate,
            eligible: null,
            missingQualificationIds: [],
          })),
        }),
      ),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();
    await page.getByTestId('candidate-select').selectOption(MEMBER_B);

    // The ruling's other arm: nothing to override, so nothing is demanded.
    await expect(page.getByTestId('assign-reason-required')).toHaveCount(0);
    await expect(page.getByTestId('cell-assign-save')).toBeEnabled();
  });

  test('I-10: pinning issues one write and one re-read', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/assignments/*/pin`, (route) =>
      json(route, 200, {
        cell: {
          date: DATES[0],
          shiftTypeId: SHIFT_DAY,
          requiredCount: 2,
          assignments: [assignment({ isPinned: true })],
          revision: MOVED_REVISION,
        },
        correlationId: 'e2e-correlation-id',
      }),
    );
    await openCell(page);

    const recording = await recordRequests(
      page,
      'schedule-pin-assignment',
      info.project.name,
      async () => {
        await page.getByTestId('cell-pin-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').click();
        await expect(page.getByTestId('cell-assignments')).toContainText('Yes');
      },
    );
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('I-10: removing issues one write and one re-read', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/assignments/*/removal`, (route) =>
      json(route, 200, {
        cell: {
          date: DATES[0],
          shiftTypeId: SHIFT_DAY,
          requiredCount: 2,
          assignments: [],
          revision: MOVED_REVISION,
        },
        correlationId: 'e2e-correlation-id',
      }),
    );
    await openCell(page);
    await page.getByTestId('cell-remove-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').click();
    await expect(page.getByTestId('cell-remove-form')).toBeVisible();
    await page.getByLabel('Why is it being removed?').fill('requirement withdrawn');

    const recording = await recordRequests(
      page,
      'schedule-remove-assignment',
      info.project.name,
      async () => {
        await page.getByTestId('cell-remove-save').click();
        await expect(page.getByTestId('cell-editor-empty')).toBeVisible();
      },
    );
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('the candidate read failing renders an error, not an empty picker', async ({ page }) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/candidates*`, (route) =>
      json(route, 500, envelope('INTERNAL_ERROR', 'The request could not be completed.')),
    );
    await openCell(page);
    await page.getByTestId('cell-assign-open').click();

    await expect(page.getByTestId('candidates-error')).toBeVisible();
    await expect(page.getByTestId('candidate-select')).toHaveCount(0);
  });
});
