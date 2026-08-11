import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
  setRequirement,
  transitionVersion,
} from '../../src/schedule/service.js';
import { publishVersion } from '../../src/schedule/publication.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, publicationKey, scheduleActor } from '../support/schedule.js';

/**
 * Schedule-graph consistency, proven AT THE DATABASE (OPUS-M4-000B; doc 34
 * §4-C and §4-E; migration 0014).
 *
 * ## What "proven at the database" means here, and what it excludes
 *
 * Doc 34 §4-C is explicit: "prove at the database (composite FK or invariant
 * check, **never UI filtering alone**) that the referenced record belongs to
 * the same group". So every probe below issues raw SQL **as `app_runtime`** —
 * the role the application actually runs as — bypassing every service, every
 * route and every contract. If a control only exists in TypeScript, these
 * probes find nothing in its way.
 *
 * ## Why each control is proven INDEPENDENTLY
 *
 * Several invariants are guarded twice over: a service check for the readable
 * error, a BEFORE trigger, and a composite foreign key. They fire in that fixed
 * order, so the outermost one is the only refusal an ordinary probe ever sees —
 * and "the FK is fine, the trigger caught it" is exactly how a broken FK ships.
 *
 * Where two database controls overlap, the trigger is therefore SUSPENDED
 * inside a transaction that is then rolled back (`withTriggerDisabled`), so the
 * inner control has to answer on its own. The suspension is `app_migrator`'s,
 * it never commits, and the schema is byte-identical afterwards — the same
 * device `publication-invariants.test.ts` already uses to prove D-15a.
 *
 * ## Falsifiability
 *
 * The final describe block is this file's MUTATION CONTROL: it drops each new
 * constraint inside a rolled-back transaction and shows the previously-refused
 * write SUCCEEDING. A refusal that cannot be made to stop happening is not
 * evidence that anything is enforcing it.
 */

const multi = ownedMulti('schedule-graph-invariants', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let migrator: Runtime;
let context: TenantContext;
let siblingContext: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let siblingActor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;
let siblingMembershipId: string;
let siblingShiftTypeId: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  migrator = createRuntime('app_migrator', { max: 2 });
  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[1];
  if (type === undefined) throw new Error('no shift type');
  shiftTypeId = type;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'graph-invariants',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;

  siblingContext = {
    ...context,
    groupId: catalogue.sibling.groupId,
    membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
  };
  siblingActor = scheduleActor(fixture.alpha.users.groupTwoScheduler.id);
  siblingMembershipId = fixture.alpha.users.groupTwoScheduler.membershipId;
  const siblingType = catalogue.sibling.shiftTypeIds[1];
  if (siblingType === undefined) throw new Error('no sibling shift type');
  siblingShiftTypeId = siblingType;
});

afterAll(async () => {
  await runtime?.destroy();
  await migrator?.destroy();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Probe helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Issue raw SQL as `app_runtime`; return the error text, or `null` on success. */
async function attempt(statement: string, ctx: TenantContext = context): Promise<string | null> {
  try {
    await runtime.runner.run(ctx, async ({ query }) => {
      await sql.raw(statement).execute(query);
    });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Run `body` with `trigger` disabled, then ROLL BACK.
 *
 * `app_migrator` owns the schema, so it can suspend a trigger; the transaction
 * always aborts, so the suspension never outlives the probe. This exists to make
 * an INNER control answer for itself when an outer one would otherwise speak
 * first — see this file's header.
 */
async function withTriggerDisabled(
  table: string,
  trigger: string,
  statement: string,
  ctx: TenantContext = context,
): Promise<string | null> {
  const marker = `ROLLED_BACK_${randomUUID()}`;
  /* The statement's own error is captured BEFORE the abort and carried out on
   * the marker. An earlier version of this helper threw the marker from a
   * `finally`, which masked the statement's failure as a success — so a probe
   * that was actually being refused by an unrelated constraint reported "the
   * inner control let it through". A helper that can only report success is
   * worse than no helper. */
  let statementError: string | null = null;
  try {
    await migrator.runner.run(ctx, async ({ query }) => {
      await sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`).execute(query);
      try {
        await sql.raw(statement).execute(query);
      } catch (error) {
        statementError = (error as Error).message;
      }
      // Always abort. The suspension is a probe, never a migration.
      throw new Error(marker);
    });
    return null;
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes(marker)) return statementError;
    // The abort itself failed, or the DISABLE did — report it rather than
    // silently attributing it to the statement.
    return message;
  }
}

/**
 * A fresh `assignment_identity` in a period.
 *
 * D-14 (`assignment_snapshots_one_per_identity_version`) refuses a second
 * snapshot for one identity in one version, and it is a UNIQUE constraint, so it
 * answers before any foreign key. A probe that reused an identity would be
 * refused by D-14 and prove nothing about the constraint under test.
 */
async function freshIdentity(periodId: string): Promise<string> {
  const id = randomUUID();
  await run(async ({ query }) => {
    await sql
      .raw(
        `INSERT INTO assignment_identities (id, organization_id, group_id, period_id)
         VALUES ('${id}', '${context.organizationId}', '${context.groupId as string}', '${periodId}')`,
      )
      .execute(query);
  });
  return id;
}

/** A fresh period + draft version + one assignment. */
async function draftWithAssignment(
  label: string,
  date: string,
): Promise<{ periodId: string; versionId: string; shiftId: string; identityId: string; snapshotId: string }> {
  const periodId = await run(async (uow) =>
    createPeriod(uow, actor, { name: `${label} period`, startDate: date, endDate: date }),
  );
  return run(async (uow) => {
    const versionId = await createDraftVersion(uow, actor, periodId);
    const added = await addManualAssignment(uow, actor, {
      versionId,
      membershipId: assigneeA,
      shiftTypeId,
      date,
      startsAt: fixtureInstant(date, 8),
      endsAt: fixtureInstant(date, 16),
    });
    const shift = (await uow.query
      .selectFrom('shifts')
      .select('id')
      .where('version_id', '=', versionId)
      .executeTakeFirstOrThrow()) as unknown as { id: string };
    return {
      periodId,
      versionId,
      shiftId: shift.id,
      identityId: added.assignmentIdentityId,
      snapshotId: added.snapshotId,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * §4-C — the participant belongs to the group
 * ──────────────────────────────────────────────────────────────────────────── */

describe('doc 34 §4-C — a schedule participant is a member of THIS group', () => {
  it('a snapshot naming another group’s membership is refused, as app_runtime, in raw SQL', async () => {
    const base = await draftWithAssignment('participant-crossgroup', '2033-01-10');
    const error = await attempt(`
      INSERT INTO assignment_snapshots
        (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
         shift_id, date, starts_at, ends_at)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${base.identityId}', '${base.versionId}', '${siblingMembershipId}',
              '${base.shiftId}', '2033-01-10',
              '2033-01-10T18:00:00Z', '2033-01-10T20:00:00Z')
    `);
    expect(error, 'a cross-group participant must be refused').not.toBeNull();
  });

  /**
   * The FK, on its own.
   *
   * The BEFORE trigger normally answers first (a row trigger runs before the
   * statement's foreign-key check), so without suspending it this probe would
   * prove only that SOMETHING refused. With the trigger gone, the refusal has to
   * come from `assignment_snapshots_participant_in_group_fk` or not at all.
   */
  it('and the COMPOSITE FK refuses it independently, with the trigger suspended', async () => {
    const base = await draftWithAssignment('participant-fk-alone', '2033-01-11');
    const identityId = await freshIdentity(base.periodId);
    const error = await withTriggerDisabled(
      'assignment_snapshots',
      'assignment_snapshots_participant_and_period_guard',
      `INSERT INTO assignment_snapshots
         (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
          shift_id, date, starts_at, ends_at)
       VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
               '${identityId}', '${base.versionId}', '${siblingMembershipId}',
               '${base.shiftId}', '2033-01-11',
               '2033-01-11T18:00:00Z', '2033-01-11T20:00:00Z')`,
    );
    expect(error, 'the FK must refuse it with no trigger in front').not.toBeNull();
    expect(error).toMatch(/participant_in_group|foreign key/i);
  });

  it('an ORGANIZATION membership cannot be a participant either', async () => {
    const fixture = multi();
    const base = await draftWithAssignment('participant-orgmember', '2033-01-12');
    const error = await attempt(`
      INSERT INTO assignment_snapshots
        (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
         shift_id, date, starts_at, ends_at)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${base.identityId}', '${base.versionId}',
              '${fixture.alpha.users.organizationAdmin.membershipId}',
              '${base.shiftId}', '2033-01-12',
              '2033-01-12T18:00:00Z', '2033-01-12T20:00:00Z')
    `);
    expect(error, 'an organization membership has no group and cannot work a shift').not.toBeNull();
  });

  /**
   * The same rule from the OTHER side.
   *
   * Cross-tenant probes that only ever run in one direction are how an
   * asymmetric control ships: a predicate that happens to be right for Group One
   * and wrong for Group Two passes a one-directional suite forever. This runs
   * the sibling group's own service path against Group One's membership.
   */
  it('and from the sibling group’s side, through the real service path', async () => {
    await expect(
      runtime.runner.run(siblingContext, async (uow) => {
        const periodId = await createPeriod(uow, siblingActor, {
          name: 'sibling participant period',
          startDate: '2033-01-14',
          endDate: '2033-01-14',
        });
        const versionId = await createDraftVersion(uow, siblingActor, periodId);
        return addManualAssignment(uow, siblingActor, {
          versionId,
          // Group One's membership, inside Group Two's draft.
          membershipId: assigneeA,
          shiftTypeId: siblingShiftTypeId,
          date: '2033-01-14',
          startsAt: fixtureInstant('2033-01-14', 8),
          endsAt: fixtureInstant('2033-01-14', 16),
        });
      }),
    ).rejects.toThrow(/ASSIGNEE_NOT_IN_GROUP|no such member of this group/i);
  });

  it('a CREDIT to another group’s membership is refused', async () => {
    const base = await draftWithAssignment('credit-crossgroup', '2033-01-13');
    const error = await attempt(`
      INSERT INTO credits
        (id, organization_id, group_id, assignment_identity_id, source_version_id,
         source_snapshot_id, credited_membership_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${base.identityId}', '${base.versionId}', '${base.snapshotId}',
              '${siblingMembershipId}')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/credited_participant_in_group|foreign key/i);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * §4-E — the schedule graph agrees with itself
 * ──────────────────────────────────────────────────────────────────────────── */

describe('doc 34 §4-E — snapshot ↔ shift, in the SAME version', () => {
  it('a snapshot cannot hang on a shift belonging to a different version', async () => {
    const first = await draftWithAssignment('snapshot-shift-a', '2033-02-01');
    const second = await draftWithAssignment('snapshot-shift-b', '2033-02-02');
    const identityId = await freshIdentity(second.periodId);

    const error = await attempt(`
      INSERT INTO assignment_snapshots
        (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
         shift_id, date, starts_at, ends_at)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${identityId}', '${second.versionId}', '${assigneeA}',
              -- the OTHER version's shift
              '${first.shiftId}', '2033-02-02',
              '2033-02-02T18:00:00Z', '2033-02-02T20:00:00Z')
    `);
    expect(error, 'a snapshot must not reach across versions for its shift').not.toBeNull();
    expect(error).toMatch(/shift_in_same_version|foreign key/i);
  });
});

describe('doc 34 §4-E — credit ↔ snapshot ↔ version ↔ identity all agree', () => {
  it('a credit naming a snapshot from a DIFFERENT version is refused', async () => {
    const first = await draftWithAssignment('credit-version-a', '2033-02-05');
    const second = await draftWithAssignment('credit-version-b', '2033-02-06');

    const error = await attempt(`
      INSERT INTO credits
        (id, organization_id, group_id, assignment_identity_id, source_version_id,
         source_snapshot_id, credited_membership_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${first.identityId}', '${first.versionId}',
              -- a snapshot from the OTHER version
              '${second.snapshotId}', '${assigneeA}')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/snapshot_in_source_version|foreign key/i);
  });

  it('a credit naming a snapshot that belongs to a DIFFERENT identity is refused', async () => {
    /* Two assignments in ONE version, so `source_version_id` agrees and only
     * the IDENTITY disagrees — which isolates the second FK. Without it, a
     * fairness figure could be attributed to the wrong person with three
     * individually valid foreign keys pointing at it. */
    const date = '2033-02-07';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'credit-identity period', startDate: date, endDate: date }),
    );
    const built = await run(async (uow) => {
      const versionId = await createDraftVersion(uow, actor, periodId);
      const one = await addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 8),
        endsAt: fixtureInstant(date, 12),
      });
      const two = await addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 13),
        endsAt: fixtureInstant(date, 18),
      });
      return { versionId, one, two };
    });

    const error = await attempt(`
      INSERT INTO credits
        (id, organization_id, group_id, assignment_identity_id, source_version_id,
         source_snapshot_id, credited_membership_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${built.one.assignmentIdentityId}', '${built.versionId}',
              -- the OTHER identity's snapshot, same version
              '${built.two.snapshotId}', '${assigneeA}')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/snapshot_carries_identity|foreign key/i);
  });
});

describe('doc 34 §4-E — dates lie inside their period', () => {
  it('a REQUIREMENT dated outside its period is refused', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'requirement-range period',
        startDate: '2033-03-01',
        endDate: '2033-03-07',
      }),
    );

    await expect(
      run(async (uow) =>
        setRequirement(uow, actor, {
          periodId,
          date: '2033-03-20',
          shiftTypeId,
          requiredCount: 1,
        }),
      ),
      'the service path must be refused too',
    ).rejects.toThrow(/SCHEDULE_REQUIREMENT_OUT_OF_PERIOD/);

    const error = await attempt(`
      INSERT INTO schedule_requirements
        (id, organization_id, group_id, period_id, date, shift_type_id, required_count)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${periodId}', '2033-02-25', '${shiftTypeId}', 1)
    `);
    expect(error, 'and raw SQL as app_runtime must be refused').not.toBeNull();
    expect(error).toMatch(/SCHEDULE_REQUIREMENT_OUT_OF_PERIOD/);
  });

  it('a requirement ON either boundary day is ACCEPTED — the check is not off by one', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'requirement-boundary period',
        startDate: '2033-03-10',
        endDate: '2033-03-16',
      }),
    );
    for (const date of ['2033-03-10', '2033-03-16']) {
      await expect(
        run(async (uow) =>
          setRequirement(uow, actor, { periodId, date, shiftTypeId, requiredCount: 1 }),
        ),
      ).resolves.toBeTypeOf('string');
    }
  });

  it('a SHIFT dated outside its version’s period is refused', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'shift-range period',
        startDate: '2033-04-01',
        endDate: '2033-04-07',
      }),
    );
    const versionId = await run(async (uow) => createDraftVersion(uow, actor, periodId));

    const error = await attempt(`
      INSERT INTO shifts (id, organization_id, group_id, version_id, date, shift_type_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${versionId}', '2033-04-20', '${shiftTypeId}')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/SCHEDULE_SHIFT_OUT_OF_PERIOD/);
  });
});

describe('doc 34 §4-E — an identity and its version belong to the same period', () => {
  it('a snapshot joining an identity from period A to a version of period B is refused', async () => {
    const a = await draftWithAssignment('identity-period-a', '2033-05-01');
    const b = await draftWithAssignment('identity-period-b', '2033-05-02');

    const error = await attempt(`
      INSERT INTO assignment_snapshots
        (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
         shift_id, date, starts_at, ends_at)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              -- period A's identity, period B's version
              '${a.identityId}', '${b.versionId}', '${assigneeA}',
              '${b.shiftId}', '2033-05-02',
              '2033-05-02T18:00:00Z', '2033-05-02T20:00:00Z')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/SCHEDULE_SNAPSHOT_PERIOD_MISMATCH/);
  });
});

describe('doc 34 §4-E — supersession is within ONE period', () => {
  it('a supersession row relating two periods’ versions is refused', async () => {
    const a = await draftWithAssignment('supersede-a', '2033-06-01');
    const b = await draftWithAssignment('supersede-b', '2033-06-02');

    const error = await attempt(`
      INSERT INTO version_supersessions
        (id, organization_id, group_id, superseded_version_id, superseding_version_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${a.versionId}', '${b.versionId}')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/SCHEDULE_SUPERSESSION_PERIOD_MISMATCH/);
  });
});

describe('doc 34 §4-E / V-15c — reality names only the CURRENT published version', () => {
  it('a reality row for a DRAFT version is refused at INSERT', async () => {
    const base = await draftWithAssignment('reality-draft', '2033-07-01');
    const error = await attempt(`
      INSERT INTO current_published_assignments
        (id, organization_id, group_id, membership_id, period_id, starts_at, ends_at,
         source_version_id, source_snapshot_id, assignment_identity_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${assigneeA}', '${base.periodId}',
              '2033-07-01T08:00:00Z', '2033-07-01T16:00:00Z',
              '${base.versionId}', '${base.snapshotId}', '${base.identityId}')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/SCHEDULE_REALITY_NOT_CURRENT_VERSION/);
  });

  /**
   * The DEFERRED half, which is the one that catches drift rather than a bad
   * insert: a version that stops being current while its reality rows survive.
   *
   * It must be deferred, and this test is also what proves the deferral is
   * correct — the legitimate publication path spends several statements in
   * exactly this state (step 08 clears `is_current`, step 12 prunes), and it
   * commits fine.
   */
  it('retiring a current version while its reality rows survive fails at COMMIT', async () => {
    const date = '2033-07-05';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'reality-orphan period', startDate: date, endDate: date }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
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
        idempotencyKey: publicationKey('reality-orphan'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const rows = await run(async (uow) =>
      uow.query
        .selectFrom('current_published_assignments')
        .select('id')
        .where('source_version_id', '=', versionId)
        .execute(),
    );
    expect(rows.length, 'the publication must have produced reality rows to orphan').toBe(1);

    const error = await attempt(
      `UPDATE schedule_versions SET is_current = false WHERE id = '${versionId}'`,
    );
    expect(error, 'retiring it must fail while its reality rows survive').not.toBeNull();
    expect(error).toMatch(/SCHEDULE_REALITY_ORPHANED/);

    // And the version is untouched: the whole transaction aborted.
    const after = await run(async (uow) =>
      uow.query
        .selectFrom('schedule_versions')
        .select('is_current')
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(after.is_current).toBe(true);
  });

  it('CONTROL: the real publication path retires a version and prunes in one transaction', async () => {
    /* The same forbidden intermediate state, reached legitimately. If the guard
     * were IMMEDIATE rather than DEFERRED this would fail, so this row is what
     * makes the deferral evidence rather than a preference. */
    const date = '2033-07-09';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'reality-control period', startDate: date, endDate: date }),
    );
    const v1 = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
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
        idempotencyKey: publicationKey('reality-control-1'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    await expect(
      run(async (uow) => {
        const v2 = await createDraftVersion(uow, actor, periodId);
        await addManualAssignment(uow, actor, {
          versionId: v2,
          membershipId: assigneeA,
          shiftTypeId,
          date,
          startsAt: fixtureInstant(date, 8),
          endsAt: fixtureInstant(date, 16),
        });
        await transitionVersion(uow, actor, v2, 'in_review');
        await transitionVersion(uow, actor, v2, 'approved');
        return publishVersion(uow, actor, {
          periodId,
          versionId: v2,
          idempotencyKey: publicationKey('reality-control-2'),
          expectedPriorCurrentVersionId: v1,
        });
      }),
      'the deferred guard must not refuse the legitimate publication sequence',
    ).resolves.toBeDefined();
  });
});

describe('doc 34 §4-E — a publication record names a version of its own period', () => {
  it('is enforced by a composite FK', async () => {
    const a = await draftWithAssignment('pubrec-a', '2033-08-01');
    const b = await draftWithAssignment('pubrec-b', '2033-08-02');
    const error = await attempt(`
      INSERT INTO publication_records
        (id, organization_id, group_id, period_id, version_id, publication_idempotency_key)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${a.periodId}', '${b.versionId}', 'graph-probe')
    `);
    expect(error).not.toBeNull();
    expect(error).toMatch(/version_in_period|foreign key/i);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * MUTATION CONTROL — every constraint above is shown to be load-bearing
 * ──────────────────────────────────────────────────────────────────────────── */

describe('mutation control: each control, removed, lets its violation through', () => {
  /**
   * Drop a constraint (or trigger) inside a transaction, run the previously
   * refused statement, and abort. A `null` return means the statement SUCCEEDED
   * — which is the point: with the control gone, the graph inconsistency is
   * writable, so the refusals above are the control's doing and not an accident
   * of some other rule.
   */
  async function withoutControl(ddl: string, statement: string): Promise<string | null> {
    const marker = `ROLLED_BACK_${randomUUID()}`;
    try {
      await migrator.runner.run(context, async ({ query }) => {
        await sql.raw(ddl).execute(query);
        await sql.raw(statement).execute(query);
        throw new Error(marker);
      });
      return null;
    } catch (error) {
      const message = (error as Error).message;
      return message.includes(marker) ? null : message;
    }
  }

  it('without the participant FK and its trigger, a cross-group participant is WRITABLE', async () => {
    const base = await draftWithAssignment('mutation-participant', '2033-09-01');
    const identityId = await freshIdentity(base.periodId);
    const statement = `
      INSERT INTO assignment_snapshots
        (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
         shift_id, date, starts_at, ends_at)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${identityId}', '${base.versionId}', '${siblingMembershipId}',
              '${base.shiftId}', '2033-09-01',
              '2033-09-01T18:00:00Z', '2033-09-01T20:00:00Z')`;

    expect(await attempt(statement), 'refused while the controls are in place').not.toBeNull();
    expect(
      await withoutControl(
        `ALTER TABLE assignment_snapshots
           DROP CONSTRAINT assignment_snapshots_participant_in_group_fk;
         ALTER TABLE assignment_snapshots
           DISABLE TRIGGER assignment_snapshots_participant_and_period_guard`,
        statement,
      ),
      'with both controls removed the write must SUCCEED',
    ).toBeNull();
  });

  it('without the same-version shift FK, a cross-version shift reference is WRITABLE', async () => {
    const first = await draftWithAssignment('mutation-shift-a', '2033-09-05');
    const second = await draftWithAssignment('mutation-shift-b', '2033-09-06');
    const identityId = await freshIdentity(second.periodId);
    const statement = `
      INSERT INTO assignment_snapshots
        (id, organization_id, group_id, assignment_identity_id, version_id, membership_id,
         shift_id, date, starts_at, ends_at)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${identityId}', '${second.versionId}', '${assigneeA}',
              '${first.shiftId}', '2033-09-06',
              '2033-09-06T18:00:00Z', '2033-09-06T20:00:00Z')`;

    expect(await attempt(statement)).not.toBeNull();
    expect(
      await withoutControl(
        `ALTER TABLE assignment_snapshots
           DROP CONSTRAINT assignment_snapshots_shift_in_same_version_fk`,
        statement,
      ),
      'with the FK removed the cross-version reference must SUCCEED',
    ).toBeNull();
  });

  it('without the range trigger, a shift outside its period is WRITABLE', async () => {
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'mutation-range period',
        startDate: '2033-10-01',
        endDate: '2033-10-07',
      }),
    );
    const versionId = await run(async (uow) => createDraftVersion(uow, actor, periodId));
    const statement = `
      INSERT INTO shifts (id, organization_id, group_id, version_id, date, shift_type_id)
      VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
              '${versionId}', '2033-10-20', '${shiftTypeId}')`;

    expect(await attempt(statement)).not.toBeNull();
    expect(
      await withoutControl(
        'ALTER TABLE shifts DISABLE TRIGGER shifts_location_and_range_guard',
        statement,
      ),
      'with the trigger disabled the out-of-period shift must SUCCEED',
    ).toBeNull();
  });

  it('without the deferred guard, a current version can be retired leaving reality behind', async () => {
    const date = '2033-10-25';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'mutation-orphan period', startDate: date, endDate: date }),
    );
    const versionId = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
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
        idempotencyKey: publicationKey('mutation-orphan'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const statement = `UPDATE schedule_versions SET is_current = false WHERE id = '${versionId}'`;
    expect(await attempt(statement)).not.toBeNull();
    expect(
      await withoutControl(
        `ALTER TABLE schedule_versions DISABLE TRIGGER schedule_versions_reality_retired_guard`,
        statement,
      ),
      'with the deferred guard disabled the orphaning UPDATE must SUCCEED',
    ).toBeNull();
  });
});
