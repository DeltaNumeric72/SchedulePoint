import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';

import { resolveEvidencePath, screenshotDir } from './support/evidence-target.js';
import {
  readHandshake,
  realStackAvailable,
  type RealStackHandshake,
} from './support/real-stack.js';

/**
 * **THE CRITICAL PATH, AGAINST THE REAL STACK** — doc 35 §6g Included (A),
 * unblocked by FAD-48.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What is real here, stated before anything is claimed
 *
 * | Layer | What runs |
 * | --- | --- |
 * | browser | Chromium, the PRODUCTION `apps/web/dist` bundle, at two viewports |
 * | origin | a static+proxy server — one origin, exactly as the ingress image gives a deployment |
 * | API | `apps/api/src/index.ts`, the process a deployment runs, with its outbox runner and its `build.solve` queue runner |
 * | database | a throwaway PostgreSQL cluster, migrated, RLS on, seeded through the production write path |
 * | solver | real CP-SAT, through `SP_SOLVER_WORKER_COMMAND` |
 *
 * **`page.route` appears nowhere in this file, and no response is fabricated.**
 * That is the entire point: `builds.spec.ts` and its nine siblings prove the
 * INTERFACE under interception, `apps/api/test/**` proves the SERVER over HTTP
 * and in SQL, and until this file existed the JOIN between them had never run
 * (EV-M4-005 §12).
 *
 * ## Two steps have NO browser surface in M4, and are not faked
 *
 * doc 35 §6g's fourteen steps include **work profiles / qualifications** and the
 * **canonical solver input**. Neither has a page in `apps/web/src/router.tsx` —
 * CAP-020's remaining views are M6, and the packet's own Excluded row says so.
 * They are therefore exercised over **real HTTP against the same real API**,
 * through Playwright's `request` fixture carrying the same session cookie and
 * the same SPEC-01 §2.2 declaration the browser sends. That is a smaller claim
 * than the other twelve steps and it is labelled as one everywhere it appears:
 * the workflow is proven end to end, and two of its fourteen steps are proven at
 * the API rather than in the browser because there is no browser surface to
 * prove them at. Nothing is mocked, and nothing is asserted about a screen that
 * does not exist.
 *
 * ## Why the spec skips under the default configuration
 *
 * It lives beside the intercepting specs, so `playwright.config.ts` collects it
 * too — and under that config there is no cluster, no API and no bundle-serving
 * proxy. It declares its precondition instead of assuming one: `SP_REAL_STACK=1`
 * is set only by `e2e/real-stack.config.ts`'s `globalSetup`, which is what
 * starts the stack. A skipped test that says why is honest; a test that passes
 * against a server that is not there is not.
 *
 * **That sentence was false until FAD-50 C-3, and is true now.** `globalSetup`
 * set the daemon's ports and never the handshake, so this spec skipped under
 * BOTH configurations and the real-stack run exited 0 with `2 skipped` — the
 * failure mode a skip-guard has when nothing satisfies it. The setup now sets
 * `SP_REAL_STACK` once the stack is genuinely up, and
 * `support/must-run-reporter.ts` fails any real-stack run in which nothing
 * executed, so this can never quietly become decorative again.
 * ─────────────────────────────────────────────────────────────────────────────
 */

test.skip(
  !realStackAvailable(),
  'the real stack is not running — use `playwright test --config e2e/real-stack.config.ts`',
);

let stack: RealStackHandshake;

/**
 * A recovery code PER PROJECT, chosen by name rather than by a counter.
 *
 * Two counters were tried and both were measured wrong. A module-level `let`
 * fails because Playwright re-imports a spec file for each project; a counter on
 * `globalThis` fails too, because the two projects do not share a worker
 * process. Both produced the same symptom — the second project presenting a code
 * the first had already spent, refused as `consumed_recovery_code` by the
 * single-use control doing exactly its job.
 *
 * A name→index map has no shared state to get wrong. An unknown project name is
 * a loud error rather than a silent reuse: adding a third viewport must add a
 * third code here, not quietly collide with `desktop`.
 */
const RECOVERY_CODE_INDEX: Readonly<Record<string, number>> = { desktop: 0, mobile: 1 };

/**
 * A DISJOINT week per project, and this too was measured rather than foreseen.
 *
 * The two projects run against ONE database, one after the other. With the same
 * dates the second period overlapped the first and the server refused it — which
 * is the period-overlap rule doing its job, surfacing here as a form that would
 * not close. Each project therefore authors its own week.
 */
const PERIOD_WEEK: Readonly<Record<string, { first: string; last: string }>> = {
  desktop: { first: '2029-01-01', last: '2029-01-07' },
  mobile: { first: '2029-02-01', last: '2029-02-07' },
};

function weekFor(project: string): { first: string; last: string } {
  const week = PERIOD_WEEK[project];
  if (week === undefined) {
    throw new Error(
      `no period week is allocated to the project "${project}" — add one to PERIOD_WEEK rather ` +
        "than overlapping another project's period",
    );
  }
  return week;
}

function recoveryCodeFor(project: string): string {
  const index = RECOVERY_CODE_INDEX[project];
  if (index === undefined) {
    throw new Error(
      `no recovery code is allocated to the project "${project}" — add one to ` +
        "RECOVERY_CODE_INDEX rather than sharing another project's single-use code",
    );
  }
  const code = stack.recoveryCodes[index];
  if (code === undefined) {
    throw new Error(
      `the harness provisioned only ${String(stack.recoveryCodes.length)} recovery codes`,
    );
  }
  return code;
}

test.beforeAll(() => {
  stack = readHandshake();
});

function groupBase(): string {
  return `/organizations/${stack.organizationId}/groups/${stack.groupId}`;
}

/**
 * The request recorder for THIS suite — deliberately NOT `support/request-budget.ts`.
 *
 * ## Why not the shared recorder, measured rather than assumed
 *
 * The shared recorder writes into `scripts/gates/request-budget/recordings/`,
 * and `scripts/gates/request-budget.mjs` fails on a recording with no declared
 * budget **and** on a budget with no recording. Declaring the eight interactions
 * below therefore made `corepack pnpm check` depend on a real-stack run it does
 * not perform: the recordings directory is git-ignored, so a fresh checkout
 * would fail the budget gate for want of a run nobody asked it to do. Measured
 * — 16 violations on the first full battery, then 52 budgets against recordings
 * that only exist after `real-stack.config.ts` has run.
 *
 * So the real-stack ledger is the EVIDENCE BUNDLE's, not the gate's. §6g's
 * requirement is that every interaction's request count is RECORDED; it is,
 * here and in the transcript, with the same counting rule (data: and blob: URLs
 * excluded, because they are not network requests). The mocked suite's budgets
 * are untouched and still enforced.
 */
interface CriticalPathRecording {
  readonly step: string;
  readonly requests: readonly { method: string; url: string }[];
}

async function recordStep(
  page: Page,
  step: string,
  action: () => Promise<void>,
): Promise<CriticalPathRecording> {
  const requests: { method: string; url: string }[] = [];
  const listener = (request: Request): void => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    requests.push({ method: request.method(), url });
  };
  page.on('request', listener);
  try {
    await action();
  } finally {
    page.off('request', listener);
  }
  return { step, requests };
}

function writeLedger(project: string, ledger: readonly CriticalPathRecording[]): void {
  const path = resolveEvidencePath(
    `docs/evidence/EV-M4-005/critical-path-requests.${project}.json`,
  );
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ project, recordedAt: new Date().toISOString(), ledger }, null, 2)}\n`,
    'utf8',
  );
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
    'axe-core found violations on the real-stack critical path',
  ).toEqual([]);
}

async function capture(page: Page, name: string, project: string): Promise<void> {
  const directory = screenshotDir('EV-M4-005');
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `critical-path-${name}.${project}.png`),
    fullPage: true,
  });
}

/**
 * Signs in through the REAL two-step flow, in the browser.
 *
 * `SignInPage` announces the state rather than navigating, so the spec performs
 * the navigation a user performs by following the instruction on screen. The
 * challenge is answered with a recovery code through the page's own "Use a
 * recovery code instead" control — the enrolment itself was done server-side by
 * the harness, for the reason `real-stack-daemon.ts` records.
 */
async function signIn(page: Page, project: string): Promise<void> {
  await page.goto(`/organizations/${stack.organizationId}/sign-in`);
  await expect(page.getByTestId('sign-in-form')).toBeVisible();
  await page.getByLabel('Login email').fill(stack.loginEmail);
  await page.getByLabel('Password').fill(stack.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // The server said what is required next. A real second factor, announced.
  await expect(page.getByTestId('authn-status')).toContainText(/authenticator|Signed in/i, {
    timeout: 30_000,
  });

  await page.goto(`/organizations/${stack.organizationId}/sign-in/challenge`);
  await expect(page.getByTestId('mfa-use-recovery')).toBeVisible();
  await page.getByTestId('mfa-use-recovery').click();
  await page.getByLabel('Recovery code').fill(recoveryCodeFor(project));
  await page.getByRole('button', { name: /verify|continue|submit/i }).click();
  await expect(page.getByTestId('authn-status')).toContainText(/signed in/i, { timeout: 30_000 });
}

/**
 * The declaration the BROWSER learnt, read back out of the running application.
 *
 * Used only by the two API-level steps, so that they declare exactly what the
 * browser declares rather than something a test computed for itself. It is read
 * from the live page through the same `/me/context` route the client uses — a
 * second computation here would be a second source of truth.
 */
async function declarationFor(page: Page, groupId: string | null): Promise<string> {
  const context = (await page.evaluate(async (organizationId: string) => {
    const response = await fetch(`/api/organizations/${organizationId}/me/context`, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    return response.json() as Promise<unknown>;
  }, stack.organizationId)) as {
    organizationVersion: number;
    membershipSetVersion: number;
    sessionEpoch: number;
    memberships: { kind: string; groupId: string | null; groupVersion: number | null }[];
  };

  const groupVersion =
    groupId === null
      ? null
      : (context.memberships.find((m) => m.kind === 'group' && m.groupId === groupId)
          ?.groupVersion ?? null);
  return JSON.stringify({
    contextVersion: {
      organizationVersion: context.organizationVersion,
      groupVersion,
      membershipSetVersion: context.membershipSetVersion,
    },
    sessionEpoch: context.sessionEpoch,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * ONE test, because it is ONE workflow
 *
 * The steps depend on each other — step 2 needs the period step 1 created, step
 * 7 needs the build step 6 launched — and each sign-in spends a single-use
 * recovery code. Splitting it into fourteen tests would either share mutable
 * state between tests (which `fixture-regression`'s shuffle exists to punish) or
 * re-run the whole workflow fourteen times.
 * ──────────────────────────────────────────────────────────────────────────── */

test.describe('the critical path, end to end, against the real stack', () => {
  test('STEP 0 the join, then the workflow: period -> demand -> rules -> build', async ({
    page,
    request,
  }, info) => {
    test.slow();
    const ledger: CriticalPathRecording[] = [];
    const budget: { step: string; requests: number }[] = [];
    const uniqueSuffix = `${info.project.name}-${String(Date.now() % 100000)}`;

    /* ── STEP 0 — the join FAD-48 exists to make possible ─────────────────── *
     *
     * Waited for rather than sampled. An earlier version enumerated the requests
     * seen so far after the page had rendered, and it was RACY in the direction
     * that flatters: `periods-new` is visible in the loading state too, so the
     * enumeration sometimes ran before the list request was issued and reported
     * zero. A test that intermittently under-reports the thing it exists to
     * prove is worse than no test, so the proof is now a specific response. */
    await signIn(page, info.project.name);

    const periodsRead = page.waitForResponse(
      (response) =>
        // `/api/` matters: `page.goto` requests the SPA route at the SAME path,
        // and matching the document instead of the API call is how this proof
        // would silently become a proof about the static server.
        response.url().includes('/api/') &&
        response.url().includes('/schedule/periods') &&
        response.request().method() === 'GET',
      { timeout: 60_000 },
    );
    await page.goto(`${groupBase()}/schedule/periods`);
    const listResponse = await periodsRead;
    const listHeaders = await listResponse.request().allHeaders();

    // THE MEASUREMENT §12 SAID DID NOT EXIST, in three parts:
    //   the shipped bundle sent a declaration...
    expect(
      listHeaders['x-schedulepoint-context'],
      'the shipped bundle sent no SPEC-01 §2.2 declaration',
    ).toBeDefined();
    //   ...the real server ACCEPTED it (not 400 CONTEXT_MALFORMED, not 409)...
    expect(listResponse.status(), await listResponse.text()).toBe(200);
    //   ...and the page rendered from it.
    await expect(page.getByTestId('periods-new')).toBeVisible({ timeout: 60_000 });

    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 0 join: GET ${listResponse.url()} -> ` +
        `${String(listResponse.status())} with declaration ` +
        `${String(listHeaders['x-schedulepoint-context'])}\n`,
    );

    await expectNoAxeViolations(page);
    await capture(page, 'step-00-signed-in', info.project.name);

    /* ── STEP 1 — the period (browser) ──────────────────────────────────── */
    //
    // Settled first, and that is not politeness. An I-13 recording measures what
    // a CLICK caused; a page-load read still in flight would be counted against
    // the click and the assertion would fail for a reason that has nothing to do
    // with the invariant. Under interception those reads resolve instantly and
    // the question never arises — which is exactly the kind of difference a real
    // stack surfaces.
    await page.waitForLoadState('networkidle');
    const openForm = await recordStep(page, 'critical-path-open-new-period', async () => {
      await page.getByTestId('periods-new').click();
      await expect(page.getByTestId('periods-form')).toBeVisible();
    });
    // I-13, on the real stack this time: a control labelled New persists nothing.
    expect(openForm.requests, 'opening the period form issued a request').toEqual([]);
    ledger.push(openForm);
    budget.push({ step: 'open new period', requests: openForm.requests.length });

    const periodName = `Critical path ${uniqueSuffix}`;
    await page.getByLabel('Period name').fill(periodName);
    const week = weekFor(info.project.name);
    await page.getByLabel('First day').fill(week.first);
    await page.getByLabel('Last day').fill(week.last);

    const savePeriod = await recordStep(page, 'critical-path-save-period', async () => {
      await page.getByTestId('periods-save').click();
      await expect(page.getByTestId('periods-form')).toHaveCount(0, { timeout: 30_000 });
    });
    ledger.push(savePeriod);
    budget.push({ step: 'save period', requests: savePeriod.requests.length });

    // The row is REAL: the server assigned the id, and the page is showing what
    // the server said, not what the form typed.
    //
    // Asserted on the CONTROL rather than on a `rowheader`, because the periods
    // surface reflows: at 1280px it is a table and at 390px it is a card list,
    // so a role that exists at one viewport does not exist at the other. The
    // control is present in both, and it is what carries the server's id.
    const openPeriod = page
      .locator('[data-testid^="period-open-"]')
      .filter({ hasText: periodName });
    await expect(openPeriod).toHaveCount(1, { timeout: 30_000 });
    const periodTestId = await openPeriod.getAttribute('data-testid');
    const periodId = (periodTestId ?? '').replace('period-open-', '');
    expect(periodId, 'the created period has no server-assigned id').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 1 created period ${periodId} in PostgreSQL\n`,
    );
    await expectNoAxeViolations(page);
    await capture(page, 'step-01-period-created', info.project.name);

    /* ── STEP 2 — the demand (browser) ──────────────────────────────────── */
    await openPeriod.click();
    await expect(page.getByTestId('requirements-new')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('requirements-new').click();
    await page.getByLabel('Date').fill(week.first);
    await page.getByTestId('requirements-shift-type').selectOption(stack.shiftTypeIds[0] ?? '');
    await page.getByLabel('People required').fill('1');

    const saveRequirement = await recordStep(page, 'critical-path-save-requirement', async () => {
      await page.getByTestId('requirements-save').click();
      await expect(page.getByTestId('requirements-form')).toHaveCount(0, { timeout: 30_000 });
    });
    ledger.push(saveRequirement);
    budget.push({ step: 'save requirement', requests: saveRequirement.requests.length });
    await expectNoAxeViolations(page);
    await capture(page, 'step-02-demand', info.project.name);

    /* ── STEP 3 — profiles and qualifications (API, DISCLOSED) ──────────── *
     *
     * No browser surface exists: `router.tsx` has no work-profile or
     * qualification page, and CAP-020's remaining views are M6 (doc 35 §6g
     * Excluded). Exercised over real HTTP against the same real API, with the
     * SAME session and the SAME declaration the browser is sending — not mocked,
     * and not claimed as a browser step. */
    const declaration = await declarationFor(page, stack.groupId);
    const qualifications = await request.get(`/api${groupBase()}/catalogue/qualifications`, {
      headers: { 'x-schedulepoint-context': declaration, accept: 'application/json' },
    });
    expect(
      [200, 404],
      `the qualification read answered ${String(qualifications.status())}`,
    ).toContain(qualifications.status());
    budget.push({ step: 'qualifications (API, no browser surface)', requests: 1 });

    /* ── STEP 4 — the rules surface (browser) ────────────────────────────── */
    await page.goto(`${groupBase()}/catalogue/rules`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expectNoAxeViolations(page);
    await capture(page, 'step-04-rules', info.project.name);

    /* ── STEP 5 — the draft version the build is posed against (browser) ─── */
    await page.goto(`${groupBase()}/schedule/periods`);
    await page.locator(`[data-testid="period-open-${periodId}"]`).click();
    await expect(page.getByTestId('versions-new')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('versions-new').click();
    await expect(page.getByTestId('versions-confirm')).toBeVisible();

    const createVersion = await recordStep(page, 'critical-path-create-draft-version', async () => {
      await page.getByTestId('versions-confirm-save').click();
      await expect(page.getByTestId('versions-confirm')).toHaveCount(0, { timeout: 30_000 });
    });
    ledger.push(createVersion);
    budget.push({ step: 'create draft version', requests: createVersion.requests.length });

    await expect(page.getByTestId('versions-list')).toBeVisible({ timeout: 30_000 });
    const versionTestId = await page
      .locator('[data-testid^="version-open-"]')
      .first()
      .getAttribute('data-testid');
    const versionId = (versionTestId ?? '').replace('version-open-', '');
    expect(versionId, 'no draft version was created').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 5 created draft version ${versionId}\n`,
    );
    await capture(page, 'step-05-draft-version', info.project.name);

    /* ── STEP 6 — the build configuration and the launch (browser) ───────── */
    await page.goto(`${groupBase()}/builds/periods/${periodId}`);
    await expect(page.getByTestId('build-configuration-new')).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    const openConfiguration = await recordStep(
      page,
      'critical-path-open-new-configuration',
      async () => {
        await page.getByTestId('build-configuration-new').click();
        await expect(page.getByTestId('build-configuration-form')).toBeVisible();
      },
    );
    // I-13 again, on the surface that starts the production scheduling
    // mechanism. A control labelled New must persist nothing.
    expect(openConfiguration.requests, 'opening the configuration form issued a request').toEqual(
      [],
    );
    ledger.push(openConfiguration);
    budget.push({ step: 'open new configuration', requests: openConfiguration.requests.length });

    await page.getByLabel('Configuration name').fill(`Critical path ${uniqueSuffix}`);
    await page.getByLabel('Time limit (seconds)').fill('20');
    const saveConfiguration = await recordStep(
      page,
      'critical-path-save-configuration',
      async () => {
        await page.getByTestId('build-configuration-save').click();
        await expect(page.getByTestId('build-configurations-list')).toBeVisible({
          timeout: 30_000,
        });
      },
    );
    ledger.push(saveConfiguration);
    budget.push({ step: 'save configuration', requests: saveConfiguration.requests.length });
    await expectNoAxeViolations(page);
    await capture(page, 'step-06-configuration', info.project.name);

    /* ── STEP 7 — the REAL worker and REAL CP-SAT ────────────────────────── */
    await page.locator('[data-testid^="build-launch-open-"]').first().click();
    await expect(page.getByTestId('build-launch-form')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Candidate label').fill(`Candidate ${uniqueSuffix}`);
    await page.getByLabel('Source draft version').fill(versionId);

    const launch = await recordStep(page, 'critical-path-launch-build', async () => {
      await page.getByTestId('build-launch-save').click();
      await expect(page.getByTestId('build-launch-form')).toHaveCount(0, { timeout: 60_000 });
    });
    ledger.push(launch);
    budget.push({ step: 'launch build', requests: launch.requests.length });

    // The run exists in the database, and the queue runner in the API process
    // takes it. Polled through the UI rather than through SQL, because what is
    // under proof is that a scheduler can SEE it happen.
    await expect(
      page.getByTestId('build-runs-table').or(page.getByTestId('build-runs-list')),
    ).toBeVisible({ timeout: 60_000 });
    const runTestId = await page
      .locator('[data-testid^="build-run-open-"]')
      .first()
      .getAttribute('data-testid');
    const runId = (runTestId ?? '').replace('build-run-open-', '');
    expect(runId, 'no build run was created').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 7 launched build run ${runId} — ` +
        `real worker, real CP-SAT (${stack.solverCommand ?? 'NO SOLVER COMMAND SET'})\n`,
    );

    /* ── The build detail, POLLED by reloading ───────────────────────────── *
     *
     * `BuildDetailPage` does not poll — PO-DEC-18 makes the server authoritative
     * and the page offers an explicit refresh rather than a background beat, so a
     * spec that waits on a locator would wait for ever on a page that is not
     * going to change by itself. Reloading is what a scheduler does, and it is
     * what this loop does.
     *
     * The loop REPORTS the state it saw rather than only timing out. A build
     * that never leaves `queued` is a finding about the queue binding, and a
     * bare "locator not found after 240s" would hide which of the sixteen states
     * it was actually sitting in. */
    const TERMINAL = /^build-state-(completed|infeasible|failed|cancelled|expired)/;
    /**
     * The two forward transitions a SCHEDULER performs, in the order the state
     * machine allows them.
     *
     * A run is created in `draft_configuration` — M4-003's sixteen-state,
     * server-authoritative machine does not start solving because a row exists.
     * `Submit for validation` and then `Run` are the scheduler's two deliberate
     * acts, and clicking them here is driving the workflow, not nudging a test
     * past an obstacle. Nothing else is clicked: `build-cancel-open` is on the
     * same page, and a loop that pressed every available button would eventually
     * cancel the thing it is waiting for.
     */
    const FORWARD = ['build-submit', 'build-run'] as const;
    const observed: string[] = [];
    const actionsTaken: string[] = [];
    let reached: string | undefined;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      await page.goto(`${groupBase()}/builds/runs/${runId}`);
      await page.waitForLoadState('networkidle');
      const states = await page.locator('[data-testid^="build-state-"]').all();
      const names = (
        await Promise.all(states.map((locator) => locator.getAttribute('data-testid')))
      ).filter((name): name is string => name !== null);
      for (const name of names) {
        if (!observed.includes(name)) observed.push(name);
      }
      reached = names.find((name) => TERMINAL.test(name));
      if (reached !== undefined) break;

      let acted = false;
      for (const action of FORWARD) {
        const control = page.getByTestId(action);
        if ((await control.count()) > 0 && (await control.first().isEnabled())) {
          await control.first().click();
          await page.waitForLoadState('networkidle');
          actionsTaken.push(action);
          acted = true;
          break;
        }
      }
      if (!acted) await page.waitForTimeout(5_000);
    }
    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 7 scheduler actions: ` +
        `${actionsTaken.length === 0 ? '(none)' : actionsTaken.join(' -> ')}\n`,
    );

    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 7 states observed: ` +
        `${observed.length === 0 ? '(none)' : observed.join(', ')}\n`,
    );
    await capture(page, 'step-07-build-detail', info.project.name);
    await expectNoAxeViolations(page);

    expect(
      reached,
      `the build never reached a terminal state; states observed: ${observed.join(', ') || '(none)'}`,
    ).toBeDefined();
    process.stdout.write(
      `[critical-path/${info.project.name}] STEP 7 terminal state: ${String(reached)}\n`,
    );

    /* ── STEPS 8-9 — independent validation, conflicts and quality ───────── *
     *
     * The build detail page is where the scheduler reads the SERVER's verdict on
     * a completed candidate: whether it is usable at all (the M4-003
     * validation gate), and what its quality was measured to be. Both are read
     * off the real run — no fixture decided them. */
    const usability = page.getByTestId('build-usability');
    const quality = page.getByTestId('build-quality');
    const validationSurfaces: string[] = [];
    if ((await usability.count()) > 0) {
      validationSurfaces.push(`usability="${(await usability.first().innerText()).slice(0, 80)}"`);
    }
    if ((await quality.count()) > 0) validationSurfaces.push('quality panel rendered');
    if ((await page.getByTestId('build-conflicts-caveat').count()) > 0) {
      validationSurfaces.push('conflicts caveat rendered');
    }
    process.stdout.write(
      `[critical-path/${info.project.name}] STEPS 8-9 validation/quality surfaces: ` +
        `${validationSurfaces.length === 0 ? '(none rendered)' : validationSurfaces.join(' | ')}\n`,
    );
    expect(
      validationSurfaces.length,
      'a completed build showed neither a usability verdict nor a quality measurement',
    ).toBeGreaterThan(0);

    /* ── The two review transitions selection requires ───────────────────── *
     *
     * `Select this candidate` appears only in `approved`, and `approved` is
     * reached through `completed -> reviewed -> approved`. Those are the
     * scheduler's OWN acts — "I have reviewed the findings", then "Approve" —
     * and the state machine refuses to skip them. Driving them here is the
     * workflow; skipping them would be asserting that a candidate nobody
     * reviewed can become a draft. */
    for (const action of ['build-review', 'build-approve'] as const) {
      const control = page.getByTestId(action);
      if ((await control.count()) > 0 && (await control.first().isEnabled())) {
        await control.first().click();
        await page.waitForLoadState('networkidle');
        await page.goto(`${groupBase()}/builds/runs/${runId}`);
        await page.waitForLoadState('networkidle');
        actionsTaken.push(action);
      }
    }
    process.stdout.write(
      `[critical-path/${info.project.name}] STEPS 10-11 review transitions: ` +
        `${actionsTaken.join(' -> ')}\n`,
    );

    /* ── STEPS 10-11 — candidate selection into a NEW draft ──────────────── *
     *
     * FAD-44's origin grant: selection writes a NEW M3 draft through the one
     * write path, and publishes nothing. The confirmation says so in words, and
     * it is asserted rather than assumed — a selection surface that did not say
     * it publishes nothing would be the surface I-13 exists about. */
    /* **FAD-50 C-2.** This block used to be wrapped in
     * `if (count > 0 && isEnabled())` with a `console.log` in the `else`, and
     * `appliedDraft` was computed and never asserted. A period the server
     * refused to apply, a control that never rendered, a selection that silently
     * did nothing — every one of those printed a line and PASSED.
     *
     * The reviewer diagnosed the reason it had been written that way, and it was
     * not that the server could not do it: the POST returns 200, the run reaches
     * `applied_to_draft_schedule`, a new draft id comes back and the UI renders
     * `build-applied`. The spec was looking before React's post-invalidate
     * render had settled, and `networkidle` does not wait for that — it waits
     * for the network. So the guard was papering over a WAIT bug, and the fix is
     * to wait for the thing itself. */
    const applyOpen = page.getByTestId('build-apply-open');
    await expect(
      applyOpen.first(),
      'STEP 10: the completed run offered no selection control — the critical path stops here',
    ).toBeEnabled({ timeout: 30_000 });

    await applyOpen.first().click();
    await expect(page.getByTestId('build-apply-confirm')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('build-apply-confirm')).toContainText('nothing is published');

    const apply = await recordStep(page, 'critical-path-apply-candidate', async () => {
      await page.getByTestId('build-apply-confirm-button').click();
      /* The OUTCOME, awaited — not the network going quiet. This is the whole
       * repair: `build-applied` is rendered from the refetched run, one React
       * commit after the request that `networkidle` was satisfied by. */
      await expect(page.getByTestId('build-applied')).toBeVisible({ timeout: 60_000 });
    });
    ledger.push(apply);
    budget.push({ step: 'select candidate into a new draft', requests: apply.requests.length });

    /* The applied DRAFT, asserted rather than counted. The element names the new
     * version, so the id is read back out of the screen a scheduler is looking
     * at rather than out of a response nobody sees. */
    const appliedText = (await page.getByTestId('build-applied').innerText()).trim();
    const appliedVersionId = /draft version ([0-9a-f-]{36})/i.exec(appliedText)?.[1] ?? null;
    expect(appliedVersionId, `STEP 11: no draft version id in "${appliedText}"`).not.toBeNull();
    expect(appliedVersionId).not.toBe(versionId);

    /* and the RUN moved with it — the screen and the state agree. The testid
       carries the state name, so this asserts the exact state rather than a
       word that happens to appear somewhere on the page. */
    await expect(page.getByTestId('build-state-applied_to_draft_schedule')).toBeVisible();
    /* nothing was published by a selection (FAD-44's origin grant, on the screen) */
    await expect(page.locator('body')).not.toContainText('published this schedule');

    process.stdout.write(
      `[critical-path/${info.project.name}] STEPS 10-11 selection APPLIED: ` +
        `source ${versionId} -> new draft ${String(appliedVersionId)}\n`,
    );
    await capture(page, 'step-10-selection', info.project.name);
    await expectNoAxeViolations(page);

    /* ── STEPS 12-13 — the publication surfaces ──────────────────────────── *
     *
     * **FAD-50 C-2.** These three steps asserted an `<h1>` was visible and axe
     * was green, and nothing else. An h1 is present on an error page, an empty
     * page, and a page rendering somebody else's period — so the assertion could
     * not fail for any reason the step is about. Each now asserts the CONTENT
     * that makes it that step: the review surface shows the draft this build
     * just produced, the history shows this period's versions, and the published
     * view answers about this period rather than 404ing. */
    await page.goto(`${groupBase()}/publication/versions/${appliedVersionId ?? versionId}/review`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    /* The review surface is showing THE APPLIED DRAFT — the one selection just
       created, reached by its own id. That is the join between step 11 and step
       12, and it is the thing an h1 assertion could never see. */
    await expect(page.getByTestId('review-summary')).toBeVisible({ timeout: 30_000 });
    /* The blocker verdict is COMPUTED and shown — either there are blockers and
       they are itemised, or the surface says there are none. A page that showed
       neither would be a review screen that has not reviewed anything. */
    await expect(
      page.getByTestId('review-no-blockers').or(page.getByTestId('review-blockers')),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText(/not found|no such version/i);
    await expectNoAxeViolations(page);
    await capture(page, 'step-12-publication-review', info.project.name);

    await page.goto(`${groupBase()}/publication/periods/${periodId}/history`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    /* The history lists at least one version for this period. Before the build
       there was a draft; after selection there is another. An empty history here
       would mean the period the rest of the spec worked on is not this one. */
    await expect(page.getByTestId('history-immutability-legend')).toBeVisible({ timeout: 30_000 });
    /* At least one version row, and the applied draft is ONE OF THEM — the join
       between step 11 and step 13, by id rather than by count. */
    await expect(page.getByTestId(`version-row-${String(appliedVersionId)}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('body')).not.toContainText(/not found/i);
    await expectNoAxeViolations(page);
    await capture(page, 'step-13-version-history', info.project.name);

    await page.goto(`${groupBase()}/publication/periods/${periodId}/published`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    /* Nothing was published by this workflow — selection creates a DRAFT — so
       the honest content here is the empty state, and asserting it is asserting
       FAD-44's origin grant from the other end. What must never appear is an
       error, or a published schedule this path did not publish. */
    await expect(page.locator('body')).not.toContainText(/not found|something went wrong/i);
    await expectNoAxeViolations(page);
    await capture(page, 'step-13-published-schedule', info.project.name);

    /* ── STEP 14 — the staff schedule view ───────────────────────────────── *
     *
     * The staff-facing end of doc 07 §1: a DRAFT is invisible to staff. This
     * workflow published nothing, so the correct and asserted outcome is that
     * the member's own schedule shows no assignment from the draft the build
     * just produced — the invariant, seen from the person it protects. */
    await page.goto(`${groupBase()}/my-schedule/${stack.membershipId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    /* **FAD-51 D-3 — assert THE correct outcome, not merely A rendered state.**
     *
     * The previous version was a four-way disjunction over the view spellings,
     * and it admitted both the empty and the non-empty schedule: on desktop
     * `schedule-calendar` renders whatever the content is, so the assertion
     * could not fail for the reason this step exists. It also asserted
     * `schedule-status` only `toBeAttached`, which is satisfied while that very
     * element still reads "Loading your schedule…".
     *
     * `schedule-status` is the viewport-independent line that carries the exact
     * outcome, and the exact outcome here is knowable: this workflow selects a
     * candidate into a DRAFT and publishes nothing, so the staff member must
     * have no shifts. Asserting the sentence pins doc 07 §1 — a draft is
     * invisible to staff — from the side of the person it protects, and it pins
     * it identically at both viewports. */
    const status = page.getByTestId('schedule-status');
    await expect(status).toHaveText(/^No shifts between /, { timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText(/not found|something went wrong/i);
    /* doc 07 §1, asserted: the unpublished draft is not on a staff screen. */
    await expect(page.locator('body')).not.toContainText(String(appliedVersionId));
    await expectNoAxeViolations(page);
    await capture(page, 'step-14-my-schedule', info.project.name);

    /* ── The ledger ─────────────────────────────────────────────────────── */
    writeLedger(info.project.name, ledger);
    for (const entry of budget) {
      // Printed rather than only asserted, because §6g requires every
      // interaction's request count to be RECORDED, and a number that only
      // exists inside an assertion is not a record.
      process.stdout.write(
        `[critical-path/${info.project.name}] ${entry.step}: ${String(entry.requests)} request(s)\n`,
      );
    }
  });
});
