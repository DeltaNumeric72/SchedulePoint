import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

import { screenshotDir } from './support/evidence-target.js';
import { mockDeclaredContext } from './support/declared-context.js';

/**
 * The staff-facing schedule views: every state, both viewports, axe on each
 * (OPUS-M3-006).
 *
 * ## Why the API is intercepted rather than run
 *
 * The same division `schedule.spec.ts`, `catalogue.spec.ts` and `rules.spec.ts`
 * record: this file proves the **interface** behaves correctly for each
 * response. That the server produces those responses — self-scoping, draft
 * invisibility, the zone conversion, cross-group denial — is proven separately,
 * over HTTP against the real database, in
 * `apps/api/test/schedule/views-http.test.ts`. The component tree, router,
 * contracts, zod parse, query client and rendering here are all the real ones.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066 |
 * | the calendar and the list render the SAME entries, compared as sets | the packet's "both first-class" requirement |
 * | an overnight shift appears on BOTH days, worded differently on each | the packet's overnight requirement |
 * | arrow keys move between days and Enter opens one | AC-02, keyboard navigation |
 * | switching rendering issues **zero** requests; moving the window issues one | I-10 / SP-HR-2 |
 * | the status is a live region, not only pixels | SP-HR programmatic status |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 * | the page states the zone it is rendering in | the timezone requirement |
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const PERIOD = '55555555-5555-4555-8555-555555555555';
const VERSION = '66666666-6666-4666-8666-666666666666';
const SHIFT_DAY = '77777777-7777-4777-8777-777777777777';
const SHIFT_NIGHT = '88888888-8888-4888-8888-888888888888';

const MY_SCHEDULE_URL = `/organizations/${ORGANIZATION}/groups/${GROUP}/my-schedule/${MEMBERSHIP}`;
const DAILY_SHEET_DATE = '2029-06-06';
const DAILY_SHEET_URL = `/organizations/${ORGANIZATION}/groups/${GROUP}/daily-sheet/${DAILY_SHEET_DATE}`;
const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/published-schedule`;

const ZONE = 'Pacific/Auckland';

const SCREENSHOTS = screenshotDir('EV-M3-STAFF-VIEWS');

/* ────────────────────────────────────────────────────────────────────────────
 * Fixtures
 * ──────────────────────────────────────────────────────────────────────────── */

/** `YYYY-MM-DD` shifted by `days`, in UTC — the same arithmetic the model uses. */
function shift(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    assignmentIdentityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    membershipId: MEMBERSHIP,
    displayName: 'Synthetic Member A',
    shiftTypeId: SHIFT_DAY,
    shiftTypeCode: 'DAY',
    shiftTypeName: 'Day shift',
    isOnCall: false,
    startsAt: '2029-06-03T20:00:00.000Z',
    endsAt: '2029-06-04T04:00:00.000Z',
    startDate: '2029-06-04',
    endDate: '2029-06-04',
    startTime: '08:00',
    endTime: '16:00',
    isContinuation: false,
    continuesToNextDay: false,
    versionId: VERSION,
    versionNumber: 1,
    periodId: PERIOD,
    /* OPUS-M4-000B. `scheduleEntrySchema` is `.strict()` and requires all five,
     * so a fixture missing them fails the client-side parse, renders nothing,
     * and every interaction times out at 30s.
     *
     * `timezone` here is the zone THIS entry's clock was rendered under, which
     * is a different fact from the response-level `timezone` (the calendar
     * axis). `version-snapshot` is the ordinary case: a published version keeps
     * the zone it was published with, so its wall clock does not move when an
     * administrator changes the group's setting. */
    locationId: null,
    locationName: null,
    locationArchived: false,
    timezone: ZONE,
    timezoneSource: 'version-snapshot',
    ...overrides,
  };
}

/**
 * A personal schedule covering whatever window the page asked for.
 *
 * The page picks its own window from the browser's date, so the fixture is built
 * FROM the request rather than pinned to a literal range — otherwise this file
 * would pass or fail depending on the day it ran, which is the kind of test that
 * gets deleted six months later.
 *
 * Three shifts, positioned relative to the window's start:
 *
 *  - a day shift on `from + 2`;
 *  - an overnight shift starting on `from + 4`, which is why `from + 5` carries
 *    its continuation — the same assignment identity on both days;
 *  - nothing else, so the empty days are real empty days.
 */
function personalSchedule(from: string, to: string) {
  const dayShiftDate = shift(from, 2);
  const nightDate = shift(from, 4);
  const nightNext = shift(from, 5);

  const night = {
    assignmentIdentityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    shiftTypeId: SHIFT_NIGHT,
    shiftTypeCode: 'NGT',
    shiftTypeName: 'Night shift',
    startsAt: '2029-06-06T10:00:00.000Z',
    endsAt: '2029-06-06T18:00:00.000Z',
    startDate: nightDate,
    endDate: nightNext,
    startTime: '22:00',
    endTime: '06:00',
  };

  const days: { date: string; entries: unknown[] }[] = [];
  for (let cursor = from; cursor <= to; cursor = shift(cursor, 1)) {
    if (cursor === dayShiftDate) {
      days.push({ date: cursor, entries: [entry({ startDate: cursor, endDate: cursor })] });
    } else if (cursor === nightDate) {
      days.push({
        date: cursor,
        entries: [entry({ ...night, isContinuation: false, continuesToNextDay: true })],
      });
    } else if (cursor === nightNext) {
      days.push({
        date: cursor,
        entries: [entry({ ...night, isContinuation: true, continuesToNextDay: false })],
      });
    } else {
      days.push({ date: cursor, entries: [] });
    }
  }

  return {
    membershipId: MEMBERSHIP,
    displayName: 'Synthetic Member A',
    timezone: ZONE,
    from,
    to,
    days,
    correlationId: 'e2e-correlation-id',
  };
}

function dailySheet(date: string, overrides: Record<string, unknown> = {}) {
  return {
    date,
    timezone: ZONE,
    entries: [
      entry({ startDate: date, endDate: date }),
      entry({
        assignmentIdentityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        membershipId: COLLEAGUE,
        displayName: 'Synthetic Member B',
        shiftTypeId: SHIFT_NIGHT,
        shiftTypeCode: 'NGT',
        shiftTypeName: 'Night shift',
        startDate: shift(date, -1),
        endDate: date,
        startTime: '22:00',
        endTime: '06:00',
        isContinuation: true,
        continuesToNextDay: false,
      }),
    ],
    correlationId: 'e2e-correlation-id',
    ...overrides,
  };
}

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

/** The healthy routing: a personal schedule for any window, and a populated sheet. */
async function routeHappyPath(page: Page): Promise<void> {
  await page.route(`${API}/members/*`, (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get('from') ?? '2029-06-01';
    const to = url.searchParams.get('to') ?? '2029-06-28';
    return json(route, 200, personalSchedule(from, to));
  });
  await page.route(`${API}/daily-sheet*`, (route) => {
    const url = new URL(route.request().url());
    return json(route, 200, dailySheet(url.searchParams.get('date') ?? DAILY_SHEET_DATE));
  });
}

/** Every `data-entry-summary` currently in the DOM, as a sorted set. */
async function summaries(page: Page): Promise<string[]> {
  const values = await page.locator('[data-entry-summary]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-entry-summary') ?? ''),
  );
  return [...values].sort();
}

/* ────────────────────────────────────────────────────────────────────────────
 * States
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The context read every capability request now depends on (FAD-48).
 *
 * This spec intercepts the API, so the client's `GET /me/context` has to be
 * intercepted too or it falls through to the static preview server. It is
 * plumbing, not a claim: see `support/declared-context.ts`.
 */
test.beforeEach(async ({ page }) => {
  await mockDeclaredContext(page, { organizationId: ORGANIZATION, groupIds: [GROUP] });
});

test.describe('my schedule — states', () => {
  test('LOADING: the surface announces itself while it is being fetched', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(`${API}/members/*`, async (route) => {
      await held;
      await json(route, 200, personalSchedule('2029-06-04', '2029-07-01'));
    });

    await page.goto(MY_SCHEDULE_URL);
    const loading = page.getByTestId('surface-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-loading', info.project.name);
    release();
  });

  test('EMPTY: a window with no shifts says so, in words', async ({ page }, info) => {
    await page.route(`${API}/members/*`, (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get('from') ?? '2029-06-04';
      const to = url.searchParams.get('to') ?? '2029-07-01';
      const empty = personalSchedule(from, to);
      return json(route, 200, { ...empty, days: empty.days.map((day) => ({ ...day, entries: [] })) });
    });

    await page.goto(MY_SCHEDULE_URL);
    await page.getByTestId('view-table').click();
    // "No shifts in this range" — never "no data", and never a blank panel.
    await expect(page.getByText('No shifts in this range.')).toBeVisible();
    await expect(page.getByTestId('schedule-status')).toContainText('No shifts between');

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-empty', info.project.name);
  });

  test('ERROR: a 500 renders the fixed message and a reference, and nothing else', async ({
    page,
  }, info) => {
    await page.route(`${API}/members/*`, (route) =>
      json(route, 500, envelope('INTERNAL_ERROR', 'The request could not be completed.')),
    );

    await page.goto(MY_SCHEDULE_URL);
    const error = page.getByTestId('surface-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText('The request could not be completed.');
    await expect(page.getByTestId('schedule-calendar')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-error', info.project.name);
  });

  test('DENIED: a 403 says "no permission" and never says why', async ({ page }, info) => {
    await page.route(`${API}/members/*`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );

    await page.goto(MY_SCHEDULE_URL);
    const denied = page.getByTestId('surface-permission-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toHaveAttribute('role', 'alert');
    // SPEC-06 P-3: the interface never reconstructs the reason. No capability
    // key (`schedule.own_published.read`), no layer (`L4.2`), no explanation.
    // The pattern is anchored on the SHAPE of a key rather than on the word
    // "schedule", which the surface's own name legitimately contains.
    await expect(denied).not.toContainText(/capabilit|schedule\.[a-z_]+\.[a-z_]+|\bL\d\b/);
    await expect(page.getByTestId('schedule-calendar')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-denied', info.project.name);
  });

  test('NOT FOUND: a 404 is rendered as not found, not as a permission problem', async ({
    page,
  }, info) => {
    // This is what asking for somebody else's personal view looks like from the
    // client: the server answers with the single tenant 404, and the interface
    // renders exactly that — calling it a permission problem would tell the user
    // the other person's schedule exists.
    await page.route(`${API}/members/*`, (route) => json(route, 404, envelope('NOT_FOUND', 'Not found.')));

    await page.goto(MY_SCHEDULE_URL);
    const error = page.getByTestId('surface-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Not found.');
    await expect(page.getByTestId('surface-permission-denied')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-not-found', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The two renderings
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('my schedule — calendar and list', () => {
  test('the calendar is an ARIA grid with weekday headers and labelled days', async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop', 'the calendar is the desktop default');
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);

    const calendar = page.getByTestId('schedule-calendar');
    await expect(calendar).toBeVisible();
    await expect(calendar).toHaveAttribute('aria-colcount', '7');
    await expect(calendar.getByRole('columnheader')).toHaveCount(7);

    // A day cell's accessible name carries the answer, not only the date: a
    // screen-reader user should not have to enter a cell to learn whether they
    // are working.
    const working = page.locator('[data-testid="calendar-day"][aria-label*="Day shift"]').first();
    await expect(working).toHaveAttribute('aria-label', /08:00–16:00/);
    const free = page.locator('[data-testid="calendar-day"][aria-label*="no shifts"]').first();
    await expect(free).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-calendar', info.project.name);
  });

  test('the list is a real table with row and column headers', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the wide form of the alternative');
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);
    await page.getByTestId('view-table').click();

    const table = page.getByTestId('schedule-table');
    await expect(table).toBeVisible();
    await expect(table.locator('caption')).toHaveCount(1);
    await expect(table.locator('th[scope="col"]').first()).toBeVisible();
    await expect(table.locator('th[scope="row"]').first()).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-list', info.project.name);
  });

  test('the calendar and the alternative render the SAME entries', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);

    await page.getByTestId('view-calendar').click();
    await expect(page.getByTestId('schedule-calendar')).toBeVisible();
    const fromCalendar = await summaries(page);

    await page.getByTestId('view-table').click();
    await expect(
      page.locator('[data-testid="schedule-table"], [data-testid="schedule-list"]'),
    ).toBeVisible();
    const fromAlternative = await summaries(page);

    // Set equality, byte for byte. "Both first-class" cannot mean "roughly the
    // same", and a divergence here is a failing test rather than something a
    // reviewer might notice.
    expect(fromAlternative).toEqual(fromCalendar);
    expect(fromCalendar.length).toBeGreaterThan(0);
  });

  test('below 640px the alternative is a LIST carrying the same entries', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the narrow form belongs to the mobile project');
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);

    const list = page.getByTestId('schedule-list');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('schedule-table')).toHaveCount(0);
    await expect(list.locator('li').first()).toHaveAttribute('data-entry-summary', /.+/);

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-list-mobile', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The overnight shift
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('an overnight shift', () => {
  test('appears on BOTH days, and the two days say different things', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);
    await page.getByTestId('view-table').click();

    const rows = page.locator('[data-entry-summary*="|NGT|"]');
    await expect(rows).toHaveCount(2);

    // The day it begins: "22:00 until 06:00 the next day". The day it runs into:
    // "Continues from 22:00 on …, until 06:00". Repeating an identical
    // "22:00–06:00" on both would say the person works sixteen hours.
    await expect(page.locator('[data-entry-summary*="|NGT|"]').first()).toContainText(
      'until 06:00 the next day',
    );
    await expect(page.locator('[data-entry-summary*="|NGT|"]').nth(1)).toContainText(
      'Continues from 22:00',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-overnight', info.project.name);
  });

  test('the calendar marks the two days differently too', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the calendar is the desktop default');
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);

    await expect(page.locator('[data-testid="calendar-day"] >> text=(overnight)')).toHaveCount(1);
    await expect(page.locator('[data-testid="calendar-day"] >> text=(continues)')).toHaveCount(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Keyboard, status, zone
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('keyboard and status', () => {
  test('arrow keys move between days and Enter opens the daily sheet', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the calendar is the desktop default');
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);

    const first = page.locator('[data-testid="calendar-day"]').first();
    await first.focus();
    const firstDate = await first.getAttribute('data-date');

    await page.keyboard.press('ArrowRight');
    const afterRight = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-date'),
    );
    expect(afterRight).not.toBe(firstDate);

    // Down is a WEEK, not a row of arbitrary length — the calendar's second axis
    // has to mean something.
    await page.keyboard.press('ArrowDown');
    const afterDown = await page.evaluate(() => document.activeElement?.getAttribute('data-date'));
    expect(afterDown).not.toBe(afterRight);

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/daily-sheet/${String(afterDown)}$`));
    await expect(page.getByTestId('sheet-status')).toBeAttached();

    await capture(page, 'my-schedule-keyboard-daily-sheet', info.project.name);
  });

  test('the status is a live region and names the zone', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);

    const status = page.getByTestId('schedule-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toContainText('shifts between');
    // The reader is told which zone the times are in. A rota rendered in an
    // unnamed zone is a rota nobody can check.
    await expect(page.getByTestId('timezone-note')).toContainText(ZONE);
  });

  test('the page states that drafts are not shown', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);
    await expect(page.getByTestId('published-only-note')).toContainText('published schedule');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Budgets (I-10 / SP-HR-2)
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('requests per interaction', () => {
  test('switching between the calendar and the list issues ZERO requests', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);
    await expect(page.getByTestId('schedule-status')).toContainText('shifts between');

    const recording = await recordRequests(
      page,
      'my-schedule-switch-view',
      info.project.name,
      async () => {
        await page.getByTestId('view-table').click();
        await expect(
          page.locator('[data-testid="schedule-table"], [data-testid="schedule-list"]'),
        ).toBeVisible();
      },
    );

    // ZERO: both renderings come from the data the page already holds. A fetch
    // here would make changing how you look at your rota cost a round trip.
    expect(recording.requests).toEqual([]);
  });

  test('moving the window issues exactly one request', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);
    await expect(page.getByTestId('schedule-status')).toContainText('shifts between');

    const recording = await recordRequests(
      page,
      'my-schedule-next-window',
      info.project.name,
      async () => {
        await page.getByTestId('range-next').click();
        await expect(page.getByTestId('schedule-status')).toContainText('shifts between');
      },
    );

    // I-10 in its strictest form: one action, one read. A window the page has
    // not seen cannot come from the cache, and nothing else is fetched.
    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.method).toBe('GET');
    expect(recording.requests[0]?.url).toContain('/published-schedule/members/');
  });

  test('opening a day from the calendar issues exactly one request', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'the calendar is the desktop default');
    await routeHappyPath(page);
    await page.goto(MY_SCHEDULE_URL);
    await expect(page.getByTestId('schedule-status')).toContainText('shifts between');

    const recording = await recordRequests(
      page,
      'daily-sheet-open-from-calendar',
      info.project.name,
      async () => {
        await page.locator('[data-testid="calendar-day"]').first().focus();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('sheet-status')).toContainText('working on');
      },
    );

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.url).toContain('/published-schedule/daily-sheet');
  });

  test('moving to the next day on the sheet issues exactly one request', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(DAILY_SHEET_URL);
    await expect(page.getByTestId('sheet-status')).toContainText('working on');

    const recording = await recordRequests(
      page,
      'daily-sheet-next-day',
      info.project.name,
      async () => {
        await page.getByTestId('day-next').click();
        await expect(page.getByRole('heading', { level: 2 })).toContainText('7 June 2029');
      },
    );

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.url).toContain('/published-schedule/daily-sheet');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The daily sheet
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('the daily assignment sheet', () => {
  test('shows everyone working, including a shift that began yesterday', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(DAILY_SHEET_URL);

    await expect(page.getByText('Synthetic Member A')).toBeVisible();
    await expect(page.getByText('Synthetic Member B')).toBeVisible();
    await expect(page.getByText(/Continues from 22:00/)).toBeVisible();
    await expect(page.getByTestId('timezone-note')).toContainText(ZONE);

    // Doc 07 §1: this is a read of the published master schedule, NOT the
    // picklist module. Nothing on the page offers a turn.
    await expect(page.getByRole('button', { name: /take|claim|pick|pass/i })).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'daily-sheet', info.project.name);
  });

  test('EMPTY: a date nobody is working says so', async ({ page }, info) => {
    await page.route(`${API}/daily-sheet*`, (route) =>
      json(route, 200, dailySheet(DAILY_SHEET_DATE, { entries: [] })),
    );

    await page.goto(DAILY_SHEET_URL);
    await expect(page.getByTestId('surface-empty')).toContainText(
      'Nobody is assigned on this date',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'daily-sheet-empty', info.project.name);
  });

  test('DENIED: a 403 is a permission state, not an empty sheet', async ({ page }, info) => {
    await page.route(`${API}/daily-sheet*`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );

    await page.goto(DAILY_SHEET_URL);
    // "You may not see this" and "nobody is working" are different facts, and
    // the interface never confuses them.
    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expect(page.getByTestId('surface-empty')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'daily-sheet-denied', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 320px
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('AC-08 — 320px', () => {
  test('my schedule reflows with no page-level horizontal scroll', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the 320px assertion belongs to the mobile project');
    await routeHappyPath(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(MY_SCHEDULE_URL);
    await expect(page.getByTestId('schedule-list')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expectNoAxeViolations(page);
    await capture(page, 'my-schedule-320px', info.project.name);
  });

  test('the daily sheet reflows too', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the 320px assertion belongs to the mobile project');
    await routeHappyPath(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(DAILY_SHEET_URL);
    await expect(page.getByTestId('sheet-list')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expectNoAxeViolations(page);
    await capture(page, 'daily-sheet-320px', info.project.name);
  });
});
