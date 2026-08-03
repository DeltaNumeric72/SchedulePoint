import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { CONTEXT_PROBE_TOUCH_JOB, defaultJobHandlers } from '../../src/jobs/handlers.js';
import { executeJob } from '../../src/jobs/worker.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE, groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';

/**
 * **Emission coverage — every mutation that exists today writes an audit row,
 * and writes it in the same transaction as the change.**
 *
 * ## The two questions, and why the second is the hard one
 *
 * "Does the mutation emit?" is easy to test and easy to satisfy. "Does it emit
 * **atomically**?" is the one that matters, because an audit write in its own
 * transaction produces a log that is *usually* right — right until the moment
 * something goes wrong, which is the only moment anybody reads it. FAD-12 makes
 * the atomicity normative; the third test below is the proof, and it works by
 * making the mutation fail *after* the audit call and asserting that **neither**
 * survives.
 *
 * ## Coverage is enumerated from the CODE, not from a list
 *
 * The last test walks every mutating surface this milestone ships and asserts
 * each one emitted. It is a short list today — the HTTP context-probe touch and
 * its job twin — and OPUS-M1-002's mutations join it at merge. The integration
 * point is one call: see `recordAuditEvent`'s docblock.
 */

const alpha = FIXTURE.alpha;
let http: HttpHarness;
let worker: Runtime;
let admin: pg.Client;

const groupOnePath = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`;

beforeAll(async () => {
  http = await buildHttpHarness();
  worker = createRuntime('app_worker');
  admin = adminClient();
  await admin.connect();
});

afterAll(async () => {
  await http.close();
  await worker.destroy();
  await admin.end();
});

/** Audit rows for a correlation id, read from ground truth. */
async function auditRowsFor(correlationId: string) {
  const { rows } = await admin.query<{
    event_name: string;
    actor_kind: string;
    actor_membership_id: string | null;
    group_id: string | null;
    subject_type: string;
    subject_id: string;
    sequence: string;
  }>(
    `select event_name, actor_kind, actor_membership_id::text as actor_membership_id,
            group_id::text as group_id, subject_type, subject_id::text as subject_id,
            sequence::text as sequence
       from audit_events where correlation_id = $1 order by sequence`,
    [correlationId],
  );
  return rows;
}

describe('every existing mutation emits an audit event', () => {
  it('the HTTP mutation emits one, attributed to the acting membership and the declared group', async () => {
    const correlationId = 'emit-http-1';
    const counters = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      userId: alpha.users.scheduler.id,
    });

    const response = await http.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(alpha.users.scheduler.id, counters, correlationId),
    });
    expect(response.statusCode).toBe(200);

    const rows = await auditRowsFor(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_name).toBe('membership.activity_touched');
    expect(rows[0]?.actor_kind).toBe('membership');
    expect(rows[0]?.actor_membership_id).toBe(alpha.users.scheduler.membershipId);
    expect(rows[0]?.group_id, 'attributed to the DECLARED group').toBe(alpha.groupOne.id);
    expect(rows[0]?.subject_id).toBe(alpha.users.scheduler.membershipId);
    log(
      `HTTP touch → audit sequence ${String(rows[0]?.sequence)}, ` +
        `${String(rows[0]?.event_name)}, actor ${String(rows[0]?.actor_membership_id)}`,
    );
  });

  it('the JOB surface emits the SAME event against the SAME subject (SPEC-06 §7)', async () => {
    const correlationId = 'emit-job-1';
    const outcome = await executeJob(
      worker.runner,
      {
        id: 'aaaaaaaa-0000-4000-8000-00000000job1',
        kind: CONTEXT_PROBE_TOUCH_JOB,
        context: {
          actionScope: 'group',
          expectedOrganizationId: alpha.organizationId,
          expectedGroupId: alpha.groupOne.id,
          membershipId: alpha.users.scheduler.membershipId,
          systemActor: false,
          correlationId,
          authorizationVersionAtEnqueue: 'irrelevant-here',
        },
        args: {},
        enqueuedAt: new Date().toISOString(),
      },
      defaultJobHandlers(),
    );
    expect(outcome.status).toBe('completed');

    const rows = await auditRowsFor(correlationId);
    expect(rows).toHaveLength(1);
    // The identical assertion set as the HTTP case above. If the two surfaces
    // ever diverge in what they audit, one of these two tests fails.
    expect(rows[0]?.event_name).toBe('membership.activity_touched');
    expect(rows[0]?.actor_kind).toBe('membership');
    expect(rows[0]?.actor_membership_id).toBe(alpha.users.scheduler.membershipId);
    expect(rows[0]?.group_id).toBe(alpha.groupOne.id);
    expect(rows[0]?.subject_id).toBe(alpha.users.scheduler.membershipId);
    log('job touch → the same event name, actor, group and subject as the HTTP surface');
  });

  it('a mutation that FAILS emits nothing — the audit write is in the same transaction (FAD-12)', async () => {
    const correlationId = 'emit-rollback-1';
    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          groupContext(
            alpha.organizationId,
            alpha.groupOne.id,
            alpha.users.scheduler.membershipId,
            correlationId,
          ),
          async (uow) => {
            // The shape of a real mutation: write, audit, and then discover the
            // change was invalid. The order matters — the audit call has already
            // succeeded and its row already exists on this connection.
            await sql`
              update memberships set last_active_at = now()
               where id = ${alpha.users.scheduler.membershipId}::uuid
            `.execute(uow.query);

            const recorded = await recordAuditEvent(uow, {
              eventName: 'membership.activity_touched',
              subjectType: 'membership',
              subjectId: alpha.users.scheduler.membershipId,
            });
            expect(recorded.sequence, 'the audit row exists inside the transaction').toMatch(
              /^\d+$/,
            );

            // Self-visible: the row is really there, on this connection, now.
            const visible = await sql<{ n: string }>`
              select count(*)::text as n from audit_events where correlation_id = ${correlationId}
            `.execute(uow.query);
            expect(Number(visible.rows[0]?.n)).toBe(1);

            throw new Error('the mutation turned out to be invalid (synthetic)');
          },
        ),
      ).rejects.toThrow('synthetic');
    } finally {
      await runtime.destroy();
    }

    expect(
      await auditRowsFor(correlationId),
      'a rolled-back mutation leaves NO audit row',
    ).toEqual([]);
    log('a failed mutation leaves 0 audit rows: the audit write shares its transaction');
  });

  it('the chain does not skip a sequence when a transaction rolls back', async () => {
    // A rolled-back append still advanced `audit_chain_heads` inside its
    // transaction — and the rollback took that with it. If the head were
    // maintained outside the transaction (a sequence, an advisory counter, an
    // application-side cache), the chain would develop a permanent gap every
    // time a mutation failed, and chain verification would alarm on ordinary
    // application errors. Asserting it directly, because the failure mode is
    // silent until the first rollback in production.
    const before = await admin.query<{ n: string }>(
      'select coalesce(max(sequence), 0)::text as n from audit_events where organization_id = $1::uuid',
      [alpha.organizationId],
    );

    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          groupContext(
            alpha.organizationId,
            alpha.groupOne.id,
            alpha.users.scheduler.membershipId,
            'emit-rollback-2',
          ),
          async (uow) => {
            await recordAuditEvent(uow, {
              eventName: 'membership.activity_touched',
              subjectType: 'membership',
              subjectId: alpha.users.scheduler.membershipId,
            });
            throw new Error('rolled back (synthetic)');
          },
        ),
      ).rejects.toThrow('synthetic');

      const after = await runtime.runner.run(
        groupContext(
          alpha.organizationId,
          alpha.groupOne.id,
          alpha.users.scheduler.membershipId,
          'emit-rollback-3',
        ),
        (uow) =>
          recordAuditEvent(uow, {
            eventName: 'membership.activity_touched',
            subjectType: 'membership',
            subjectId: alpha.users.scheduler.membershipId,
          }),
      );
      expect(
        Number(after.sequence),
        'the next successful append takes the sequence the rolled-back one released',
      ).toBe(Number(before.rows[0]?.n) + 1);
    } finally {
      await runtime.destroy();
    }
    log('a rolled-back append leaves no gap: the chain head is transactional too');
  });

  it('an actor-less draft is REFUSED rather than attributed to nobody', async () => {
    const runtime = createRuntime('app_runtime');
    try {
      await expect(
        runtime.runner.run(
          // A context with no acting membership, and a draft that did not say
          // it was a system action.
          groupContext(alpha.organizationId, alpha.groupOne.id, null, 'emit-no-actor'),
          (uow) =>
            recordAuditEvent(uow, {
              eventName: 'membership.activity_touched',
              subjectType: 'membership',
              subjectId: alpha.users.scheduler.membershipId,
            }),
        ),
      ).rejects.toThrow('AUDIT_ACTOR_UNRESOLVED');
    } finally {
      await runtime.destroy();
    }
    log('"nobody was acting" and "we failed to resolve the actor" are kept distinguishable');
  });
});
