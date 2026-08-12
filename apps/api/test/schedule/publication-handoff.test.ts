import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { createRule } from '../../src/rules/service.js';
import { differenceByIdentity, type DiffSnapshot } from '../../src/schedule/diff.js';
import { transitionPeriodStatus } from '../../src/schedule/publication.js';
import { grantHolding } from '../../src/profiles/qualifications.js';
import { authorWorkProfile } from '../../src/profiles/work-profiles.js';
import {
  MATERIAL_FIELDS,
  MATERIAL_INPUT_CLASSES,
  composeMaterialInputDigest,
  materialChangeFields,
  materialInputDigest,
  materialInputDigests,
  materialStakeholders,
  semanticRequestDigest,
  type MaterialAssignment,
} from '../../src/schedule/review-identity.js';
import {
  addManualAssignment,
  cloneCredits,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  moveCredit,
  recordConflict,
  setPin,
  setRequirement,
  voidCredit,
} from '../../src/schedule/service.js';
import { adminClient } from '../support/admin-client.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';

/**
 * **Named proof — the publication handoff** (OPUS-M4-000C; doc 34 §4-G).
 *
 * Four properties, each of which was a gap rather than a risk:
 *
 *  1. **One material-change definition.** `differenceByIdentity` compared the
 *     participant and the two instants and NOTHING else, so moving an
 *     assignment's shift type, location, pin or credit produced no diff row and
 *     notified nobody. The definition now lives in `review-identity.ts` and this
 *     asserts the diff and the affected-participant union are computed FROM it,
 *     rather than agreeing with it by coincidence.
 *
 *  2. **The review identity covers every material input.** All NINE input
 *     classes are moved ONE AT A TIME, and each arm asserts both that its own
 *     class digest moved AND that the COMPOSITE moved — a class that moved its
 *     own digest without reaching the compare-and-set token would be a class the
 *     CAS ignores. A tenth arm asserts the matrix covers exactly the classes the
 *     digest declares, so it cannot silently shrink.
 *
 *     This claim was previously larger than its proof: it said nine and proved
 *     three (independent review C-1). Two of the six missing classes could not
 *     have bitten at all, because `profiles` and `qualifications` are read per
 *     INVOLVED membership and the old fixture's version had no assignments.
 *
 *  3. **A closed period refuses new versions, requirements and publications**,
 *     and the ONLY way past that is the explicit audited transition.
 *
 *  4. **A clone preserves credits.** It did not, so a revert — which is a
 *     clone-then-publish — silently undid every credit move it existed to
 *     restore. Probed against a crafted set including a MOVED credit and a
 *     VOIDED one, because a voided credit is a record and not an absence.
 */

const multi = ownedMulti('publication-handoff', {
  profile: 'full',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

function context(correlationId = 'publication-handoff'): ReturnType<typeof groupContext> {
  const alpha = multi().alpha;
  return groupContext(
    alpha.organizationId,
    alpha.groupOne.id,
    alpha.users.scheduler.membershipId,
    correlationId,
  );
}

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context(), fn);

const actor = (): ReturnType<typeof scheduleActor> =>
  scheduleActor(multi().alpha.users.scheduler.id);

/**
 * A period with a range no other test in this file uses.
 *
 * D-2 forbids overlapping periods per group, so a shared fortnight makes the
 * SECOND test in a describe fail on an exclusion violation that has nothing to
 * do with what it is testing. The counter is monotonic within the file, so every
 * period lands in its own week and the refusals under test are the only ones.
 */
let periodCursor = 0;

/**
 * A period, and THE DATES INSIDE IT.
 *
 * The range is returned because 000B's `shifts ↔ period date range` invariant
 * refuses a shift outside its period (`SCHEDULE_SHIFT_OUT_OF_PERIOD`). Tests
 * that minted a period here and then hard-coded assignment dates from some other
 * year were relying on nothing checking — and now something does. Returning the
 * range means a caller cannot pick a date that is not in it without saying so.
 */
async function freshPeriod(label: string): Promise<{
  readonly id: string;
  readonly start: string;
  readonly end: string;
  /** A date inside the period. `offset` 0 is the first day. */
  dayIn(offset: number): string;
}> {
  periodCursor += 1;
  const day = 1 + periodCursor * 7;
  const iso = (value: Date): string => value.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(2034, 0, day));
  const end = new Date(Date.UTC(2034, 0, day + 5));
  const id = await run((uow) =>
    createPeriod(uow, actor(), {
      name: `${label}-${randomUUID().slice(0, 8)}`,
      startDate: iso(start),
      endDate: iso(end),
    }),
  );
  return {
    id,
    start: iso(start),
    end: iso(end),
    dayIn: (offset: number) => iso(new Date(Date.UTC(2034, 0, day + offset))),
  };
}

/** A `MaterialAssignment` with every dimension fixed, so one field moves at a time. */
function material(overrides: Partial<MaterialAssignment> = {}): MaterialAssignment {
  return {
    assignmentIdentityId: 'identity-1',
    membershipId: 'member-a',
    date: '2034-03-04',
    startsAtMs: Date.UTC(2034, 2, 4, 8),
    endsAtMs: Date.UTC(2034, 2, 4, 16),
    shiftTypeId: 'shift-type-1',
    locationId: null,
    isPinned: false,
    creditedMembershipId: null,
    creditWeight: null,
    ...overrides,
  };
}

/** The same, as a `DiffSnapshot`, so the diff is driven by the SAME facts. */
function snapshot(overrides: Partial<MaterialAssignment> = {}): DiffSnapshot {
  const value = material(overrides);
  return {
    assignmentIdentityId: value.assignmentIdentityId,
    membershipId: value.membershipId,
    startsAt: new Date(value.startsAtMs),
    endsAt: new Date(value.endsAtMs),
    status: 'active',
    date: value.date,
    shiftTypeId: value.shiftTypeId,
    locationId: value.locationId,
    isPinned: value.isPinned,
    creditedMembershipId: value.creditedMembershipId,
    creditWeight: value.creditWeight,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. One material-change definition
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the difference is computed FROM the one material-change definition', () => {
  const MOVES: readonly { field: (typeof MATERIAL_FIELDS)[number]; change: Partial<MaterialAssignment> }[] =
    [
      { field: 'participant', change: { membershipId: 'member-b' } },
      { field: 'date', change: { date: '2034-03-05' } },
      { field: 'time', change: { startsAtMs: Date.UTC(2034, 2, 4, 9) } },
      { field: 'shiftType', change: { shiftTypeId: 'shift-type-2' } },
      { field: 'location', change: { locationId: 'location-1' } },
      { field: 'pin', change: { isPinned: true } },
      { field: 'credit', change: { creditedMembershipId: 'member-c', creditWeight: '1.0000' } },
    ];

  it('every material dimension is detected, one at a time', () => {
    for (const move of MOVES) {
      expect(materialChangeFields(material(), material(move.change)), move.field).toEqual([
        move.field,
      ]);
    }
    // …and the sweep covers the whole closed set, so a dimension added to the
    // definition without a case here fails rather than going untested.
    expect(new Set(MOVES.map((move) => move.field))).toEqual(new Set(MATERIAL_FIELDS));
  });

  it('EVERY material dimension produces a diff row — the gap this closes', () => {
    for (const move of MOVES) {
      const difference = differenceByIdentity([snapshot()], [snapshot(move.change)]);
      expect(difference.changes, `${move.field} produced no change`).toHaveLength(1);
      expect(difference.changes[0]?.materialFields).toEqual([move.field]);
    }
  });

  it('the diff SUMMARY never claims more than the definition found', () => {
    const kindOf = (change: Partial<MaterialAssignment>): string | undefined =>
      differenceByIdentity([snapshot()], [snapshot(change)]).changes[0]?.kind;

    expect(kindOf({ membershipId: 'member-b' })).toBe('reassigned');
    expect(kindOf({ startsAtMs: Date.UTC(2034, 2, 4, 9) })).toBe('retimed');
    // The three that were previously INVISIBLE.
    expect(kindOf({ shiftTypeId: 'shift-type-2' })).toBe('amended');
    expect(kindOf({ locationId: 'location-1' })).toBe('amended');
    expect(kindOf({ isPinned: true })).toBe('amended');
  });

  it('identical content is NOT a change, and its holder is not affected', () => {
    const difference = differenceByIdentity([snapshot()], [snapshot()]);
    expect(difference.changes).toEqual([]);
    expect(difference.affectedMembershipIds).toEqual([]);
  });

  it('the affected union uses the SAME definition, and includes the credited membership', () => {
    /* "Who works a shift and who is scored for it can legitimately differ" (doc
     * 07). A credit moved from A to B affects two people, neither of whom need
     * be the assignee — and before this packet it affected nobody at all. */
    const before = snapshot({ creditedMembershipId: 'member-x', creditWeight: '1.0000' });
    const after = snapshot({ creditedMembershipId: 'member-y', creditWeight: '1.0000' });
    const difference = differenceByIdentity([before], [after]);

    expect(difference.affectedMembershipIds).toEqual(['member-a', 'member-x', 'member-y'].sort());
    // The union is exactly the stakeholders of both sides, from the definition.
    expect(new Set(difference.affectedMembershipIds)).toEqual(
      new Set([...materialStakeholders(material(before)), ...materialStakeholders(material(after))]),
    );
  });

  it('a reassignment affects BOTH people — the defect the union exists to prevent', () => {
    const difference = differenceByIdentity(
      [snapshot({ membershipId: 'member-a' })],
      [snapshot({ membershipId: 'member-b' })],
    );
    expect(difference.affectedMembershipIds).toEqual(['member-a', 'member-b']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The review identity covers every material input
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the review identity covers every material input — the NINE-CLASS MATRIX', () => {
  /**
   * **The condition this closes (independent review C-1).**
   *
   * The previous version of this block claimed "each of the nine input classes
   * is moved ONE AT A TIME and the digest must move" and proved exactly three:
   * `ruleRevisions`, `demand` and `timezone`. The reviewer showed that the other
   * six could each be replaced by a constant with the whole suite staying green
   * — coverage, not breakage, but the digest is the publication compare-and-set
   * token and doc 35 §7's bar applies: a control that has only ever been
   * observed passing is not evidence.
   *
   * Two of the six could not have bitten at all as the fixture stood.
   * `profiles` and `qualifications` are read per involved membership, and
   * "involved" is derived from the version's assignments and credits — so
   * against a version with NO assignments both classes are empty and no change
   * to anybody's profile or credential can move them. That is correct by design
   * (a profile change for somebody who is not on this schedule cannot affect
   * this publication) and it is exactly why the fixture below carries real
   * assignments.
   *
   * Each arm asserts BOTH halves, and the second is the one that makes it a
   * matrix rather than nine smoke tests:
   *
   *   1. the TARGET class digest moved — the class bites;
   *   2. the COMPOSITE moved — the class actually reaches the CAS token.
   *
   * A class that moved its own digest without moving the composite would be a
   * class the compare-and-set ignores, which is the failure mode worth catching.
   */

  let period: string;
  let version: string;
  let assignee: string;
  let secondIdentity: string;
  let secondSnapshot: string;
  let shiftTypeId: string;
  /* Dates DERIVED from the period, not typed beside it: 000B's shift ↔ period
   * range invariant refuses anything outside, and a hard-coded date is only
   * correct until the period cursor moves. */
  let matrixDayOne: string;
  let matrixDayTwo: string;

  beforeAll(async () => {
    const alpha = multi().alpha;
    const seeded = multi().catalogue?.alpha?.shiftTypeIds[0];
    if (seeded === undefined) throw new Error('needs the alpha catalogue seed');
    shiftTypeId = seeded;
    assignee = alpha.users.scheduler.membershipId;

    const window = await freshPeriod('digest-matrix');
    period = window.id;
    matrixDayOne = window.dayIn(1);
    matrixDayTwo = window.dayIn(2);
    version = await run((uow) => createDraftVersion(uow, actor(), period));

    /* REAL assignments, so `involved` is non-empty and the profiles and
     * qualifications classes are reachable at all. */
    const added = await run(async (uow) => {
      const first = await addManualAssignment(uow, actor(), {
        versionId: version,
        membershipId: assignee,
        shiftTypeId,
        date: matrixDayOne,
        startsAt: fixtureInstant(matrixDayOne, 8),
        endsAt: fixtureInstant(matrixDayOne, 16),
      });
      const second = await addManualAssignment(uow, actor(), {
        versionId: version,
        membershipId: assignee,
        shiftTypeId,
        date: matrixDayTwo,
        startsAt: fixtureInstant(matrixDayTwo, 8),
        endsAt: fixtureInstant(matrixDayTwo, 16),
      });
      return { first, second };
    });
    /* The snapshot and the identity must be the SAME assignment. The first
     * spelling paired `second.assignmentIdentityId` with `first.snapshotId`,
     * which 000B's new `credits_snapshot_carries_identity_fk` refused outright —
     * a credit pointing at a snapshot that does not carry its identity. The FK
     * caught a real inconsistency in this fixture, which is what it is for. */
    secondSnapshot = added.second.snapshotId;
    secondIdentity = added.second.assignmentIdentityId;

    /* Everything the matrix's mutations need a capability for.
     *
     * Granted ONE AT A TIME and tolerantly: the MULTI fixture already grants
     * some of these to the scheduler, and `capability_grants_no_overlapping_window`
     * (correctly) refuses a second overlapping grant of the same capability. The
     * refusal means "already held", which is exactly the state the matrix needs
     * — so it is absorbed per capability rather than by widening the grant
     * helper, which every other file depends on. */
    for (const capability of [
      'group.timezone.administer',
      'schedule.catalogue.administer',
      'staffing.work_profile.administer',
      'staffing.qualification_holding.administer',
    ]) {
      try {
        await grantStaffingCapabilities(runtime.runner, multi(), {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          membershipId: assignee,
          capabilities: [capability],
        });
      } catch (error) {
        if (!String(error).includes('capability_grants_no_overlapping_window')) throw error;
      }
    }
  }, 120_000);

  /**
   * Apply one mutation and assert the named class — and the composite — moved.
   *
   * The BEFORE digest is read immediately before the mutation rather than once
   * for the whole block, so the arms are independent of each other and of the
   * order they run in.
   */
  async function assertClassBites(
    className: keyof Awaited<ReturnType<typeof materialInputDigests>>,
    mutate: () => Promise<void>,
  ): Promise<void> {
    const before = await run((uow) => materialInputDigests(uow, period, version));
    const beforeComposite = composeMaterialInputDigest(before);

    await mutate();

    const after = await run((uow) => materialInputDigests(uow, period, version));
    const afterComposite = composeMaterialInputDigest(after);

    expect(after[className], `the ${className} class did not move`).not.toBe(before[className]);
    expect(afterComposite, `the ${className} class did not reach the CAS token`).not.toBe(
      beforeComposite,
    );
  }

  it('1/9 assignments — pinning an assignment moves the digest', async () => {
    // A pin is a SOLVER INPUT, not a display flag: unpinning changes what a
    // build may do, so a review that did not notice it would be stale.
    await assertClassBites('assignments', async () => {
      await run((uow) => setPin(uow, actor(), version, secondIdentity, true));
    });
  });

  it('2/9 credits — moving a credit moves the digest', async () => {
    await assertClassBites('credits', async () => {
      await run((uow) =>
        moveCredit(uow, actor(), {
          versionId: version,
          assignmentIdentityId: secondIdentity,
          snapshotId: secondSnapshot,
          creditedMembershipId: multi().alpha.users.member.membershipId,
        }),
      );
    });
  });

  it('3/9 conflicts — recording a conflict moves the digest', async () => {
    // `info`, deliberately: a hard breach would block the publication, and the
    // property under test is that the REVIEW notices, not that publication stops.
    await assertClassBites('conflicts', async () => {
      await run((uow) =>
        recordConflict(uow, actor(), {
          versionId: version,
          severity: 'info',
          explanation: 'digest matrix probe',
        }),
      );
    });
  });

  it('4/9 ruleRevisions — authoring a rule moves the digest, though the schedule did not change', async () => {
    await assertClassBites('ruleRevisions', async () => {
      const ruleKey = `matrix_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
      await run(async (uow) => {
        const created = await createRule(uow, {
          ruleKey,
          name: 'Digest matrix probe',
          classification: 'HARD',
          scope: {},
          predicate: { kind: 'MaxConsecutive', maxDays: 4 },
        } as never);
        expect(created.kind).toBe('ok');
      });
    });
  });

  it('5/9 catalogueRevisions — a shift-type revision moves the digest', async () => {
    await assertClassBites('catalogueRevisions', async () => {
      await run(async (uow) => {
        await uow.query
          .updateTable('shift_types')
          .set({ name: `Renamed ${randomUUID().slice(0, 8)}` })
          .where('id', '=', shiftTypeId)
          .execute();
      });
    });
  });

  it('6/9 profiles — a work profile for an INVOLVED membership moves the digest', async () => {
    /* The class the old fixture could not reach. It is read per involved
     * membership, and `assignee` is involved because they hold both assignments
     * above. */
    await assertClassBites('profiles', async () => {
      await run((uow) =>
        authorWorkProfile(uow, {
          membershipId: assignee,
          workPercentage: 60,
          maxAssignmentsPerWeek: 4,
        }),
      );
    });
  });

  it('7/9 qualifications — a holding for an INVOLVED membership moves the digest', async () => {
    /* A HOLDING on the fixture's own qualification, rather than a new
     * qualification: it is the smaller mutation, it exercises the half that is
     * read through the one in-force selector, and a credential appearing for
     * somebody already on this schedule is the case a reviewer most needs the
     * digest to notice — it changes who is eligible without touching a shift. */
    const qualificationId = multi().catalogue?.alpha?.qualificationId;
    if (qualificationId === undefined) throw new Error('needs the alpha catalogue seed');

    await assertClassBites('qualifications', async () => {
      await run((uow) =>
        grantHolding(uow, {
          membershipId: assignee,
          qualificationId,
          status: 'valid',
        }),
      );
    });
  });

  it('8/9 demand — a period requirement moves the digest', async () => {
    await assertClassBites('demand', async () => {
      await run((uow) =>
        setRequirement(uow, actor(), {
          periodId: period,
          date: matrixDayOne,
          shiftTypeId,
          requiredCount: 3,
        }),
      );
    });
  });

  it('9/9 timezone — the GROUP timezone moves the digest', async () => {
    const alpha = multi().alpha;
    const original = await run(async (uow) => {
      const row = await uow.query
        .selectFrom('groups')
        .select(['timezone'])
        .where('id', '=', alpha.groupOne.id)
        .executeTakeFirst();
      return row?.timezone ?? 'UTC';
    });
    try {
      await assertClassBites('timezone', async () => {
        await run(async (uow) => {
          await uow.query
            .updateTable('groups')
            .set({ timezone: 'Pacific/Kiritimati' })
            .where('id', '=', alpha.groupOne.id)
            .execute();
        });
      });
    } finally {
      await run(async (uow) => {
        await uow.query
          .updateTable('groups')
          .set({ timezone: original })
          .where('id', '=', alpha.groupOne.id)
          .execute();
      });
    }
  });

  it('the matrix covers EVERY class the digest declares — it cannot silently shrink', () => {
    /* The control on the matrix itself. A tenth input class added to
     * `Material_INPUT_CLASSES` without an arm here would otherwise be
     * unfalsified while this block still claimed to cover "every" class — which
     * is precisely the overclaim the review found. */
    expect([...MATERIAL_INPUT_CLASSES].sort()).toEqual(
      [
        'assignments',
        'catalogueRevisions',
        'conflicts',
        'credits',
        'demand',
        'profiles',
        'qualifications',
        'ruleRevisions',
        'timezone',
      ].sort(),
    );
  });

  it('is STABLE when nothing material moves — it is not a clock', async () => {
    const first = await run((uow) => materialInputDigest(uow, period, version));
    const second = await run((uow) => materialInputDigest(uow, period, version));
    expect(second).toBe(first);
  });
});

describe('the semantic request identity distinguishes operations', () => {
  it('a publish and a revert of the same version are different requests', () => {
    const base = {
      periodId: 'p1',
      versionId: 'v1',
      expectedVersionState: 'approved',
      expectedPriorCurrentVersionId: null,
      revertedToVersionId: null,
    } as const;
    expect(semanticRequestDigest({ ...base, operation: 'publish' })).not.toBe(
      semanticRequestDigest({ ...base, operation: 'revert' }),
    );
    // …and a revert to a DIFFERENT historical version is a different request too.
    expect(
      semanticRequestDigest({ ...base, operation: 'revert', revertedToVersionId: 'v3' }),
    ).not.toBe(semanticRequestDigest({ ...base, operation: 'revert', revertedToVersionId: 'v4' }));
    // …and the same request digests identically, or the check would refuse
    // every legitimate retry.
    expect(semanticRequestDigest({ ...base, operation: 'publish' })).toBe(
      semanticRequestDigest({ ...base, operation: 'publish' }),
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The closed-period refusal matrix
 * ──────────────────────────────────────────────────────────────────────────── */

describe('a closed period refuses new work, at the DATABASE', () => {
  async function closedPeriod(): Promise<string> {
    const period = (await freshPeriod('handoff-closed')).id;
    await run((uow) => transitionPeriodStatus(uow, actor(), period, 'closed'));
    return period;
  }

  it('refuses a new VERSION', async () => {
    const period = await closedPeriod();
    await expect(run((uow) => createDraftVersion(uow, actor(), period))).rejects.toThrow(
      /PERIOD_CLOSED/,
    );
  });

  it('refuses a new REQUIREMENT', async () => {
    const period = await closedPeriod();
    const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
    if (shiftTypeId === undefined) throw new Error('needs the alpha catalogue seed');
    await expect(
      run((uow) =>
        setRequirement(uow, actor(), {
          periodId: period,
          date: '2035-01-02',
          shiftTypeId,
          requiredCount: 1,
        }),
      ),
    ).rejects.toThrow(/PERIOD_CLOSED/);
  });

  it('refuses a version already in the period being walked to PUBLISHED', async () => {
    /* The direct arm. Refusing new versions makes publishing into a closed
     * period unreachable by the ordinary route; this proves the property does
     * not depend on that reasoning holding forever. */
    const period = (await freshPeriod('handoff-closed-pub')).id;
    const version = await run((uow) => createDraftVersion(uow, actor(), period));
    await run((uow) => transitionPeriodStatus(uow, actor(), period, 'closed'));

    await expect(
      admin.query(`update schedule_versions set state = 'published' where id = $1`, [version]),
    ).rejects.toThrow(/PERIOD_CLOSED/);
  });

  it('the EXPLICIT AUDITED TRANSITION is the only way past, and it is audited', async () => {
    const period = await closedPeriod();

    const before = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where subject_id = $1 and payload->>'mechanism' = 'status_transition'`,
      [period],
    );

    const result = await run((uow) => transitionPeriodStatus(uow, actor(), period, 'planning'));
    expect(result).toEqual({ periodId: period, from: 'closed', to: 'planning' });

    // Reopened: the same write that was refused now succeeds.
    await expect(run((uow) => createDraftVersion(uow, actor(), period))).resolves.toBeTruthy();

    const after = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where subject_id = $1 and payload->>'mechanism' = 'status_transition'`,
      [period],
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
  });

  it('refuses an ILLEGAL transition, and does not audit a no-op', async () => {
    const period = await closedPeriod();
    // closed -> published is deliberately absent: a reopen goes through
    // `planning`, so reopening and republishing are two recorded acts.
    await expect(
      run((uow) => transitionPeriodStatus(uow, actor(), period, 'published')),
      // `SchedulePreconditionError` carries the CODE separately from the
      // message, so the assertion is on the sentence a caller actually sees.
    ).rejects.toThrow(/does not move from closed to published/);

    const before = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events where subject_id = $1`,
      [period],
    );
    await run((uow) => transitionPeriodStatus(uow, actor(), period, 'closed'));
    const after = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events where subject_id = $1`,
      [period],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. A clone preserves credits
 * ──────────────────────────────────────────────────────────────────────────── */

describe('a clone preserves credits', () => {
  it('carries a MOVED credit and a VOIDED one, re-keyed to the clone', async () => {
    const alpha = multi().alpha;
    const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
    if (shiftTypeId === undefined) throw new Error('needs the alpha catalogue seed');

    const window = await freshPeriod('handoff-credits');
    const period = window.id;
    const dayOne = window.dayIn(1);
    const dayTwo = window.dayIn(2);
    const source = await run((uow) => createDraftVersion(uow, actor(), period));

    // Two assignments, so one credit can be moved and one voided.
    const added = await run(async (uow) => {
      const first = await addManualAssignment(uow, actor(), {
        versionId: source,
        membershipId: alpha.users.scheduler.membershipId,
        shiftTypeId,
        date: dayOne,
        startsAt: fixtureInstant(dayOne, 8),
        endsAt: fixtureInstant(dayOne, 16),
      });
      const second = await addManualAssignment(uow, actor(), {
        versionId: source,
        membershipId: alpha.users.scheduler.membershipId,
        shiftTypeId,
        date: dayTwo,
        startsAt: fixtureInstant(dayTwo, 8),
        endsAt: fixtureInstant(dayTwo, 16),
      });
      return { first, second };
    });

    /* A credit MOVED to somebody who is not the assignee, and a credit VOIDED.
     * `groupTwoScheduler` is used only as a DIFFERENT membership id here — the
     * point is that the credited party is not the assignee, which is the case
     * the separation of credit from assignment exists for. */
    const creditedTo = alpha.users.member.membershipId;
    const voidedId = await run(async (uow) => {
      await moveCredit(uow, actor(), {
        versionId: source,
        assignmentIdentityId: added.first.assignmentIdentityId,
        snapshotId: added.first.snapshotId,
        creditedMembershipId: creditedTo,
        weight: 2,
        reason: 'handoff probe',
      });
      const id = await moveCredit(uow, actor(), {
        versionId: source,
        assignmentIdentityId: added.second.assignmentIdentityId,
        snapshotId: added.second.snapshotId,
        creditedMembershipId: creditedTo,
      });
      await voidCredit(uow, actor(), id);
      return id;
    });
    expect(voidedId).toBeTruthy();

    const clone = await run((uow) => cloneVersion(uow, actor(), source));

    const sourceCredits = await admin.query<{
      assignment_identity_id: string;
      credited_membership_id: string;
      weight: string;
      status: string;
      source_snapshot_id: string;
    }>(
      `select assignment_identity_id, credited_membership_id, weight, status, source_snapshot_id
         from credits where source_version_id = $1 order by assignment_identity_id`,
      [source],
    );
    const cloneCreditRows = await admin.query<{
      assignment_identity_id: string;
      credited_membership_id: string;
      weight: string;
      status: string;
      source_snapshot_id: string;
    }>(
      `select assignment_identity_id, credited_membership_id, weight, status, source_snapshot_id
         from credits where source_version_id = $1 order by assignment_identity_id`,
      [clone],
    );

    // COUNT — every credit came across, the voided one included.
    expect(cloneCreditRows.rowCount).toBe(sourceCredits.rowCount);
    expect(sourceCredits.rowCount).toBe(2);

    // VALUES — credited membership, weight and status carried verbatim.
    expect(
      cloneCreditRows.rows.map((row) => ({
        identity: row.assignment_identity_id,
        credited: row.credited_membership_id,
        weight: row.weight,
        status: row.status,
      })),
    ).toEqual(
      sourceCredits.rows.map((row) => ({
        identity: row.assignment_identity_id,
        credited: row.credited_membership_id,
        weight: row.weight,
        status: row.status,
      })),
    );
    // The voided credit is a RECORD, not an absence — it must be in the clone.
    expect(cloneCreditRows.rows.some((row) => row.status === 'voided')).toBe(true);

    // KEYING — each cloned credit points at the CLONE's own snapshot, never the
    // source's. A cross-version reference would look correct and resolve wrongly.
    const cloneSnapshots = await admin.query<{ id: string }>(
      'select id from assignment_snapshots where version_id = $1',
      [clone],
    );
    const cloneSnapshotIds = new Set(cloneSnapshots.rows.map((row) => row.id));
    const sourceSnapshotIds = new Set(sourceCredits.rows.map((row) => row.source_snapshot_id));
    for (const row of cloneCreditRows.rows) {
      expect(cloneSnapshotIds.has(row.source_snapshot_id)).toBe(true);
      expect(sourceSnapshotIds.has(row.source_snapshot_id)).toBe(false);
    }
  });

  it('cloning into an EMPTY target copies nothing rather than dangling', async () => {
    // A credit whose identity the target does not carry is skipped, not pointed
    // at a foreign snapshot: a dangling reference that still looks correct is the
    // failure mode `assignment_identities` exists to prevent.
    const period = (await freshPeriod('handoff-empty')).id;
    const empty = await run((uow) => createDraftVersion(uow, actor(), period));
    const other = await run((uow) => createDraftVersion(uow, actor(), period));
    expect(await run((uow) => cloneCredits(uow, empty, other))).toBe(0);
  });
});
