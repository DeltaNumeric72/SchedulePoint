import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { mockDeclaredContext } from './support/declared-context.js';
import { screenshotDir } from './support/evidence-target.js';
import { recordRequests } from './support/request-budget.js';

/**
 * **A member's own requests: every state, both viewports, axe on each**
 * (OPUS-M5-005, doc 42 §5j as amended).
 *
 * ## Why the API is intercepted rather than run
 *
 * The division every spec in this directory records: the component tree, the
 * router, the contracts, the zod parse, the query client and the rendering are
 * all the real ones, and only the bytes on the wire are supplied here. **This
 * file proves the interface behaves correctly for each response; that the SERVER
 * produces those responses — §3's deadline, §4's lifecycle, FAD-58's comment
 * store, the authorization — is proven separately over HTTP against the real
 * database** in `apps/api/test/requests/*`. The real join with no interception
 * anywhere is `critical-path.spec.ts`.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066 |
 * | clicking "Submit a request…" issues **zero** requests | **I-13** |
 * | filling the form issues **zero** requests | **I-13**, the other half |
 * | Save issues one request; an ACCEPTED save re-reads once | I-10, PO-DEC-18 |
 * | **the accepted-save state gets its own axe sweep** | the M5-003 observation this packet owes |
 * | a refused save re-reads **nothing** | I-10 |
 * | selecting `other` renders **no** companion text field | **FAD-58.1**, I-07 |
 * | the reason picker offers exactly the NINE codes | FAD-58.1 |
 * | the deadline shows BOTH dates when it rolled | SPEC-08 §3 |
 * | a closed window shows no date at all | migration 0010's `closed` |
 * | `revisionRequested` is stated in full, not as a badge | R-10 |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 *
 * ## The `other`-is-terminal assertion, and why it is written as a COUNT
 *
 * A test that asserted "no element with `data-testid=other-text` exists" would
 * pass against a page that called the field something else. So the assertion
 * below counts EVERY text-entry control inside the reason form — `input` of any
 * text-like type, plus `textarea` — before and after selecting `other`, and
 * requires the count to be zero both times. A companion field cannot be added
 * under any name without failing it. That is FAD-58.1 measured rather than
 * restated.
 *
 * ## Synthetic only
 *
 * Every date is far-future, every identifier is this file's own, and no
 * organization, site or person name from the research appears anywhere.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333';

const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/requests`;
const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/requests`;
const MINE_API = `${API}/mine`;
const DEADLINE_API = `${API}/deadline`;

const SCREENSHOTS = screenshotDir('EV-M5-REQUESTS');

const REQUEST_ONE = '44444441-4444-4444-8444-444444444444';
const REQUEST_TWO = '44444442-4444-4444-8444-444444444444';

function root(id: string, subtype: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    membershipId: MEMBERSHIP,
    subtype,
    status,
    submittedAt: '2049-05-01T09:00:00.000Z',
    decidedAt: null,
    decidedBy: null,
    withdrawnAt: null,
    expiresAt: '2049-05-20T00:00:00.000Z',
    idempotencyKey: `key-${id.slice(0, 8)}`,
    version: 1,
    isLate: false,
    revisionRequested: false,
    ...extra,
  };
}

const MINE = {
  requests: [
    {
      root: root(REQUEST_ONE, 'time-off', 'submitted'),
      record: { subtype: 'time-off', targetDate: '2049-06-07' },
    },
    {
      /* R-10: withdrawn after a published version honoured it. The row exists so
       * the full sentence — not a badge — can be asserted. */
      root: root(REQUEST_TWO, 'availability', 'withdrawn', { revisionRequested: true }),
      record: { subtype: 'availability', targetDate: '2049-06-14' },
    },
  ],
};

const MINE_EMPTY = { requests: [] };

const DEADLINE_DATED = {
  kind: 'dated',
  nominal: '2049-05-15',
  effective: '2049-05-15',
  rolled: false,
};
const DEADLINE_ROLLED = {
  kind: 'dated',
  nominal: '2049-05-15',
  effective: '2049-05-14',
  rolled: true,
};
const DEADLINE_CLOSED = { kind: 'closed' };

const THREAD = {
  comments: [
    {
      id: '99999991-9999-4999-8999-999999999999',
      requestId: REQUEST_ONE,
      channel: 'requester',
      reasonCode: 'childcare',
      body: null,
      authorMembershipId: MEMBERSHIP,
      createdAt: '2049-05-02T09:00:00.000Z',
    },
    {
      id: '99999992-9999-4999-8999-999999999999',
      requestId: REQUEST_ONE,
      channel: 'scheduler',
      reasonCode: null,
      body: 'Noted. Cover for that week is being arranged.',
      authorMembershipId: '55555555-5555-4555-8555-555555555555',
      createdAt: '2049-05-03T09:00:00.000Z',
    },
  ],
};

const THREAD_EMPTY = { comments: [] };

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

/**
 * Zero axe violations, **including `best-practice`**.
 *
 * The same assertion every spec in this directory makes: `heading-order` is a
 * `best-practice` rule rather than a WCAG one, and dropping the tag would
 * silently weaken every page in this file (non-bypass rule 10). The tag is then
 * proven to have selected something, because a mis-spelled tag makes `analyze()`
 * return zero violations from a smaller rule set — a stronger-looking claim
 * backed by a weaker check.
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

/** Every text-entry control inside a container. The `other`-is-terminal probe. */
async function textEntryCount(page: Page, testId: string): Promise<number> {
  return page
    .getByTestId(testId)
    .locator(
      'textarea, input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type])',
    )
    .count();
}

/** The two page-load reads, both fulfilled. */
async function mockPage(
  page: Page,
  options: {
    readonly mine?: unknown;
    readonly deadline?: unknown;
    readonly thread?: unknown;
  } = {},
): Promise<void> {
  await page.route(DEADLINE_API, (route) => json(route, 200, options.deadline ?? DEADLINE_DATED));
  await page.route(MINE_API, (route) => json(route, 200, options.mine ?? MINE));
  await page.route(`${API}/*/comments`, (route) =>
    json(route, 200, options.thread ?? THREAD_EMPTY),
  );
}

test.beforeEach(async ({ page }) => {
  await mockDeclaredContext(page, { organizationId: ORGANIZATION, groupIds: [GROUP] });
});

test.describe('my requests — reading', () => {
  test('LOADING: the list announces itself while the read is in flight', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(DEADLINE_API, (route) => json(route, 200, DEADLINE_DATED));
    await page.route(MINE_API, async (route) => {
      await held;
      await json(route, 200, MINE);
    });

    await page.goto(BASE);
    const loading = page.getByTestId('surface-loading').first();
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'requests-loading', info.project.name);
    release();
    await expect(page.getByTestId('requests')).toBeVisible();
  });

  test('POPULATED: the status history reads in words, and R-10 is a sentence', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.goto(BASE);

    await expect(page.getByRole('heading', { level: 1, name: 'My requests' })).toBeVisible();
    await expect(page.getByTestId(`status-${REQUEST_ONE}`)).toHaveText(/Waiting for a decision/);
    await expect(page.getByTestId(`status-${REQUEST_TWO}`)).toContainText('Taken back');

    /* R-10 in FULL. "Revision requested" alone would read as though the
       published schedule had changed; it has not. */
    await expect(page.getByTestId(`revision-${REQUEST_TWO}`)).toContainText(
      'a published schedule had already used this, so a revision has been asked for',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'requests-populated', info.project.name);
  });

  test('EMPTY: no requests says so in words, not "no data"', async ({ page }, info) => {
    await mockPage(page, { mine: MINE_EMPTY });
    await page.goto(BASE);

    await expect(page.getByTestId('surface-empty')).toContainText(
      'You have not asked for anything',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'requests-empty', info.project.name);
  });

  test('DEADLINE ROLLED: BOTH dates are shown, because the pair is the point', async ({
    page,
  }, info) => {
    await mockPage(page, { deadline: DEADLINE_ROLLED });
    await page.goto(BASE);

    const rolled = page.getByTestId('deadline-rolled');
    await expect(rolled).toContainText('2049-05-15');
    await expect(rolled).toContainText('2049-05-14');

    await expectNoAxeViolations(page);
    await capture(page, 'requests-deadline-rolled', info.project.name);
  });

  test('DEADLINE CLOSED: a closed window shows NO date — none is invented', async ({
    page,
  }, info) => {
    await mockPage(page, { deadline: DEADLINE_CLOSED });
    await page.goto(BASE);

    await expect(page.getByTestId('deadline-closed')).toBeVisible();
    /* Migration 0010 kept `closed` separate from an absent date precisely so a
       surface would not report one. Nothing on the panel may look like a date. */
    await expect(page.getByTestId('deadline-closed')).not.toContainText('2049');
    await expect(page.getByTestId('deadline-dated')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-deadline-closed', info.project.name);
  });

  test('403 renders no-permission; 404 renders not-found — the server decided which', async ({
    page,
  }, info) => {
    await page.route(DEADLINE_API, (route) => json(route, 200, DEADLINE_DATED));
    await page.route(MINE_API, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'You do not have permission to do that.')),
    );
    await page.goto(BASE);
    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'requests-forbidden', info.project.name);

    await page.unroute(MINE_API);
    await page.route(MINE_API, (route) => json(route, 404, envelope('NOT_FOUND', 'Not found.')));
    await page.reload();
    await expect(page.getByTestId('surface-error')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'requests-not-found', info.project.name);
  });

  test('AC-08: the page does not scroll sideways at 320px', async ({ page }) => {
    await mockPage(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(BASE);
    await expect(page.getByTestId('requests')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(
      overflow,
      'the PAGE must not scroll sideways; the table container may',
    ).toBeLessThanOrEqual(0);
  });
});

test.describe('my requests — I-13 and the submit form', () => {
  test('opening the form issues ZERO requests', async ({ page }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await expect(page.getByTestId('requests')).toBeVisible();

    const recording = await recordRequests(
      page,
      'requests-open-submit-form',
      info.project.name,
      async () => {
        await page.getByTestId('open-submit-form').click();
        await expect(page.getByTestId('submit-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* ZERO is the only correct number and this budget can never be raised
     * without I-13 changing first. A control labelled Submit that persisted a
     * request on click is the incident the invariant comes from. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-form-open', info.project.name);
  });

  test('filling the form issues ZERO requests', async ({ page }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await page.getByTestId('open-submit-form').click();
    await expect(page.getByTestId('submit-form')).toBeVisible();

    const recording = await recordRequests(
      page,
      'requests-fill-submit-form',
      info.project.name,
      async () => {
        await page.getByTestId('subtype').selectOption('time-off');
        await page.getByTestId('target-date').fill('2049-06-21');
        await page.waitForTimeout(500);
      },
    );

    /* The other half of I-13: a field that fetched or saved on change would put
     * a half-entered absence on the wire. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-form-filled', info.project.name);
  });

  test('the time-off RANGE is a choice, and the half-stated range is unrepresentable', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await page.getByTestId('open-submit-form').click();
    await page.getByTestId('subtype').selectOption('time-off');
    await page.getByTestId('shape-range').check();

    await expect(page.getByTestId('range-start')).toBeVisible();
    await expect(page.getByTestId('range-end')).toBeVisible();
    /* The single-date field is GONE rather than ignored: the contract's union has
       two members and no third shape, and the form mirrors the thing it makes. */
    await expect(page.getByTestId('target-date')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-form-range', info.project.name);
  });

  test('a REFUSED save issues one request and re-reads NOTHING', async ({ page }, info) => {
    await mockPage(page);
    await page.route(API, (route) =>
      route.request().method() === 'POST'
        ? json(
            route,
            409,
            envelope('REQUEST_WINDOW_CLOSED', 'Requests for that period closed on 2049-05-15.'),
          )
        : json(route, 200, MINE),
    );
    await page.goto(BASE);
    await page.getByTestId('open-submit-form').click();
    await page.getByTestId('target-date').fill('2049-06-21');

    const recording = await recordRequests(
      page,
      'requests-save-refused',
      info.project.name,
      async () => {
        await page.getByTestId('save-request').click();
        await expect(page.getByTestId('validation-summary-submit-request')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* One Save, one request. A refused save does NOT refetch, because nothing
     * changed — a refetch here would be an amplification with no cause. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(1);
    await expect(page.getByTestId('validation-summary-submit-request')).toContainText(
      'closed on 2049-05-15',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'requests-save-refused', info.project.name);
  });

  test('an ACCEPTED save is one write plus ONE re-read — and the SAVED state is swept', async ({
    page,
  }, info) => {
    /* **The M5-003 observation this packet owes.** Every earlier surface swept
     * the form-open and the refused states and stopped there; the state a person
     * is actually left looking at after a successful save had never had its own
     * axe run. It does now, on this surface and on every other one this packet
     * adds. */
    await mockPage(page);
    let saved = false;
    await page.route(API, (route) => {
      if (route.request().method() === 'POST') {
        saved = true;
        return json(route, 201, MINE.requests[0]);
      }
      return json(route, 200, MINE);
    });
    await page.route(MINE_API, (route) =>
      json(route, 200, saved ? MINE : { requests: [MINE.requests[0]] }),
    );

    await page.goto(BASE);
    await page.getByTestId('open-submit-form').click();
    await page.getByTestId('target-date').fill('2049-06-21');

    const recording = await recordRequests(
      page,
      'requests-save-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('save-request').click();
        await expect(page.getByTestId('submit-form')).toHaveCount(0);
        await page.waitForTimeout(500);
      },
    );

    /* The write plus ONE invalidation refetch. Two is the MEASURED number, not a
     * target: the list must reflect the new request and the client does not
     * synthesise it from the response (PO-DEC-18) — which here would also mean
     * inventing the version the next withdrawal has to present. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);

    await expect(page.getByTestId('requests')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'requests-save-accepted', info.project.name);
  });

  test('WITHDRAW: one write, one re-read, and the saved state is swept', async ({ page }, info) => {
    await mockPage(page);
    await page.route(`${API}/*/withdraw`, (route) =>
      json(route, 200, { requestId: REQUEST_ONE, version: 2, revisionRequested: false }),
    );
    await page.goto(BASE);
    await expect(page.getByTestId('requests')).toBeVisible();

    const recording = await recordRequests(
      page,
      'requests-withdraw-accepted',
      info.project.name,
      async () => {
        await page.getByTestId(`withdraw-${REQUEST_ONE}`).click();
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-withdrawn', info.project.name);
  });
});

test.describe('my requests — FAD-58.1, the reason code channel', () => {
  test('opening the detail reads the thread — one action, one request', async ({ page }, info) => {
    await mockPage(page, { thread: THREAD });
    await page.goto(BASE);
    await expect(page.getByTestId('requests')).toBeVisible();

    const recording = await recordRequests(
      page,
      'requests-open-detail',
      info.project.name,
      async () => {
        await page.getByTestId(`expand-${REQUEST_ONE}`).click();
        await expect(page.getByTestId(`thread-${REQUEST_ONE}`)).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* ONE read, and only when asked for. Fetching every thread with the list
     * would make a list of twenty requests cost twenty-one reads for something
     * nobody asked to see. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(1);

    /* The requester's half renders the CODE said in words; the scheduler's half
       renders the bounded text. Exactly one is present on any row. */
    await expect(page.getByTestId(`thread-${REQUEST_ONE}`)).toContainText('Childcare');
    await expect(page.getByTestId(`thread-${REQUEST_ONE}`)).toContainText(
      'Cover for that week is being arranged',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'requests-detail-open', info.project.name);
  });

  test('the picker offers exactly the NINE codes, and there is NOWHERE to type', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await page.getByTestId(`expand-${REQUEST_ONE}`).click();
    await expect(page.getByTestId(`reason-form-${REQUEST_ONE}`)).toBeVisible();

    const options = page.getByTestId(`reason-code-${REQUEST_ONE}`).locator('option');
    /* Nine, plus the "Choose a reason" placeholder. A tenth would fail here, and
       a tenth is exactly what FAD-58 forbids without a decision overturning it. */
    await expect(options).toHaveCount(10);
    for (const label of [
      'Personal',
      'Family',
      'Childcare',
      'Bereavement',
      'Travel',
      'Education',
      'Religious observance',
      'Professional obligation',
      'Other',
    ]) {
      await expect(options.filter({ hasText: label }).first()).toHaveCount(1);
    }

    /* No medical, sick, health or appointment code. Their absence IS the design
       (FAD-58.1), and asserting it keeps a future packet from adding one
       quietly. */
    for (const forbidden of ['Medical', 'Sick', 'Health', 'Appointment', 'Illness']) {
      await expect(options.filter({ hasText: forbidden })).toHaveCount(0);
    }

    /* ZERO text-entry controls in the form, counted by TYPE rather than by
       test id, so a companion field cannot be added under another name. */
    expect(await textEntryCount(page, `reason-form-${REQUEST_ONE}`)).toBe(0);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-reason-picker', info.project.name);
  });

  test('`other` is TERMINAL: selecting it opens no companion field', async ({ page }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await page.getByTestId(`expand-${REQUEST_ONE}`).click();
    await expect(page.getByTestId(`reason-form-${REQUEST_ONE}`)).toBeVisible();

    const before = await textEntryCount(page, `reason-form-${REQUEST_ONE}`);
    await page.getByTestId(`reason-code-${REQUEST_ONE}`).selectOption('other');
    await page.waitForTimeout(200);
    const after = await textEntryCount(page, `reason-form-${REQUEST_ONE}`);

    /* Zero before, zero after. "other, specify" would be the free-text channel
     * under another name — I-07 is not patient-scoped, and a length bound bounds
     * SIZE, not KIND. This is the assertion that keeps it out. */
    expect(before).toBe(0);
    expect(after).toBe(0);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-reason-other', info.project.name);
  });

  test('attaching a reason is one write plus ONE re-read, and the saved state is swept', async ({
    page,
  }, info) => {
    await mockPage(page, { thread: THREAD });
    await page.route(`${API}/*/reason-codes`, (route) =>
      json(route, 201, {
        comment: {
          id: '99999993-9999-4999-8999-999999999999',
          requestId: REQUEST_ONE,
          channel: 'requester',
          reasonCode: 'travel',
          body: null,
          authorMembershipId: MEMBERSHIP,
          createdAt: '2049-05-04T09:00:00.000Z',
        },
      }),
    );
    await page.goto(BASE);
    await page.getByTestId(`expand-${REQUEST_ONE}`).click();
    await expect(page.getByTestId(`reason-form-${REQUEST_ONE}`)).toBeVisible();
    await page.getByTestId(`reason-code-${REQUEST_ONE}`).selectOption('travel');

    const recording = await recordRequests(
      page,
      'requests-attach-reason-accepted',
      info.project.name,
      async () => {
        await page.getByTestId(`attach-reason-${REQUEST_ONE}`).click();
        await page.waitForTimeout(500);
      },
    );

    /* I-16: one turn, ONE accepted selection, through one transaction. One write
     * plus one re-read of the thread. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);

    await expectNoAxeViolations(page);
    await capture(page, 'requests-reason-attached', info.project.name);
  });
});
