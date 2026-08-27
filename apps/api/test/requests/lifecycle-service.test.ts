import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { requestStore } from '../../src/requests/store.js';
import {
  expireRequest,
  submitRequest,
  withdrawRequest,
  type RequestOutcome,
} from '../../src/requests/service.js';
import { sweepExpiredRequests } from '../../src/requests/sweeper.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The request lifecycle SERVICE — SPEC-08 §§3–4 driven end to end through the
 * production path (OPUS-M5-001, doc 42 §5c Parts B and C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What this file proves that the migration cycle does not
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `migration-0023-populated-cycle.test.ts` proves the DATABASE refuses things,
 * by issuing raw statements — because a negative proved through a service proves
 * the service refused it, not the database. This file is the other half: the
 * service's own behaviour, driven through `submitRequest`, `withdrawRequest`,
 * `expireRequest` and `sweepExpiredRequests`, which is what an HTTP route
 * actually calls.
 *
 * The two together are R-01's two layers, each proved on its own terms.
 *
 * ## Synthetic only, and every date far-future
 *
 * 2046–2047. No organization, site or person name from the research appears
 * here, and every idempotency key is the fixture's own.
 */

const multi = ownedMulti('requests-lifecycle-service', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
let membershipId: string;
let organizationAdminMembershipId: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** Unwrap an outcome that must have succeeded, with the failure in the message. */
function ok<T>(outcome: RequestOutcome<T>): T {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${JSON.stringify(outcome.failure)}`);
  }
  return outcome.value;
}

/** Set the group's §3 policy — the production columns, under tenant context. */
async function setGroupPolicy(policy: {
  mode?: 'closed' | 'fixed_date' | 'days_before_period_start';
  until?: string | null;
  leadDays?: number | null;
  rolls?: 'forward' | 'backward' | 'exact';
  late?: 'reject' | 'accept_as_late';
}): Promise<void> {
  await run(
    async ({ query }) =>
      await sql`
        update groups
           set request_until_mode = ${policy.mode ?? 'fixed_date'},
               request_until_date = ${policy.until ?? null}::date,
               request_until_lead_days = ${policy.leadDays ?? null},
               deadline_rolls = ${policy.rolls ?? 'exact'},
               late_submission_policy = ${policy.late ?? 'reject'}
         where id = ${context.groupId}::uuid
      `.execute(query),
  );
}

/** An availability submission through the service. */
async function submitAvailability(
  key: string,
  day: string,
  now: Date,
): Promise<RequestOutcome<Awaited<ReturnType<typeof submitRequest>> extends RequestOutcome<infer T> ? T : never>> {
  return run(async (uow) =>
    submitRequest(uow, {
      membershipId,
      subtype: 'availability',
      record: { subtype: 'availability', targetDate: day },
      idempotencyKey: key,
      periodStart: null,
      now,
    }),
  );
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  membershipId = alpha.users.member.membershipId;
  organizationAdminMembershipId = alpha.users.organizationAdmin.membershipId;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId,
    correlationId: 'requests-lifecycle-service',
  };

  /* The narrowing means the acting membership must hold `requests.administer`
   * to reach another member's rows — which the sweeper does. Granted through
   * the production mechanism (SPEC-06 L4.2), under an ORGANIZATION-scoped
   * context, by a DIFFERENT user, so the two-person rule on
   * `capability_grants` is satisfied rather than worked around. */
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: organizationAdminMembershipId,
      correlationId: 'requests-lifecycle-grant',
    } as never,
    async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values({
          id: randomUUID(),
          organization_id: alpha.organizationId,
          group_id: alpha.groupOne.id,
          membership_id: membershipId,
          capability_key: 'requests.administer',
          granted: true,
          granted_by_membership_id: organizationAdminMembershipId,
        })
        .execute();

      /* `setGroupPolicy` writes the group's §3 columns, and migration 0010's
       * `app_guard_group_settings_administration` gates every write to them on
       * `group.settings.administer`. The test needs it for the same reason a
       * scheduler configuring the request window would, and takes it the same
       * way. Two keys, one grant statement, one grantor. */
      await query
        .insertInto('capability_grants')
        .values({
          id: randomUUID(),
          organization_id: alpha.organizationId,
          group_id: alpha.groupOne.id,
          membership_id: membershipId,
          capability_key: 'group.settings.administer',
          granted: true,
          granted_by_membership_id: organizationAdminMembershipId,
        })
        .execute();
    },
  );
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('§3 — submission through the service, and the server-side deadline', () => {
  it('an on-time submission lands at `submitted`, NOT at `draft`', async () => {
    /* The initial-INSERT ruling from the caller's side: `draft` exists inside
     * the transaction, between two statements, and is never a state anybody
     * outside it has seen. One action, one request (I-10). */
    await setGroupPolicy({ until: '2046-12-31', rolls: 'exact' });

    const result = ok(
      await submitAvailability('svc.ontime.1', '2047-01-15', new Date('2046-06-01T09:00:00Z')),
    );

    expect(result.replayed).toBe(false);
    expect(result.isLate).toBe(false);
    expect(result.request.root.status).toBe('submitted');
    expect(result.request.root.submittedAt).not.toBeNull();
    expect(result.request.root.isLate).toBe(false);
    expect(result.request.record).toMatchObject({
      subtype: 'availability',
      targetDate: '2047-01-15',
    });
  }, 180_000);

  it('`expires_at` is SERVER-COMPUTED from the group policy, and the roll moves it', async () => {
    /* 2046-06-16 is a Saturday. Under `forward` the effective deadline is Monday
     * the 18th, so `expires_at` must fall on the 19th at 00:00 in the group's
     * zone — the END of the deadline day, so a submission at 23:59 local on the
     * 18th is inside it. Under `exact` it must fall a weekend earlier.
     *
     * The two are compared to each other rather than to a literal instant,
     * because the group's timezone is the fixture's and the point is that the
     * ROLL moved the deadline — not what UTC offset that zone happens to have. */
    await setGroupPolicy({ until: '2046-06-16', rolls: 'exact' });
    const exact = ok(
      await submitAvailability('svc.roll.exact', '2047-02-01', new Date('2046-01-05T09:00:00Z')),
    );

    await setGroupPolicy({ until: '2046-06-16', rolls: 'forward' });
    const forward = ok(
      await submitAvailability('svc.roll.forward', '2047-02-02', new Date('2046-01-05T09:00:00Z')),
    );

    await setGroupPolicy({ until: '2046-06-16', rolls: 'backward' });
    const backward = ok(
      await submitAvailability('svc.roll.backward', '2047-02-03', new Date('2046-01-05T09:00:00Z')),
    );

    const at = (r: typeof exact): number => r.request.root.expiresAt.getTime();

    /* Three configurations, three DIFFERENT instants, correctly ordered. A roll
     * implementation that quietly did nothing would make all three equal. */
    expect(at(backward)).toBeLessThan(at(exact));
    expect(at(exact)).toBeLessThan(at(forward));

    /* Two whole days between backward (Friday the 15th) and exact (Saturday the
     * 16th)? No — one. Friday→Saturday is one day; Saturday→Monday is two. */
    expect(at(exact) - at(backward)).toBe(24 * 60 * 60 * 1000);
    expect(at(forward) - at(exact)).toBe(2 * 24 * 60 * 60 * 1000);
  }, 180_000);

  it('a CLOSED window refuses the submission, and writes nothing', async () => {
    await setGroupPolicy({ mode: 'closed', until: null });

    const before = await run(async (uow) => requestStore.listForMembership(uow, membershipId));
    const outcome = await submitAvailability(
      'svc.closed.1',
      '2047-03-01',
      new Date('2046-06-01T09:00:00Z'),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toEqual({
        kind: 'deadline',
        detail: 'window-closed',
        effective: null,
      });
    }

    const after = await run(async (uow) => requestStore.listForMembership(uow, membershipId));
    expect(after.length, 'a refused submission must write no row').toBe(before.length);
  }, 180_000);

  it('a LATE submission is refused WITH the effective deadline stated (§3)', async () => {
    await setGroupPolicy({ until: '2046-06-18', rolls: 'exact', late: 'reject' });

    const outcome = await submitAvailability(
      'svc.late.reject',
      '2047-03-08',
      /* Local date 2046-06-19 in any zone this fixture uses — a full day past. */
      new Date('2046-06-19T18:00:00Z'),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('deadline');
      if (outcome.failure.kind === 'deadline') {
        expect(outcome.failure.detail).toBe('late-rejected');
        /* The date itself — §3: "Rejected with the effective deadline STATED".
         * A refusal that will not say what the deadline was is one the requester
         * cannot act on. */
        expect(outcome.failure.effective).toBe('2046-06-18');
      }
    }
  }, 180_000);

  it('the SAME submission is ACCEPTED with `is_late` under `accept_as_late`', async () => {
    /* Configured, never implicit: the only thing that changed between this case
     * and the one above is the group's policy column. */
    await setGroupPolicy({ until: '2046-06-18', rolls: 'exact', late: 'accept_as_late' });

    const result = ok(
      await submitAvailability(
        'svc.late.accept',
        '2047-03-15',
        new Date('2046-06-19T18:00:00Z'),
      ),
    );

    expect(result.isLate).toBe(true);
    expect(result.request.root.isLate).toBe(true);
    expect(result.request.root.status).toBe('submitted');
  }, 180_000);
});

describe('R-11 — duplicate submission with the same idempotency key yields ONE row', () => {
  it('the second call returns the FIRST request and writes nothing', async () => {
    await setGroupPolicy({ until: '2046-12-31', rolls: 'exact' });
    const key = 'svc.r11.same-key';

    const first = ok(await submitAvailability(key, '2047-04-05', new Date('2046-06-01T09:00:00Z')));
    expect(first.replayed).toBe(false);

    const second = ok(
      await submitAvailability(key, '2047-04-05', new Date('2046-06-01T09:05:00Z')),
    );
    expect(second.replayed, 'the second call must report itself a replay').toBe(true);
    expect(second.request.root.id, 'and must return the SAME row').toBe(first.request.root.id);

    const rows = await run(
      async ({ query }) =>
        await sql<{ n: string }>`
          select count(*)::text as n from requests
           where membership_id = ${membershipId}::uuid and idempotency_key = ${key}
        `.execute(query),
    );
    expect(Number(rows.rows[0]?.n), 'exactly one row').toBe(1);
  }, 180_000);

  it('a replay emits NO second audit event and NO second outbox row', async () => {
    /* R-11 is about the ROW, but a replay that emitted an event would make "how
     * many times did this person submit" unanswerable and would notify the
     * requester twice. Asserted directly, because it is the part a naive
     * "return the existing row" implementation gets wrong. */
    await setGroupPolicy({ until: '2046-12-31', rolls: 'exact' });
    const key = 'svc.r11.events';

    const first = ok(await submitAvailability(key, '2047-04-12', new Date('2046-06-01T09:00:00Z')));
    const requestId = first.request.root.id;

    const countEvents = async (): Promise<{ audit: number; outbox: number }> => {
      const audit = await run(
        async ({ query }) =>
          await sql<{ n: string }>`
            select count(*)::text as n from audit_events
             where subject_type = 'request' and subject_id = ${requestId}::uuid
          `.execute(query),
      );
      const outbox = await run(
        async ({ query }) =>
          await sql<{ n: string }>`
            select count(*)::text as n from outbox_events
             where idempotency_key = ${`request-submitted:${requestId}`}
          `.execute(query),
      );
      return {
        audit: Number(audit.rows[0]?.n ?? '0'),
        outbox: Number(outbox.rows[0]?.n ?? '0'),
      };
    };

    const afterFirst = await countEvents();
    expect(afterFirst).toEqual({ audit: 1, outbox: 1 });

    await submitAvailability(key, '2047-04-12', new Date('2046-06-01T09:05:00Z'));
    expect(await countEvents(), 'a replay adds nothing').toEqual(afterFirst);
  }, 180_000);
});

describe('R-22 / R-10 — withdrawal through the service', () => {
  /** Submit, then walk the row to `status` with raw statements. */
  async function submittedAt(key: string, day: string, status: string): Promise<string> {
    await setGroupPolicy({ until: '2046-12-31', rolls: 'exact' });
    const result = ok(await submitAvailability(key, day, new Date('2046-06-01T09:00:00Z')));
    const id = result.request.root.id;
    if (status === 'submitted') return id;

    await run(async ({ query }) => {
      /* **These paths are AVAILABILITY's, and the distinction is §2's not a
       * detail.** An availability reaches `consumed_by_build` from `approved`
       * — through review — whereas `accepted_as_input → consumed_by_build` is
       * `shift-preference`'s edge ALONE, because nobody approves a non-binding
       * preference. The first draft of this helper used the shift-preference
       * path for an availability and the transition guard refused it, which is
       * the matrix doing its job on the test rather than on the code. */
      const path: Record<string, readonly string[]> = {
        accepted_as_input: ['accepted_as_input'],
        consumed_by_build: ['under_review', 'approved', 'consumed_by_build'],
        reflected_in_version: [
          'under_review',
          'approved',
          'consumed_by_build',
          'reflected_in_version',
        ],
      };
      for (const step of path[status] ?? []) {
        await sql`update requests set status = ${step} where id = ${id}::uuid`.execute(query);
      }
    });
    return id;
  }

  async function versionOf(requestId: string): Promise<number> {
    const root = await run(async (uow) => requestStore.loadRoot(uow, requestId));
    if (root === null) throw new Error('the request vanished');
    return root.version;
  }

  it('R-22: withdrawal SUCCEEDS from `accepted_as_input`', async () => {
    const id = await submittedAt('svc.r22.before', '2047-05-03', 'accepted_as_input');
    const result = ok(
      await run(async (uow) =>
        withdrawRequest(uow, {
          requestId: id,
          expectedVersion: await versionOf(id),
          /* OPUS-M5-003: §4's requester-initiated-only rule is decided on the
           * ACTING membership, so the service takes it. These cases are the
           * OWNER's own withdrawals and pass their own membership; the refusal
           * for a colleague's row is proven over HTTP in
           * `own-write-ownership.test.ts`. */
          membershipId,
          now: new Date('2046-06-02T09:00:00Z'),
        }),
      ),
    );
    expect(result.revisionRequested).toBe(false);

    const root = await run(async (uow) => requestStore.loadRoot(uow, id));
    expect(root?.status).toBe('withdrawn');
    expect(root?.withdrawnAt).not.toBeNull();
    expect(root?.revisionRequested).toBe(false);
  }, 180_000);

  it('R-22: withdrawal is REFUSED after `consumed_by_build`, by the DOMAIN', async () => {
    /* The refusal must come from the domain layer with a status the caller can
     * branch on — not from the database as an opaque `restrict_violation`.
     * That is the whole reason R-01 asks for two layers rather than one. */
    const id = await submittedAt('svc.r22.after', '2047-05-10', 'consumed_by_build');
    const outcome = await run(async (uow) =>
      withdrawRequest(uow, {
        requestId: id,
        expectedVersion: await versionOf(id),
        /* OPUS-M5-003: §4's requester-initiated-only rule is decided on the
         * ACTING membership, so the service takes it. These cases are the
         * OWNER's own withdrawals and pass their own membership; the refusal
         * for a colleague's row is proven over HTTP in
         * `own-write-ownership.test.ts`. */
        membershipId,
        now: new Date('2046-06-02T09:00:00Z'),
      }),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('illegal-operation');
      if (outcome.failure.kind === 'illegal-operation') {
        expect(outcome.failure.status).toBe('consumed_by_build');
      }
    }

    const root = await run(async (uow) => requestStore.loadRoot(uow, id));
    expect(root?.status, 'a refused withdrawal must not move the row').toBe('consumed_by_build');
  }, 180_000);

  it('R-10: withdrawal after `reflected_in_version` raises a revision request', async () => {
    const id = await submittedAt('svc.r10', '2047-05-17', 'reflected_in_version');

    const result = ok(
      await run(async (uow) =>
        withdrawRequest(uow, {
          requestId: id,
          expectedVersion: await versionOf(id),
          /* OPUS-M5-003: §4's requester-initiated-only rule is decided on the
           * ACTING membership, so the service takes it. These cases are the
           * OWNER's own withdrawals and pass their own membership; the refusal
           * for a colleague's row is proven over HTTP in
           * `own-write-ownership.test.ts`. */
          membershipId,
          now: new Date('2046-06-02T09:00:00Z'),
        }),
      ),
    );

    expect(result.revisionRequested, 'R-10 must request a revision').toBe(true);

    const root = await run(async (uow) => requestStore.loadRoot(uow, id));
    expect(root?.status).toBe('withdrawn');
    expect(root?.revisionRequested).toBe(true);

    /* The EVENT — its own audit name and its own outbox kind, so "which
     * published schedules have outstanding revision requests" is a query rather
     * than a payload scan. */
    const audit = await run(
      async ({ query }) =>
        await sql<{ event_name: string }>`
          select event_name from audit_events
           where subject_type = 'request' and subject_id = ${id}::uuid
           order by sequence
        `.execute(query),
    );
    expect(audit.rows.map((r) => r.event_name)).toEqual([
      'requests.request.submitted',
      'requests.request.withdrawn',
      'requests.request.revision_requested',
    ]);

    const outbox = await run(
      async ({ query }) =>
        await sql<{ kind: string }>`
          select kind from outbox_events
           where idempotency_key like ${`schedule-revision-requested:${id}:%`}
        `.execute(query),
    );
    expect(outbox.rows.map((r) => r.kind)).toEqual(['schedule.revision_requested']);
  }, 180_000);

  it('R-10: the PUBLISHED VERSION is untouched — no schedule row is written', async () => {
    /* I-18: a published version is immutable in the database. The service issues
     * no statement against `schedule_versions` at all, and this asserts the
     * consequence rather than the intention: the version census is byte-identical
     * across the withdrawal. */
    const id = await submittedAt('svc.r10.untouched', '2047-05-24', 'reflected_in_version');

    const versionCensus = async (): Promise<string> => {
      const rows = await run(
        async ({ query }) =>
          await sql<{ digest: string }>`
            select coalesce(md5(string_agg(id::text || ':' || state || ':' ||
                                           coalesce(version_number::text, '-'), ',' order by id)), 'empty')
                   as digest
              from schedule_versions
          `.execute(query),
      );
      return rows.rows[0]?.digest ?? 'empty';
    };

    const before = await versionCensus();
    ok(
      await run(async (uow) =>
        withdrawRequest(uow, {
          requestId: id,
          expectedVersion: await versionOf(id),
          /* OPUS-M5-003: §4's requester-initiated-only rule is decided on the
           * ACTING membership, so the service takes it. These cases are the
           * OWNER's own withdrawals and pass their own membership; the refusal
           * for a colleague's row is proven over HTTP in
           * `own-write-ownership.test.ts`. */
          membershipId,
          now: new Date('2046-06-02T09:00:00Z'),
        }),
      ),
    );
    expect(await versionCensus(), 'the published version must be unchanged').toBe(before);
  }, 180_000);

  it('a STALE `expectedVersion` is a CONFLICT, never a silent overwrite (§4)', async () => {
    const id = await submittedAt('svc.conflict', '2047-05-31', 'submitted');
    const current = await versionOf(id);

    const outcome = await run(async (uow) =>
      withdrawRequest(uow, {
        requestId: id,
        expectedVersion: current - 1,
        /* OPUS-M5-003: §4's requester-initiated-only rule is decided on the
         * ACTING membership, so the service takes it. These cases are the
         * OWNER's own withdrawals and pass their own membership; the refusal
         * for a colleague's row is proven over HTTP in
         * `own-write-ownership.test.ts`. */
        membershipId,
        now: new Date('2046-06-02T09:00:00Z'),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('conflict');

    const root = await run(async (uow) => requestStore.loadRoot(uow, id));
    expect(root?.status).toBe('submitted');
  }, 180_000);

  it('a request in ANOTHER member\'s name is NOT FOUND, not refused', async () => {
    /* The narrowing, from the service's side: an id that exists but belongs to
     * somebody else and an id that names nothing are the same answer. */
    const outcome = await run(async (uow) =>
      withdrawRequest(uow, {
        requestId: randomUUID(),
        expectedVersion: 1,
        /* OPUS-M5-003: §4's requester-initiated-only rule is decided on the
         * ACTING membership, so the service takes it. These cases are the
         * OWNER's own withdrawals and pass their own membership; the refusal
         * for a colleague's row is proven over HTTP in
         * `own-write-ownership.test.ts`. */
        membershipId,
        now: new Date('2046-06-02T09:00:00Z'),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe('not-found');
  }, 120_000);
});

describe('§3 — the expiry sweeper (R-23\'s domain half)', () => {
  it('moves an undecided past-deadline request to `expired`, audited and notified', async () => {
    await setGroupPolicy({ until: '2046-06-18', rolls: 'exact', late: 'accept_as_late' });
    const submitted = ok(
      await submitAvailability('svc.sweep.1', '2047-06-07', new Date('2046-06-01T09:00:00Z')),
    );
    const id = submitted.request.root.id;

    /* Sweep at an instant past the deadline the SERVER computed. */
    const result = await run(async (uow) =>
      sweepExpiredRequests(uow, new Date('2046-07-01T00:00:00Z')),
    );

    expect(result.refused, 'no claimed row may be refused').toBe(0);
    expect(result.expired.map((e) => e.requestId)).toContain(id);

    const root = await run(async (uow) => requestStore.loadRoot(uow, id));
    expect(root?.status).toBe('expired');

    const audit = await run(
      async ({ query }) =>
        await sql<{ event_name: string }>`
          select event_name from audit_events
           where subject_type = 'request' and subject_id = ${id}::uuid
           order by sequence
        `.execute(query),
    );
    expect(audit.rows.map((r) => r.event_name)).toContain('requests.request.expired');

    /* The requester is notified through the OUTBOX — in the same transaction as
     * the status change (I-11: a notification failure never rolls back a domain
     * change; delivery happens afterwards, from a dispatcher that cannot reach
     * back into this transaction). */
    const outbox = await run(
      async ({ query }) =>
        await sql<{ kind: string }>`
          select kind from outbox_events where idempotency_key = ${`request-expired:${id}`}
        `.execute(query),
    );
    expect(outbox.rows.map((r) => r.kind)).toEqual(['requests.request.expired']);
  }, 180_000);

  it('does NOT touch a request whose deadline has not passed', async () => {
    await setGroupPolicy({ until: '2046-12-31', rolls: 'exact' });
    const live = ok(
      await submitAvailability('svc.sweep.live', '2047-06-14', new Date('2046-06-01T09:00:00Z')),
    );

    const result = await run(async (uow) =>
      sweepExpiredRequests(uow, new Date('2046-07-01T00:00:00Z')),
    );
    expect(result.expired.map((e) => e.requestId)).not.toContain(live.request.root.id);

    const root = await run(async (uow) => requestStore.loadRoot(uow, live.request.root.id));
    expect(root?.status).toBe('submitted');
  }, 180_000);

  it('R-23: a DECIDED request past its deadline is never expired', async () => {
    /* The sweeper's claim query names the three undecided statuses, and
     * `expireRequest` re-asks the domain matrix before writing. This drives the
     * second control directly: a row in `approved` handed to `expireRequest` is
     * refused rather than expired, so a drifted claim query could not expire a
     * decision. */
    await setGroupPolicy({ until: '2046-06-18', rolls: 'exact', late: 'accept_as_late' });
    const submitted = ok(
      await submitAvailability('svc.sweep.decided', '2047-06-21', new Date('2046-06-01T09:00:00Z')),
    );
    const id = submitted.request.root.id;

    await run(async ({ query }) => {
      await sql`update requests set status = 'under_review' where id = ${id}::uuid`.execute(query);
      await sql`update requests set status = 'approved' where id = ${id}::uuid`.execute(query);
    });

    const root = await run(async (uow) => requestStore.loadRoot(uow, id));
    if (root === null) throw new Error('the request vanished');

    const outcome = await run(async (uow) =>
      expireRequest(uow, root, new Date('2046-07-01T00:00:00Z')),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe('illegal-operation');
      if (outcome.failure.kind === 'illegal-operation') {
        expect(outcome.failure.status).toBe('approved');
      }
    }

    const after = await run(async (uow) => requestStore.loadRoot(uow, id));
    expect(after?.status, 'an approved request must survive the sweep').toBe('approved');

    /* …and the sweeper does not claim it either. Both controls, separately. */
    const swept = await run(async (uow) =>
      sweepExpiredRequests(uow, new Date('2046-07-01T00:00:00Z')),
    );
    expect(swept.expired.map((e) => e.requestId)).not.toContain(id);
  }, 180_000);

  it('a second sweep is a no-op — the first already moved everything it claimed', async () => {
    const first = await run(async (uow) =>
      sweepExpiredRequests(uow, new Date('2046-07-01T00:00:00Z')),
    );
    const second = await run(async (uow) =>
      sweepExpiredRequests(uow, new Date('2046-07-01T00:00:00Z')),
    );
    expect(second.claimed, 'nothing left to claim').toBe(0);
    expect(second.expired).toEqual([]);
    expect(first.refused).toBe(0);
    expect(second.refused).toBe(0);
  }, 180_000);
});
