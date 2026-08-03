import { randomUUID } from 'node:crypto';

import type { EnqueuedJob, FrozenJobContext } from '@schedulepoint/domain';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defaultJobHandlers, contextProbeTouchHandler, CONTEXT_PROBE_TOUCH_JOB } from '../../src/jobs/handlers.js';
import { executeJob } from '../../src/jobs/worker.js';
import { adminClient } from '../support/admin-client.js';

import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  lastActiveAt,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant.
 *
 * It used to write to the shared MULTI baseline, which every other file also read.
 * NR-13 measured what that cost: six order-dependent tests across five files, and
 * eleven of twenty-four files modifying rows the shared seed created. The fixture
 * below has the same shape and fresh identifiers, and RLS — not agreement — is what
 * keeps it out of everybody else's queries.
 */
const multi = ownedMulti('jobs-job-context');


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

/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const alpha = () => multi().alpha;
const enqueuePath = () => `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/context-probe/enqueue`;

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
  // As the organization administrator: since OPUS-M1-002 a privilege-bearing
  // membership change with no acting membership is refused at the database
  // (EV-M1-TENANCY residual 4's control).
  await harness.runtime.runner.run(
    multi.administrator(alpha().organizationId, 'job-context-role-change'),
    async ({ query }) => {
      await query
        .updateTable('memberships')
        .set(values)
        .where('id', '=', membershipId)
        .execute();
    },
  );
}

/**
 * The administrative writes the OPUS-M1-004 cases need, all through a unit of
 * work under the organization administrator.
 *
 * Not through the superuser: since OPUS-M1-002 these tables are guarded by
 * `app_require_capability`, and a test that reached around that guard would be
 * proving the evaluator against a state the product cannot actually reach.
 */
async function asAdministrator<T>(
  fn: (query: Parameters<Parameters<HttpHarness['runtime']['runner']['run']>[1]>[0]['query']) => Promise<T>,
): Promise<T> {
  return harness.runtime.runner.run(
    multi.administrator(alpha().organizationId, 'job-context-admin'),
    async ({ query }) => fn(query),
  );
}

async function setEntitlementState(
  moduleKey: string,
  state: 'trial' | 'active' | 'suspended' | 'revoked',
): Promise<void> {
  await asAdministrator(async (query) => {
    await query
      .updateTable('entitlements')
      .set({ state })
      .where('organization_id', '=', alpha().organizationId)
      .where('module_key', '=', moduleKey)
      .execute();
  });
}

async function setModuleAvailability(
  groupId: string,
  moduleKey: string,
  available: boolean,
): Promise<void> {
  await asAdministrator(async (query) => {
    await query
      .updateTable('group_module_availability')
      .set({ available })
      .where('organization_id', '=', alpha().organizationId)
      .where('group_id', '=', groupId)
      .where('module_key', '=', moduleKey)
      .execute();
  });
}

/** An explicit DENY (SPEC-06 P-1) on a membership, returning the row's id. */
async function writeDenyGrant(
  membershipId: string,
  groupId: string,
  capabilityKey: string,
): Promise<string> {
  const id = randomUUID();
  await asAdministrator(async (query) => {
    await query
      .insertInto('capability_grants')
      .values({
        id,
        organization_id: alpha().organizationId,
        group_id: groupId,
        membership_id: membershipId,
        capability_key: capabilityKey,
        granted: false,
        granted_by_membership_id: alpha().users.organizationAdmin.membershipId,
      })
      .execute();
  });
  return id;
}

async function removeGrant(id: string): Promise<void> {
  // No runtime role holds DELETE on `capability_grants`, so the grant is CLOSED
  // rather than removed — which is also what the product would do (PO-DEC-04:
  // disabling never deletes data).
  //
  // BOTH bounds move. `capability_grants_window` is `valid_to > valid_from`, and
  // `valid_from` defaulted to the insert's `now()`, so closing the window means
  // moving the whole window into the past rather than only its upper bound.
  const from = new Date(Date.now() - 2000);
  const to = new Date(Date.now() - 1000);
  await asAdministrator(async (query) => {
    await query
      .updateTable('capability_grants')
      .set({ valid_from: from, valid_to: to })
      .where('id', '=', id)
      .execute();
  });
}

function frozenContext(overrides: Partial<FrozenJobContext> = {}): FrozenJobContext {
  return {
    actionScope: 'group',
    expectedOrganizationId: alpha().organizationId,
    expectedGroupId: alpha().groupOne.id,
    membershipId: alpha().users.scheduler.membershipId,
    principalUserId: alpha().users.scheduler.id,
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
      url: enqueuePath(),
      headers: contextHeaders(
        alpha().users.scheduler.id,
        await currentCounters(admin, {
          organizationId: alpha().organizationId,
          groupId: alpha().groupOne.id,
          userId: alpha().users.scheduler.id,
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
    expect(body.frozen.organizationId).toBe(alpha().organizationId);
    expect(body.frozen.groupId).toBe(alpha().groupOne.id);
    expect(body.frozen.membershipId).toBe(alpha().users.scheduler.membershipId);
    expect(body.frozen.actionScope).toBe('group');
    expect(body.frozen.authorizationVersionAtEnqueue).toMatch(/^av1:/);
    expect(harness.jobQueue.jobs).toHaveLength(1);
    log(`enqueued ${body.jobId} with frozen context ${JSON.stringify(body.frozen)}`);
  });

  it('an unauthorized actor enqueues nothing at all', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: enqueuePath(),
      headers: contextHeaders(
        alpha().users.member.id,
        await currentCounters(admin, {
          organizationId: alpha().organizationId,
          groupId: alpha().groupOne.id,
          userId: alpha().users.member.id,
        }),
      ),
    });
    expect(response.statusCode).toBe(403);
    expect(harness.jobQueue.jobs).toHaveLength(0);
  });

  it('the frozen context is a COPY — mutating the caller\'s object cannot retarget the job', async () => {
    const mutable = { ...frozenContext() };
    const enqueued = await harness.jobQueue.enqueue(CONTEXT_PROBE_TOUCH_JOB, mutable, {});
    mutable.expectedGroupId = alpha().groupTwo.id;
    expect(enqueued.context.expectedGroupId).toBe(alpha().groupOne.id);
  });
});

describe('SPEC-01 §6 / SPEC-06 §5 — execution re-evaluates against current state', () => {
  const handlers = defaultJobHandlers();

  it('a job whose actor still holds the capability completes, and writes under the frozen tenant', async () => {
    const before = await lastActiveAt(admin, alpha().users.scheduler.membershipId);
    const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);

    expect(outcome.status).toBe('completed');
    const after = await lastActiveAt(admin, alpha().users.scheduler.membershipId);
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
    const membershipId = alpha().users.scheduler.membershipId;
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
    const membershipId = alpha().users.scheduler.membershipId;
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
      job(frozenContext({ membershipId: multi().beta.users.scheduler.membershipId })),
      handlers,
    );
    expect(outcome.status).toBe('cancelled_unauthorized');
  });

  it('an unregistered job kind fails explicitly rather than silently succeeding', async () => {
    const outcome = await executeJob(worker.runner, job(frozenContext(), 'no.such.job'), handlers);
    expect(outcome.status).toBe('failed');
  });
});

describe('SPEC-06 §7 — one evaluator, every path', () => {
  /**
   * **The two surfaces now DO share one evaluator, and this is what says so.**
   *
   * OPUS-M1-002 replaced the HTTP surface's role allow-list with SPEC-06's truth
   * table but could not touch `apps/api/src/jobs/**`, which was OPUS-M1-003's
   * parallel file scope — so the job surface kept OPUS-M1-001's allow-list and
   * SPEC-06 §7's "One evaluator, every path. A surface with its own
   * authorization logic is a defect" was **not** satisfied. FAD-13 item 1 issued
   * this integration task to close it.
   *
   * The test that stood here compared the worker's allow-list against the
   * catalogue, which was the strongest thing available while two evaluators
   * existed. It is replaced rather than deleted: the declaration is now compared
   * against the ROUTE's own object, and the dimensions the allow-list could not
   * see are exercised below.
   */
  it('the job handler declares the SAME SPEC-06 action object the HTTP route declares', async () => {
    const { GROUP_SCOPED_CONFIG } = await import('../../src/http/routes/context-probe.route.js');

    expect(contextProbeTouchHandler.policy.capability).toBe(GROUP_SCOPED_CONFIG.policy.capability);
    expect(contextProbeTouchHandler.policy.actionScope).toBe(GROUP_SCOPED_CONFIG.actionScope);
    // Compared against the route's object, not against a copy of its contents:
    // a test that restates the declaration keeps passing after the two diverge.
    expect(contextProbeTouchHandler.policy.action).toEqual(GROUP_SCOPED_CONFIG.action);

    // And the declaration names something the catalogue knows, or the evaluator
    // would deny at L4 for a reason that looks like a permissions problem.
    const { capabilityDefinition } = await import('@schedulepoint/domain');
    const definition = capabilityDefinition(contextProbeTouchHandler.policy.action.key);
    expect(definition, 'the job action is not in the capability catalogue').toBeDefined();
    expect(definition?.scope).toBe(contextProbeTouchHandler.policy.actionScope);

    log(
      `both surfaces evaluate ${contextProbeTouchHandler.policy.action.key} through ` +
        'packages/domain/src/authz — one truth table, one loader, one transaction',
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

describe('the dimensions the worker could NOT see before OPUS-M1-004 (SPEC-06 A-07)', () => {
  const handlers = defaultJobHandlers();

  /**
   * Each of these three would have COMPLETED under the role allow-list.
   *
   * The allow-list read `memberships.group_role` and nothing else, so an
   * entitlement revoked after enqueue, a module withdrawn from the group, or an
   * explicit deny grant written against the actor were all invisible to it. They
   * are the reason FAD-13 called the gap "a real gap, not a cosmetic one".
   */
  it('L1: an entitlement revoked between enqueue and execution cancels the job', async () => {
    const before = await lastActiveAt(admin, alpha().users.scheduler.membershipId);
    await setEntitlementState('core_scheduling', 'revoked');
    try {
      const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);
      expect(outcome.status, 'a revoked module still ran its queued job').toBe(
        'cancelled_unauthorized',
      );
      expect(await lastActiveAt(admin, alpha().users.scheduler.membershipId)).toStrictEqual(before);
      log(`entitlement revoked after enqueue: ${outcome.status}`);
    } finally {
      await setEntitlementState('core_scheduling', 'active');
    }
  });

  it('L2: the module made unavailable in the group cancels the job', async () => {
    const before = await lastActiveAt(admin, alpha().users.scheduler.membershipId);
    await setModuleAvailability(alpha().groupOne.id, 'core_scheduling', false);
    try {
      const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);
      expect(outcome.status).toBe('cancelled_unauthorized');
      expect(await lastActiveAt(admin, alpha().users.scheduler.membershipId)).toStrictEqual(before);
      log(`module availability withdrawn after enqueue: ${outcome.status}`);
    } finally {
      await setModuleAvailability(alpha().groupOne.id, 'core_scheduling', true);
    }
  });

  it('L4: an explicit DENY grant on the actor cancels the job (P-1)', async () => {
    const before = await lastActiveAt(admin, alpha().users.scheduler.membershipId);
    const grantId = await writeDenyGrant(
      alpha().users.scheduler.membershipId,
      alpha().groupOne.id,
      'membership.touch_self',
    );
    try {
      const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);
      expect(outcome.status, 'an explicit deny grant did not reach the job surface').toBe(
        'cancelled_unauthorized',
      );
      expect(await lastActiveAt(admin, alpha().users.scheduler.membershipId)).toStrictEqual(before);
      log(`explicit deny grant: ${outcome.status}`);
    } finally {
      await removeGrant(grantId);
    }
  });

  it('a frozen context whose principal no longer matches the membership is cancelled', async () => {
    // The frozen principal is a real control rather than bookkeeping: it is what
    // the evaluator's L3 cross-check compares the membership row against.
    const outcome = await executeJob(
      worker.runner,
      job(frozenContext({ principalUserId: alpha().users.member.id })),
      handlers,
    );
    expect(outcome.status).toBe('cancelled_unauthorized');
  });

  it('a frozen context with NO principal is refused, not evaluated without the check', async () => {
    const outcome = await executeJob(
      worker.runner,
      job(frozenContext({ principalUserId: null })),
      handlers,
    );
    expect(outcome.status).toBe('refused_no_context');
  });

  it('S-21: an INFINITE validity bound cancels the job instead of crashing the worker', async () => {
    // `timestamptz` accepts `infinity`; node-postgres returns it as the JavaScript
    // number `Infinity`, and `Infinity.toISOString` does not exist. Before the
    // guard, `executeJob` threw a `TypeError` here — a job that neither completed
    // nor reached a terminal state, which is exactly what SPEC-06 §5 forbids.
    //
    // ## Why this test drops a constraint, and why that is the honest repro
    //
    // `0002_authorization.sql` added `memberships_finite_window`, so this row
    // CANNOT be written any more. The guard exists for rows written **before**
    // that constraint did, and the only way to produce one is to put the schema
    // briefly back into the state those rows were written in. The constraint is
    // dropped and re-added by the SUPERUSER, around a write made through a
    // genuine administrator unit of work (the administration trigger is NOT
    // touched — the write is legitimate, only the bound is impossible).
    //
    // Re-adding the constraint at the end is a second assertion: `ADD CONSTRAINT`
    // validates every existing row, so it fails if the repair did not land or if
    // any other infinite bound leaked out of this test.
    const membershipId = alpha().users.scheduler.membershipId;
    await admin.query('alter table memberships drop constraint memberships_finite_window');
    try {
      await asAdministrator(async (query) => {
        await sql`update memberships set valid_to = 'infinity'::timestamptz
                   where id = ${membershipId}::uuid`.execute(query);
      });

      const outcome = await executeJob(worker.runner, job(frozenContext()), handlers);
      expect(outcome.status, 'an infinite bound must not crash the worker').toBe(
        'cancelled_unauthorized',
      );
      log(`membership with valid_to = infinity: ${outcome.status}, no TypeError`);
    } finally {
      await asAdministrator(async (query) => {
        await query
          .updateTable('memberships')
          .set({ valid_to: null })
          .where('id', '=', membershipId)
          .execute();
      });
      await admin.query(
        `alter table memberships add constraint memberships_finite_window check (
             valid_from > '-infinity'::timestamptz and valid_from < 'infinity'::timestamptz
         and (valid_to is null
              or (valid_to > '-infinity'::timestamptz and valid_to < 'infinity'::timestamptz)))`,
      );
    }
  });
});
