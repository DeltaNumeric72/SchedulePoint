import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { dispatchOutboxEvent } from '../../src/outbox/dispatcher.js';
import { AlwaysFailingSink } from '../../src/outbox/sink.js';
import { publishVersion } from '../../src/schedule/publication.js';
import { ScheduleDeniedError, SchedulePreconditionError } from '../../src/schedule/errors.js';
import {
  addManualAssignment,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  moveCredit,
  reassignAssignment,
  recordConflict,
  removeAssignment,
  setPin,
  transitionVersion,
  voidCredit,
} from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, publicationKey, scheduleActor } from '../support/schedule.js';
import { revokeGrantsById } from '../support/staffing.js';

/**
 * The publication spine's invariants, each with the red case that proves the
 * control is doing the work.
 *
 * A passing test with no demonstrated red case is not evidence for a
 * load-bearing invariant (packet 32 §9), so every claim here is paired: the
 * thing works, AND it visibly stops working when its control is removed.
 */

const multi = ownedMulti('schedule-invariants', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let worker: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;
let assigneeB: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** An approved, publishable version with one assignment. Fresh period each time. */
async function approvedVersion(
  label: string,
  startDate: string,
  membershipId?: string,
): Promise<{ periodId: string; versionId: string }> {
  const periodId = await run(async (uow) =>
    createPeriod(uow, actor, { name: `${label} period`, startDate, endDate: startDate }),
  );
  const versionId = await run(async (uow) => {
    const draft = await createDraftVersion(uow, actor, periodId);
    await addManualAssignment(uow, actor, {
      versionId: draft,
      membershipId: membershipId ?? assigneeA,
      shiftTypeId,
      date: startDate,
      startsAt: fixtureInstant(startDate, 8),
      endsAt: fixtureInstant(startDate, 16),
    });
    await transitionVersion(uow, actor, draft, 'in_review');
    await transitionVersion(uow, actor, draft, 'approved');
    return draft;
  });
  return { periodId, versionId };
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  worker = createRuntime('app_worker', { max: 3 });
  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[0];
  if (type === undefined) throw new Error('no shift type');
  shiftTypeId = type;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'schedule-invariants',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;
  assigneeB = fixture.alpha.users.member.membershipId;
});

afterAll(async () => {
  await runtime?.destroy();
  await worker?.destroy();
});

/* ────────────────────────────────────────────────────────────────────────────
 * I-11 — a notification failure never rolls back a domain change. BOTH halves.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('I-11 — the notification boundary, proven from both sides', () => {
  it('HALF A (pre-commit): an outbox WRITE failure rolls the publication back atomically', async () => {
    const { periodId, versionId } = await approvedVersion('i11-a', '2032-01-05');

    // The outbox write is INSIDE the transaction, so its failure must take the
    // whole publication with it. Nothing may be half-published.
    await expect(
      run(async (uow) =>
        publishVersion(
          uow,
          actor,
          { periodId, versionId, idempotencyKey: publicationKey('i11a'), expectedPriorCurrentVersionId: null },
          {
            publishOutbox: () => {
              throw new Error('OUTBOX_WRITE_FAILED: synthetic pre-commit failure');
            },
          },
        ),
      ),
    ).rejects.toThrow('OUTBOX_WRITE_FAILED');

    const after = await run(async ({ query }) => {
      const version = await query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current', 'version_number'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
      const reality = await query
        .selectFrom('current_published_assignments')
        .select('id')
        .where('period_id', '=', periodId)
        .execute();
      const records = await sql<{ n: string }>`SELECT count(*) AS n FROM publication_records
                                                WHERE version_id = ${versionId}`.execute(query);
      const supersessions = await sql<{ n: string }>`SELECT count(*) AS n FROM version_supersessions
                                                      WHERE superseding_version_id = ${versionId}`.execute(
        query,
      );
      return {
        version,
        reality: reality.length,
        records: Number(records.rows[0]?.n),
        supersessions: Number(supersessions.rows[0]?.n),
      };
    });

    expect(after.version.state, 'the publication must have rolled back whole').toBe('approved');
    expect(after.version.is_current).toBe(false);
    expect(after.version.version_number).toBeNull();
    expect(after.reality, 'no reality rows from a rolled-back publication').toBe(0);
    expect(after.records).toBe(0);
    expect(after.supersessions).toBe(0);
  });

  it('HALF B (post-commit): a DELIVERY failure never unwinds a committed publication', async () => {
    const { periodId, versionId } = await approvedVersion('i11-b', '2032-02-09');

    const result = await run(async (uow) =>
      publishVersion(uow, actor, { periodId, versionId, idempotencyKey: publicationKey('i11b'), expectedPriorCurrentVersionId: null }),
    );
    expect(result.outboxEventId).not.toBeNull();

    // The publication has COMMITTED. Now fail delivery as hard as possible.
    const sink = new AlwaysFailingSink();
    const outcome = await dispatchOutboxEvent(worker.runner, sink, {
      organizationId: context.organizationId,
      outboxEventId: result.outboxEventId as string,
    });
    expect(sink.attempts.length, 'delivery was genuinely attempted').toBeGreaterThan(0);
    expect(outcome.status, 'delivery failed, as instrumented').not.toBe('dispatched');

    // The domain change is untouched: still published, still current, reality
    // intact, publication record intact.
    const after = await run(async ({ query }) => {
      const version = await query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current', 'version_number'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow();
      const reality = await query
        .selectFrom('current_published_assignments')
        .select('id')
        .where('source_version_id', '=', versionId)
        .execute();
      const records = await sql<{ n: string }>`SELECT count(*) AS n FROM publication_records
                                                WHERE version_id = ${versionId}`.execute(query);
      return { version, reality: reality.length, records: Number(records.rows[0]?.n) };
    });

    expect(after.version.state, 'a delivery failure must NEVER unwind a publication').toBe(
      'published',
    );
    expect(after.version.is_current).toBe(true);
    expect(after.version.version_number).not.toBeNull();
    expect(after.reality).toBeGreaterThan(0);
    expect(after.records).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Immutability: no API path mutates published content, and the database agrees.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('published content is immutable through every path', () => {
  it('the service refuses to edit a published version, and D-15a would refuse it anyway', async () => {
    const { periodId, versionId } = await approvedVersion('immutable', '2032-03-08');
    await run(async (uow) =>
      publishVersion(uow, actor, { periodId, versionId, idempotencyKey: publicationKey('imm'), expectedPriorCurrentVersionId: null }),
    );

    const identity = await run(async ({ query }) => {
      const row = await query
        .selectFrom('assignment_snapshots')
        .select('assignment_identity_id')
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow();
      return row.assignment_identity_id;
    });

    // Application layer: a clear, typed refusal.
    await expect(
      run(async (uow) => reassignAssignment(uow, actor, versionId, identity, assigneeB, 'nope')),
    ).rejects.toBeInstanceOf(SchedulePreconditionError);

    // Database layer, independently: the same edit issued as raw SQL raises.
    await expect(
      run(async ({ query }) =>
        sql`UPDATE assignment_snapshots SET membership_id = ${assigneeB}
             WHERE version_id = ${versionId}`.execute(query),
      ),
    ).rejects.toThrow('SCHEDULE_PUBLISHED_IMMUTABLE');
  });

  it('RED: with the D-15a trigger dropped inside a rolled-back transaction, the edit SUCCEEDS', async () => {
    // The falsifiability control. If dropping the trigger did NOT let the edit
    // through, the trigger was not what was refusing it, and every immutability
    // claim above would be resting on something else.
    const { periodId, versionId } = await approvedVersion('red-d15a', '2032-04-05');
    await run(async (uow) =>
      publishVersion(uow, actor, { periodId, versionId, idempotencyKey: publicationKey('redimm'), expectedPriorCurrentVersionId: null }),
    );

    const migrator = createRuntime('app_migrator', { max: 1 });
    try {
      let landed = 0;
      await expect(
        migrator.runner.run(context, async ({ query }) => {
          await sql`ALTER TABLE assignment_snapshots DISABLE TRIGGER assignment_snapshots_immutable_when_published`.execute(
            query,
          );
          const result = await sql<{ id: string }>`
            UPDATE assignment_snapshots SET is_pinned = true
             WHERE version_id = ${versionId} RETURNING id`.execute(query);
          landed = result.rows.length;
          // ALWAYS roll back: the probe must not leave a mutated published row.
          throw new Error('ROLLBACK_PROBE');
        }),
      ).rejects.toThrow('ROLLBACK_PROBE');

      expect(landed, 'with the trigger disabled the UPDATE must land — else it was never the control').toBeGreaterThan(0);

      // And the rollback really happened: the row is unchanged and the trigger
      // is back in force.
      const stillPinned = await run(async ({ query }) =>
        query
          .selectFrom('assignment_snapshots')
          .select('is_pinned')
          .where('version_id', '=', versionId)
          .execute(),
      );
      expect(stillPinned.every((r) => r.is_pinned === false)).toBe(true);
      await expect(
        run(async ({ query }) =>
          sql`UPDATE assignment_snapshots SET is_pinned = true WHERE version_id = ${versionId}`.execute(
            query,
          ),
        ),
      ).rejects.toThrow('SCHEDULE_PUBLISHED_IMMUTABLE');
    } finally {
      await migrator.destroy();
    }
  });

  it('RED: tampering with current_published_assignments is caught by the V-15c equality check', async () => {
    const { periodId, versionId } = await approvedVersion('drift', '2032-05-10');
    await run(async (uow) =>
      publishVersion(uow, actor, { periodId, versionId, idempotencyKey: publicationKey('drift'), expectedPriorCurrentVersionId: null }),
    );

    const driftOf = async (query: PgUnitOfWork['query']): Promise<number> => {
      const result = await sql<{ n: string }>`
        WITH expected AS (
          SELECT s.id AS snapshot_id FROM assignment_snapshots s
            JOIN schedule_versions v ON v.id = s.version_id
           WHERE v.is_current AND s.status = 'active'),
        actual AS (SELECT source_snapshot_id AS snapshot_id FROM current_published_assignments)
        SELECT count(*) AS n FROM (
          (SELECT snapshot_id FROM expected EXCEPT SELECT snapshot_id FROM actual)
          UNION ALL
          (SELECT snapshot_id FROM actual EXCEPT SELECT snapshot_id FROM expected)) AS d`.execute(
        query,
      );
      return Number(result.rows[0]?.n ?? -1);
    };

    // Clean before.
    expect(await run(async ({ query }) => driftOf(query))).toBe(0);

    /* Tamper, measure, roll back — the check must SEE the drift.
     *
     * As `app_migrator`, because no runtime role holds DELETE on this table
     * (R-05). This comment used to claim the SECURITY DEFINER prune "only ever
     * deletes rows the publication is legitimately retiring", and at the time
     * that was FALSE — the independent review called the prune as plain
     * `app_runtime`, with no publication in flight, and emptied an arbitrary
     * own-tenant version's reality rows. The prune is now bound to the
     * publication path (it refuses a version that is still `is_current`, and
     * refuses any version publication has not superseded), and the
     * `prune cannot be used as a general delete primitive` test below is what
     * holds that claim true rather than this sentence.
     *
     * The probe is stronger for being run as the migrator: the drift it plants
     * is one no application path can produce, so the equality check is shown to
     * catch corruption from outside the application entirely — a bad repair
     * script, a restored backup, a hand-run statement. */
    const migrator = createRuntime('app_migrator', { max: 1 });
    try {
      await expect(
        migrator.runner.run(context, async ({ query }) => {
          await sql`DELETE FROM current_published_assignments
                     WHERE source_version_id = ${versionId}`.execute(query);
          const drift = await driftOf(query);
          expect(
            drift,
            'the equality check must detect a hand-tampered reality table',
          ).toBeGreaterThan(0);
          throw new Error('ROLLBACK_PROBE');
        }),
      ).rejects.toThrow('ROLLBACK_PROBE');
    } finally {
      await migrator.destroy();
    }

    // Clean again after the rollback.
    expect(await run(async ({ query }) => driftOf(query))).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * B-1 — the prune is bound to the publication path, not a delete primitive.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('app_schedule_prune_current_assignments is not a general delete primitive', () => {
  it('RED: the reviewer probe — app_runtime pruning a CURRENT version — is REFUSED', async () => {
    const { periodId, versionId } = await approvedVersion('prune-attack', '2033-01-10');
    await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId,
        idempotencyKey: publicationKey('pruneatk'),
        expectedPriorCurrentVersionId: null,
      }),
    );

    const realityCount = async (): Promise<number> =>
      run(async ({ query }) => {
        const rows = await query
          .selectFrom('current_published_assignments')
          .select('id')
          .where('source_version_id', '=', versionId)
          .execute();
        return rows.length;
      });
    const before = await realityCount();
    expect(before, 'the publication put reality rows in place').toBeGreaterThan(0);

    /* The independent review's exact probe: plain `app_runtime`, an ORDINARY
     * unit of work, no publication in flight, an arbitrary own-tenant version
     * id. It used to delete 1 row and drive V-15c's drift from 0 to 1,
     * unrecoverably — disarming D-1b within the tenant so a later publication
     * could double-book against emptied reality. */
    await expect(
      run(async ({ query }) =>
        sql`SELECT app_schedule_prune_current_assignments(${versionId})`.execute(query),
      ),
    ).rejects.toThrow('SCHEDULE_PRUNE_VERSION_IS_CURRENT');

    expect(await realityCount(), 'nothing was deleted').toBe(before);
  });

  it('RED: pruning a DRAFT version is refused too (it owns no reality)', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'prune-draft period',
        startDate: '2033-02-07',
        endDate: '2033-02-07',
      }),
    );
    const draft = await run(async (uow) => createDraftVersion(uow, actor, periodId));

    await expect(
      run(async ({ query }) =>
        sql`SELECT app_schedule_prune_current_assignments(${draft})`.execute(query),
      ),
    ).rejects.toThrow('SCHEDULE_PRUNE_VERSION_NOT_PUBLISHED');
  });

  it('CONTROL: the legitimate publication path still prunes the outgoing version', async () => {
    // The guard must refuse the attack WITHOUT breaking step 12. A publication
    // that supersedes a prior version retires exactly that version's rows.
    const { periodId, versionId: first } = await approvedVersion('prune-ok', '2033-03-07');
    await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId: first,
        idempotencyKey: publicationKey('pruneok1'),
        expectedPriorCurrentVersionId: null,
      }),
    );

    const second = await run(async (uow) => {
      const clone = await cloneVersion(uow, actor, first);
      await transitionVersion(uow, actor, clone, 'in_review');
      await transitionVersion(uow, actor, clone, 'approved');
      return clone;
    });
    await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId: second,
        idempotencyKey: publicationKey('pruneok2'),
        expectedPriorCurrentVersionId: first,
      }),
    );

    const reality = await run(async ({ query }) =>
      query
        .selectFrom('current_published_assignments')
        .select(['source_version_id'])
        .where('period_id', '=', periodId)
        .execute(),
    );
    expect(reality.length).toBeGreaterThan(0);
    expect(
      reality.every((row) => row.source_version_id === second),
      'the outgoing version was pruned and the incoming inserted',
    ).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * B-2 — D-15a covers INSERT, and every mutator refuses a published version.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('published versions are set-immutable (FAD-22(1))', () => {
  /** A published version with one assignment, and the identity/snapshot on it. */
  const publishedFixture = async (
    label: string,
    date: string,
  ): Promise<{
    periodId: string;
    versionId: string;
    identityId: string;
    snapshotId: string;
    shiftId: string;
  }> => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: `${label} period`, startDate: date, endDate: date }),
    );
    const built = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      const added = await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 8),
        endsAt: fixtureInstant(date, 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId,
        versionId: draft,
        idempotencyKey: publicationKey(label.slice(0, 20)),
        expectedPriorCurrentVersionId: null,
      });
      return { draft, ...added };
    });
    const shift = await run(async ({ query }) =>
      query
        .selectFrom('assignment_snapshots')
        .select('shift_id')
        .where('id', '=', built.snapshotId)
        .executeTakeFirstOrThrow(),
    );
    return {
      periodId,
      versionId: built.draft,
      identityId: built.assignmentIdentityId,
      snapshotId: built.snapshotId,
      shiftId: shift.shift_id,
    };
  };

  it('RED: a raw INSERT of a snapshot under a PUBLISHED version raises (D-15a INSERT arm)', async () => {
    const f = await publishedFixture('insert-arm', '2033-04-04');

    const contentCount = async (): Promise<number> =>
      run(async ({ query }) => {
        const rows = await query
          .selectFrom('assignment_snapshots')
          .select('id')
          .where('version_id', '=', f.versionId)
          .execute();
        return rows.length;
      });
    expect(await contentCount()).toBe(1);

    /* The reviewer's probe. A `BEFORE UPDATE OR DELETE`-only guard accepted
     * this: the published version's content SET grew from 1 to 2 while every
     * existing row stayed "immutable", changing the version's content and its
     * re-derived affected-staff set. I-18 says every child row is immutable,
     * which is set-immutability. */
    await expect(
      run(async ({ query }) => {
        const identity = await query
          .insertInto('assignment_identities')
          .values({
            id: randomUUID(),
            organization_id: context.organizationId,
            group_id: context.groupId as string,
            period_id: f.periodId,
            origin: 'manual',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        return sql`
          INSERT INTO assignment_snapshots
            (id, organization_id, group_id, assignment_identity_id, version_id,
             membership_id, shift_id, date, starts_at, ends_at, origin, status)
          VALUES (${randomUUID()}, ${context.organizationId}, ${context.groupId},
                  ${identity.id}, ${f.versionId}, ${assigneeB}, ${f.shiftId},
                  '2033-04-04', '2033-04-04T18:00:00Z'::timestamptz,
                  '2033-04-04T22:00:00Z'::timestamptz, 'manual', 'active')
        `.execute(query);
      }),
    ).rejects.toThrow('SCHEDULE_PUBLISHED_IMMUTABLE');

    expect(await contentCount(), 'the published content set did not grow').toBe(1);
  });

  it('RED: a raw INSERT of a credit against a PUBLISHED version raises', async () => {
    const f = await publishedFixture('credit-insert', '2033-05-02');
    await expect(
      run(async ({ query }) =>
        sql`
          INSERT INTO credits
            (id, organization_id, group_id, assignment_identity_id, source_version_id,
             source_snapshot_id, credited_membership_id, weight, status)
          VALUES (${randomUUID()}, ${context.organizationId}, ${context.groupId},
                  ${f.identityId}, ${f.versionId}, ${f.snapshotId}, ${assigneeB}, 1, 'active')
        `.execute(query),
      ),
    ).rejects.toThrow('SCHEDULE_PUBLISHED_IMMUTABLE');
  });

  it('every one of the 7 content mutators refuses a published version', async () => {
    const f = await publishedFixture('all-mutators', '2033-06-06');
    const refusals: string[] = [];

    const refuses = async (name: string, call: () => Promise<unknown>): Promise<void> => {
      await expect(call(), `${name} must refuse a published version`).rejects.toBeInstanceOf(
        SchedulePreconditionError,
      );
      refusals.push(name);
    };

    await refuses('addManualAssignment', () =>
      run(async (uow) =>
        addManualAssignment(uow, actor, {
          versionId: f.versionId,
          membershipId: assigneeB,
          shiftTypeId,
          date: '2033-06-06',
          startsAt: fixtureInstant('2033-06-06', 18),
          endsAt: fixtureInstant('2033-06-06', 22),
        }),
      ),
    );
    await refuses('removeAssignment', () =>
      run(async (uow) => removeAssignment(uow, actor, f.versionId, f.identityId, 'no')),
    );
    await refuses('reassignAssignment', () =>
      run(async (uow) => reassignAssignment(uow, actor, f.versionId, f.identityId, assigneeB, 'no')),
    );
    await refuses('setPin', () =>
      run(async (uow) => setPin(uow, actor, f.versionId, f.identityId, true)),
    );
    await refuses('moveCredit', () =>
      run(async (uow) =>
        moveCredit(uow, actor, {
          versionId: f.versionId,
          assignmentIdentityId: f.identityId,
          snapshotId: f.snapshotId,
          creditedMembershipId: assigneeB,
        }),
      ),
    );
    await refuses('recordConflict', () =>
      run(async (uow) =>
        recordConflict(uow, actor, { versionId: f.versionId, severity: 'hard-breach' }),
      ),
    );

    // `voidCredit` needs a credit that EXISTS, so it is created on a draft and
    // the version is then published — the shape a real post-publication
    // correction attempt has.
    const draftPeriod = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'void-credit period',
        startDate: '2033-07-04',
        endDate: '2033-07-04',
      }),
    );
    const creditId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, draftPeriod);
      const added = await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2033-07-04',
        startsAt: fixtureInstant('2033-07-04', 8),
        endsAt: fixtureInstant('2033-07-04', 16),
      });
      const id = await moveCredit(uow, actor, {
        versionId: draft,
        assignmentIdentityId: added.assignmentIdentityId,
        snapshotId: added.snapshotId,
        creditedMembershipId: assigneeB,
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId: draftPeriod,
        versionId: draft,
        idempotencyKey: publicationKey('voidcredit'),
        expectedPriorCurrentVersionId: null,
      });
      return id;
    });
    await refuses('voidCredit', () => run(async (uow) => voidCredit(uow, actor, creditId)));

    expect(refusals, 'all seven content mutators refuse').toHaveLength(7);
  });

  it('recordConflict evaluates a capability and emits an audit event', async () => {
    const fixture = multi();
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'conflict authz period',
        startDate: '2033-08-01',
        endDate: '2033-08-01',
      }),
    );
    const draft = await run(async (uow) => createDraftVersion(uow, actor, periodId));

    // A membership with no schedule capability is denied — this surface used to
    // have no check at all (non-bypass rule 4).
    const memberContext: TenantContext = {
      ...context,
      membershipId: fixture.alpha.users.member.membershipId,
    };
    await expect(
      runtime.runner.run(memberContext, async (uow) =>
        recordConflict(uow, scheduleActor(fixture.alpha.users.member.id), {
          versionId: draft,
          severity: 'info',
        }),
      ),
    ).rejects.toBeInstanceOf(ScheduleDeniedError);

    // The authorized path writes the row AND the audit event (rule 6).
    const conflictId = await run(async (uow) =>
      recordConflict(uow, actor, { versionId: draft, severity: 'info' }),
    );
    const events = await run(async ({ query }) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM audit_events
                          WHERE event_name = 'schedule.conflict.recorded'
                            AND subject_id = ${draft}`.execute(query),
    );
    expect(conflictId).toBeTruthy();
    expect(Number(events.rows[0]?.n), 'the conflict was audited').toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-22(2) and (3) — the mandatory compare-and-set, and the key's one domain.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('publication contract (FAD-22(2), FAD-22(3))', () => {
  it('a STALE expected-current fails explicitly, with no race required', async () => {
    const { periodId, versionId: first } = await approvedVersion('cas-stale', '2034-01-09');
    await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId: first,
        idempotencyKey: publicationKey('cas1'),
        expectedPriorCurrentVersionId: null,
      }),
    );

    const second = await run(async (uow) => {
      const clone = await cloneVersion(uow, actor, first);
      await transitionVersion(uow, actor, clone, 'in_review');
      await transitionVersion(uow, actor, clone, 'approved');
      return clone;
    });

    // The caller still believes nothing is current — a stale view. Under the
    // old OPTIONAL parameter this simply published and silently superseded.
    await expect(
      run(async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId: second,
          idempotencyKey: publicationKey('cas2'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CURRENT_VERSION_MOVED' });

    // Stating the truth publishes.
    const ok = await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId: second,
        idempotencyKey: publicationKey('cas3'),
        expectedPriorCurrentVersionId: first,
      }),
    );
    expect(ok.replay).toBe(false);
    expect(ok.priorCurrentVersionId).toBe(first);
  });

  it('a key outside the domain is refused BEFORE any work, not as a raw 23514', async () => {
    const { periodId, versionId } = await approvedVersion('key-domain', '2034-02-06');

    await expect(
      run(async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId,
          idempotencyKey: 'has spaces and : colons',
          expectedPriorCurrentVersionId: null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });

    // Nothing happened: the refusal precedes the lock and every write.
    const state = await run(async ({ query }) =>
      query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current'])
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(state.state).toBe('approved');
    expect(state.is_current).toBe(false);

    // And the database refuses it independently, for a caller that never came
    // through the service (the CHECK is the backstop, not the first line).
    await expect(
      run(async ({ query }) =>
        sql`INSERT INTO publication_records
              (id, organization_id, group_id, period_id, version_id,
               publication_idempotency_key, outcome)
            VALUES (${randomUUID()}, ${context.organizationId}, ${context.groupId},
                    ${periodId}, ${versionId}, ${'bad key with spaces'}, 'published')`.execute(
          query,
        ),
      ),
    ).rejects.toThrow(/publication_records_key_domain|check constraint/i);
  });

  it('a replay returns the RECORDED outcome, not a fabricated empty one', async () => {
    // Two assignees, so the affected set is non-empty and a fabricated reply
    // would be visibly wrong.
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'replay period',
        startDate: '2034-03-06',
        endDate: '2034-03-06',
      }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2034-03-06',
        startsAt: fixtureInstant('2034-03-06', 8),
        endsAt: fixtureInstant('2034-03-06', 16),
      });
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeB,
        shiftTypeId,
        date: '2034-03-06',
        startsAt: fixtureInstant('2034-03-06', 16),
        endsAt: fixtureInstant('2034-03-06', 22),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    const key = publicationKey('replay');
    const first = await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId,
        idempotencyKey: key,
        expectedPriorCurrentVersionId: null,
      }),
    );
    expect(first.difference.affectedMembershipIds.length).toBe(2);

    const replay = await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId,
        idempotencyKey: key,
        expectedPriorCurrentVersionId: null,
      }),
    );
    expect(replay.replay).toBe(true);
    expect(replay.outboxEventId).toBeNull();
    // The RECORDED outcome. The first implementation returned an empty affected
    // set and a null prior version to every replay — a lie a retry after a
    // dropped connection could not detect.
    expect(replay.versionNumber).toBe(first.versionNumber);
    expect([...replay.difference.affectedMembershipIds].sort()).toEqual(
      [...first.difference.affectedMembershipIds].sort(),
    );
  });

  it('a key reused for a DIFFERENT version fails explicitly, never a silent no-op', async () => {
    const { periodId, versionId: first } = await approvedVersion('reuse', '2034-04-03');
    const key = publicationKey('reuse');
    await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId: first,
        idempotencyKey: key,
        expectedPriorCurrentVersionId: null,
      }),
    );

    const second = await run(async (uow) => {
      const clone = await cloneVersion(uow, actor, first);
      await transitionVersion(uow, actor, clone, 'in_review');
      await transitionVersion(uow, actor, clone, 'approved');
      return clone;
    });

    await expect(
      run(async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId: second,
          idempotencyKey: key,
          expectedPriorCurrentVersionId: first,
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_VERSION' });
  });

  it('N-4: two concurrent same-key publications resolve as replay-or-error, never a raw 23505', async () => {
    const { periodId, versionId } = await approvedVersion('samekey', '2034-05-08');
    const key = publicationKey('samekey');

    const attempt = (): Promise<unknown> =>
      runtime.runner.run(context, async (uow) =>
        publishVersion(uow, actor, {
          periodId,
          versionId,
          idempotencyKey: key,
          expectedPriorCurrentVersionId: null,
        }),
      );
    const outcomes = await Promise.allSettled([attempt(), attempt()]);

    // Under the reordered step-01/02 the idempotency read happens UNDER the
    // period lock, so the second attempt sees the committed record. Whatever
    // interleaving occurred, no attempt may surface a unique-violation.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        const message = String((outcome.reason as Error).message);
        expect(message, 'a raw 23505 leaked instead of a decision').not.toMatch(
          /duplicate key value|23505/i,
        );
      }
    }
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    expect(fulfilled.length, 'at least one attempt resolved').toBeGreaterThan(0);

    const records = await run(async ({ query }) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM publication_records
                          WHERE period_id = ${periodId}
                            AND publication_idempotency_key = ${key}`.execute(query),
    );
    expect(Number(records.rows[0]?.n), 'published exactly once').toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * N-5 — D-1b is tenant-qualified, and still catches the cross-GROUP case.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('D-1b after tenant-qualification (N-5)', () => {
  it('a cross-GROUP, same-organization double-booking still aborts the publication', async () => {
    /* Adding `organization_id` to the EXCLUDE closes a cross-tenant existence
     * oracle. It must NOT have narrowed the constraint: a membership belongs to
     * exactly one organization, so two rows sharing a membership necessarily
     * share an organization. The case that could have been weakened is the
     * cross-GROUP one — same organization, different groups — so it is asserted
     * directly rather than reasoned about.
     *
     * `group_id` is deliberately absent from the equality columns: a person
     * cannot be in two places in reality regardless of which group's schedule
     * put them there. */
    const fixture = multi();

    // Group One publishes assigneeA at 08:00–16:00.
    const { periodId, versionId } = await approvedVersion('n5-group-one', '2034-06-05');
    await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId,
        idempotencyKey: publicationKey('n5a'),
        expectedPriorCurrentVersionId: null,
      }),
    );

    // The SAME membership is what D-1b keys on, so the collision is constructed
    // in the sibling group against that same membership.
    const siblingContext: TenantContext = {
      ...context,
      groupId: fixture.catalogue?.alpha?.sibling.groupId as string,
      membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
    };
    const siblingActor = scheduleActor(fixture.alpha.users.groupTwoScheduler.id);
    /* Index 1 since OPUS-M4-000A: this arm assigns a GROUP-ONE membership
     * inside the sibling group, and a group-one membership can never hold a
     * sibling-group credential (the 0004 guard binds a holding to its
     * membership's group) — so the requirement-bearing sibling type [0] would
     * refuse at the qualification gate before D-1b could speak. The unencumbered
     * type keeps this a pure D-1b proof. */
    const siblingShiftType = fixture.catalogue?.alpha?.sibling.shiftTypeIds[1] as string;

    const built = await runtime.runner.run(siblingContext, async (uow) => {
      const period = await createPeriod(uow, siblingActor, {
        name: 'n5 sibling period',
        startDate: '2034-07-03',
        endDate: '2034-07-03',
      });
      const draft = await createDraftVersion(uow, siblingActor, period);
      await addManualAssignment(uow, siblingActor, {
        versionId: draft,
        // Group One's membership, deliberately: this is the person D-1b
        // protects, and the interval overlaps what Group One published.
        membershipId: assigneeA,
        shiftTypeId: siblingShiftType,
        date: '2034-06-05',
        startsAt: fixtureInstant('2034-06-05', 12),
        endsAt: fixtureInstant('2034-06-05', 20),
      });
      await transitionVersion(uow, siblingActor, draft, 'in_review');
      await transitionVersion(uow, siblingActor, draft, 'approved');
      return { period, draft };
    });

    await expect(
      runtime.runner.run(siblingContext, async (uow) =>
        publishVersion(uow, siblingActor, {
          periodId: built.period,
          versionId: built.draft,
          idempotencyKey: publicationKey('n5b'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
      'D-1b must still catch a cross-GROUP collision within one organization',
    ).rejects.toThrow(/no_double_book|exclusion|conflicting key/i);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Authorization: allow AND deny per surface; freshness on the publish path.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('authorization', () => {
  it('publish is a DISTINCT capability from edit: a member may do neither', async () => {
    const fixture = multi();
    // Built as the scheduler FIRST, outside the member's unit of work: a unit of
    // work cannot change tenant tuple mid-flight, and nesting one inside another
    // raises NESTED_TENANT_CHANGE rather than exercising authorization.
    const { periodId, versionId } = await approvedVersion('deny', '2032-06-07');

    // `member` holds the group `member` role, which carries neither
    // `schedule.version.edit` nor `schedule.publish`.
    const memberContext: TenantContext = {
      ...context,
      membershipId: fixture.alpha.users.member.membershipId,
    };
    const memberActor = scheduleActor(fixture.alpha.users.member.id);

    await expect(
      runtime.runner.run(memberContext, async (uow) =>
        createDraftVersion(uow, memberActor, periodId),
      ),
      'edit is denied',
    ).rejects.toBeInstanceOf(ScheduleDeniedError);

    await expect(
      runtime.runner.run(memberContext, async (uow) =>
        publishVersion(uow, memberActor, {
          periodId,
          versionId,
          idempotencyKey: publicationKey('member-publish'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
      'publish is denied separately',
    ).rejects.toBeInstanceOf(ScheduleDeniedError);
  });

  it('I-19 — a grant revoked mid-flight denies the publication it was in the middle of', async () => {
    const fixture = multi();
    const { periodId, versionId } = await approvedVersion('freshness', '2032-07-05');

    /* `schedule.publish` is grant-only, and this fixture grants it to the
     * scheduler. Closing that grant's window must therefore deny — and because
     * the evaluation happens INSIDE the publishing transaction, it sees the
     * closure rather than a snapshot taken before it (I-19).
     *
     * The grant's window is CLOSED rather than a deny row added: an overlapping
     * allow and deny for one (membership, capability) is refused by
     * `capability_grants_no_overlapping_window`, which is the schema working. */
    const existing = await run(async ({ query }) =>
      query
        .selectFrom('capability_grants')
        .select('id')
        .where('membership_id', '=', fixture.alpha.users.scheduler.membershipId)
        .where('capability_key', '=', 'schedule.publish')
        .where('granted', '=', true)
        .execute(),
    );
    expect(existing.length, 'the fixture grants schedule.publish to the scheduler').toBeGreaterThan(
      0,
    );

    const grantIds = existing.map((row) => row.id);
    /* `revokeGrantsById` FLIPS `granted` to false in place — it does not delete
     * and does not close a window, because no runtime role holds DELETE on
     * `capability_grants` (0002, deliberately). The row therefore becomes an
     * EXPLICIT DENY, which is a stronger denial than absence: P-1 makes it beat
     * every allow. Restoring means flipping it back, NOT adding a second row —
     * a second row would overlap and `capability_grants_no_overlapping_window`
     * would refuse it, which is the schema working. */
    const setGranted = async (granted: boolean): Promise<void> => {
      await runtime.runner.run(
        multi.administrator(context.organizationId, 'freshness-grant-flip'),
        async ({ query }) => {
          await query
            .updateTable('capability_grants')
            .set({ granted })
            .where('id', 'in', grantIds)
            .execute();
        },
      );
    };

    try {
      await revokeGrantsById(runtime.runner, fixture, {
        organizationId: context.organizationId,
        grantIds,
      });

      await expect(
        run(async (uow) =>
          publishVersion(uow, actor, {
            periodId,
            versionId,
            idempotencyKey: publicationKey('fresh'),
            expectedPriorCurrentVersionId: null,
          }),
        ),
      ).rejects.toBeInstanceOf(ScheduleDeniedError);

      // Nothing was published under the denied attempt.
      const denied = await run(async ({ query }) =>
        query
          .selectFrom('schedule_versions')
          .select(['state', 'is_current'])
          .where('id', '=', versionId)
          .executeTakeFirstOrThrow(),
      );
      expect(denied.state).toBe('approved');
      expect(denied.is_current).toBe(false);
    } finally {
      // Restored in `finally`, so a failure above cannot leave a deny row that
      // silently denies every later test in this file.
      await setGranted(true);
    }

    // The SAME call now succeeds — which is what makes the denial attributable
    // to the grant and to nothing else.
    const after = await run(async (uow) =>
      publishVersion(uow, actor, {
        periodId,
        versionId,
        idempotencyKey: publicationKey('fresh-2'),
        expectedPriorCurrentVersionId: null,
      }),
    );
    expect(after.replay).toBe(false);
    expect(after.versionNumber).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Credits are separate from assignments — the tenth concept, kept distinct.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('credits', () => {
  it('a credit moves without touching the assignment snapshot', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'credit period',
        startDate: '2032-08-09',
        endDate: '2032-08-09',
      }),
    );
    const built = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      const added = await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2032-08-09',
        startsAt: fixtureInstant('2032-08-09', 8),
        endsAt: fixtureInstant('2032-08-09', 16),
      });
      return { draft, ...added };
    });

    const before = await run(async ({ query }) =>
      query
        .selectFrom('assignment_snapshots')
        .selectAll()
        .where('id', '=', built.snapshotId)
        .executeTakeFirstOrThrow(),
    );

    // The credit goes to B while A still WORKS the shift — legitimate and the
    // whole reason credit is a separate concept.
    await run(async (uow) =>
      moveCredit(uow, actor, {
        versionId: built.draft,
        assignmentIdentityId: built.assignmentIdentityId,
        snapshotId: built.snapshotId,
        creditedMembershipId: assigneeB,
        reason: 'covered the clinic',
      }),
    );

    const after = await run(async ({ query }) =>
      query
        .selectFrom('assignment_snapshots')
        .selectAll()
        .where('id', '=', built.snapshotId)
        .executeTakeFirstOrThrow(),
    );
    expect(after, 'a credit edit must not reach the snapshot').toEqual(before);
    expect(after.membership_id, 'the assignee is unchanged').toBe(assigneeA);

    const credit = await run(async ({ query }) =>
      query
        .selectFrom('credits')
        .select(['credited_membership_id', 'status'])
        .where('assignment_identity_id', '=', built.assignmentIdentityId)
        .executeTakeFirstOrThrow(),
    );
    expect(credit.credited_membership_id, 'the CREDIT moved').toBe(assigneeB);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Cloning preserves identity — the property the whole model rests on.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('cloning', () => {
  it('preserves assignment identity across versions and gives the clone its own snapshots', async () => {
    const { periodId, versionId } = await approvedVersion('clone-id', '2032-09-06');
    await run(async (uow) =>
      publishVersion(uow, actor, { periodId, versionId, idempotencyKey: publicationKey('cloneid'), expectedPriorCurrentVersionId: null }),
    );

    const clone = await run(async (uow) => cloneVersion(uow, actor, versionId));

    const rows = await run(async ({ query }) =>
      query
        .selectFrom('assignment_snapshots')
        .select(['id', 'version_id', 'assignment_identity_id', 'supersedes_snapshot_id'])
        .where('version_id', 'in', [versionId, clone])
        .execute(),
    );
    const source = rows.filter((r) => r.version_id === versionId);
    const cloned = rows.filter((r) => r.version_id === clone);

    expect(cloned).toHaveLength(source.length);
    expect(
      new Set(cloned.map((r) => r.assignment_identity_id)),
      'identity is PRESERVED — this is what makes "what changed" a join',
    ).toEqual(new Set(source.map((r) => r.assignment_identity_id)));
    expect(
      cloned.every((r) => !source.some((s) => s.id === r.id)),
      'the clone has its OWN snapshot rows',
    ).toBe(true);
    expect(
      cloned.every((r) => source.some((s) => s.id === r.supersedes_snapshot_id)),
      'each cloned snapshot records the snapshot it came from',
    ).toBe(true);
  });
});
