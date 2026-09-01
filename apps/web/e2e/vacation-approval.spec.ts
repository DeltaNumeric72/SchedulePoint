import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { mockDeclaredContext } from './support/declared-context.js';
import { screenshotDir } from './support/evidence-target.js';
import { recordRequests } from './support/request-budget.js';

/**
 * **The scheduler's vacation round: approve, deny, commit, and the REVERSAL's
 * graduated confirmation** (OPUS-M5-005; SPEC-08 §5.4/§5.5/§5.6, the affordance
 * doc 42 §5h routed to this packet).
 *
 * The interception division is this directory's: the component tree, the router,
 * the contracts, the zod parse and the rendering are real; only the bytes on the
 * wire are supplied. That the SERVER produces them — D-21's race, D-26's
 * idempotency, FAD-59's ledger, §5.6's release and revision event — is proven
 * over HTTP against real PostgreSQL in `apps/api/test/requests/`, and the new
 * read route is proven there too
 * (`vacation-round-scheduler-read-http.test.ts`).
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066 |
 * | opening the reversal confirmation issues **zero** requests | **I-13** |
 * | completing the acknowledgement issues **zero** requests | **I-13**, the other half |
 * | the reversal names ALL THREE consequences before it will proceed | §5.6, the graduated confirmation |
 * | the reversal cannot be submitted with the acknowledgement alone | the two steps are sequential |
 * | the reversal cannot be submitted without a reason | §5.6's MANDATORY reason |
 * | open mode says NO unit returns, rather than promising a release | **V-30** |
 * | `isOverride` is rendered WITH the status that disambiguates it | **FU-36** |
 * | the variance warns and blocks NOTHING | doc 09 §2.1 |
 * | a named refusal is rendered with ITS OWN remedy | §5.4/§5.5's closed codes |
 * | **the accepted-decision states get their own axe sweep** | the M5-003 observation |
 * | no page-level horizontal scroll at 320px | AC-08 |
 *
 * ## The reversal's two-step property, asserted as a STATE MACHINE
 *
 * Three assertions rather than one, because "there is a confirmation" is not the
 * claim. The claim is that no path reaches a completed reversal in fewer than
 * two deliberate acts plus a sentence: the submit is disabled with NEITHER step
 * done, still disabled with ONLY the acknowledgement done, still disabled with a
 * reason but no acknowledgement (unreachable by construction — the field is not
 * rendered — so that leg is asserted as the field's absence), and enabled only
 * with both. A confirmation that could be clicked through would fail the middle
 * assertion while passing a naive "the dialog appeared" one.
 *
 * Synthetic only: far-future dates, this file's own identifiers, and the one
 * reversal reason below is administrative and non-clinical.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const PERIOD = '55555555-5555-4555-8555-555555555555';
const MEMBER_A = '33333333-3333-4333-8333-333333333333';
const MEMBER_B = '33333334-3333-4333-8333-333333333333';
const GRANT = '66666666-6666-4666-8666-666666666666';

const PENDING_SELECTION = '77777771-7777-4777-8777-777777777777';
const COMMITTED_SELECTION = '77777772-7777-4777-8777-777777777777';
const REVERSED_SELECTION = '77777773-7777-4777-8777-777777777777';
const DRAFT_VERSION = '88888888-8888-4888-8888-888888888888';
const SCHEDULE_PERIOD = '88888889-8888-4888-8888-888888888888';

const BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/vacation/rounds/${PERIOD}/review`;
const GROUP_API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}`;
const SELECTIONS_API = `${GROUP_API}/vacation/rounds/${PERIOD}/selections`;
const PERIODS_API = `${GROUP_API}/schedule/periods`;
const VERSIONS_API = `${GROUP_API}/schedule/periods/${SCHEDULE_PERIOD}/versions`;
const COMMIT_API = `${GROUP_API}/vacation/rounds/${PERIOD}/commit`;

const SCREENSHOTS = screenshotDir('EV-M5-VACATION-APPROVAL');

function view(
  id: string,
  membershipId: string,
  weekStart: string,
  status: string,
  rootStatus: string | null,
  extra: { isOverride?: boolean; committedToVersionId?: string | null } = {},
) {
  return {
    selection: {
      id,
      requestId:
        rootStatus === null ? null : `99999999-9999-4999-8999-99999999999${id.slice(7, 8)}`,
      membershipId,
      vacationPeriodId: PERIOD,
      weekStart,
      status,
      version: 1,
      grantId: GRANT,
      /* C-3, held for the SCHEDULER too: `isOverride` is carried and
       * `overrideReason` is NOT, and `vacationSelectionSummarySchema` is
       * `.strict()` — so a fixture carrying the reason would fail to parse. The
       * wire contract enforces its own omission, for this reader as well. */
      isOverride: extra.isOverride ?? false,
      committedToVersionId: extra.committedToVersionId ?? null,
    },
    rootStatus,
    rootVersion: rootStatus === null ? null : 1,
    submittedAt: '2049-05-01T09:00:00.000Z',
    expiresAt: '2049-05-20T00:00:00.000Z',
    isLate: false,
  };
}

const QUOTA_ROUND = {
  period: {
    id: PERIOD,
    startDate: '2049-06-07',
    endDate: '2049-07-02',
    mode: 'quota' as const,
    state: 'open' as const,
    version: 1,
  },
  selections: [
    view(PENDING_SELECTION, MEMBER_A, '2049-06-07', 'pending', 'submitted'),
    view(COMMITTED_SELECTION, MEMBER_B, '2049-06-14', 'committed', 'reflected_in_version', {
      committedToVersionId: DRAFT_VERSION,
    }),
  ],
  variance: [
    {
      grantId: GRANT,
      kind: 'personal-entitlement' as const,
      membershipId: MEMBER_A,
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
 * FU-36's discriminating fixture: TWO rows with `isOverride` true, one `approved`
 * and one `reversed`. The flag says the same thing on both rows and the STATUS is
 * the only thing that tells the two facts apart — so a page that rendered the
 * flag without consulting the status would print the same sentence twice, and
 * the assertions below would catch it.
 */
const OVERRIDE_ROUND = {
  ...QUOTA_ROUND,
  selections: [
    view(PENDING_SELECTION, MEMBER_A, '2049-06-07', 'approved', 'approved', { isOverride: true }),
    view(REVERSED_SELECTION, MEMBER_B, '2049-06-14', 'reversed', 'reversed', { isOverride: true }),
  ],
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
  selections: [
    view(COMMITTED_SELECTION, MEMBER_B, '2049-06-14', 'committed', 'reflected_in_version', {
      committedToVersionId: DRAFT_VERSION,
    }),
  ],
  variance: [],
};

const EMPTY_ROUND = { ...QUOTA_ROUND, selections: [] };

/**
 * The schedule period the commit targets.
 *
 * The fields are `schedulePeriodViewSchema`'s exactly, and the list carries
 * `correlationId`, because both schemas are `.strict()`. An earlier revision of
 * this fixture invented `version` and omitted `correlationId`; the zod parse
 * threw, the query errored, the period picker rendered no options, and the two
 * commit cases below timed out at 30s waiting to select one. The contract
 * enforcing its own shape is what found it — recorded here rather than quietly
 * corrected, because the failure mode (a timeout, not a parse error) points
 * nowhere near the cause.
 */
const PERIODS = {
  periods: [
    {
      id: SCHEDULE_PERIOD,
      name: 'Summer 2049',
      startDate: '2049-06-01',
      endDate: '2049-08-31',
      status: 'planning',
    },
  ],
  correlationId: 'e2e-correlation-id',
};

/** `scheduleVersionViewSchema` exactly — likewise `.strict()`, likewise found by it. */
const VERSIONS = {
  periodId: SCHEDULE_PERIOD,
  versions: [
    {
      id: DRAFT_VERSION,
      periodId: SCHEDULE_PERIOD,
      versionNumber: null,
      state: 'draft',
      lockState: 'unlocked',
      isCurrent: false,
      clonedFromVersionId: null,
      isEditable: true,
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

/** The page's two loads. Both are always fulfilled so a state is never a 404. */
async function mockPage(page: Page, round: unknown = QUOTA_ROUND): Promise<void> {
  await page.route(SELECTIONS_API, (route) => json(route, 200, round));
  await page.route(PERIODS_API, (route) => json(route, 200, PERIODS));
}

test.beforeEach(async ({ page }) => {
  await mockDeclaredContext(page, { organizationId: ORGANIZATION, groupIds: [GROUP] });
});

test.describe('the round, as a decider reads it', () => {
  test('LOADING: the round announces itself while the read is in flight', async ({
    page,
  }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await page.route(PERIODS_API, (route) => json(route, 200, PERIODS));
    await page.route(SELECTIONS_API, async (route) => {
      await held;
      await json(route, 200, QUOTA_ROUND);
    });

    await page.goto(BASE);
    const loading = page.getByTestId('surface-loading').first();
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');

    await expectNoAxeViolations(page);
    await capture(page, 'approval-loading', info.project.name);
    release();
    await expect(page.getByTestId('round-selections')).toBeVisible();
  });

  test("POPULATED: every member's weeks, with the act each status permits", async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.goto(BASE);

    await expect(
      page.getByRole('heading', { level: 1, name: 'Vacation round — review' }),
    ).toBeVisible();

    /* The read is `scope: 'period'` — TWO members' weeks, which is the whole
       reason the route this packet adds exists. */
    await expect(page.getByTestId(`row-${PENDING_SELECTION}`)).toContainText('2049-06-07');
    await expect(page.getByTestId(`row-${COMMITTED_SELECTION}`)).toContainText('2049-06-14');

    /* The affordance follows the SELECTION's status: `pending` gets approve and
       deny (R-18/R-19), `committed` gets reverse (§5.6), and neither gets the
       other's. */
    await expect(page.getByTestId(`approve-${PENDING_SELECTION}`)).toBeVisible();
    await expect(page.getByTestId(`deny-${PENDING_SELECTION}`)).toBeVisible();
    await expect(page.getByTestId(`reverse-${PENDING_SELECTION}`)).toHaveCount(0);
    await expect(page.getByTestId(`reverse-${COMMITTED_SELECTION}`)).toBeVisible();
    await expect(page.getByTestId(`approve-${COMMITTED_SELECTION}`)).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'approval-populated', info.project.name);
  });

  test('FU-36: `isOverride` is told apart by the STATUS, on two rows that share the flag', async ({
    page,
  }, info) => {
    await mockPage(page, OVERRIDE_ROUND);
    await page.goto(BASE);

    /* Same flag, two different facts. The approved row means "approved beyond
       the allowance"; the reversed row means "a reason is recorded for the
       reversal" — 0022's frozen equality `is_override = (override_reason IS NOT
       NULL)` plus §5.6's mandatory reason force the second. A page that printed
       one sentence for both would fail here. */
    await expect(page.getByTestId(`row-override-${PENDING_SELECTION}`)).toContainText(
      'approved beyond the allowance',
    );
    await expect(page.getByTestId(`row-override-${REVERSED_SELECTION}`)).toContainText(
      'a reason is recorded for the reversal',
    );
    await expect(page.getByTestId(`row-override-${REVERSED_SELECTION}`)).not.toContainText(
      'approved beyond the allowance',
    );

    /* The variance WARNS and blocks nothing — doc 09 §2.1. It is an alert rather
       than a colour, so it reaches somebody who cannot see the colour, and no
       control on the page is disabled by it. */
    const over = page.getByTestId(`approval-variance-over-${GRANT}`);
    await expect(over).toHaveAttribute('role', 'alert');
    await expect(over).toContainText('warning, not a limit');

    await expectNoAxeViolations(page);
    await capture(page, 'approval-override', info.project.name);
  });

  test('EMPTY: a round nobody has asked for says so in words', async ({ page }, info) => {
    await mockPage(page, EMPTY_ROUND);
    await page.goto(BASE);
    await expect(page.getByTestId('no-round-selections')).toContainText('Nobody has asked');
    await expectNoAxeViolations(page);
    await capture(page, 'approval-empty', info.project.name);
  });

  test('403 renders no-permission — a member cannot reach the review surface', async ({
    page,
  }, info) => {
    await page.route(PERIODS_API, (route) => json(route, 200, PERIODS));
    await page.route(SELECTIONS_API, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'You do not have permission to do that.')),
    );
    await page.goto(BASE);
    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'approval-forbidden', info.project.name);
  });

  test('AC-08: the page does not scroll sideways at 320px', async ({ page }) => {
    await mockPage(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(BASE);
    await expect(page.getByTestId('round-selections')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('§5.4 — approving and denying a week', () => {
  test('APPROVE is one write plus ONE re-read, and the decided state is swept', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.route(`${GROUP_API}/vacation/selections/${PENDING_SELECTION}/approve`, (route) =>
      json(route, 200, {
        selectionId: PENDING_SELECTION,
        requestId: '99999999-9999-4999-8999-999999999991',
        outcome: 'approved',
        selectionVersion: 2,
        grantId: GRANT,
        isOverride: false,
        replayed: false,
      }),
    );
    await page.goto(BASE);
    await expect(page.getByTestId(`approve-${PENDING_SELECTION}`)).toBeVisible();

    const recording = await recordRequests(
      page,
      'vacation-approve-accepted',
      info.project.name,
      async () => {
        await page.getByTestId(`approve-${PENDING_SELECTION}`).click();
        await page.waitForTimeout(500);
      },
    );

    /* One write plus ONE server-authoritative re-read (PO-DEC-18). Patching the
     * cache would invent the selection's new VERSION, which the next act has to
     * present. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);

    await expectNoAxeViolations(page);
    await capture(page, 'approval-approved', info.project.name);
  });

  test('a NAMED refusal is rendered with its own remedy', async ({ page }, info) => {
    await mockPage(page);
    await page.route(`${GROUP_API}/vacation/selections/${PENDING_SELECTION}/approve`, (route) =>
      json(
        route,
        409,
        envelope(
          'OVERRIDE_REQUIRED',
          'This week exceeds the entitlement, and you may not approve beyond it.',
        ),
      ),
    );
    await page.goto(BASE);

    const recording = await recordRequests(
      page,
      'vacation-approve-refused',
      info.project.name,
      async () => {
        await page.getByTestId(`approve-${PENDING_SELECTION}`).click();
        await expect(page.getByTestId('approval-problem')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* One write, no refetch — nothing changed. And the refusal keeps its own
     * words: `OVERRIDE_REQUIRED` means this actor may not exceed the quota,
     * which is a different situation from `QUOTA_EXHAUSTED` and from
     * `VERSION_CONFLICT`, and the surface does not flatten the three. */
    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(1);
    await expect(page.getByTestId('approval-problem')).toContainText('may not approve beyond it');

    await expectNoAxeViolations(page);
    await capture(page, 'approval-refused', info.project.name);
  });

  test('DENY opens a form first, and says that a denial consumes nothing', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.goto(BASE);

    const recording = await recordRequests(
      page,
      'vacation-open-deny-week',
      info.project.name,
      async () => {
        await page.getByTestId(`deny-${PENDING_SELECTION}`).click();
        await expect(page.getByTestId('deny-week-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);
    await expect(page.getByTestId('deny-week-note')).toContainText('consumes nothing');

    await page.getByTestId('deny-week-submit').click();
    await expect(page.getByTestId('validation-summary-deny-week')).toContainText(
      'A denial says why',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'approval-deny-form', info.project.name);
  });
});

test.describe('§5.6 — the REVERSAL and its graduated confirmation', () => {
  test('opening the confirmation issues ZERO requests, and names all three consequences', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await expect(page.getByTestId(`reverse-${COMMITTED_SELECTION}`)).toBeVisible();

    const recording = await recordRequests(
      page,
      'vacation-open-reverse-confirm',
      info.project.name,
      async () => {
        await page.getByTestId(`reverse-${COMMITTED_SELECTION}`).click();
        await expect(page.getByTestId('reverse-week-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* I-13: opens a confirmation and reverses nothing. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);

    /* ALL THREE consequences, each asserted by its own meaning rather than by
       the panel merely being present. */
    await expect(page.getByTestId('consequence-units')).toContainText(
      'returned to the entitlement',
    );
    await expect(page.getByTestId('consequence-revision')).toContainText(
      'The published schedule is not changed by this',
    );
    await expect(page.getByTestId('consequence-revision')).toContainText(
      'publish a corrected version',
    );
    await expect(page.getByTestId('consequence-snapshots')).toContainText('are kept');
    await expect(page.getByTestId('consequence-snapshots')).toContainText('Nothing is deleted');

    await expectNoAxeViolations(page);
    await capture(page, 'reverse-confirm-open', info.project.name);
  });

  test('the two steps are SEQUENTIAL: neither alone reaches a reversal', async ({ page }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await page.getByTestId(`reverse-${COMMITTED_SELECTION}`).click();
    await expect(page.getByTestId('reverse-week-form')).toBeVisible();

    /* State 1 — NEITHER step done. Disabled, and the reason field does not
       exist yet, so the "reason without acknowledgement" leg is unreachable by
       construction rather than guarded against. */
    await expect(page.getByTestId('reverse-submit')).toBeDisabled();
    await expect(page.getByTestId('reverse-reason')).toHaveCount(0);
    await expect(page.getByTestId('reverse-step-two-pending')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'reverse-step-none', info.project.name);

    /* State 2 — acknowledgement ONLY. Still disabled. This is the assertion a
       naive "the dialog appeared" test would pass without: a confirmation that
       could be clicked through fails HERE. */
    const recording = await recordRequests(
      page,
      'vacation-fill-reverse-confirm',
      info.project.name,
      async () => {
        await page.getByTestId('reverse-acknowledge').check();
        await expect(page.getByTestId('reverse-reason')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );
    /* The other half of I-13: completing the acknowledgement writes nothing. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);
    await expect(page.getByTestId('reverse-submit')).toBeDisabled();
    await expectNoAxeViolations(page);
    await capture(page, 'reverse-step-one', info.project.name);

    /* State 3 — whitespace is not a reason. The contract trims before it bounds,
       so a surface that accepted "   " would be sending a body the server
       refuses. */
    await page.getByTestId('reverse-reason').fill('   ');
    await expect(page.getByTestId('reverse-submit')).toBeDisabled();

    /* State 4 — both steps. Only now. */
    await page.getByTestId('reverse-reason').fill('The department lost its locum cover.');
    await expect(page.getByTestId('reverse-submit')).toBeEnabled();
    await expectNoAxeViolations(page);
    await capture(page, 'reverse-step-both', info.project.name);
  });

  test('OPEN mode says NO unit returns, rather than promising a release', async ({
    page,
  }, info) => {
    await mockPage(page, OPEN_ROUND);
    await page.goto(BASE);
    await page.getByTestId(`reverse-${COMMITTED_SELECTION}`).click();

    /* V-30: an open round has no grant row, so there is nothing to release. A
       confirmation that promised a returned unit here would be describing a write
       that cannot happen. */
    await expect(page.getByTestId('consequence-units')).toContainText('No allowance unit');
    await expect(page.getByTestId('consequence-units')).not.toContainText('is returned to the');
    await expect(page.getByTestId('approval-variance-open')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'reverse-open-mode', info.project.name);
  });

  test('the completed reversal is one write plus ONE re-read, and the saved state is swept', async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.route(`${GROUP_API}/vacation/selections/${COMMITTED_SELECTION}/reverse`, (route) =>
      json(route, 200, {
        selectionId: COMMITTED_SELECTION,
        requestId: '99999999-9999-4999-8999-999999999992',
        selectionVersion: 2,
        unitReleased: true,
        revisionRequested: true,
      }),
    );
    await page.goto(BASE);
    await page.getByTestId(`reverse-${COMMITTED_SELECTION}`).click();
    await page.getByTestId('reverse-acknowledge').check();
    await page.getByTestId('reverse-reason').fill('The department lost its locum cover.');

    const recording = await recordRequests(
      page,
      'vacation-reverse-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('reverse-submit').click();
        await expect(page.getByTestId('reverse-week-form')).toHaveCount(0);
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);
    await expectNoAxeViolations(page);
    await capture(page, 'reverse-accepted', info.project.name);
  });
});

test.describe('§5.6 — the commit', () => {
  test('opening the commit form issues ZERO requests', async ({ page }, info) => {
    await mockPage(page);
    await page.goto(BASE);
    await expect(page.getByTestId('open-commit')).toBeVisible();

    const recording = await recordRequests(
      page,
      'vacation-open-commit',
      info.project.name,
      async () => {
        await page.getByTestId('open-commit').click();
        await expect(page.getByTestId('commit-form')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    /* ZERO — the versions read is gated on a schedule period actually being
     * chosen, so opening the form fetches nothing. */
    expect(recording.requests, JSON.stringify(recording.requests, null, 2)).toEqual([]);

    /* The commit is an act on the ROUND, and the form says so rather than
       offering a selection list that does not exist in the contract. */
    await expect(page.getByTestId('commit-explainer')).toContainText('every approved week');

    await expectNoAxeViolations(page);
    await capture(page, 'commit-form-open', info.project.name);
  });

  test("choosing a schedule period reads that period's versions — one action, one request", async ({
    page,
  }, info) => {
    await mockPage(page);
    await page.route(VERSIONS_API, (route) => json(route, 200, VERSIONS));
    await page.goto(BASE);
    await page.getByTestId('open-commit').click();

    const recording = await recordRequests(
      page,
      'vacation-choose-commit-period',
      info.project.name,
      async () => {
        await page.getByTestId('commit-period').selectOption(SCHEDULE_PERIOD);
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(1);

    /* Only DRAFTS are listed — committing into a published version is refused by
       name (I-18), and the help text says so rather than leaving a scheduler to
       wonder where their version went. */
    const options = page.getByTestId('commit-version').locator('option');
    await expect(options).toHaveCount(2);

    await expectNoAxeViolations(page);
    await capture(page, 'commit-period-chosen', info.project.name);
  });

  test('the commit is one write plus ONE re-read, and a REPLAY says so', async ({ page }, info) => {
    await mockPage(page);
    await page.route(VERSIONS_API, (route) => json(route, 200, VERSIONS));
    await page.route(COMMIT_API, (route) =>
      json(route, 200, {
        vacationPeriodId: PERIOD,
        targetVersionId: DRAFT_VERSION,
        committedSelectionIds: [PENDING_SELECTION],
        assignmentsCreated: 0,
        /* R-12: the ledger already held this key. Nothing was written the second
         * time, and the surface must not report it as a second commit. */
        replayed: true,
      }),
    );
    await page.goto(BASE);
    await page.getByTestId('open-commit').click();
    await page.getByTestId('commit-period').selectOption(SCHEDULE_PERIOD);
    await page.getByTestId('commit-version').selectOption(DRAFT_VERSION);

    const recording = await recordRequests(
      page,
      'vacation-commit-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('commit-submit').click();
        await expect(page.getByTestId('commit-result')).toBeVisible();
        await page.waitForTimeout(500);
      },
    );

    expect(recording.requests.length, JSON.stringify(recording.requests, null, 2)).toBe(2);
    await expect(page.getByTestId('commit-replayed')).toContainText(
      'Nothing was written a second time',
    );

    await expectNoAxeViolations(page);
    await capture(page, 'commit-accepted', info.project.name);
  });
});
