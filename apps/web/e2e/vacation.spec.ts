import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { mockDeclaredContext } from './support/declared-context.js';
import { screenshotDir } from './support/evidence-target.js';
import { recordRequests } from './support/request-budget.js';

/**
 * The staff vacation round: every state, both viewports, axe on each
 * (OPUS-M5-003, doc 42 §5f Part B).
 *
 * ## Why the API is intercepted rather than run
 *
 * The division every spec in this directory records: the component tree, the
 * router, the contracts, the zod parse, the query client and the rendering are
 * all the real ones, and only the bytes on the wire are supplied here. **This
 * file proves the interface behaves correctly for each response; that the SERVER
 * produces those responses — the §5.3 mapping, the guarded writes, the
 * authorization — is proven separately, over HTTP against the real database, in
 * `apps/api/test/requests/vacation-selection-http.test.ts`.**
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066 |
 * | clicking "Select a week…" issues **zero** requests | **I-13** |
 * | filling the week field issues **zero** requests | **I-13**, the other half |
 * | Save issues one request; an accepted save re-reads once | I-10, PO-DEC-18 |
 * | a refused save re-reads **nothing** | I-10 |
 * | the displayed status is DERIVED from the ROOT's status | **R-15**, SPEC-08 §5.3 |
 * | the list is rendered in the order the server sent it | the ordering matrix |
 * | the variance warning WARNS and blocks nothing | doc 09 §2.1, §5.5 |
 * | open mode shows no allowance, and does not read it as exhausted | **V-30** |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 *
 * ## R-15's e2e half, and what it takes for it to DISCRIMINATE
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **A correction, kept rather than deleted (condition C-2).** This docblock used
 * to say that `selection.status: 'pending'` beside `rootStatus: 'submitted'`
 * made the two implementations distinguishable, "so a page that rendered
 * `selection.status` directly would print 'pending'". **That was false**, and a
 * reviewer proved it by planting the read-off-the-selection defect and watching
 * every case here PASS.
 *
 * The reason is worth stating as a CLASS, because it is easy to write this
 * mistake again in any surface that derives one of a pair from the other:
 *
 *   * the derivation `root → selection` is TOTAL over the seven root statuses
 *     §5.3 produces, so it always yields a selection token — it never yields the
 *     raw root word;
 *   * both implementations then index the SAME `STATUS_WORDING` table with a
 *     selection token;
 *   * so on any PAIR-CONSISTENT row the two agree by construction, whatever the
 *     two raw values happen to look like. `pending`/`submitted` are different
 *     WORDS for one state, and a difference of spelling is not a difference of
 *     behaviour.
 *
 * **Only a DIVERGENT pair discriminates** — a row whose selection status and root
 * status are not §5.3 partners. Then deriving yields one wording and reading the
 * selection yields another, and exactly one of them is the invariant.
 *
 * `DIVERGENT` below is that row, and it is deliberately a pair **the real server
 * would refuse to produce**: `readVacationRound` asserts `vacationStatusPairAgrees`
 * on every row before replying and D-27 refuses to commit one at all. That is not
 * a weakness of the fixture, it is the whole point — the only input on which the
 * two implementations differ is one the server guarantees never to send, so the
 * ONLY place this property can be tested is here, where the bytes are supplied.
 * The reviewer's mutation of the page fails on this row with
 * `Expected /Waiting for a decision/, Received "Approved"`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const PERIOD = '55555555-5555-4555-8555-555555555555';
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333';
const GRANT = '66666666-6666-4666-8666-666666666666';

const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/vacation/rounds/${PERIOD}`;
const ROUND_API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/vacation/rounds/${PERIOD}`;
const SUBMIT_API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/requests`;

const SCREENSHOTS = screenshotDir('EV-M5-VACATION');

function selection(
  index: number,
  weekStart: string,
  status: string,
  rootStatus: string | null,
  submittedAt: string | null,
) {
  return {
    selection: {
      id: `7777777${String(index)}-7777-4777-8777-777777777777`,
      requestId: rootStatus === null ? null : `8888888${String(index)}-8888-4888-8888-888888888888`,
      membershipId: MEMBERSHIP,
      vacationPeriodId: PERIOD,
      weekStart,
      status,
      version: 1,
      grantId: null,
      /* C-3: the member's round read carries `isOverride` and NOT
       * `overrideReason`, and `vacationSelectionSummarySchema` is `.strict()` —
       * so a fixture carrying the reason would fail to parse, which is the wire
       * contract enforcing its own omission. */
      isOverride: false,
      committedToVersionId: null,
    },
    rootStatus,
    rootVersion: rootStatus === null ? null : 1,
    submittedAt,
    expiresAt: rootStatus === null ? null : '2049-05-01T00:00:00.000Z',
    isLate: false,
  };
}

/** A quota round with three weeks claimed and an allowance partly used. */
const QUOTA_ROUND = {
  period: {
    id: PERIOD,
    startDate: '2049-06-07',
    endDate: '2049-07-02',
    mode: 'quota' as const,
    state: 'open' as const,
    version: 1,
  },
  /* In the order the SERVER sends them — week, then submission instant, then id.
   * The page does not re-sort, so this order is what must appear. */
  selections: [
    selection(0, '2049-06-07', 'pending', 'submitted', '2049-05-01T09:00:00.000Z'),
    selection(1, '2049-06-14', 'approved', 'approved', '2049-05-01T10:00:00.000Z'),
    selection(2, '2049-06-21', 'denied', 'denied', '2049-05-01T11:00:00.000Z'),
  ],
  variance: [
    {
      grantId: GRANT,
      kind: 'personal-entitlement' as const,
      membershipId: MEMBERSHIP,
      weekStart: null,
      unitsTotal: 3,
      unitsConsumed: 1,
      overrideUnits: 0,
      bound: 3,
      remaining: 2,
      overEntitlement: 0,
      state: 'within' as const,
    },
  ],
};

/**
 * The row that DISCRIMINATES: a selection saying `approved` beside a root saying
 * `submitted` — a pair §5.3 does not partner and the server never sends.
 *
 * Deriving from the root gives `pending` → "Waiting for a decision".
 * Reading the selection gives `approved` → "Approved".
 * Exactly one of those is R-15, and only this row can tell them apart.
 */
const DIVERGENT_ROUND = {
  ...QUOTA_ROUND,
  selections: [selection(3, '2049-06-28', 'approved', 'submitted', '2049-05-01T12:00:00.000Z')],
};

/** The same round with the allowance exceeded through an audited override. */
const OVER_QUOTA_ROUND = {
  ...QUOTA_ROUND,
  variance: [
    {
      ...QUOTA_ROUND.variance[0],
      unitsTotal: 1,
      unitsConsumed: 2,
      overrideUnits: 1,
      bound: 2,
      remaining: 0,
      overEntitlement: 1,
      state: 'over-entitlement' as const,
    },
  ],
};

/** V-30: an open round has NO grants at all, and that is not an error. */
const OPEN_ROUND = {
  period: { ...QUOTA_ROUND.period, mode: 'open' as const },
  selections: [selection(0, '2049-06-07', 'pending', 'submitted', '2049-05-01T09:00:00.000Z')],
  variance: [],
};

const EMPTY_ROUND = { ...QUOTA_ROUND, selections: [] };

const SHUT_ROUND = {
  ...QUOTA_ROUND,
  period: { ...QUOTA_ROUND.period, state: 'closed' as const },
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

/**
 * Zero axe violations, **including `best-practice`**.
 *
 * The same assertion every spec in this directory makes, and for the reason
 * theirs record: `heading-order` is a `best-practice` rule rather than a WCAG
 * one, and dropping the tag would silently weaken every page in this file
 * (non-bypass rule 10). The tag is then proven to have selected something,
 * because a mis-spelled tag makes `analyze()` return zero violations from a
 * smaller rule set — a stronger-looking claim backed by a weaker check.
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

test.beforeEach(async ({ page }) => {
  await mockDeclaredContext(page, { organizationId: ORGANIZATION, groupIds: [GROUP] });
});

test.describe('vacation — the round', () => {
  test('LOADING: the round announces itself while the read is in flight', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(ROUND_API, async (route) => {
      await held;
      await json(route, 200, QUOTA_ROUND);
    });

    await page.goto(BASE);
    const loading = page.getByTestId('surface-loading').first();
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'round-loading', info.project.name);
    release();
    await expect(page.getByTestId('selections')).toBeVisible();
  });

  test('POPULATED: R-15 — the status is DERIVED from the ROOT, not read off the selection', async ({
    page,
  }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, QUOTA_ROUND));
    await page.goto(BASE);

    await expect(page.getByRole('heading', { level: 1, name: 'Vacation round' })).toBeVisible();

    /* The fixture's `selection.status` is `pending` and its `rootStatus` is
     * `submitted` — two different words for one state. §5.3's table maps
     * `submitted → pending`, and the page's wording for `pending` is "Waiting for
     * a decision". A page that printed `selection.status` would show the literal
     * token instead, so this assertion tells the two implementations apart. */
    await expect(page.getByTestId('status-2049-06-07')).toHaveText(/Waiting for a decision/);
    await expect(page.getByTestId('status-2049-06-14')).toHaveText(/Approved/);
    await expect(page.getByTestId('status-2049-06-21')).toHaveText(/Not approved/);

    /* The ORDER is the server's rule and the page does not re-sort. */
    const weeks = await page.getByTestId('selections').locator('tbody tr td:first-child').allInnerTexts();
    expect(weeks).toEqual(['2049-06-07', '2049-06-14', '2049-06-21']);

    await expectNoAxeViolations(page);
    await capture(page, 'round-populated', info.project.name);
  });

  test('R-15 DISCRIMINATES: a DIVERGENT pair is read from the ROOT, never from the selection', async ({
    page,
  }, info) => {
    /* The case the docblock above exists for. The fixture's selection says
     * `approved` and its root says `submitted` — a pair §5.3 does not partner —
     * so the two implementations produce DIFFERENT WORDS here and only here.
     *
     * A page deriving through §5.3's table shows "Waiting for a decision"; a page
     * reading `selection.status` shows "Approved". The assertion below fails for
     * the second with `Expected /Waiting for a decision/, Received "Approved"`,
     * which is what makes this file's R-15 claim a measurement rather than a
     * restatement. */
    await page.route(ROUND_API, (route) => json(route, 200, DIVERGENT_ROUND));
    await page.goto(BASE);

    await expect(page.getByTestId('status-2049-06-28')).toHaveText(/Waiting for a decision/);
    /* And explicitly NOT the selection's own word, so the assertion cannot be
     * satisfied by a page that happened to print both. */
    await expect(page.getByTestId('status-2049-06-28')).not.toHaveText(/Approved/);

    await expectNoAxeViolations(page);
    await capture(page, 'round-divergent-pair', info.project.name);
  });

  test('EMPTY: a round with no selections says so in words, not "no data"', async ({ page }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, EMPTY_ROUND));
    await page.goto(BASE);

    await expect(page.getByTestId('no-selections')).toContainText(
      'You have not asked for any weeks',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'round-empty', info.project.name);
  });

  test('a shut round offers no selection control at all', async ({ page }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, SHUT_ROUND));
    await page.goto(BASE);

    await expect(page.getByTestId('round-shut')).toBeVisible();
    await expect(page.getByTestId('select-week')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'round-shut', info.project.name);
  });

  test('V-30: an open round shows no allowance and does NOT read that as exhausted', async ({
    page,
  }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, OPEN_ROUND));
    await page.goto(BASE);

    await expect(page.getByTestId('variance-open-mode')).toContainText(
      'does not count an allowance',
    );
    /* The failure V-30 fixed, from the interface side: an empty grant list must
     * not be presented as "no allowance left", and the selection control must
     * still be there. */
    await expect(page.getByTestId('variance-empty')).toHaveCount(0);
    await expect(page.getByTestId('select-week')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'round-open-mode', info.project.name);
  });

  test('the variance indicator WARNS and blocks nothing (doc 09 §2.1)', async ({ page }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, OVER_QUOTA_ROUND));
    await page.goto(BASE);

    const warning = page.getByTestId(`variance-over-${GRANT}`);
    await expect(warning).toBeVisible();
    /* An alert, so it reaches somebody who cannot see the colour it is drawn in. */
    await expect(warning).toHaveAttribute('role', 'alert');
    await expect(warning).toContainText('beyond the entitlement');

    /* Advisory, not blocking: the selection control is still there and still
     * enabled. "The variance indicator warns; approval still succeeds." */
    await expect(page.getByTestId('select-week')).toBeEnabled();

    await expectNoAxeViolations(page);
    await capture(page, 'round-over-quota', info.project.name);
  });

  test('PERMISSION DENIED: a 403 says so, and does not say why', async ({ page }, info) => {
    await page.route(ROUND_API, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'This action is not permitted.')),
    );
    await page.goto(BASE);

    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'round-denied', info.project.name);
  });

  test('NOT FOUND: a 404 renders "not found", never "no permission"', async ({ page }, info) => {
    await page.route(ROUND_API, (route) =>
      json(route, 404, envelope('NOT_FOUND', 'Not found.')),
    );
    await page.goto(BASE);

    await expect(page.getByTestId('surface-error')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'round-not-found', info.project.name);
  });

  test('no page-level horizontal scroll at 320px', async ({ page }) => {
    await page.route(ROUND_API, (route) => json(route, 200, QUOTA_ROUND));
    await page.goto(BASE);
    await expect(page.getByTestId('selections')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the PAGE must not scroll sideways; the table container may').toBeLessThanOrEqual(0);
  });
});

test.describe('vacation — I-13 and the request budget', () => {
  test('I-13: "Select a week…" opens a form and issues ZERO requests', async ({ page }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, QUOTA_ROUND));
    await page.goto(BASE);
    await expect(page.getByTestId('selections')).toBeVisible();

    const recording = await recordRequests(
      page,
      'vacation-open-select-week',
      info.project.name,
      async () => {
        await page.getByTestId('select-week').click();
        await expect(page.getByTestId('select-week-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* ZERO is the only correct number. A control that claimed a vacation week on
     * click would put a person's leave into a quota ledger before they had
     * finished thinking about it — which is exactly the incident I-13 exists
     * because of. This budget can never be raised without the invariant changing. */
    expect(recording.requests).toEqual([]);
    await expectNoAxeViolations(page);
    await capture(page, 'select-week-form', info.project.name);
  });

  test('I-13: choosing a week in the open form issues ZERO requests', async ({ page }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, QUOTA_ROUND));
    await page.goto(BASE);
    await page.getByTestId('select-week').click();
    await expect(page.getByTestId('select-week-form')).toBeVisible();

    const recording = await recordRequests(
      page,
      'vacation-fill-select-week',
      info.project.name,
      async () => {
        await page.locator('select[name="weekStart"]').selectOption('2049-06-28');
        await page.waitForTimeout(500);
      },
    );

    /* The other half of I-13: not only does opening the form write nothing,
     * filling it issues nothing either. A field that checked availability on
     * change would put a half-considered week on the wire. */
    expect(recording.requests).toEqual([]);
  });

  test('I-10: an accepted Save is one write and ONE server-authoritative re-read', async ({
    page,
  }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, QUOTA_ROUND));
    await page.route(SUBMIT_API, (route) =>
      json(route, 201, {
        root: {
          id: '99999999-9999-4999-8999-999999999999',
          membershipId: MEMBERSHIP,
          subtype: 'vacation-selection',
          status: 'submitted',
          submittedAt: '2049-05-02T09:00:00.000Z',
          decidedAt: null,
          decidedBy: null,
          withdrawnAt: null,
          expiresAt: '2049-05-31T00:00:00.000Z',
          idempotencyKey: 'vac-55555555-2049-06-28',
          version: 1,
          isLate: false,
          revisionRequested: false,
        },
        record: {
          subtype: 'vacation-selection',
          vacationPeriodId: PERIOD,
          weekStart: '2049-06-28',
        },
      }),
    );

    await page.goto(BASE);
    await page.getByTestId('select-week').click();
    await page.locator('select[name="weekStart"]').selectOption('2049-06-28');

    const recording = await recordRequests(
      page,
      'vacation-save-selection-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('save-selection').click();
        await expect(page.getByTestId('select-week-form')).toHaveCount(0);
        await page.waitForTimeout(500);
      },
    );

    /* TWO, under the PO-DEC-18 ruling every accepted-save budget in this
     * repository carries: the POST plus ONE re-read of what the SERVER says the
     * round is. The read-back is load-bearing rather than cosmetic here — it is
     * how the client learns the selection's new VERSION, which the next
     * withdrawal must present. */
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('I-10: a refused Save is one request and re-reads NOTHING', async ({ page }, info) => {
    await page.route(ROUND_API, (route) => json(route, 200, QUOTA_ROUND));
    await page.route(SUBMIT_API, (route) =>
      json(
        route,
        409,
        envelope('VACATION_WEEK_ALREADY_SELECTED', 'You already hold a selection for that week.'),
      ),
    );

    await page.goto(BASE);
    await page.getByTestId('select-week').click();
    await page.locator('select[name="weekStart"]').selectOption('2049-06-28');

    const recording = await recordRequests(
      page,
      'vacation-save-selection-refused',
      info.project.name,
      async () => {
        await page.getByTestId('save-selection').click();
        await expect(page.getByTestId('validation-summary-vacation')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* One Save, one request. A refused save does NOT refetch, because nothing
     * changed — which is what makes the two-request success budget a property of
     * the success path rather than of Save in general. */
    expect(recording.requests.length).toBeLessThanOrEqual(1);
    /* And the refusal is stated in the server's own words, so a member knows
     * which of the three refusals they met. */
    await expect(page.getByTestId('validation-summary-vacation')).toContainText(
      'already hold a selection',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'select-week-refused', info.project.name);
  });
});
