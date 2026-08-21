import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { recordRequests } from './support/request-budget.js';

import { screenshotDir } from './support/evidence-target.js';
import { mockDeclaredContext } from './support/declared-context.js';

/**
 * The publication and version-management surface: every state, both viewports,
 * axe on each (OPUS-M3-005).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why the API is intercepted rather than run
 *
 * The same division `schedule.spec.ts`, `catalogue.spec.ts` and `rules.spec.ts`
 * record: this file proves the **interface** behaves correctly for each
 * response. That the server produces those responses — the grant-only gate, the
 * two compare-and-sets, the idempotent replay, the rollback on a late
 * prerequisite failure, cross-group isolation — is proven separately, over HTTP
 * against the real database, in `apps/api/test/schedule/publication-http.test.ts`
 * and `publication-concurrency.test.ts`. The component tree, router, contracts,
 * zod parse, query client and rendering here are all the real ones.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066, AC-01 |
 * | "Publish this version…" and filling the panel issue **zero** requests | **I-13** |
 * | a double-click issues exactly ONE publication request | D-17, I-10 |
 * | a RETRY carries the SAME idempotency key as the first attempt | **D-17 — red-cased** |
 * | the publish control renders a deny state when the grant is absent | SP-E §1.3, doc 08 §4 |
 * | `CURRENT_VERSION_MOVED` renders explicitly with one reload control | FAD-22(2), V-12, SP-E §1.4 |
 * | `STALE_REVIEW` renders explicitly | PO-DEC-18 |
 * | the rendered change rows equal the response's changes, one for one | the packet's equality requirement |
 * | no `data-affordance="edit"` control in any immutable row — and a draft row HAS one | **I-18** |
 * | the typed confirmation is demanded before the request is made | SP-E §3 |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3/P-6 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const PERIOD = '33333333-3333-4333-8333-333333333333';
const V1 = '44444444-4444-4444-8444-444444444444';
const V2 = '55555555-5555-4555-8555-555555555555';
const DRAFT = '66666666-6666-4666-8666-666666666666';
const MEMBER_A = '77777777-7777-4777-8777-777777777777';
const MEMBER_B = '88888888-8888-4888-8888-888888888888';
const SHIFT_DAY = '99999999-9999-4999-8999-999999999999';
const IDENTITY_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const IDENTITY_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const PUBLICATION_BASE = `/organizations/${ORGANIZATION}/groups/${GROUP}/publication`;
const REVIEW_URL = `${PUBLICATION_BASE}/versions/${DRAFT}/review`;
const HISTORY_URL = `${PUBLICATION_BASE}/periods/${PERIOD}/history`;
const PUBLISHED_URL = `${PUBLICATION_BASE}/periods/${PERIOD}/published`;
const COMPARISON_URL = `${PUBLICATION_BASE}/versions/${V2}/comparison`;
const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}`;

const SCREENSHOTS = screenshotDir('EV-M3-PUBLICATION-UX');

const PERIOD_NAME = 'March authoring window';
const DIGEST = 'a'.repeat(64);
const MOVED_DIGEST = 'b'.repeat(64);

function periodView() {
  return {
    id: PERIOD,
    name: PERIOD_NAME,
    startDate: '2029-03-01',
    endDate: '2029-03-31',
    status: 'planning',
  };
}

function versionView(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    periodId: PERIOD,
    versionNumber: null,
    state: 'approved',
    lockState: 'unlocked',
    isCurrent: false,
    clonedFromVersionId: null,
    isEditable: false,
    ...overrides,
  };
}

function publishedVersionView(overrides: Record<string, unknown> = {}) {
  return {
    ...versionView(),
    publishedAt: '2029-02-01T09:00:00.000Z',
    publishedByMembershipId: MEMBER_A,
    publishedByDisplayName: 'Synthetic Member A',
    supersededAt: null,
    supersededByVersionId: null,
    createdAt: '2029-01-01T09:00:00.000Z',
    isImmutable: true,
    activeAssignmentCount: 2,
    ...overrides,
  };
}

function change(overrides: Record<string, unknown> = {}) {
  return {
    assignmentIdentityId: IDENTITY_1,
    kind: 'reassigned',
    fromMembershipId: MEMBER_A,
    toMembershipId: MEMBER_B,
    date: '2029-03-04',
    shiftTypeId: SHIFT_DAY,
    shiftTypeCode: 'DAY',
    startsAt: '2029-03-04T08:00:00.000Z',
    endsAt: '2029-03-04T16:00:00.000Z',
    fromDisplayName: 'Synthetic Member A',
    toDisplayName: 'Synthetic Member B',
    /* OPUS-M4-000C: every material dimension that moved. REQUIRED by
     * `assignmentChangeCoreSchema`, so a fixture without it fails the parse and
     * the review never renders. */
    materialFields: ['participant'],
    ...overrides,
  };
}

function difference(overrides: Record<string, unknown> = {}) {
  return {
    changes: [
      change(),
      change({
        assignmentIdentityId: IDENTITY_2,
        kind: 'added',
        fromMembershipId: null,
        fromDisplayName: null,
        materialFields: ['participant', 'date', 'time', 'shiftType', 'location', 'pin', 'credit'],
        date: '2029-03-05',
        startsAt: '2029-03-05T08:00:00.000Z',
        endsAt: '2029-03-05T16:00:00.000Z',
      }),
    ],
    affectedMembershipIds: [MEMBER_A, MEMBER_B],
    affectedMembers: [
      {
        membershipId: MEMBER_A,
        displayName: 'Synthetic Member A',
        added: 0,
        removed: 0,
        reassignedAway: 1,
        reassignedTo: 0,
        retimed: 0,
        amended: 0,
      },
      {
        membershipId: MEMBER_B,
        displayName: 'Synthetic Member B',
        added: 1,
        removed: 0,
        reassignedAway: 0,
        reassignedTo: 1,
        retimed: 0,
        amended: 0,
      },
    ],
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    version: versionView(),
    period: periodView(),
    // `scheduleVersionViewSchema`, not the published view: the review's
    // `currentVersion` is the plain version shape and the contract is `.strict()`.
    currentVersion: versionView({ id: V2, versionNumber: 2, state: 'published', isCurrent: true }),
    expectedPriorCurrentVersionId: V2,
    reviewDigest: DIGEST,
    difference: difference(),
    blockers: [],
    warnings: [
      { code: 'UNMET_REQUIREMENT', message: '2 stated staffing requirements are not met. This does not block publication.', count: 2 },
    ],
    canPublish: true,
    canRevert: true,
    frictionTier: 'type-to-confirm',
    confirmationPhrase: PERIOD_NAME,
    timezone: 'UTC',
    correlationId: 'e2e-correlation-id',
    ...overrides,
  };
}

function history(overrides: Record<string, unknown> = {}) {
  return {
    period: periodView(),
    versions: [
      { ...versionView({ id: DRAFT, state: 'draft', isEditable: true }), publishedAt: null, publishedByMembershipId: null, publishedByDisplayName: null, supersededAt: null, supersededByVersionId: null, createdAt: '2029-02-10T09:00:00.000Z', isImmutable: false, activeAssignmentCount: 3 },
      publishedVersionView({ id: V2, versionNumber: 2, state: 'published', isCurrent: true }),
      publishedVersionView({
        id: V1,
        versionNumber: 1,
        state: 'superseded',
        isCurrent: false,
        supersededAt: '2029-02-01T09:00:00.000Z',
        supersededByVersionId: V2,
      }),
    ],
    currentVersionId: V2,
    canPublish: true,
    canRevert: true,
    timezone: 'UTC',
    correlationId: 'e2e-correlation-id',
    ...overrides,
  };
}

const PUBLISHED_SCHEDULE = {
  period: periodView(),
  version: publishedVersionView({ id: V2, versionNumber: 2, state: 'published', isCurrent: true }),
  assignments: [
    {
      assignmentIdentityId: IDENTITY_1,
      membershipId: MEMBER_A,
      displayName: 'Synthetic Member A',
      date: '2029-03-04',
      shiftTypeId: SHIFT_DAY,
      startsAt: '2029-03-04T08:00:00.000Z',
      endsAt: '2029-03-04T16:00:00.000Z',
      isPinned: false,
      overrideReasonGiven: false,
    },
  ],
  shiftTypes: [
    { id: SHIFT_DAY, code: 'DAY', name: 'Day shift', startTime: '08:00', endTime: '16:00', crossesMidnight: false },
  ],
  timezone: 'UTC',
  correlationId: 'e2e-correlation-id',
};

/**
 * The audit-chain read for the current published version (OPUS-M3-008).
 *
 * The two sequences are deliberately NON-CONTIGUOUS (`41` then `44`): a
 * group-scoped read of an organization-wide sequence has gaps by construction,
 * and the surface has to say so rather than let a reader treat one as damage.
 */
const AUDIT_EVENTS = {
  events: [
    {
      id: 'aa000001-0000-4000-8000-000000000001',
      sequence: '44',
      occurredAt: '2027-03-02T09:00:00.000Z',
      eventName: 'schedule.version.published',
      actorKind: 'membership',
      actorMembershipId: '99999999-9999-4999-8999-999999999999',
      actorDisplayName: 'Synthetic Member A',
      groupId: GROUP,
      subjectType: 'schedule_version',
      subjectId: V2,
      payload: { period: 'p', number: 2, affected: 2, changes: 2 },
      entryHash: 'ab'.repeat(32),
      prevHash: 'cd'.repeat(32),
    },
    {
      id: 'aa000001-0000-4000-8000-000000000002',
      sequence: '41',
      occurredAt: '2027-03-01T09:00:00.000Z',
      eventName: 'schedule.version.created',
      actorKind: 'membership',
      actorMembershipId: '99999999-9999-4999-8999-999999999999',
      actorDisplayName: 'Synthetic Member A',
      groupId: GROUP,
      subjectType: 'schedule_version',
      subjectId: V2,
      payload: { period: 'p', origin: 'clone' },
      entryHash: 'ef'.repeat(32),
      prevHash: '01'.repeat(32),
    },
  ],
  truncated: false,
  sequenceIsOrganizationWide: true,
  correlationId: 'e2e-correlation-id',
};

/**
 * The audit reply for a request, honouring its `limit` exactly as the server
 * does: at most `limit` events, and `truncated` true when more exist.
 */
function auditEventsFor(url: URL): Record<string, unknown> {
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const available = AUDIT_EVENTS.events;
  return {
    events: available.slice(0, limit),
    truncated: available.length > limit,
    sequenceIsOrganizationWide: true,
    correlationId: 'e2e-correlation-id',
  };
}

const RECORDS = {
  periodId: PERIOD,
  records: [
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      versionId: V2,
      versionNumber: 2,
      outcome: 'published',
      recordedAt: '2029-02-01T09:00:00.000Z',
      actorMembershipId: MEMBER_A,
      actorDisplayName: 'Synthetic Member A',
      affectedCount: 2,
      priorCurrentVersionId: V1,
    },
  ],
  correlationId: 'e2e-correlation-id',
};

const COMPARISON = {
  fromVersion: publishedVersionView({ id: V1, versionNumber: 1, state: 'superseded' }),
  toVersion: publishedVersionView({ id: V2, versionNumber: 2, state: 'published', isCurrent: true }),
  difference: difference(),
  shiftTypes: PUBLISHED_SCHEDULE.shiftTypes,
  timezone: 'UTC',
  correlationId: 'e2e-correlation-id',
};

const AFFECTED = {
  fromVersionId: V1,
  toVersionId: V2,
  affectedMembers: difference().affectedMembers,
  changeCount: 2,
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

/** The default routing: an approved draft with a real difference and a history. */
async function routeHappyPath(page: Page): Promise<void> {
  await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
    json(route, 200, review()),
  );
  await page.route(`${API}/schedule/periods/*/history`, (route) => json(route, 200, history()));
  await page.route(`${API}/schedule/periods/*/published`, (route) =>
    json(route, 200, PUBLISHED_SCHEDULE),
  );
  await page.route(`${API}/schedule/periods/*/publication-records`, (route) =>
    json(route, 200, RECORDS),
  );
  await page.route(`${API}/schedule/versions/*/comparison*`, (route) => json(route, 200, COMPARISON));
  await page.route(`${API}/schedule/versions/*/affected-staff*`, (route) => json(route, 200, AFFECTED));
  /* The audit READ surface (OPUS-M3-008). Its own base path, not under
   * `/schedule` — it is a different capability with different scope rules.
   *
   * The reply is COMPUTED from the request's own `limit`, not a pinned constant
   * (N-6): the server reads one row past the limit and reports `truncated`, and
   * a fixture that always answered two events with `truncated: false` could never
   * exercise the branch that says so. */
  await page.route(`${API}/audit-events*`, (route) =>
    json(route, 200, auditEventsFor(new URL(route.request().url()))),
  );
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

test.describe('publication review — states', () => {
  test('LOADING: the review announces itself while it is being fetched', async ({ page }, info) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication-review`, async (route) => {
      await held;
      await json(route, 200, review());
    });

    await page.goto(REVIEW_URL);
    const loading = page.getByTestId('surface-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toHaveAttribute('aria-live', 'polite');

    await expectNoAxeViolations(page);
    await capture(page, 'review-loading', info.project.name);
    release();
  });

  test('ERROR: a 500 renders the fixed message verbatim, never expanded', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(route, 500, envelope('INTERNAL_ERROR', 'The request could not be completed.')),
    );

    await page.goto(REVIEW_URL);
    const error = page.getByTestId('surface-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(error).toContainText('The request could not be completed.');

    await expectNoAxeViolations(page);
    await capture(page, 'review-error', info.project.name);
  });

  test('DENIAL: a 403 says "no permission"; a 404 says "not found" — different messages', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'Not permitted.')),
    );

    await page.goto(REVIEW_URL);
    await expect(page.getByTestId('surface-permission-denied')).toBeVisible();
    await expect(page.getByTestId('surface-permission-denied')).toContainText(
      'You do not have permission',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'review-denied', info.project.name);

    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(route, 404, envelope('NOT_FOUND', 'Not found.')),
    );
    await page.reload();
    const notFound = page.getByTestId('surface-error');
    await expect(notFound).toBeVisible();
    await expect(notFound).not.toContainText('permission');
  });

  test('EMPTY: a period that has never been published says so, and is not an error', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/periods/*/published`, (route) =>
      json(route, 200, { ...PUBLISHED_SCHEDULE, version: null, assignments: [] }),
    );
    await page.route(`${API}/schedule/periods/*/publication-records`, (route) =>
      json(route, 200, { ...RECORDS, records: [] }),
    );

    await page.goto(PUBLISHED_URL);
    await expect(page.getByTestId('surface-empty').first()).toContainText(
      'Nothing has been published for this period yet',
    );
    await expect(page.getByTestId('surface-error')).toHaveCount(0);
    await expectNoAxeViolations(page);
    await capture(page, 'published-empty', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * I-13 and the budgets
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('I-13 — nothing is published before an explicit confirmation', () => {
  test('opening the confirmation issues ZERO requests', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(REVIEW_URL);
    await expect(page.getByTestId('publish-open-confirm')).toBeVisible();

    const recording = await recordRequests(page, 'publication-open-confirm', info.project.name, async () => {
      await page.getByTestId('publish-open-confirm').click();
      await expect(page.getByTestId('publish-confirm-form')).toBeVisible();
    });

    expect(recording.requests).toEqual([]);
    await expectNoAxeViolations(page);
    await capture(page, 'review-confirm-open', info.project.name);
  });

  test('filling the confirmation issues ZERO requests', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();

    const recording = await recordRequests(page, 'publication-fill-confirm', info.project.name, async () => {
      await page.getByTestId('publish-acknowledge').check();
      await page.getByTestId('publish-phrase').fill(PERIOD_NAME);
    });

    expect(recording.requests).toEqual([]);
  });

  test('the typed confirmation is demanded BEFORE any request is made', async ({ page }, info) => {
    await routeHappyPath(page);
    let publishCalls = 0;
    await page.route(`${API}/schedule/versions/*/publication`, async (route) => {
      publishCalls += 1;
      await json(route, 200, {
        replay: false,
        versionId: DRAFT,
        versionNumber: 3,
        priorCurrentVersionId: V2,
        affectedMembershipCount: 2,
        changeCount: 2,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    // Neither the acknowledgement nor the phrase: submit anyway.
    await page.getByTestId('publish-confirm').click();

    await expect(page.getByTestId('validation-summary-publish')).toBeVisible();
    await expect(page.getByTestId('validation-summary-publish')).toHaveAttribute('role', 'alert');
    expect(publishCalls).toBe(0);

    await expectNoAxeViolations(page);
    await capture(page, 'review-confirm-refused', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The idempotency key — publish ONCE
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('publish once', () => {
  /** Fill the confirmation panel and return the recorded request bodies. */
  async function armPublish(page: Page, respond: (attempt: number, route: Route) => Promise<void>) {
    const bodies: { idempotencyKey: string }[] = [];
    let attempt = 0;
    await page.route(`${API}/schedule/versions/*/publication`, async (route) => {
      attempt += 1;
      bodies.push(JSON.parse(route.request().postData() ?? '{}') as { idempotencyKey: string });
      await respond(attempt, route);
    });
    return bodies;
  }

  test('a DOUBLE-CLICK issues exactly one publication request', async ({ page }, info) => {
    await routeHappyPath(page);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve_) => {
      release = resolve_;
    });
    const bodies = await armPublish(page, async (_attempt, route) => {
      await held;
      await json(route, 200, {
        replay: false,
        versionId: DRAFT,
        versionNumber: 3,
        priorCurrentVersionId: V2,
        affectedMembershipCount: 2,
        changeCount: 2,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    await page.getByTestId('publish-acknowledge').check();
    await page.getByTestId('publish-phrase').fill(PERIOD_NAME);

    const confirm = page.getByTestId('publish-confirm');
    await confirm.click();
    // The control is disabled while the request is in flight, so the second
    // click cannot become a second request.
    await expect(confirm).toBeDisabled();
    await confirm.click({ force: true }).catch(() => undefined);
    await confirm.click({ force: true }).catch(() => undefined);

    release();
    await expect(page.getByTestId('publish-result')).toBeVisible();
    expect(bodies).toHaveLength(1);

    await expectNoAxeViolations(page);
    await capture(page, 'review-published', info.project.name);
  });

  /**
   * **The red-cased property.** A retry after a failure must carry the SAME
   * idempotency key, so the server replays instead of publishing a second time.
   *
   * `scripts/red-cases/run.mjs` case `publish-idempotency-key-retained` makes the
   * client mint a fresh key per attempt; this assertion must then fail.
   */
  test('a RETRY carries the same idempotency key, and the replay is rendered honestly', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    const bodies = await armPublish(page, async (attempt, route) => {
      if (attempt === 1) {
        await route.abort('connectionfailed');
        return;
      }
      await json(route, 200, {
        replay: true,
        versionId: DRAFT,
        versionNumber: 3,
        priorCurrentVersionId: V2,
        affectedMembershipCount: 2,
        changeCount: 2,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    await page.getByTestId('publish-acknowledge').check();
    await page.getByTestId('publish-phrase').fill(PERIOD_NAME);
    await page.getByTestId('publish-confirm').click();

    // The first attempt failed at the network. The surface says so and says the
    // retry cannot publish twice.
    await expect(page.getByTestId('publish-failed')).toBeVisible();
    await expect(page.getByTestId('publish-failed')).toContainText('cannot publish twice');
    await capture(page, 'review-publish-failed', info.project.name);

    await page.getByTestId('publish-confirm').click();
    await expect(page.getByTestId('publish-result')).toBeVisible();

    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.idempotencyKey).toBeTruthy();
    expect(bodies[1]?.idempotencyKey).toBe(bodies[0]?.idempotencyKey);

    // And the replay is rendered as a replay, not as a second publication.
    await expect(page.getByTestId('publish-result')).toContainText('Already published');
    await expectNoAxeViolations(page);
    await capture(page, 'review-published-replay', info.project.name);
  });

  test('BUDGET: an accepted publication is the write plus one server-authoritative re-read', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication`, (route) =>
      json(route, 200, {
        replay: false,
        versionId: DRAFT,
        versionNumber: 3,
        priorCurrentVersionId: V2,
        affectedMembershipCount: 2,
        changeCount: 2,
        correlationId: 'e2e-correlation-id',
      }),
    );

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    await page.getByTestId('publish-acknowledge').check();
    await page.getByTestId('publish-phrase').fill(PERIOD_NAME);

    const recording = await recordRequests(
      page,
      'publication-publish-accepted',
      info.project.name,
      async () => {
        // The refetch wait is registered BEFORE the click, or the response can
        // arrive first and the wait would hang on a response already delivered.
        const refetched = page.waitForResponse((response) =>
          response.url().includes('publication-review'),
        );
        await page.getByTestId('publish-confirm').click();
        await expect(page.getByTestId('publish-result')).toBeVisible();
        await refetched;
      },
    );

    expect(recording.requests.filter((request) => request.url.includes('/api/')).length).toBeLessThanOrEqual(2);
  });

  test('BUDGET: a refused publication is ONE request and does not refetch', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication`, (route) =>
      json(route, 422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: 'e2e-correlation-id',
          problems: [{ field: 'confirmationPhrase', message: 'Type the period name exactly.' }],
        },
      }),
    );

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    await page.getByTestId('publish-acknowledge').check();
    await page.getByTestId('publish-phrase').fill(PERIOD_NAME);

    const recording = await recordRequests(
      page,
      'publication-publish-refused',
      info.project.name,
      async () => {
        await page.getByTestId('publish-confirm').click();
        await expect(page.getByTestId('validation-summary-publish')).toBeVisible();
      },
    );

    expect(recording.requests.filter((request) => request.url.includes('/api/'))).toHaveLength(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The two 409s, and the grant deny state
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('refusals the interface must render truthfully', () => {
  test('CAS LOSER: another publication won the period — rendered, with one reload control', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication`, (route) =>
      json(route, 409, {
        error: {
          code: 'CURRENT_VERSION_MOVED',
          message: 'Another publication reached this period first.',
          correlationId: 'e2e-correlation-id',
          currentVersionId: V1,
          currentVersionNumber: 1,
        },
      }),
    );

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    await page.getByTestId('publish-acknowledge').check();
    await page.getByTestId('publish-phrase').fill(PERIOD_NAME);
    await page.getByTestId('publish-confirm').click();

    const alert = page.getByTestId('publish-current-version-moved');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('Nothing was published');
    // Review N3: the panel names the version by its NUMBER. The uuid is what the
    // client needs and is deliberately NOT what the reader is shown.
    await expect(alert).toContainText('Version 1 is current now');
    await expect(alert).not.toContainText(V1);
    await expect(page.getByTestId('publish-reload-review')).toBeVisible();
    // Nothing claims success.
    await expect(page.getByTestId('publish-result')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'review-cas-moved', info.project.name);
  });

  test('STALE REVIEW: the draft changed while it was being read — rendered, never merged', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication`, (route) =>
      json(route, 409, {
        error: {
          code: 'STALE_REVIEW',
          message: 'This draft changed while you were reviewing it.',
          correlationId: 'e2e-correlation-id',
          currentReviewDigest: MOVED_DIGEST,
        },
      }),
    );

    await page.goto(REVIEW_URL);
    await page.getByTestId('publish-open-confirm').click();
    await page.getByTestId('publish-acknowledge').check();
    await page.getByTestId('publish-phrase').fill(PERIOD_NAME);
    await page.getByTestId('publish-confirm').click();

    const alert = page.getByTestId('publish-stale-review');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toContainText('Nothing was published');
    await expect(page.getByTestId('publish-reload-review-stale')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'review-stale-review', info.project.name);
  });

  test('GRANT DENY STATE: without the publish grant the control is absent and the reason is written', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(route, 200, review({ canPublish: false, canRevert: false })),
    );

    await page.goto(REVIEW_URL);
    // The review is still readable — reviewing is `schedule.version.edit`.
    await expect(page.getByTestId('review-diff-table').or(page.getByTestId('review-diff-list'))).toBeVisible();
    // …and the deny state says WHY, in words, rather than silently vanishing.
    const denied = page.getByTestId('publish-denied');
    await expect(denied).toBeVisible();
    await expect(denied).toContainText('publishing needs the publish permission');
    await expect(page.getByTestId('publish-open-confirm')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'review-publish-denied', info.project.name);
  });

  test('a version that IS current does not claim it would supersede itself', async ({ page }, info) => {
    await routeHappyPath(page);
    // What the review looks like after this version has been published: the
    // re-read makes `currentVersion` THIS version. The first version of the
    // screen printed "Publishing this would supersede version 2" about version 2.
    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(
        route,
        200,
        review({
          version: versionView({ versionNumber: 2, state: 'published', isCurrent: true }),
          currentVersion: versionView({ versionNumber: 2, state: 'published', isCurrent: true }),
          expectedPriorCurrentVersionId: null,
          blockers: [
            {
              code: 'VERSION_ALREADY_PUBLISHED',
              message:
                'This version has already been published. Amend it by cloning it into a new draft and publishing forward.',
              conflictId: null,
              ruleKey: null,
            },
          ],
        }),
      ),
    );

    await page.goto(REVIEW_URL);
    const sentence = page.getByTestId('review-supersedes');
    await expect(sentence).toContainText('This version IS what staff are working to now');
    await expect(sentence).not.toContainText('would supersede');
    await expect(page.getByTestId('publish-blocked')).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'review-already-published', info.project.name);
  });

  test('BLOCKED: a breached HARD rule blocks publication and NAMES the rule', async ({
    page,
  }, info) => {
    /* SPEC-05 §6 step 06, as the review branch predicts it (OPUS-M3-008). The
     * rule key is rendered as its own line rather than buried in the message,
     * because the scheduler's next action is to open that rule. */
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(
        route,
        200,
        review({
          blockers: [
            {
              code: 'HARD_RULE_BREACH',
              message:
                'HARD rule needs_acls (RequiresQualification) is breached: a member is assigned on 2033-06-17 without a valid holding on that date.',
              conflictId: null,
              ruleKey: 'needs_acls',
            },
            {
              code: 'HARD_RULE_NOT_EVALUABLE',
              message:
                'HARD rule coverage_rule (RequiredCount) cannot be checked by this system. A HARD rule is never skipped, so publication is blocked.',
              conflictId: null,
              ruleKey: 'coverage_rule',
            },
          ],
        }),
      ),
    );

    await page.goto(REVIEW_URL);
    await expect(page.getByTestId('blocker-HARD_RULE_BREACH')).toBeVisible();
    await expect(page.getByTestId('blocker-rule-needs_acls')).toContainText('needs_acls');
    // "cannot be checked" must never read as "passed".
    await expect(page.getByTestId('blocker-HARD_RULE_NOT_EVALUABLE')).toContainText(
      'never skipped',
    );
    await expect(page.getByTestId('publish-blocked')).toBeVisible();
    await expect(page.getByTestId('publish-open-confirm')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'review-blocked-hard-rule', info.project.name);
  });

  test('BLOCKED: an open hard breach blocks publication and the control is not offered', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication-review`, (route) =>
      json(
        route,
        200,
        review({
          blockers: [
            {
              code: 'OPEN_HARD_BREACH',
              message: 'Open hard breach: two shifts overlap for one person.',
              conflictId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              ruleKey: null,
            },
          ],
        }),
      ),
    );

    await page.goto(REVIEW_URL);
    await expect(page.getByTestId('blocker-OPEN_HARD_BREACH')).toBeVisible();
    await expect(page.getByTestId('publish-blocked')).toBeVisible();
    await expect(page.getByTestId('publish-open-confirm')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'review-blocked', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The difference display equals the response
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('the rendered difference is the served difference', () => {
  test('every change in the response is rendered, one row each, and nothing else is', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(REVIEW_URL);

    const served = difference().changes;
    const rows = page.locator('[data-testid^="diffrow-"]');
    await expect(rows).toHaveCount(served.length);

    for (const served_ of served) {
      const row = page.getByTestId(`diffrow-${served_.assignmentIdentityId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(served_.date);
      await expect(row).toContainText(served_.shiftTypeCode);
      // The KIND is carried by words, never by colour alone.
      const sentence = row.getByTestId('change-sentence');
      await expect(sentence).toContainText(
        served_.kind === 'added' ? 'Added' : served_.kind === 'reassigned' ? 'Moved' : '',
      );
    }

    // The affected set is the UNION: a reassignment affects BOTH people.
    await expect(page.getByTestId(`affected-${MEMBER_A}`)).toBeVisible();
    await expect(page.getByTestId(`affected-${MEMBER_B}`)).toBeVisible();
    await expect(page.getByTestId('review-diff-affected-count')).toContainText('2 people are affected');

    await expectNoAxeViolations(page);
    await capture(page, 'review-difference', info.project.name);
  });

  test('BUDGET: changing the comparison target re-reads BOTH the comparison and the affected staff', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(COMPARISON_URL);
    // Settle first: a recording that started mid-load would measure the page load
    // rather than the interaction.
    await expect(page.getByTestId('comparison-against')).toBeVisible();
    await expect(page.getByTestId('affected-read-count')).toBeVisible();

    const recording = await recordRequests(
      page,
      'publication-change-comparison',
      info.project.name,
      async () => {
        const refetched = page.waitForResponse(
          (response) =>
            response.url().includes('affected-staff') && response.url().includes('againstVersionId'),
        );
        await page.getByTestId('comparison-against').selectOption(V1);
        await refetched;
      },
    );

    // TWO, and both are load-bearing: the change-level view and the person-level
    // view are separate reads on purpose (see VersionComparisonPage's docblock),
    // so "who would be told about this?" is answerable without first fetching the
    // whole change list. One user action, one authoritative round trip per view.
    const api = recording.requests.filter((request) => request.url.includes('/api/'));
    expect(api).toHaveLength(2);
    expect(api.filter((request) => request.url.includes('/comparison'))).toHaveLength(1);
    expect(api.filter((request) => request.url.includes('/affected-staff'))).toHaveLength(1);
    expect(api.every((request) => request.method === 'GET')).toBe(true);
  });

  test('the comparison page renders the same change set and the affected-staff read agrees', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(COMPARISON_URL);

    await expect(page.locator('[data-testid^="diffrow-"]')).toHaveCount(difference().changes.length);
    await expect(page.getByTestId('affected-read-count')).toContainText('2 people are affected');
    await expect(page.getByTestId('affected-read-count')).toContainText('2 changes');

    await expectNoAxeViolations(page);
    await capture(page, 'comparison', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * History — immutability, forward correction, revert
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('version history', () => {
  test('IMMUTABILITY: no edit affordance in any immutable row — and a draft row HAS one', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(HISTORY_URL);

    const immutableRows = page.locator('[data-immutable="true"]');
    await expect(immutableRows).toHaveCount(2);
    // The property: not one control that edits a published or superseded version.
    await expect(immutableRows.locator('[data-affordance="edit"]')).toHaveCount(0);

    // NON-VACUITY: the assertion above would also pass if no row rendered any
    // control at all, or if `data-affordance` were never emitted. The draft row
    // proves both are false.
    const mutableRows = page.locator('[data-immutable="false"]');
    await expect(mutableRows).toHaveCount(1);
    await expect(mutableRows.locator('[data-affordance="edit"]')).toHaveCount(1);

    // …and the immutable rows are MARKED as such, in words.
    await expect(page.getByTestId(`state-${V2}`)).toContainText('Published');
    await expect(page.getByTestId(`state-${V1}`)).toContainText('Superseded');
    await expect(page.getByTestId('history-immutability-legend')).toContainText('cannot be edited');

    await expectNoAxeViolations(page);
    await capture(page, 'history', info.project.name);
  });

  test('FORWARD CORRECTION: cloning a published version writes nothing until an explicit confirm', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    let cloneCalls = 0;
    await page.route(`${API}/schedule/versions/clone`, async (route) => {
      cloneCalls += 1;
      await json(route, 200, {
        version: { ...versionView({ id: DRAFT, state: 'draft', isEditable: true }) },
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(HISTORY_URL);
    // Settle first: a recording that started mid-load would measure the page
    // load rather than the click.
    await expect(page.getByTestId(`clone-${V2}`)).toBeVisible();

    const recording = await recordRequests(
      page,
      'publication-open-clone-confirm',
      info.project.name,
      async () => {
        await page.getByTestId(`clone-${V2}`).click();
        await expect(page.getByTestId('clone-panel')).toBeVisible();
      },
    );
    expect(recording.requests).toEqual([]);
    expect(cloneCalls).toBe(0);
    await expectNoAxeViolations(page);
    await capture(page, 'history-clone-confirm', info.project.name);

    await page.getByTestId('clone-confirm').click();
    await expect(page.getByTestId('clone-created')).toBeVisible();
    expect(cloneCalls).toBe(1);
    // The handoff is a LINK the user chooses, not a navigation done for them.
    await expect(page.getByTestId('clone-open-draft')).toHaveAttribute(
      'href',
      `/organizations/${ORGANIZATION}/groups/${GROUP}/schedule/versions/${DRAFT}`,
    );
    await capture(page, 'history-clone-created', info.project.name);
  });

  test('REVERT: its own typed confirmation, refused before any request is made', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    let revertCalls = 0;
    await page.route(`${API}/schedule/periods/*/revert`, async (route) => {
      revertCalls += 1;
      await json(route, 200, {
        replay: false,
        versionId: DRAFT,
        versionNumber: 3,
        priorCurrentVersionId: V2,
        affectedMembershipCount: 2,
        changeCount: 2,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(HISTORY_URL);
    await expect(page.getByTestId(`revert-${V1}`)).toBeVisible();

    const recording = await recordRequests(
      page,
      'publication-open-revert-confirm',
      info.project.name,
      async () => {
        await page.getByTestId(`revert-${V1}`).click();
        await expect(page.getByTestId('revert-panel')).toBeVisible();
      },
    );
    expect(recording.requests).toEqual([]);
    await expectNoAxeViolations(page);
    await capture(page, 'history-revert-confirm', info.project.name);

    // The wrong phrase is refused by the client, and issues nothing.
    await page.getByTestId('revert-acknowledge').check();
    await page.getByTestId('revert-phrase').fill(PERIOD_NAME);
    await page.getByTestId('revert-confirm').click();
    await expect(page.getByTestId('validation-summary-revert')).toBeVisible();
    expect(revertCalls).toBe(0);

    // The revert phrase is DIFFERENT from the publish phrase, so a user cannot
    // revert with something they had typed to publish.
    await page.getByTestId('revert-phrase').fill(`revert ${PERIOD_NAME}`);
    await page.getByTestId('revert-confirm').click();
    await expect(page.getByTestId('revert-result')).toBeVisible();
    expect(revertCalls).toBe(1);

    await expectNoAxeViolations(page);
    await capture(page, 'history-reverted', info.project.name);
  });

  test('a revert is not offered on the CURRENT version, only on superseded ones', async ({ page }) => {
    await routeHappyPath(page);
    await page.goto(HISTORY_URL);
    await expect(page.getByTestId(`revert-${V1}`)).toBeVisible();
    await expect(page.getByTestId(`revert-${V2}`)).toHaveCount(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The published schedule, and the honest labelling of the records table
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('published schedule', () => {
  test('renders the current version read-only, with no control that writes', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(PUBLISHED_URL);

    await expect(page.getByTestId('published-summary')).toContainText('version 2');
    await expect(page.getByTestId('published-readonly')).toContainText('can never be edited');
    await expect(page.getByTestId(`published-assignment-${IDENTITY_1}`)).toBeVisible();
    // Nothing on this page edits anything.
    await expect(page.locator('[data-affordance="edit"]')).toHaveCount(0);

    // The records table says what it is, and is not called an audit trail.
    await expect(page.getByTestId('records-scope-note')).toContainText('not the audit chain');
    await expect(page.getByTestId('records-table')).toContainText('Synthetic Member A');

    // …and the audit chain is now a SECOND table, labelled as what it is.
    await expect(page.getByTestId('audit-table')).toContainText('schedule.version.published');
    await expect(page.getByTestId('audit-scope-note')).toContainText('not a verification of it');
    // The gap is stated rather than presented as damage.
    await expect(page.getByTestId('audit-scope-note')).toContainText('gaps');

    await expectNoAxeViolations(page);
    await capture(page, 'published-schedule', info.project.name);
  });

  test('TRUNCATION: more history than fits says so, rather than looking complete', async ({
    page,
  }, info) => {
    /* N-6. The server MEASURES truncation by reading one row past the limit. The
     * first version of this surface computed the flag and threw it away, so a
     * reader with more than a page of history was shown a partial list that
     * looked whole — the one thing an audit surface must not do.
     *
     * 51 events against the page's limit of 50, so the branch is reached by the
     * REAL arithmetic (`auditEventsFor` slices and compares) rather than by a
     * hand-set boolean. */
    await routeHappyPath(page);
    const many = Array.from({ length: 51 }, (_, index) => ({
      ...AUDIT_EVENTS.events[0],
      id: `bb0000${String(index).padStart(2, '0')}-0000-4000-8000-000000000001`,
      sequence: String(200 - index),
    }));
    await page.route(`${API}/audit-events*`, (route) => {
      const limit = Number(new URL(route.request().url()).searchParams.get('limit') ?? '50');
      return json(route, 200, {
        events: many.slice(0, limit),
        truncated: many.length > limit,
        sequenceIsOrganizationWide: true,
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(PUBLISHED_URL);

    await expect(page.getByTestId('audit-truncated')).toContainText('not the whole history');
    await expect(page.getByTestId('audit-truncated')).toContainText('50 most recent');
    await expect(page.getByTestId('audit-table').locator('tbody tr')).toHaveCount(50);

    await expectNoAxeViolations(page);
    await capture(page, 'published-audit-truncated', info.project.name);
  });

  test('…and with everything on one page the truncation affordance is ABSENT', async ({ page }) => {
    // The control. Without it, a truncation notice that rendered unconditionally
    // would pass the test above and lie on every other page.
    await routeHappyPath(page);
    await page.goto(PUBLISHED_URL);
    await expect(page.getByTestId('audit-table')).toBeVisible();
    await expect(page.getByTestId('audit-truncated')).toHaveCount(0);
  });

  test('DENIAL: without the audit-read grant the chain is a stated panel, not an error', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/audit-events*`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'Not permitted.')),
    );

    await page.goto(PUBLISHED_URL);

    await expect(page.getByTestId('audit-denied')).toContainText('audit-read permission');
    // The rest of the page is unaffected — the point of rendering a denial
    // rather than an error.
    await expect(page.getByTestId('records-table')).toBeVisible();
    await expect(page.getByTestId(`published-assignment-${IDENTITY_1}`)).toBeVisible();

    await expectNoAxeViolations(page);
    await capture(page, 'published-audit-denied', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Keyboard and 320px
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('keyboard and narrow viewport', () => {
  test('KEYBOARD: review → confirm → publish, without a mouse', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/schedule/versions/*/publication`, (route) =>
      json(route, 200, {
        replay: false,
        versionId: DRAFT,
        versionNumber: 3,
        priorCurrentVersionId: V2,
        affectedMembershipCount: 2,
        changeCount: 2,
        correlationId: 'e2e-correlation-id',
      }),
    );

    await page.goto(REVIEW_URL);
    await expect(page.getByTestId('publish-open-confirm')).toBeVisible();

    await page.getByTestId('publish-open-confirm').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('publish-confirm-form')).toBeVisible();

    await page.getByTestId('publish-acknowledge').focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('publish-acknowledge')).toBeChecked();

    await page.getByTestId('publish-phrase').focus();
    await page.keyboard.type(PERIOD_NAME);

    await page.getByTestId('publish-confirm').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('publish-result')).toBeVisible();

    await capture(page, 'review-keyboard', info.project.name);
  });

  test('320px: the review reflows with no page-level horizontal scroll', async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await routeHappyPath(page);
    await page.goto(REVIEW_URL);
    await expect(page.getByTestId('review-summary')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expectNoAxeViolations(page);
    await capture(page, 'review-320', info.project.name);
  });

  test('320px: the history reflows as a list, with the same rows and the same affordance rule', async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await routeHappyPath(page);
    await page.goto(HISTORY_URL);

    await expect(page.getByTestId('history-list')).toBeVisible();
    await expect(page.getByTestId('history-table')).toHaveCount(0);
    // The same property holds in the narrow rendering: it is the same data in a
    // different shape, not a reduced one.
    await expect(page.locator('[data-immutable="true"]')).toHaveCount(2);
    await expect(page.locator('[data-immutable="true"] [data-affordance="edit"]')).toHaveCount(0);
    await expect(page.locator('[data-immutable="false"] [data-affordance="edit"]')).toHaveCount(1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expectNoAxeViolations(page);
    await capture(page, 'history-320', info.project.name);
  });

  test('320px: the published schedule reflows with no page-level horizontal scroll', async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await routeHappyPath(page);
    await page.goto(PUBLISHED_URL);
    await expect(page.getByTestId('published-assignments-list')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await expectNoAxeViolations(page);
    await capture(page, 'published-320', info.project.name);
  });
});
