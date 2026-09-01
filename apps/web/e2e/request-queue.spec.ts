import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { mockDeclaredContext } from './support/declared-context.js';
import { screenshotDir } from './support/evidence-target.js';
import { recordRequests } from './support/request-budget.js';

/**
 * **The scheduler's queue and one request's detail: every state, both viewports,
 * axe on each** (OPUS-M5-005; SPEC-08 §4).
 *
 * The interception division is the one every spec in this directory records: the
 * component tree, the router, the contracts, the zod parse and the rendering are
 * real, and only the bytes on the wire are supplied here. That the SERVER
 * produces these bodies — the decision transaction, the per-item batch outcomes,
 * `requests.read_any`'s narrowing — is proven over HTTP against real PostgreSQL
 * in `apps/api/test/requests/`.
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066 |
 * | selecting rows issues **zero** requests | I-10 — a checkbox is not a decision |
 * | opening the batch form issues **zero** requests | **I-13** |
 * | one batch decision is ONE request | I-10 |
 * | a PARTIAL batch renders EVERY item's outcome, never a count | §4, doc 42 §5d Part C |
 * | each failure reason is said in words with its own remedy | the closed vocabulary |
 * | an approval offers NO reason field; a denial requires one | §4, migration 0024's CHECK |
 * | the decision history is a LIST and a reversal names what it supersedes | §4 — nothing is overwritten |
 * | the requester's comment renders as a CODE; the scheduler's as text | FAD-58, migration 0026 |
 * | the comment bound (1..1000) is SURFACED | FAD-58.2 |
 * | **the accepted-decision states get their own axe sweep** | the M5-003 observation |
 * | no page-level horizontal scroll at 320px | AC-08 |
 *
 * Synthetic only: far-future dates, this file's own identifiers, no name from
 * the research anywhere.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const SCHEDULER = '55555555-5555-4555-8555-555555555555';

const REQUEST_ONE = '44444441-4444-4444-8444-444444444444';
const REQUEST_TWO = '44444442-4444-4444-8444-444444444444';

const QUEUE_BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/request-queue`;
const DETAIL_BASE = `${QUEUE_BASE}/${REQUEST_ONE}`;
const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/requests`;
const QUEUE_API = `${API}/queue*`;
const DECISIONS_API = `${API}/decisions`;
const DETAIL_API = `${API}/${REQUEST_ONE}`;

const SCREENSHOTS = screenshotDir('EV-M5-REQUEST-QUEUE');

function root(id: string, subtype: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    membershipId: MEMBER,
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

const QUEUE = {
  requests: [
    {
      root: root(REQUEST_ONE, 'time-off', 'submitted'),
      record: { subtype: 'time-off', targetDate: '2049-06-07' },
    },
    {
      root: root(REQUEST_TWO, 'no-call', 'submitted', { isLate: true }),
      record: { subtype: 'no-call', targetDate: '2049-06-14' },
    },
  ],
};

const QUEUE_EMPTY = { requests: [] };

/**
 * A PARTIAL batch: one accepted, one refused with a reason that has its own
 * remedy. The whole point of the per-item shape, and the case a "3 of 4 done"
 * summary line would erase.
 */
const PARTIAL_BATCH = {
  outcomes: [
    { requestId: REQUEST_ONE, ok: true, decision: 'approved', status: 'approved', version: 2 },
    { requestId: REQUEST_TWO, ok: false, failure: 'version-conflict' },
  ],
};

const DETAIL = {
  request: {
    root: root(REQUEST_ONE, 'time-off', 'approved', {
      decidedAt: '2049-05-05T09:00:00.000Z',
      decidedBy: SCHEDULER,
      version: 2,
    }),
    record: { subtype: 'time-off', targetDate: '2049-06-07' },
  },
  approvals: [
    {
      id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: REQUEST_ONE,
      decision: 'approved',
      decidedBy: SCHEDULER,
      decidedAt: '2049-05-05T09:00:00.000Z',
      reason: null,
      isOverride: false,
      vacationSelectionId: null,
      supersedesApprovalId: null,
    },
  ],
  comments: [
    {
      id: '99999991-9999-4999-8999-999999999999',
      requestId: REQUEST_ONE,
      channel: 'requester',
      reasonCode: 'bereavement',
      body: null,
      authorMembershipId: MEMBER,
      createdAt: '2049-05-02T09:00:00.000Z',
    },
    {
      id: '99999992-9999-4999-8999-999999999999',
      requestId: REQUEST_ONE,
      channel: 'scheduler',
      reasonCode: null,
      body: 'Cover arranged with the on-call rota.',
      authorMembershipId: SCHEDULER,
      createdAt: '2049-05-03T09:00:00.000Z',
    },
  ],
};

/** The same request after a reversal: TWO decisions, the second naming the first. */
const DETAIL_REVERSED = {
  ...DETAIL,
  request: { ...DETAIL.request, root: root(REQUEST_ONE, 'time-off', 'reversed', { version: 3 }) },
  approvals: [
    ...DETAIL.approvals,
    {
      id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      requestId: REQUEST_ONE,
      decision: 'reversed',
      decidedBy: SCHEDULER,
      decidedAt: '2049-05-06T09:00:00.000Z',
      reason: 'The department lost its locum cover for that week.',
      isOverride: false,
      vacationSelectionId: null,
      supersedesApprovalId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  ],
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

test.beforeEach(async ({ page }) => {
  await mockDeclaredContext(page, { organizationId: ORGANIZATION, groupIds: [GROUP] });
});

test.describe('the review queue', () => {
  test('LOADING: the queue announces itself while the read is in flight', async ({
    page,
  }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(QUEUE_API, async (route) => {
      await held;
      await json(route, 200, QUEUE);
    });

    await page.goto(QUEUE_BASE);
    const loading = page.getByTestId('surface-loading').first();
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');

    await expectNoAxeViolations(page);
    await capture(page, 'queue-loading', info.project.name);
    release();
    await expect(page.getByTestId('queue')).toBeVisible();
  });

  test('POPULATED: the queue reads in words, and says where vacation weeks are decided', async ({
    page,
  }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.goto(QUEUE_BASE);

    await expect(page.getByRole('heading', { level: 1, name: 'Requests to review' })).toBeVisible();
    await expect(page.getByTestId(`queue-row-${REQUEST_ONE}`)).toContainText('Time off');
    await expect(page.getByTestId(`queue-row-${REQUEST_TWO}`)).toContainText('(late)');

    /* The queue is the five non-vacation subtypes and that is the SERVER's rule
       — `listPendingReview` skips vacation roots. The surface says where they go
       instead of offering an always-empty filter option. */
    await expect(page.getByTestId('queue-vacation-note')).toContainText('vacation round');
    const kinds = page.getByTestId('filter-subtype').locator('option');
    await expect(kinds.filter({ hasText: 'Vacation week' })).toHaveCount(0);

    /* The identity honesty note: names come with the contacts directory, which
       carries its own decision about which fields may be shown to whom. */
    await expect(page.getByTestId('queue-identity-note')).toContainText('membership identifier');

    await expectNoAxeViolations(page);
    await capture(page, 'queue-populated', info.project.name);
  });

  test('EMPTY: nothing waiting says so in words', async ({ page }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE_EMPTY));
    await page.goto(QUEUE_BASE);
    await expect(page.getByTestId('surface-empty')).toContainText('Nothing is waiting');
    await expectNoAxeViolations(page);
    await capture(page, 'queue-empty', info.project.name);
  });

  test('403 renders no-permission — a member cannot reach the queue', async ({ page }, info) => {
    await page.route(QUEUE_API, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'You do not have permission to do that.')),
    );
    await page.goto(QUEUE_BASE);
    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'queue-forbidden', info.project.name);
  });

  test('AC-08: the page does not scroll sideways at 320px', async ({ page }) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(QUEUE_BASE);
    await expect(page.getByTestId('queue')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('the batch decision — I-13 and per-item outcomes', () => {
  test('selecting rows issues ZERO requests: a checkbox is not a decision', async ({
    page,
  }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.goto(QUEUE_BASE);
    await expect(page.getByTestId('queue')).toBeVisible();

    const recording = await recordRequests(
      page,
      'queue-select-rows',
      info.project.name,
      async () => {
        await page.getByTestId(`select-${REQUEST_ONE}`).check();
        await page.getByTestId(`select-${REQUEST_TWO}`).check();
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);
    await expect(page.getByTestId('batch-count')).toContainText('2 selected');

    await expectNoAxeViolations(page);
    await capture(page, 'queue-rows-selected', info.project.name);
  });

  test('opening the batch form issues ZERO requests', async ({ page }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.goto(QUEUE_BASE);
    await page.getByTestId(`select-${REQUEST_ONE}`).check();

    const recording = await recordRequests(
      page,
      'queue-open-batch',
      info.project.name,
      async () => {
        await page.getByTestId('open-batch').click();
        await expect(page.getByTestId('batch-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* I-13, in the form the invariant states. A control that decided twenty
     * requests on click is the incident it comes from. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);

    /* An approval offers NO reason field — §4 asks for one on a denial and §5.5
       on an override, and neither asks on an ordinary approval. */
    await expect(page.getByTestId('batch-no-reason')).toBeVisible();
    await expect(page.getByTestId('batch-reason')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'queue-batch-open', info.project.name);
  });

  test('a denial REVEALS the mandatory reason field, and refuses without it', async ({
    page,
  }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.goto(QUEUE_BASE);
    await page.getByTestId(`select-${REQUEST_ONE}`).check();
    await page.getByTestId('open-batch').click();
    await page.getByTestId('batch-decision').selectOption('denied');

    await expect(page.getByTestId('batch-reason')).toBeVisible();
    await page.getByTestId('batch-submit').click();
    await expect(page.getByTestId('validation-summary-batch')).toContainText('A denial says why');

    await expectNoAxeViolations(page);
    await capture(page, 'queue-batch-reason-required', info.project.name);
  });

  test('ONE request decides the batch, and EVERY outcome is rendered', async ({ page }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.route(DECISIONS_API, (route) => json(route, 200, PARTIAL_BATCH));
    await page.goto(QUEUE_BASE);
    await page.getByTestId(`select-${REQUEST_ONE}`).check();
    await page.getByTestId(`select-${REQUEST_TWO}`).check();
    await page.getByTestId('open-batch').click();

    const recording = await recordRequests(
      page,
      'queue-batch-decision',
      info.project.name,
      async () => {
        await page.getByTestId('batch-submit').click();
        await expect(page.getByTestId('batch-outcomes')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* ONE write for the whole batch plus ONE re-read. Twenty decisions in twenty
     * requests would be the amplification I-10 forbids, which is exactly why the
     * contract takes a list. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);

    /* EVERY item, never a count. A batch that half-succeeded and reported "done"
     * is the failure the per-item shape exists to prevent, and a summary line
     * would reintroduce it in the display layer. */
    await expect(page.getByTestId(`outcome-${REQUEST_ONE}`)).toContainText('Approved');
    await expect(page.getByTestId(`outcome-${REQUEST_TWO}`)).toContainText(
      'changed while you were looking',
    );
    await expect(page.getByTestId('batch-outcomes')).toContainText('1 of 2 were decided');

    /* The accepted-decision state, swept — the M5-003 observation. */
    await expectNoAxeViolations(page);
    await capture(page, 'queue-batch-outcomes', info.project.name);
  });

  test('changing a filter is one action and one read', async ({ page }, info) => {
    await page.route(QUEUE_API, (route) => json(route, 200, QUEUE));
    await page.goto(QUEUE_BASE);
    await expect(page.getByTestId('queue')).toBeVisible();

    const recording = await recordRequests(
      page,
      'queue-change-filter',
      info.project.name,
      async () => {
        await page.getByTestId('filter-subtype').selectOption('time-off');
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(1);
    await expectNoAxeViolations(page);
    await capture(page, 'queue-filtered', info.project.name);
  });
});

test.describe('one request in full', () => {
  test('POPULATED: the history is a LIST, and a reversal names what it supersedes', async ({
    page,
  }, info) => {
    await page.route(DETAIL_API, (route) => json(route, 200, DETAIL_REVERSED));
    await page.goto(DETAIL_BASE);

    await expect(page.getByTestId('decisions').locator('li')).toHaveCount(2);
    /* §4: "a new `approvals` record; the prior decision is never overwritten". A
       single current-decision field would be the shape that sentence forbids, and
       rendering only the latest row would be that shape in the display layer. */
    await expect(page.getByTestId('decisions')).toContainText('Approved');
    await expect(page.getByTestId('decisions')).toContainText('Reversed');
    await expect(page.getByTestId('supersedes-aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toContainText(
      'Supersedes an earlier decision, which is kept',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'detail-history', info.project.name);
  });

  test('the two comment channels render from `channel`, never guessed', async ({ page }, info) => {
    await page.route(DETAIL_API, (route) => json(route, 200, DETAIL));
    await page.goto(DETAIL_BASE);

    /* The requester's half is a CODE said in words — there is no text, because
       there is nowhere for them to type (FAD-58.1). The scheduler's half is the
       bounded administrative text. Exactly one is present on any row. */
    await expect(page.getByTestId('comment-99999991-9999-4999-8999-999999999999')).toContainText(
      'Bereavement',
    );
    await expect(page.getByTestId('comment-99999992-9999-4999-8999-999999999999')).toContainText(
      'Cover arranged with the on-call rota',
    );

    /* The bound is SURFACED rather than enforced silently. */
    await expect(page.getByTestId('comment-remaining')).toContainText('1000 characters left');
    await expect(page.getByTestId('comment-body')).toHaveAttribute('maxlength', '1000');

    await expectNoAxeViolations(page);
    await capture(page, 'detail-comments', info.project.name);
  });

  test('APPROVE is one write plus ONE re-read, and the decided state is swept', async ({
    page,
  }, info) => {
    await page.route(DETAIL_API, (route) =>
      route.request().method() === 'GET' ? json(route, 200, DETAIL) : json(route, 200, DETAIL),
    );
    await page.route(`${DETAIL_API}/approve`, (route) =>
      json(route, 200, {
        requestId: REQUEST_ONE,
        decision: 'approved',
        status: 'approved',
        version: 2,
        approvalId: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    );
    await page.goto(DETAIL_BASE);
    await expect(page.getByTestId('approve')).toBeVisible();

    const recording = await recordRequests(
      page,
      'detail-approve-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('approve').click();
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);
    await expectNoAxeViolations(page);
    await capture(page, 'detail-approved', info.project.name);
  });

  test('DENY opens a form first — it can never be a one-click act', async ({ page }, info) => {
    await page.route(DETAIL_API, (route) => json(route, 200, DETAIL));
    await page.goto(DETAIL_BASE);

    const recording = await recordRequests(
      page,
      'detail-open-deny',
      info.project.name,
      async () => {
        await page.getByTestId('open-deny').click();
        await expect(page.getByTestId('deny-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* I-13: opens a form, decides nothing. A denial requires a reason, so it
     * cannot be satisfied by a click even if somebody wanted it to be. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);

    await page.getByTestId('decision-submit').click();
    await expect(page.getByTestId('validation-summary-decision')).toContainText(
      'A denial says why',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'detail-deny-form', info.project.name);
  });

  test('a VERSION CONFLICT is rendered with its own remedy, and re-reads nothing', async ({
    page,
  }, info) => {
    await page.route(DETAIL_API, (route) => json(route, 200, DETAIL));
    await page.route(`${DETAIL_API}/approve`, (route) =>
      json(
        route,
        409,
        envelope('VERSION_CONFLICT', 'This request changed while you were looking. Reload it.'),
      ),
    );
    await page.goto(DETAIL_BASE);

    const recording = await recordRequests(
      page,
      'detail-approve-refused',
      info.project.name,
      async () => {
        await page.getByTestId('approve').click();
        await expect(page.getByTestId('validation-summary-decision')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* One write, and NO refetch: nothing changed, so a refetch would be an
     * amplification with no cause. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(1);
    await expect(page.getByTestId('validation-summary-decision')).toContainText('Reload it');

    await expectNoAxeViolations(page);
    await capture(page, 'detail-conflict', info.project.name);
  });

  test('adding a comment is one write plus ONE re-read, and the saved state is swept', async ({
    page,
  }, info) => {
    await page.route(DETAIL_API, (route) => json(route, 200, DETAIL));
    await page.route(`${DETAIL_API}/comments`, (route) =>
      json(route, 201, {
        comment: {
          id: '99999993-9999-4999-8999-999999999999',
          requestId: REQUEST_ONE,
          channel: 'scheduler',
          reasonCode: null,
          body: 'Rota updated.',
          authorMembershipId: SCHEDULER,
          createdAt: '2049-05-04T09:00:00.000Z',
        },
      }),
    );
    await page.goto(DETAIL_BASE);
    await page.getByTestId('comment-body').fill('Rota updated.');

    const recording = await recordRequests(
      page,
      'detail-comment-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('add-comment').click();
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);
    await expectNoAxeViolations(page);
    await capture(page, 'detail-comment-added', info.project.name);
  });
});
