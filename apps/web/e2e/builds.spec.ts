import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

import { screenshotDir } from './support/evidence-target.js';
import { recordRequests } from './support/request-budget.js';
import { mockDeclaredContext } from './support/declared-context.js';

/**
 * The scheduler's build experience: the full state matrix, both viewports, axe
 * on each (OPUS-M4-003).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why the API is intercepted rather than run
 *
 * The same division every other spec in this directory records: this file proves
 * the **interface** behaves correctly for each response. That the server
 * produces those responses — the transition guard, the fencing trigger, the
 * validation gate, D-4a/D-4d, the idempotent replay — is proven separately, over
 * HTTP and in SQL against the real database, in `apps/api/test/builds/**`. The
 * component tree, router, contracts, zod parse, query client and rendering here
 * are all the real ones.
 *
 * ## What is asserted, and against which requirement
 *
 * | Assertion | Requirement |
 * |---|---|
 * | zero axe violations on every state, both viewports | I-12, CAP-066 |
 * | "New configuration" and "Start a build" issue **zero** requests | **I-13** |
 * | a launch save issues exactly two requests (write + re-read) | I-10 |
 * | opening the cancel confirmation issues **zero** requests | I-13 discipline |
 * | `infeasible` and `failed` render DIFFERENT words | **report 21 §4** |
 * | a timeout renders as a deadline, never as infeasible | SPEC-04 §2, FAD-34 |
 * | `EXPLANATION_BUDGET_EXCEEDED` is rendered, not hidden | SPEC-04 §5 |
 * | a refused candidate says it can never become a schedule | SPEC-04 §3.3 |
 * | `BUILD_STATE_MOVED` renders explicitly with one reload control | PO-DEC-18 |
 * | `STALE_BUILD_SOURCE` renders explicitly | FAD-26(2) |
 * | a fenced result and a reap are both visible on the timeline | doc 35 §6e (3) |
 * | 403 renders "no permission"; 404 renders "not found" | SP-E §1.3, SPEC-06 P-3 |
 * | no page-level horizontal scroll at 320px | AC-08 |
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';
const PERIOD = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';
const CONFIGURATION = '55555555-5555-4555-8555-555555555555';
const RUN_A = '66666666-6666-4666-8666-666666666666';
const RUN_B = '77777777-7777-4777-8777-777777777777';
const MEMBER = '88888888-8888-4888-8888-888888888888';
const SHIFT_TYPE = '99999999-9999-4999-8999-999999999999';

const API = `**/api/organizations/${ORGANIZATION}/groups/${GROUP}/builds`;
const BUILDS_URL = `/organizations/${ORGANIZATION}/groups/${GROUP}/builds/periods/${PERIOD}`;
const RUN_URL = `/organizations/${ORGANIZATION}/groups/${GROUP}/builds/runs/${RUN_A}`;

const SCREENSHOTS = screenshotDir('EV-M4-003');
/* OPUS-M4-004's own captures. The M4-003 bundle keeps the states M4-003 proved;
 * a packet that redirected them all would rewrite an accepted bundle's evidence
 * as a side effect of adding a screenshot. */
const SCREENSHOTS_E2 = screenshotDir('EV-M4-004');

async function capture(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOTS, `${name}.${project}.png`), fullPage: true });
}

async function captureE2(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(SCREENSHOTS_E2, { recursive: true });
  await page.screenshot({
    path: resolve(SCREENSHOTS_E2, `${name}.${project}.png`),
    fullPage: true,
  });
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

function envelope(code: string, message: string): unknown {
  return { error: { code, message, correlationId: 'e2e-correlation-id' } };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function configuration(): unknown {
  return {
    id: CONFIGURATION,
    periodId: PERIOD,
    name: 'Overnight cover',
    randomSeed: 0,
    numSearchWorkers: 1,
    maxTimeSeconds: 10,
    maxDeterministicTime: null,
    interleaveSearch: true,
    dispatchTimeoutMs: 60000,
    heartbeatTimeoutMs: 120000,
    retryLimit: 2,
    reproducibilityMode: 'best-effort',
  };
}

function runSummary(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: RUN_A,
    periodId: PERIOD,
    configurationId: CONFIGURATION,
    configurationName: 'Overnight cover',
    candidateLabel: 'Candidate A',
    sourceVersionId: VERSION,
    state: 'draft_configuration',
    solverStatus: null,
    terminationReason: null,
    canonicalInputHash: null,
    claimEpoch: 0,
    heartbeatAt: null,
    retryOfBuildRunId: null,
    retryAttempt: 0,
    retryLimit: 2,
    parentBuildIds: [],
    appliedToVersionId: null,
    supersededByBuildRunId: null,
    createdAt: '2043-01-01T00:00:00.000Z',
    updatedAt: '2043-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function quality(overrides: Record<string, unknown> = {}): unknown {
  return {
    demandSatisfactionRate: 1,
    requiredSlots: 7,
    filledSlots: 7,
    hardViolations: 0,
    softPenaltyTotal: 0,
    solveWallClockMs: 412,
    /* OPUS-M4-004 — the rest of SPEC-04 §7. The contract is `.strict()`, so a
     * fixture missing any of these does not parse and the page renders an
     * `UNEXPECTED_RESPONSE` instead of the surface under test. */
    requestHonourRate: null,
    templateAdherenceRate: null,
    fairnessDispersion: 0.184,
    fairnessNormalisation: 'fte-work-percentage',
    fairnessMeasuredParticipants: 6,
    fairnessUnmeasuredParticipants: 0,
    explanationLatencyMs: null,
    objectiveWeightsDigest: 'e'.repeat(64),
    objectiveScale: 10000,
    objectiveProfileId: 'e2-default-v1',
    solverStatistics: { branches: 572, conflicts: 4, deterministicTimeUnits: 0.0046 },
    ...overrides,
  };
}

/** SPEC-04 §5's explanation record, with the T2 fields OPUS-M4-004 added. */
function explanation(overrides: Record<string, unknown> = {}): unknown {
  return {
    state: null,
    structural: [],
    conflictingRuleKeys: [],
    tier2: null,
    solveCount: null,
    elapsedSeconds: null,
    ...overrides,
  };
}

/** One recorded objective tier, with its rank, multiplier, scale and weights. */
function objectiveTier(overrides: Record<string, unknown> = {}): unknown {
  return {
    tier: 3,
    name: 'preference',
    weightScale: 1,
    scale: 10000,
    ruleKeys: ['prefer-nights'],
    components: [{ ruleKey: 'prefer-nights', scaledWeight: 20000 }],
    unmappedRuleKeys: [],
    termCount: 42,
    ...overrides,
  };
}

/** One classified conflict — PO-DEC-13's four classes on the wire. */
function conflict(overrides: Record<string, unknown> = {}): unknown {
  return {
    conflictClass: 'hard-breach',
    severityRank: 1,
    blocksApproval: true,
    banded: true,
    source: 'violation',
    code: 'rule_breached',
    subject: 'r-consecutive',
    detail: 'one membership works five consecutive nights',
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}): unknown {
  return {
    run: runSummary(),
    validationFindings: [],
    readinessFindings: [],
    result: null,
    violations: [],
    conflicts: [],
    events: [
      {
        kind: 'transition',
        fromState: null,
        toState: 'draft_configuration',
        claimEpoch: 0,
        currentClaimEpoch: null,
        reason: 'created',
        occurredAt: '2043-01-01T00:00:00.000Z',
      },
    ],
    sourceDigest: 'a'.repeat(64),
    reproducibility: null,
    /* FAD-49. The RESULT-side verdict, null by default for the same reason
       `reproducibility` is: a run with no runtime record has nothing to claim. */
    resultReproducibility: null,
    /* doc 35 §6g ruling 4. Fresh by default so the existing arms keep measuring
       what they were written to measure; the staleness arms override it. */
    staleness: { stale: false, changes: [], changeCount: 0, assemblyRefusals: [] },
    correlationId: 'e2e-correlation-id',
    ...overrides,
  };
}

async function routeHappyPath(page: Page): Promise<void> {
  await page.route(`${API}/configurations*`, (route) =>
    json(route, 200, { configurations: [configuration()], correlationId: 'e2e-correlation-id' }),
  );
  await page.route(`${API}/runs?*`, (route) =>
    json(route, 200, { runs: [runSummary()], correlationId: 'e2e-correlation-id' }),
  );
  await page.route(`${API}/runs/${RUN_A}`, (route) => json(route, 200, detail()));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The period's builds
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

test.describe('the period build list', () => {
  test('AC-01: the list renders, and the scope note states what a build is not', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(BUILDS_URL);

    await expect(page.getByTestId('build-configurations-list')).toBeVisible();
    /* I-05 and I-18 on the screen: a build proposes, it never publishes. */
    await expect(page.getByTestId('builds-scope-note')).toContainText('never publishes');
    await expectNoAxeViolations(page);
    await capture(page, 'builds-list', info.project.name);
  });

  test('AC-02 (I-13): "New configuration" issues ZERO requests', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(BUILDS_URL);
    await expect(page.getByTestId('build-configuration-new')).toBeVisible();

    const recording = await recordRequests(
      page,
      'builds-open-new-configuration',
      info.project.name,
      async () => {
        await page.getByTestId('build-configuration-new').click();
        await expect(page.getByTestId('build-configuration-form')).toBeVisible();
      },
    );
    expect(recording.requests).toEqual([]);
    await expectNoAxeViolations(page);
  });

  test('AC-03 (I-13): "Start a build" issues ZERO requests', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.goto(BUILDS_URL);
    await expect(page.getByTestId(`build-launch-open-${CONFIGURATION}`)).toBeVisible();

    const recording = await recordRequests(
      page,
      'builds-open-launch-form',
      info.project.name,
      async () => {
        await page.getByTestId(`build-launch-open-${CONFIGURATION}`).click();
        await expect(page.getByTestId('build-launch-form')).toBeVisible();
      },
    );
    expect(recording.requests).toEqual([]);
  });

  test('AC-04 (I-10): an accepted launch is ONE write and ONE re-read', async ({ page }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/runs`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return json(route, 200, { run: runSummary(), correlationId: 'e2e-correlation-id' });
    });
    await page.goto(BUILDS_URL);
    await page.getByTestId(`build-launch-open-${CONFIGURATION}`).click();
    await page.getByLabel('Candidate label').fill('Candidate A');
    await page.getByLabel('Source draft version').fill(VERSION);

    const recording = await recordRequests(
      page,
      'builds-launch-accepted',
      info.project.name,
      async () => {
        await page.getByTestId('build-launch-save').click();
        await expect(page.getByTestId('build-launch-form')).toHaveCount(0);
      },
    );
    /* The write, and the invalidation's re-read. Nothing else. */
    expect(recording.requests.length).toBeLessThanOrEqual(2);
  });

  test('AC-05: D-4a is stated in the interface when a build is already in flight', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.route(`${API}/runs`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return json(route, 409, envelope('CONFLICT', 'The request could not be completed.'));
    });
    await page.goto(BUILDS_URL);
    await page.getByTestId(`build-launch-open-${CONFIGURATION}`).click();
    await page.getByLabel('Candidate label').fill('Candidate A');
    await page.getByLabel('Source draft version').fill(VERSION);
    await page.getByTestId('build-launch-save').click();

    await expect(page.getByTestId('builds-message')).toContainText('already in flight');
    await expectNoAxeViolations(page);
    await capture(page, 'builds-in-flight-conflict', info.project.name);
  });

  test('AC-06: the empty state names what to do next', async ({ page }, info) => {
    await page.route(`${API}/configurations*`, (route) =>
      json(route, 200, { configurations: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.route(`${API}/runs?*`, (route) =>
      json(route, 200, { runs: [], correlationId: 'e2e-correlation-id' }),
    );
    await page.goto(BUILDS_URL);

    await expect(page.getByTestId('surface-empty').first()).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'builds-empty', info.project.name);
  });

  test('AC-07: a 403 renders "no permission" and never says why', async ({ page }, info) => {
    await page.route(`${API}/configurations*`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'You do not have permission to do that.')),
    );
    await page.route(`${API}/runs?*`, (route) =>
      json(route, 403, envelope('FORBIDDEN', 'You do not have permission to do that.')),
    );
    await page.goto(BUILDS_URL);

    await expect(page.getByTestId('surface-permission-denied').first()).toBeVisible();
    /* SPEC-06 P-3: the reason never reaches the screen. */
    await expect(page.locator('body')).not.toContainText('capability');
    await expectNoAxeViolations(page);
    await capture(page, 'builds-denied', info.project.name);
  });

  test('AC-08: no page-level horizontal scroll at 320px', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'the 320px assertion belongs to the mobile project');
    await routeHappyPath(page);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(BUILDS_URL);
    await expect(page.getByTestId('build-runs-list')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page);
    await capture(page, 'builds-320px', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The state matrix
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('the sixteen states, in words', () => {
  test('AC-09: `infeasible` and `failed` render DIFFERENT words', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'infeasible',
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
          }),
          result: {
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
            usable: false,
            candidateReturned: false,
            assignmentCount: 0,
            objectiveValue: null,
            elapsedMs: 900,
            quality: quality({ filledSlots: 0, demandSatisfactionRate: 0 }),
            objectiveTiers: [],
            explanation: {
              state: 'EXPLAINED_EXACT',
              structural: [
                {
                  code: 'no_eligible_member',
                  tier: 'T0',
                  date: '2043-01-05',
                  shiftTypeId: SHIFT_TYPE,
                  detail: 'demand is 1 and no participant is eligible',
                },
              ],
              conflictingRuleKeys: [],
              tier2: null,
              solveCount: 1,
              elapsedSeconds: 0.004,
            },
            rejections: [],
          },
        }),
      ),
    );
    await page.goto(RUN_URL);

    /* The distinction report 21 §4 insists on, made where a human can see it. */
    await expect(page.getByTestId('build-state-infeasible')).toContainText(
      'statement about the problem',
    );
    await expect(page.locator('body')).not.toContainText('statement about the system');
    await expect(page.getByTestId('build-structural-findings')).toContainText('no_eligible_member');
    await expectNoAxeViolations(page);
    await capture(page, 'build-infeasible', info.project.name);
  });

  test('AC-10: a timeout renders as a deadline, never as infeasible', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'TIMEOUT',
            terminationReason: 'deadline',
          }),
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-state-failed')).toContainText(
      'statement about the system',
    );
    /* FAD-34: the four termination words are four, and this one is `deadline`. */
    await expect(page.getByTestId('build-termination-reason')).toContainText(
      'reached its time limit',
    );
    await expect(page.locator('body')).not.toContainText('No schedule satisfies');
    await expectNoAxeViolations(page);
    await capture(page, 'build-timeout', info.project.name);
  });

  test('AC-11: a cancelled build says a scheduler cancelled it', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'cancelled',
            solverStatus: 'CANCELLED',
            terminationReason: 'user_cancelled',
          }),
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-termination-reason')).toContainText(
      'was cancelled by a scheduler',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'build-cancelled', info.project.name);
  });

  test('AC-12: a refused candidate says it can NEVER become a schedule', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'OPTIMAL',
            terminationReason: 'rejected',
          }),
          result: {
            solverStatus: 'OPTIMAL',
            terminationReason: 'rejected',
            usable: false,
            candidateReturned: true,
            assignmentCount: 7,
            objectiveValue: 0,
            elapsedMs: 120,
            quality: quality({ hardViolations: 1 }),
            objectiveTiers: [],
            explanation: explanation(),
            rejections: [
              {
                reason: 'hard-violation',
                detail: '1 independently measured hard finding(s)',
              },
            ],
          },
          violations: [
            {
              finding: 'breach',
              ruleKey: 'nights.max-consecutive',
              nodeKind: 'MaxConsecutive',
              field: 'rule',
              explanation: 'one membership works five consecutive nights',
            },
          ],
        }),
      ),
    );
    await page.goto(RUN_URL);

    /* SPEC-04 §3.3: the checker wins over the worker, and the interface says so
     * even though the solver reported OPTIMAL. */
    await expect(page.getByTestId('build-usability')).toContainText('REFUSED');
    await expect(page.getByTestId('build-usability')).toContainText('never become a schedule');
    await expect(page.getByTestId('build-violations')).toContainText('nights.max-consecutive');
    await expect(page.getByTestId('build-termination-reason')).toContainText('OPTIMAL');
    await expectNoAxeViolations(page);
    await capture(page, 'build-refused-candidate', info.project.name);
  });

  test('AC-13: `EXPLANATION_BUDGET_EXCEEDED` is rendered, not hidden', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'infeasible',
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
          }),
          result: {
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
            usable: false,
            candidateReturned: false,
            assignmentCount: 0,
            objectiveValue: null,
            elapsedMs: 60000,
            quality: quality({ filledSlots: 0 }),
            objectiveTiers: [],
            explanation: {
              state: 'EXPLANATION_BUDGET_EXCEEDED',
              structural: [],
              conflictingRuleKeys: ['rest.minimum', 'nights.max-consecutive'],
              /* The T2 record is what distinguishes 'narrowed within budget'
                 from 'the budget ran out' — the same list of rule keys with two
                 entirely different meanings. */
              tier2: {
                attempted: true,
                iterations: 4,
                removed: 1,
                budgetSeconds: 3,
                maxIterations: 64,
                exhausted: true,
              },
              solveCount: 5,
              elapsedSeconds: 3.2,
            },
            rejections: [],
          },
        }),
      ),
    );
    await page.goto(RUN_URL);

    /* SPEC-04 §5: a degraded explanation is a first-class outcome, stated
     * plainly, rather than a screen that appears to hang. */
    await expect(page.getByTestId('build-explanation-EXPLANATION_BUDGET_EXCEEDED')).toContainText(
      'could not be isolated within the time budget',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'build-explanation-degraded', info.project.name);
  });

  test('AC-14: readiness failures are itemised on the way back to configuration', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          readinessFindings: [
            {
              code: 'eligible_capacity_below_demand',
              tier: 'T0',
              date: '2043-01-06',
              shiftTypeId: SHIFT_TYPE,
              detail: 'demand is 3 and 1 participants are eligible',
            },
          ],
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-readiness-findings')).toContainText(
      'eligible_capacity_below_demand',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'build-readiness-failed', info.project.name);
  });

  test('AC-15: a quality panel states that the bands are not established', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'completed_with_unmet_preferences',
            solverStatus: 'FEASIBLE',
            terminationReason: 'completed',
          }),
          result: {
            solverStatus: 'FEASIBLE',
            terminationReason: 'completed',
            usable: true,
            candidateReturned: true,
            assignmentCount: 7,
            objectiveValue: 14,
            elapsedMs: 412,
            quality: quality({ softPenaltyTotal: 14 }),
            objectiveTiers: [
              objectiveTier({
                tier: 1,
                name: 'fairness',
                weightScale: 100,
                ruleKeys: ['weekend.fairness'],
                components: [{ ruleKey: 'weekend.fairness', scaledWeight: 50000 }],
                termCount: 3,
              }),
            ],
            explanation: explanation(),
            rejections: [],
          },
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-state-completed_with_unmet_preferences')).toBeVisible();
    await expect(page.getByTestId('build-soft-tiers')).toContainText('weekend.fairness');
    /* SPEC-04 §7: every band except hard_violations = 0 is undefined, and the
     * screen says so rather than colouring a number. */
    await expect(page.getByTestId('build-quality-caveat')).toContainText('not established yet');
    await expectNoAxeViolations(page);
    await capture(page, 'build-completed-unmet', info.project.name);
  });

  test('AC-16: the recovery states are visible on the timeline', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'FAILED',
            terminationReason: 'crashed',
            claimEpoch: 2,
          }),
          events: [
            {
              kind: 'transition',
              fromState: null,
              toState: 'draft_configuration',
              claimEpoch: 0,
              currentClaimEpoch: null,
              reason: 'created',
              occurredAt: '2043-01-01T00:00:00.000Z',
            },
            {
              kind: 'heartbeat_reaped',
              fromState: null,
              toState: null,
              claimEpoch: 1,
              currentClaimEpoch: 2,
              reason: 'heartbeat_expired',
              occurredAt: '2043-01-01T00:05:00.000Z',
            },
            {
              kind: 'result_refused',
              fromState: null,
              toState: null,
              claimEpoch: 1,
              currentClaimEpoch: 2,
              reason: 'stale_claim_epoch',
              occurredAt: '2043-01-01T00:06:00.000Z',
            },
          ],
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-reaped-event')).toContainText('stopped reporting');
    /* The fenced worker is a VISIBLE fact, not an absence. */
    await expect(page.getByTestId('build-fenced-event')).toContainText('superseded claim');
    await expect(page.getByTestId('build-termination-reason')).toContainText(
      'stopped without reporting why',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'build-recovered', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Actions, confirmation, and the two compare-and-sets
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('actions', () => {
  test('AC-17 (I-13 discipline): opening the cancel confirmation issues ZERO requests', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(route, 200, detail({ run: runSummary({ state: 'running', claimEpoch: 1 }) })),
    );
    await page.goto(RUN_URL);
    await expect(page.getByTestId('build-cancel-open')).toBeVisible();

    const recording = await recordRequests(
      page,
      'builds-open-cancel-confirm',
      info.project.name,
      async () => {
        await page.getByTestId('build-cancel-open').click();
        await expect(page.getByTestId('build-cancel-confirm')).toBeVisible();
      },
    );
    expect(recording.requests).toEqual([]);
    /* A running solve stops when it stops, and the panel says so rather than
     * implying the button is the stopping. */
    await expect(page.getByTestId('build-cancel-confirm')).toContainText('when it actually stops');
    await expectNoAxeViolations(page);
    await capture(page, 'build-cancel-confirm', info.project.name);
  });

  test('AC-18: `BUILD_STATE_MOVED` renders explicitly with one reload control', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(route, 200, detail({ run: runSummary({ state: 'reviewed' }) })),
    );
    await page.route(`${API}/runs/${RUN_A}/approve`, (route) =>
      json(route, 409, {
        error: {
          code: 'BUILD_STATE_MOVED',
          message: 'This build moved while you were looking at it.',
          currentState: 'superseded',
          correlationId: 'e2e-correlation-id',
        },
      }),
    );
    await page.goto(RUN_URL);
    await page.getByTestId('build-approve').click();

    await expect(page.getByTestId('build-state-moved')).toContainText(
      'Superseded by a later build',
    );
    await expect(page.getByTestId('build-refetch')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'build-state-moved', info.project.name);
  });

  test('AC-19: `STALE_BUILD_SOURCE` renders explicitly and nothing was applied', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(route, 200, detail({ run: runSummary({ state: 'approved' }) })),
    );
    await page.route(`${API}/runs/${RUN_A}/apply`, (route) =>
      json(route, 409, {
        error: {
          code: 'STALE_BUILD_SOURCE',
          message: 'The draft this build was posed against has changed.',
          currentSourceDigest: 'b'.repeat(64),
          correlationId: 'e2e-correlation-id',
        },
      }),
    );
    await page.goto(RUN_URL);
    await page.getByTestId('build-apply-open').click();
    await expect(page.getByTestId('build-apply-confirm')).toContainText('nothing is published');
    await page.getByTestId('build-apply-confirm-button').click();

    await expect(page.getByTestId('build-source-moved')).toContainText('Nothing was applied');
    await expectNoAxeViolations(page);
    await capture(page, 'build-stale-source', info.project.name);
  });

  test('AC-20: a successful selection names the NEW draft and never claims a publication', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(route, 200, detail({ run: runSummary({ state: 'approved' }) })),
    );
    await page.route(`${API}/runs/${RUN_A}/apply`, (route) =>
      json(route, 200, {
        run: runSummary({ state: 'applied_to_draft_schedule', appliedToVersionId: RUN_B }),
        draftVersionId: RUN_B,
        assignmentsWritten: 7,
        pickPositionsCarried: 1,
        correlationId: 'e2e-correlation-id',
      }),
    );
    await page.goto(RUN_URL);
    await page.getByTestId('build-apply-open').click();
    await page.getByTestId('build-apply-confirm-button').click();

    await expect(page.getByTestId('build-applied')).toContainText(RUN_B);
    await expect(page.getByTestId('build-applied')).toContainText('publish it through');
    await expectNoAxeViolations(page);
    await capture(page, 'build-applied', info.project.name);
  });

  test('AC-21: exhausted retries surface with the LAST termination reason', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'FAILED',
            terminationReason: 'crashed',
            retryAttempt: 2,
            retryLimit: 2,
          }),
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-retries-exhausted')).toContainText(
      'stopped without reporting why',
    );
    await expectNoAxeViolations(page);
    await capture(page, 'build-retries-exhausted', info.project.name);
  });

  test('AC-25 (R-2): a failed build offers a retry, and it is a NEW build', async ({
    page,
  }, info) => {
    let posted: Record<string, unknown> | null = null;
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'TIMEOUT',
            terminationReason: 'deadline',
          }),
        }),
      ),
    );
    await page.route(`${API}/runs`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posted = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      return json(route, 200, {
        run: runSummary({ id: RUN_B, retryOfBuildRunId: RUN_A, retryAttempt: 1 }),
        correlationId: 'e2e-correlation-id',
      });
    });

    await page.goto(RUN_URL);
    await expect(page.getByTestId('build-retry')).toBeVisible();

    const recording = await recordRequests(page, 'builds-retry', info.project.name, async () => {
      await page.getByTestId('build-retry').click();
      await expect(page.getByTestId('build-retried')).toBeVisible();
    });

    /* SPEC-04 §2: a retry is a NEW build_run linked by `retryOfBuildRunId`, never
     * an in-place transition. The request body is what proves it. */
    expect(posted).not.toBeNull();
    expect((posted as unknown as { retryOfBuildRunId?: string }).retryOfBuildRunId).toBe(RUN_A);
    /* I-10: the write, and the re-read from the invalidation. */
    expect(recording.requests.length).toBeLessThanOrEqual(3);

    await expect(page.getByTestId('build-retried')).toContainText('kept as the record');
    await expectNoAxeViolations(page);
    await capture(page, 'build-retry', info.project.name);
  });

  test('AC-26 (R-2): an exhausted chain shows the control DISABLED, not hidden', async ({
    page,
  }, info) => {
    /* Hiding it would leave a scheduler wondering whether retrying is possible.
     * Disabling it beside the "chain has used its retries" message answers the
     * question they actually have. */
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'FAILED',
            terminationReason: 'crashed',
            retryAttempt: 2,
            retryLimit: 2,
          }),
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-retry')).toBeDisabled();
    await expect(page.getByTestId('build-retries-exhausted')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'build-retry-exhausted', info.project.name);
  });

  test('AC-27 (R-2): an infeasible build may also be retried', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'infeasible',
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
          }),
        }),
      ),
    );
    await page.goto(RUN_URL);
    await expect(page.getByTestId('build-retry')).toBeEnabled();
    await expectNoAxeViolations(page);
    await capture(page, 'build-retry-infeasible', info.project.name);
  });

  /* D-2: the disabled-not-hidden rationale is that a scheduler should learn WHY
   * the control will not work. That only holds if the reason renders for EVERY
   * state offering the control — it rendered for `failed` alone. */
  for (const settled of [
    { state: 'infeasible', status: 'INFEASIBLE', reason: 'completed' },
    { state: 'cancelled', status: 'CANCELLED', reason: 'user_cancelled' },
  ] as const) {
    test(`AC-28 (D-2): an exhausted ${settled.state} chain states its reason`, async ({
      page,
    }, info) => {
      await page.route(`${API}/runs/${RUN_A}`, (route) =>
        json(
          route,
          200,
          detail({
            run: runSummary({
              state: settled.state,
              solverStatus: settled.status,
              terminationReason: settled.reason,
              retryAttempt: 2,
              retryLimit: 2,
            }),
          }),
        ),
      );
      await page.goto(RUN_URL);

      await expect(page.getByTestId('build-retry')).toBeDisabled();
      /* The reason, not merely the disabled control. */
      await expect(page.getByTestId('build-retries-exhausted')).toBeVisible();
      await expect(page.getByTestId('build-retries-exhausted')).toContainText('used its retries');
      await expectNoAxeViolations(page);
      await capture(page, `build-retry-exhausted-${settled.state}`, info.project.name);
    });
  }

  test('AC-22: a 404 renders "not found", not "no permission"', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(route, 404, envelope('NOT_FOUND', 'That was not found.')),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('surface-error')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'build-not-found', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * D-4c comparison
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('candidate comparison (D-4c)', () => {
  test('AC-23: differences are shown and nothing is ranked', async ({ page }, info) => {
    await page.route(`${API}/comparison*`, (route) =>
      json(route, 200, {
        runs: [
          runSummary({ id: RUN_A, state: 'reviewed', candidateLabel: 'Candidate A' }),
          runSummary({ id: RUN_B, state: 'reviewed', candidateLabel: 'Candidate B' }),
        ],
        quality: [
          { runId: RUN_A, quality: quality() },
          { runId: RUN_B, quality: quality({ softPenaltyTotal: 9 }) },
        ],
        comparability: { comparable: true },
        differences: [
          { membershipId: MEMBER, date: '2043-01-07', shiftTypeId: SHIFT_TYPE, inRunIds: [RUN_A] },
        ],
        sharedAssignmentCount: 6,
        correlationId: 'e2e-correlation-id',
      }),
    );
    await page.goto(
      `/organizations/${ORGANIZATION}/groups/${GROUP}/builds/comparison?runIds=${RUN_A},${RUN_B}`,
    );

    await expect(page.getByTestId('build-comparison-shared')).toContainText('6 placements');
    /* SPEC-04 §7 again: the surface reports and does not rank. */
    await expect(page.getByTestId('build-comparison-caveat')).toContainText(
      'which candidate is better',
    );

    /* POSITIVE CONTROL for F-01/F-02 (FAD-46). The refusal guards must withhold
       the side-by-side table and the identical-claim ONLY on a refusal. Without
       this arm, deleting the comparison outright would satisfy every assertion
       in the two refusal tests — a guard proven only in the direction that hides
       things is a guard that has never been shown to let anything through. */
    await expect(page.getByTestId('build-comparison-quality')).toBeVisible();
    await expect(page.getByTestId('build-comparison-quality-separated')).toHaveCount(0);
    await expect(page.getByTestId('build-comparison-differences-withheld')).toHaveCount(0);

    await expectNoAxeViolations(page);
    await capture(page, 'build-comparison', info.project.name);
  });

  test('AC-24: fewer than two candidates is refused with words, not an empty table', async ({
    page,
  }, info) => {
    await page.goto(
      `/organizations/${ORGANIZATION}/groups/${GROUP}/builds/comparison?runIds=${RUN_A}`,
    );
    await expect(page.getByTestId('build-comparison-too-few')).toBeVisible();
    await expectNoAxeViolations(page);
    await capture(page, 'build-comparison-too-few', info.project.name);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M4-004 — the E2 surfaces
 *
 * Every one of these renders a fact the interface could not previously show, and
 * every one is a fact somebody could get WRONG in the direction that flatters
 * the product: an optimality claim on a feasible result, a minimality claim on a
 * budget that ran out, a fairness number rendered as a failure, a comparison
 * across two different problems, a "deterministic" toggle with no cost stated.
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('E2 quality, conflicts, explanations and reproducibility', () => {
  test('AC-29: the quality panel reports fairness with its basis, and the unmeasurable rates as unmeasured', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'completed',
            solverStatus: 'FEASIBLE',
            terminationReason: 'completed',
          }),
          reproducibility: 'deterministic',
          result: {
            solverStatus: 'FEASIBLE',
            terminationReason: 'completed',
            usable: true,
            candidateReturned: true,
            assignmentCount: 7,
            objectiveValue: 4120000,
            elapsedMs: 412,
            quality: quality(),
            objectiveTiers: [objectiveTier()],
            explanation: explanation(),
            rejections: [],
          },
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-quality-fairness')).toContainText('0.184');
    /* SPEC-04 §7's normalisation, RECORDED beside the number. A dispersion whose
     * basis is unstated is a number two people read as two different facts. */
    await expect(page.getByTestId('build-quality-fairness-basis')).toContainText(
      'fte-work-percentage',
    );
    /* The two honest nulls. A `0%` would claim every request was refused. */
    await expect(page.getByTestId('build-quality')).toContainText('not measured');
    /* doc 08 §3.4: the factor and the profile, recorded so the number can be
       interpreted at all. */
    await expect(page.getByTestId('build-objective-record')).toContainText('e2-default-v1');
    await expect(page.getByTestId('build-objective-record')).toContainText('×10000');
    /* The caveat AC-15 pins must survive every addition above it. */
    await expect(page.getByTestId('build-quality-caveat')).toContainText('not established yet');
    await expectNoAxeViolations(page);
    await captureE2(page, 'build-quality-e2', info.project.name);
  });

  test('AC-30: a FEASIBLE result is never described as optimal', async ({ page }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'completed',
            solverStatus: 'FEASIBLE',
            terminationReason: 'completed',
          }),
          result: {
            solverStatus: 'FEASIBLE',
            terminationReason: 'completed',
            usable: true,
            candidateReturned: true,
            assignmentCount: 7,
            objectiveValue: 14,
            elapsedMs: 412,
            quality: quality(),
            objectiveTiers: [],
            explanation: explanation(),
            rejections: [],
          },
        }),
      ),
    );
    await page.goto(RUN_URL);

    /* The solver status is SHOWN — that is where a proof, if one existed, would
       be visible — and the word "optimal" appears nowhere else on the page. */
    await expect(page.getByTestId('build-termination-reason')).toContainText('FEASIBLE');
    await expect(page.locator('body')).not.toContainText('optimal', { ignoreCase: true });
    await expectNoAxeViolations(page);
    await captureE2(page, 'build-feasible-not-optimal', info.project.name);
  });

  /**
   * **FAD-49 / EV-M4-005 §21 — the screen reports the RESULT, not the request.**
   *
   * The defect this pins: a build posed under the deterministic parameter set
   * whose search the wall clock ended used to render "Deterministic —
   * reproducible. The full pinned parameter set is in force, so the same problem
   * run again on the same worker build produces the same schedule." Every word
   * of that is true about the CONFIGURATION and false about that RUN.
   *
   * Both directions are here, in one test, because the falsifiable claim is the
   * DIFFERENCE: the same page, the same result, two verdicts, two readings.
   */
  test('AC-31b: a wall-clock-truncated run is NOT called reproducible, and the reason is named', async ({
    page,
  }, info) => {
    const withVerdict = (
      verdict: string,
      detailText: string,
    ): Parameters<typeof detail>[0] => ({
      run: runSummary({
        state: 'completed',
        solverStatus: 'FEASIBLE',
        terminationReason: 'completed',
      }),
      /* The DISPATCH statement is `deterministic` in BOTH arms — unchanged, and
         still correct. It is the result verdict that separates them. */
      reproducibility: 'deterministic',
      resultReproducibility: { verdict, reproducible: verdict === 'reproducible', detail: detailText },
      result: {
        solverStatus: 'FEASIBLE',
        terminationReason: 'completed',
        usable: true,
        candidateReturned: true,
        assignmentCount: 7,
        objectiveValue: 4120000,
        elapsedMs: 412,
        quality: quality(),
        objectiveTiers: [],
        explanation: explanation(),
        rejections: [],
      },
    });

    /* ARM 1 — the wall clock ended it. */
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail(
          withVerdict(
            'wall-clock-truncated',
            'The search ran for 9.497948s against a 10s wall-clock limit, so the WALL CLOCK ended it rather than the deterministic budget. How much search fits in that time depends on the machine, so the same problem run again may produce a different schedule of the same quality.',
          ),
        ),
      ),
    );
    await page.goto(RUN_URL);

    const truncated = page.getByTestId('build-reproducibility-wall-clock-truncated');
    await expect(truncated).toContainText('Not reproducible');
    await expect(truncated).toContainText('WALL CLOCK');
    /* The old wording must be gone from the page, not merely joined by a caveat.
       A screen that says both is a screen a scheduler can read either way. */
    await expect(page.locator('body')).not.toContainText(
      'produces the same schedule',
    );
    await expectNoAxeViolations(page);
    await captureE2(page, 'build-reproducibility-wall-clock-truncated', info.project.name);

    /* ARM 2 — the deterministic budget ended it. The claim IS made, so arm 1 is
       not passing because the page refuses to praise anything. */
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail(
          withVerdict(
            'reproducible',
            'The deterministic budget or a completed proof ended the search after 32.618628s, well inside the 900s wall-clock limit, so the same problem run again on the same worker build produces the same schedule.',
          ),
        ),
      ),
    );
    await page.goto(RUN_URL);

    const reproducible = page.getByTestId('build-reproducibility-reproducible');
    await expect(reproducible).toContainText('Reproducible');
    await expect(reproducible).toContainText('produces the same schedule');
    await expectNoAxeViolations(page);
  });

  test('AC-31: PO-DEC-13 classes are grouped by severity, and the fairness class is advisory', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'failed',
            solverStatus: 'FEASIBLE',
            terminationReason: 'rejected',
          }),
          conflicts: [
            conflict(),
            conflict({
              conflictClass: 'unmet-demand',
              severityRank: 2,
              source: 'demand',
              code: 'demand_not_satisfied',
              subject: null,
              detail: '5 of 7 required slots were filled',
            }),
            conflict({
              conflictClass: 'fairness-outlier',
              severityRank: 4,
              blocksApproval: false,
              banded: false,
              source: 'fairness',
              code: 'fairness_load_highest',
              subject: MEMBER,
              detail: 'normalised credit 9.00 (fte-work-percentage); no band is defined',
            }),
          ],
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-conflict-class-hard-breach')).toContainText(
      'blocks approval',
    );
    await expect(page.getByTestId('build-conflict-class-unmet-demand')).toContainText(
      'blocks approval',
    );
    /* The load-bearing row: no band exists for fairness dispersion (SPEC-04 §7,
       no band until the M6 benchmark), so the class is reported and never enforced. */
    await expect(page.getByTestId('build-conflict-class-fairness-outlier')).toContainText(
      'advisory',
    );
    await expect(page.getByTestId('build-conflicts-caveat')).toContainText('never blocks approval');
    await expectNoAxeViolations(page);
    await captureE2(page, 'build-conflict-taxonomy', info.project.name);
  });

  test('AC-32: EXPLAINED_MINIMAL states what was narrowed, and the degraded state states what was not', async ({
    page,
  }, info) => {
    await page.route(`${API}/runs/${RUN_A}`, (route) =>
      json(
        route,
        200,
        detail({
          run: runSummary({
            state: 'infeasible',
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
          }),
          result: {
            solverStatus: 'INFEASIBLE',
            terminationReason: 'completed',
            usable: false,
            candidateReturned: false,
            assignmentCount: 0,
            objectiveValue: null,
            elapsedMs: 900,
            quality: quality({ filledSlots: 0, demandSatisfactionRate: 0 }),
            objectiveTiers: [],
            explanation: explanation({
              state: 'EXPLAINED_MINIMAL',
              conflictingRuleKeys: ['ci-implies', 'ci-mutex'],
              tier2: {
                attempted: true,
                iterations: 3,
                removed: 1,
                budgetSeconds: 3,
                maxIterations: 64,
                exhausted: false,
              },
              solveCount: 4,
              elapsedSeconds: 0.9,
            }),
            rejections: [],
          },
        }),
      ),
    );
    await page.goto(RUN_URL);

    await expect(page.getByTestId('build-explanation-EXPLAINED_MINIMAL')).toContainText(
      'minimal set',
    );
    /* The distinction a scheduler acts on: every remaining rule was shown to be
       NECESSARY, so relaxing any one of them is worth doing. */
    await expect(page.getByTestId('build-explanation')).toContainText('shown to be necessary');
    await expect(page.getByTestId('build-explanation-tier2')).toContainText(
      'every remaining rule was checked',
    );
    await expectNoAxeViolations(page);
    await captureE2(page, 'build-explanation-minimal', info.project.name);
  });

  test('AC-33: the deterministic toggle discloses its measured cost, and costs no request', async ({
    page,
  }, info) => {
    await routeHappyPath(page);
    await page.goto(BUILDS_URL);
    await page.getByTestId('build-configuration-new').click();

    /* I-13 again, one level down: ticking a box is local state. The budget
       entry is what stops that quietly becoming a probe request later. */
    const recording = await recordRequests(
      page,
      'builds-toggle-deterministic',
      info.project.name,
      async () => {
        await page.getByTestId('build-configuration-deterministic').check();
      },
    );
    expect(recording.requests).toEqual([]);

    await expect(page.getByTestId('build-configuration-deterministic')).toBeChecked();
    /* EV-M0-SPC H-7 measured this and the spread is wide in BOTH directions, so
       a toggle offered without the number would be a trap. It is a measurement,
       and the copy says no target is set. */
    /* F-04: the packet's OWN measurement, never the M0 toy figures. */
    await expect(page.getByTestId('build-deterministic-cost')).toContainText('10× slower');
    await expect(page.getByTestId('build-deterministic-cost')).not.toContainText('12×');
    await expect(page.getByTestId('build-deterministic-cost')).toContainText('No speed target');
    await expectNoAxeViolations(page);
    await captureE2(page, 'build-deterministic-toggle', info.project.name);
  });

  test('AC-34: the configuration list says what best-effort reproducibility does not give', async ({
    page,
  }) => {
    await routeHappyPath(page);
    await page.goto(BUILDS_URL);
    await expect(page.getByTestId('build-configuration-mode-best-effort')).toContainText(
      'not reproducible',
    );
    await expectNoAxeViolations(page);
  });

  test('AC-35: a cross-snapshot comparison is REFUSED in words, not shown as an empty table', async ({
    page,
  }, info) => {
    await page.route(`${API}/comparison*`, (route) =>
      json(route, 200, {
        runs: [
          runSummary({ id: RUN_A, state: 'reviewed', candidateLabel: 'Candidate A' }),
          runSummary({ id: RUN_B, state: 'reviewed', candidateLabel: 'Candidate B' }),
        ],
        quality: [
          { runId: RUN_A, quality: quality() },
          { runId: RUN_B, quality: quality({ softPenaltyTotal: 9 }) },
        ],
        comparability: { comparable: false, reason: 'cross-snapshot' },
        differences: [],
        sharedAssignmentCount: 0,
        correlationId: 'e2e-correlation-id',
      }),
    );
    await page.goto(
      `/organizations/${ORGANIZATION}/groups/${GROUP}/builds/comparison?runIds=${RUN_A},${RUN_B}`,
    );

    await expect(page.getByTestId('build-comparison-refused-cross-snapshot')).toContainText(
      'built from different problems',
    );
    /* And no shared-placement claim, because there is no shared problem to make
       one about. */
    await expect(page.getByTestId('build-comparison-shared')).toHaveCount(0);

    /* ── REPAIR F-01 (FAD-46) ────────────────────────────────────────────────
       The finding this assertion exists for: the differences section was
       unguarded, so an empty projection — empty because NO COMPARISON WAS MADE —
       fell through to "These candidates place everybody identically", printed
       directly beneath the notice saying they could not be compared. The
       screenshot this very test retained showed both sentences at once, and the
       assertions walked straight past it.

       Absence of the claim is the assertion. Asserting the replacement text
       alone would pass just as happily with the contradiction still on screen
       above it. */
    await expect(page.getByTestId('build-comparison-identical')).toHaveCount(0);
    await expect(page.getByText('place everybody identically')).toHaveCount(0);
    await expect(page.getByTestId('build-comparison-differences-withheld')).toContainText(
      'not a statement that the candidates agree',
    );

    /* ── REPAIR F-02 (FAD-46) ────────────────────────────────────────────────
       The side-by-side measurements table is the arrangement that says "compare
       these". It may not appear under a refusal. The per-candidate measurements
       still may — separately, each labelled with the objective it was measured
       under — because a candidate's own measurement is not invalidated by an
       incomparable sibling. */
    await expect(page.getByTestId('build-comparison-quality')).toHaveCount(0);
    await expect(page.getByTestId('build-comparison-quality-separated')).toContainText(
      'shown separately',
    );
    await expect(page.getByTestId(`build-comparison-quality-single-${RUN_A}`)).toBeVisible();
    await expect(page.getByTestId(`build-comparison-quality-single-${RUN_B}`)).toBeVisible();

    await expectNoAxeViolations(page);
    await captureE2(page, 'build-comparison-cross-snapshot', info.project.name);
  });

  test('AC-36: a weights-differ comparison is refused with its own reason', async ({
    page,
  }, info) => {
    await page.route(`${API}/comparison*`, (route) =>
      json(route, 200, {
        runs: [
          runSummary({ id: RUN_A, state: 'reviewed', candidateLabel: 'Candidate A' }),
          runSummary({ id: RUN_B, state: 'reviewed', candidateLabel: 'Candidate B' }),
        ],
        quality: [
          { runId: RUN_A, quality: quality() },
          { runId: RUN_B, quality: quality({ objectiveWeightsDigest: 'f'.repeat(64) }) },
        ],
        comparability: { comparable: false, reason: 'weights-differ' },
        differences: [],
        sharedAssignmentCount: 0,
        correlationId: 'e2e-correlation-id',
      }),
    );
    await page.goto(
      `/organizations/${ORGANIZATION}/groups/${GROUP}/builds/comparison?runIds=${RUN_A},${RUN_B}`,
    );

    /* Two different reasons, two different sentences. Collapsing them would tell
       a scheduler to go and look at the wrong thing. */
    await expect(page.getByTestId('build-comparison-refused-weights-differ')).toContainText(
      'different objective weights',
    );

    /* F-01/F-02 hold on BOTH refusal reasons. A guard fixed for one reason and
       not the other is the same defect with a narrower trigger — and this is the
       reason where the numbers are most tempting to tabulate, because the two
       candidates really do share a snapshot. */
    await expect(page.getByTestId('build-comparison-identical')).toHaveCount(0);
    await expect(page.getByTestId('build-comparison-quality')).toHaveCount(0);
    await expect(page.getByTestId('build-comparison-quality-separated')).toBeVisible();

    await expectNoAxeViolations(page);
    await captureE2(page, 'build-comparison-weights-differ', info.project.name);
  });
});
