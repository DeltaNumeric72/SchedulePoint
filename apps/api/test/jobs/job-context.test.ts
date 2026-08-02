import type { EnqueuedJob, FrozenJobContext } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultJobHandlers, contextProbeTouchHandler, CONTEXT_PROBE_TOUCH_JOB } from '../../src/jobs/handlers.js';
import { executeJob } from '../../src/jobs/worker.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  lastActiveAt,
  type HttpHarness,
} from '../support/http.js';

/**
 * **SPEC-01 §7.1 T-03 — the job-enqueue surface**, and **SPEC-01 §6 / SPEC-06 §5**
 * — frozen context and re-evaluation at execution.
 *
 * T-03 requires "identical behaviour on every surface" for five surfaces. Two
 * exist at this milestone and are covered here and in
 * `test/http/context-surface.test.ts`:
 *
 * | Surface | Status |
 * |---|---|
 * | **mutation** | covered (`context-surface.test.ts`) |
 * | **job enqueue** | covered (this file) |
 * | publication | **deferred** — no publication surface exists until SPEC-05's milestone |
 * | report request | **deferred** — SPEC-09's milestone |
 * | document upload | **deferred** — SPEC-09's milestone |
 * | WebSocket command | **deferred** — SPEC-01 §5 / SPEC-02's milestone |
 *
 * The deferral is by packet decision and is tracked in the return report. Each
 * deferred surface must run this same table when it lands; the shared context
 * path means it is a wiring test, not a re-implementation.
 */

let harness: HttpHarness;
let worker: Runtime;
let admin: pg.Client;

const alpha = FIXTURE.alpha;
const enqueuePath = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/enqueue`;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
  // The worker runs under `app_worker` — a separate credential with its own
  // grants and no BYPASSRLS, subject to exactly the same policies.
  worker = createRuntime('app_worker', { max: 2 });
});

afterAll(async () => {
  await harness.close();
  await worker.destroy();
  await admin.end();
});

afterEach(() => {
  harness.jobQueue.clear();
});

/**
 * Changes a membership THROUGH a unit of work.
 *
 * A privilege-bearing membership change outside one is refused by the
 * counter-maintenance trigger (I-15) — see `roles-and-schema.test.ts`, describe
 * block "the counter bump enforces the unit of work". These tests are simulating
 * an administrator's action, and an administrator's action goes through the same
 * path as everyone else's.
 */
async function setMembershipField(
  membershipId: string,
  values: { group_role?: string; status?: 'invited' | 'active' | 'suspended' | 'ended' },
): Promise<void> {
  await harness.runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: null,
      correlationId: 'job-context-role-change',
    },
    async ({ query }) => {
      await query
        .updateTable('memberships')
        .set(values)
        .where('id', '=', membershipId)
        .execute();
    },
  );
}

function frozenContext(overrides: Partial<FrozenJobContext> = {}): FrozenJobContext {
  return {
    actionScope: 'group',
    expectedOrganizationId: alpha.organizationId,
    expectedGroupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    systemActor: false,
    correlationId: 'job-context-test',
    authorizationVersionAtEnqueue: 'av1:1.1.1.1',
    ...overrides,
  };
}

function job(context: FrozenJobContext, kind = CONTEXT_PROBE_TOUCH_JOB): EnqueuedJob {
  return {
    id: '00000000-0000-4000-8000-00000000ffff',
    kind,
    context,
    args: {},
    enqueuedAt: new Date().toISOString(),
  };
}

describe('SPEC-01 §6 — enqueue freezes the context', () => {
  it('T-03 (job surface) an enqueue carries the verified context, frozen', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: enqueuePath,
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          userId: alpha.users.scheduler.id,
        }),
      ),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      jobId: string;
      kind: string;
      frozen: {
        organizationId: string;
        groupId: string | null;
        membershipId: string | null;
        actionScope: string;
        authorizationVersionAtEnqueue: string;
      };
    }>();

    expect(body.kind).toBe(CONTEXT_PROBE_TOUCH_JOB);
    expect(body.frozen.organizationId).toBe(alpha.organizationId);
    expect(body.frozen.groupId).toBe(alpha.groupOne.id);
    expect(body.frozen.membershipId).toBe(alpha.users.scheduler.membershipId);
    expect(body.frozen.actionScope).toBe('group');
    expect(body.frozen.authorizationVersionAtEnqueue).toMatch(/^av1:/);
    expect(harness.jobQueue.jobs).toHaveLength(1);
    log(`enqueued ${body.jobId} with frozen context ${JSON.stringify(body.frozen)}`);
  });

  it('an unauthorized actor enqueues nothing at all', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: enqueuePath,
      headers: contextHeaders(
        alpha.users.member.id,
        await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          userId: alpha.users.member.id,
        }),
      ),
    });
    expect(response.statusCode).toBe(403);
    expect(harness.jobQueue.jobs).toHaveLength(0);
  });

  it('the frozen context is a COPY — mutating the caller\'s object cannot retarget the job', async () => {
    const mutable = { ...frozenContext() };
    const enqueued = await harness.jobQueue.enqueue(CONTEXT_PROBE_TOUCH_JOB, mutable, {});
    mutable.expectedGroupId = alpha.groupTwo.id;
    expect(enqueued.context.expectedGroupId).toBe(alpha.groupOne.id);
  });
});

describe('SPEC-01 §6 / SPEC-06 §5 — execution re-evaluates against current state', () => {
  const handlers = defaultJobHandlers();

  it('a job whose actor still holds the capability completes, and writes under the frozen tenant', async () => {
    const before = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);

    expect(outcome.status).toBe('completed');
    const after = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    expect(after?.getTime() ?? null).not.toBe(before?.getTime() ?? null);
    log('job completed under app_worker and wrote inside the frozen tenant');
  });

  it('"No context: the worker REFUSES the job. There is no default tenant."', async () => {
    const cases: readonly { label: string; context: FrozenJobContext }[] = [
      { label: 'no organization', context: frozenContext({ expectedOrganizationId: '' }) },
      {
        label: 'group-scoped with no group',
        context: frozenContext({ expectedGroupId: null }),
      },
      {
        label: 'no membership and not a system actor',
        context: frozenContext({ membershipId: null }),
      },
      {
        label: 'scope disagrees with the handler',
        context: frozenContext({ actionScope: 'organization', expectedGroupId: null }),
      },
    ];

    for (const { label, context } of cases) {
      const outcome = await executeJob(worker.runner, job(context), handlers);
      expect(outcome.status, `${label} was not refused`).toBe('refused_no_context');
      log(`${label}: refused_no_context`);
    }
  });

  it('a system-actor job is refused until OPUS-M1-002 defines its capability set', async () => {
    // SPEC-06 §5 gives a system actor "its own narrow capability set". That set
    // does not exist yet, and the honest behaviour is to refuse rather than to
    // invent an unbounded actor that later has to be taken away.
    const outcome = await executeJob(
      worker.runner,
      job(frozenContext({ systemActor: true, membershipId: null })),
      handlers,
    );
    expect(outcome.status).toBe('refused_no_context');
  });

  it('a job whose actor LOST the capability terminates cancelled_unauthorized, writing nothing', async () => {
    // "The enqueue-time decision is evidence of intent, never authority."
    const membershipId = alpha.users.scheduler.membershipId;
    const before = await lastActiveAt(admin, membershipId);

    await setMembershipField(membershipId, { group_role: 'member' });
    try {
      const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);
      expect(outcome.status).toBe('cancelled_unauthorized');
      const after = await lastActiveAt(admin, membershipId);
      expect(after?.getTime() ?? null, 'a de-authorized job still wrote').toBe(
        before?.getTime() ?? null,
      );
      log(`role demoted between enqueue and execution: ${outcome.status}`);
    } finally {
      await setMembershipField(membershipId, { group_role: 'scheduler' });
    }
  });

  it('a job whose membership was ENDED terminates cancelled_unauthorized', async () => {
    const membershipId = alpha.users.scheduler.membershipId;
    await setMembershipField(membershipId, { status: 'ended' });
    try {
      const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);
      expect(outcome.status).toBe('cancelled_unauthorized');
    } finally {
      await setMembershipField(membershipId, { status: 'active' });
    }
  });

  it('a job naming a membership from ANOTHER tenant is cancelled, not executed', async () => {
    // The frozen tenant is Alpha; the membership id belongs to Beta. Under RLS
    // it simply is not visible, and invisible is the same answer as revoked.
    const outcome = await executeJob(
      worker.runner,
      job(frozenContext({ membershipId: FIXTURE.beta.users.scheduler.membershipId })),
      handlers,
    );
    expect(outcome.status).toBe('cancelled_unauthorized');
  });

  it('an unregistered job kind fails explicitly rather than silently succeeding', async () => {
    const outcome = await executeJob(worker.runner, job(frozenContext(), 'no.such.job'), handlers);
    expect(outcome.status).toBe('failed');
  });
});

describe('SPEC-06 §7 — the two surfaces authorize identically', () => {
  it('the job handler and the HTTP route share ONE allow-list object, not two copies', async () => {
    // "One evaluator, every path. A surface with its own authorization logic is
    // a defect." Until the SPEC-06 evaluator lands, the closest available
    // assertion is that the two declarations are the SAME VALUE — compared
    // against the route module's exported config object, not against a literal
    // restated here. A test that restates the list keeps passing after the two
    // surfaces diverge, which is precisely what it was written to prevent.
    const { GROUP_SCOPED_CONFIG } = await import('../../src/http/routes/context-probe.route.js');

    expect(contextProbeTouchHandler.policy.capability).toBe(
      GROUP_SCOPED_CONFIG.policy.capability,
    );
    expect(contextProbeTouchHandler.policy.actionScope).toBe(GROUP_SCOPED_CONFIG.actionScope);
    expect([...contextProbeTouchHandler.policy.allowRoles].sort()).toEqual(
      [...GROUP_SCOPED_CONFIG.provisional.allowRoles].sort(),
    );

    // And the comparison is non-vacuous: both sides actually list something.
    expect(GROUP_SCOPED_CONFIG.provisional.allowRoles.length).toBeGreaterThan(0);
    log(
      `both surfaces authorize ${GROUP_SCOPED_CONFIG.policy.capability} at ${GROUP_SCOPED_CONFIG.actionScope} scope for [${GROUP_SCOPED_CONFIG.provisional.allowRoles.join(', ')}]`,
    );
  });

  it('the enqueue route the job is reached through declares that same capability', async () => {
    const { buildServer } = await import('../../src/http/server.js');
    const { app, routeTable } = await buildServer();
    try {
      const enqueueRoute = routeTable.find((entry) => entry.url.endsWith('/context-probe/enqueue'));
      expect(enqueueRoute, 'the enqueue route is not registered').toBeDefined();
      expect(enqueueRoute?.policy?.kind).toBe('capability');
      expect(
        enqueueRoute?.policy?.kind === 'capability' ? enqueueRoute.policy.capability : undefined,
      ).toBe(contextProbeTouchHandler.policy.capability);
    } finally {
      await app.close();
    }
  });
});
