import {
  SNAPSHOT_REFUSAL_REASONS,
  SnapshotRefusedError,
  snapshotRefusals,
  type SnapshotRefusalReason,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';
import { solverInputSnapshotSchema } from '@schedulepoint/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { addManualAssignment, createDraftVersion } from '../../src/schedule/service.js';
import { setTimezone } from '../../src/settings/service.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { seedSolverFixture, type SolverFixture } from '../support/solver.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — canonical input assembly, and every refusal class**
 * (OPUS-M4-001; doc 35 §6a, SPEC-04 §3.4).
 *
 * The packet requires that "every refusal class (ambiguous, stale [revision
 * moved since read], cross-group, inactive participant, invalid date, missing
 * required input) is a typed refusal with a test", and that the refusal happens
 * **before worker invocation**. "Before" is the whole design: a build that
 * dispatched an ambiguous or stale problem and discovered the fact from the
 * result would have burned a solve and — far worse — would have a candidate
 * schedule in hand that looks exactly like a good one.
 *
 * ## Two layers, deliberately
 *
 * Each class is proven against `snapshotRefusals` **directly**, because it is a
 * pure total function and a reviewer's probe can hand-build the pathological
 * document. Three of the six are then proven again **through the real database**,
 * because those are the ones an assembly can actually produce:
 *
 * | Class | Direct | Through the database |
 * |---|---|---|
 * | `missing-required-input` | ✓ | ✓ a period with no demand |
 * | `stale-revision` | ✓ | ✓ a rule amended after the caller read it, and a moved timezone basis (R-B7) |
 * | `inactive-participant` | ✓ | ✓ a pinned assignment whose member is then suspended |
 * | `invalid-date` | ✓ | refused UPSTREAM by 0014's calendar constraints — stated, not claimed |
 * | `cross-group` | ✓ | structurally unreachable under 0014's composite FKs — stated, not claimed |
 * | `ambiguous` | ✓ | unreachable: the unique constraints already refuse it |
 *
 * Saying which arms the database makes unreachable is the point of the table. An
 * "unreachable" arm asserted through a contrived fixture would be testing the
 * fixture.
 *
 * ## Mutation control (FAD-15)
 *
 * The last case asserts that a well-formed document produces **no** refusals.
 * Without it, `snapshotRefusals` could return a refusal for everything and every
 * case above would pass while no build could ever be assembled.
 */

const multi = ownedMulti('solver-canonical-input', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: { organizationId: string; groupId: string; membershipId: string; correlationId: string };
let actor: ReturnType<typeof scheduleActor>;
let fixture: SolverFixture;
let assignee: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

const BUILD_AT = fixtureInstant('2027-06-07', 12);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const catalogue = multi.catalogue('alpha');
  const shiftTypeId = catalogue.shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('the alpha catalogue seed produced no shift type');

  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'solver-canonical-input',
  };
  actor = scheduleActor(alpha.users.scheduler.id);
  assignee = alpha.users.member.membershipId;

  /* Two lifecycle capabilities, GRANTED through the production grant path.
   *
   * Moving a membership's status is `organization.membership.administer` and
   * changing the group's zone is `group.timezone.administer`; both are enforced
   * by database guards and neither is implied by the scheduler role. The
   * alternative — a superuser UPDATE — would set up states the application
   * itself can never reach, and a refusal proven against an unreachable state
   * proves nothing (`membership-semantics.test.ts` records the same reasoning). */
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    capabilities: ['organization.membership.administer', 'group.timezone.administer'],
  });

  fixture = await seedSolverFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    actorMembershipId: alpha.users.scheduler.membershipId,
    actorUserId: alpha.users.scheduler.id,
    shiftTypeId,
    startDate: '2027-06-07',
    endDate: '2027-06-13',
    requiredCount: 1,
  });
});

afterAll(async () => {
  await runtime?.destroy();
});

/** The superuser-adjacent state change `membership-semantics.test.ts` uses. */
async function setMembershipStatus(membershipId: string, status: string): Promise<void> {
  await run(async ({ query }) => {
    await sql
      .raw(`UPDATE memberships SET status = '${status}' WHERE id = '${membershipId}'`)
      .execute(query);
  });
}

function reasonsOf(error: unknown): readonly SnapshotRefusalReason[] {
  expect(error).toBeInstanceOf(SnapshotRefusedError);
  return (error as SnapshotRefusedError).reasons;
}

describe('canonical input assembly, against the real database', () => {
  it('assembles a complete snapshot covering every constituent doc 35 §6a names', async () => {
    const assembled = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      }),
    );
    const document = assembled.document;

    expect(document.organizationId).toBe(context.organizationId);
    expect(document.groupId).toBe(context.groupId);
    expect(document.periodId).toBe(fixture.periodId);
    expect(document.versionId).toBe(fixture.versionId);
    expect(document.startDate).toBe('2027-06-07');
    expect(document.endDate).toBe('2027-06-13');
    expect(document.dayCount).toBe(7);
    /* The 0014 basis, not the group's current zone read a second time. */
    expect(document.timezone.source).toBe('version-snapshot');
    expect(document.timezone.basis.length).toBeGreaterThan(0);
    expect(document.shiftTypes.length).toBeGreaterThan(0);
    expect(document.demand.length).toBeGreaterThan(0);
    expect(document.participants.length).toBeGreaterThan(0);

    /* Account/participant type — SPEC-04 §3.4's "account type", and FAD-31's
     * staff/locum distinction, both carried per participant. */
    for (const participant of document.participants) {
      expect(participant.membershipKind).toBe('group');
      expect(['staff', 'locum']).toContain(participant.staffingKind);
      expect(participant.status).toBe('active');
      /* The eligibility verdict is present per shift type, from the FROZEN
       * shared module — not re-derived here and not re-derived in the worker. */
      expect(participant.eligibility.length).toBe(document.shiftTypes.length);
    }

    const kinds = new Set(assembled.constituents.map((entry) => entry.kind));
    expect(kinds.has('period')).toBe(true);
    expect(kinds.has('version')).toBe(true);
    expect(kinds.has('timezoneBasis')).toBe(true);
    expect(kinds.has('shiftType')).toBe(true);
    expect(kinds.has('requirement')).toBe(true);
    expect(kinds.has('qualification')).toBe(true);
    log(
      `      · ${String(assembled.constituents.length)} constituents across ` +
        `${String(kinds.size)} kinds; ${String(document.participants.length)} participants`,
    );
  });

  it('the persisted document parses against the wire contract, holdings narrowed', async () => {
    const assembled = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      }),
    );

    /* `.strict()` throughout, so this parse is also the assertion that nothing
     * unexpected is in the document — including that `evidence_ref` never
     * reached it. A field that arrived by accident would change the canonical
     * input hash; one that arrived deliberately would be an unreviewed input. */
    const parsed = solverInputSnapshotSchema.safeParse(assembled.document);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 4))).toBe(true);

    const withHoldings = assembled.document.participants.filter((p) => p.holdings.length > 0);
    expect(withHoldings.length, 'the fixture seeds credential holdings').toBeGreaterThan(0);
    for (const participant of withHoldings) {
      for (const holding of participant.holdings) {
        expect(Object.keys(holding).sort()).toEqual([
          'qualificationId',
          'status',
          'validFrom',
          'validUntil',
        ]);
      }
    }
    log(`      · ${String(withHoldings.length)} participants carry holdings; no evidence_ref`);
  });

  it('REFUSES missing required input: a period with no demand', async () => {
    const alpha = multi().alpha;
    const catalogue = multi.catalogue('alpha');
    const shiftTypeId = catalogue.shiftTypeIds[1];
    if (shiftTypeId === undefined) throw new Error('no shift type');

    const empty = await seedSolverFixture(runtime.runner, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      actorMembershipId: alpha.users.scheduler.membershipId,
      actorUserId: alpha.users.scheduler.id,
      shiftTypeId,
      startDate: '2027-07-05',
      endDate: '2027-07-11',
      requiredCount: 1,
    });
    /* Remove the seeded requirement so the period genuinely asks for nothing.
     * A build over it would return a vacuously "feasible" empty schedule —
     * the single most dangerous result this pipeline could produce, because it
     * looks like success. */
    await run(async ({ query }) => {
      await sql`DELETE FROM schedule_requirements WHERE period_id = ${empty.periodId}`.execute(
        query,
      );
    });

    let thrown: unknown;
    try {
      await run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: empty.periodId,
          versionId: empty.versionId,
          at: fixtureInstant('2027-07-05', 12),
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(reasonsOf(thrown)).toContain('missing-required-input');
    log('      · a period that asks for nothing is refused before any worker runs');
  });

  it('REFUSES a version this context cannot see', async () => {
    let thrown: unknown;
    try {
      await run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: fixture.periodId,
          versionId: '00000000-0000-4000-8000-000000000000',
          at: BUILD_AT,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(reasonsOf(thrown)).toContain('missing-required-input');
  });

  it('REFUSES a stale revision: a constituent moved since the caller read it', async () => {
    const first = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      }),
    );

    /* The world moves: the period's requirement is amended. `requirement_version`
     * is a database-owned counter no application role can write, which is what
     * makes citing it meaningful rather than advisory. */
    await run(async ({ query }) => {
      await sql`
        UPDATE schedule_requirements SET required_count = required_count + 1
         WHERE period_id = ${fixture.periodId}
      `.execute(query);
    });

    let thrown: unknown;
    try {
      await run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: fixture.periodId,
          versionId: fixture.versionId,
          at: BUILD_AT,
          expectedRevisions: first.constituents,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(reasonsOf(thrown)).toContain('stale-revision');

    /* And the control: the SAME re-read with a FRESH expectation succeeds, so
     * the refusal is about staleness and not about the comparison existing. */
    const second = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      }),
    );
    await expect(
      run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: fixture.periodId,
          versionId: fixture.versionId,
          at: BUILD_AT,
          expectedRevisions: second.constituents,
        }),
      ),
    ).resolves.toBeDefined();
    log('      · a moved requirement revision is refused; a fresh expectation is not');
  });

  it('an EMPTY expectation makes no claim, and is not treated as agreement', async () => {
    /* Honest, and deliberately distinct from "everything matched". A caller that
     * supplies nothing has not verified anything, and the code must not record
     * that as a passed check. */
    await expect(
      run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: fixture.periodId,
          versionId: fixture.versionId,
          at: BUILD_AT,
          expectedRevisions: [],
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('REFUSES a stale TIMEZONE BASIS (R-B7) before the worker is invoked', async () => {
    const alpha = multi().alpha;
    const catalogue = multi.catalogue('alpha');
    const shiftTypeId = catalogue.shiftTypeIds[1];
    if (shiftTypeId === undefined) throw new Error('no shift type');

    const tzFixture = await seedSolverFixture(runtime.runner, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      actorMembershipId: alpha.users.scheduler.membershipId,
      actorUserId: alpha.users.scheduler.id,
      shiftTypeId,
      startDate: '2027-08-02',
      endDate: '2027-08-08',
      requiredCount: 1,
    });

    const before = await run(async (uow) => {
      const row = await uow.query
        .selectFrom('groups')
        .select(['timezone', 'settings_version'])
        .where('id', '=', context.groupId)
        .executeTakeFirstOrThrow();
      return row;
    });

    const moved = before.timezone === 'UTC' ? 'Europe/Oslo' : 'UTC';
    await run(async (uow) => {
      const outcome = await setTimezone(uow, moved, before.settings_version, true);
      if (outcome.kind !== 'ok') throw new Error(`timezone change failed: ${outcome.kind}`);
    });

    let thrown: unknown;
    try {
      await run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: tzFixture.periodId,
          versionId: tzFixture.versionId,
          at: fixtureInstant('2027-08-02', 12),
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(reasonsOf(thrown)).toContain('stale-revision');
    expect((thrown as SnapshotRefusedError).refusals[0]?.subject).toBe('timezoneBasis');
    log('      · a version authored under another zone cannot be built (R-B7)');

    // Leave the fixture as found — every other case in this file reads the zone.
    await run(async (uow) => {
      const current = await uow.query
        .selectFrom('groups')
        .select('settings_version')
        .where('id', '=', context.groupId)
        .executeTakeFirstOrThrow();
      const outcome = await setTimezone(uow, before.timezone, current.settings_version, true);
      if (outcome.kind !== 'ok') throw new Error('restore failed');
    });
  });

  it('REFUSES an INACTIVE PARTICIPANT named by a fixed assignment', async () => {
    const alpha = multi().alpha;
    const catalogue = multi.catalogue('alpha');
    const shiftTypeId = catalogue.shiftTypeIds[1];
    if (shiftTypeId === undefined) throw new Error('no shift type');

    const pinned = await seedSolverFixture(runtime.runner, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      actorMembershipId: alpha.users.scheduler.membershipId,
      actorUserId: alpha.users.scheduler.id,
      shiftTypeId,
      startDate: '2027-09-06',
      endDate: '2027-09-12',
      requiredCount: 1,
    });

    const versionId = await run(async (uow) => createDraftVersion(uow, actor, pinned.periodId));
    await run(async (uow) =>
      addManualAssignment(uow, actor, {
        versionId,
        membershipId: assignee,
        shiftTypeId,
        date: '2027-09-06',
        startsAt: fixtureInstant('2027-09-06', 8),
        endsAt: fixtureInstant('2027-09-06', 16),
      }),
    );

    /* The assignment exists and is legal. THEN the member is suspended — the
     * ordinary way this arises in production, and the reason dropping the fixed
     * input silently would be wrong: a "protected" assignment that quietly stops
     * being protected is worse than a refused build. */
    await setMembershipStatus(assignee, 'suspended');
    try {
      let thrown: unknown;
      try {
        await run(async (uow) =>
          assembleCanonicalInput(uow, {
            periodId: pinned.periodId,
            versionId,
            at: fixtureInstant('2027-09-06', 12),
          }),
        );
      } catch (error) {
        thrown = error;
      }
      expect(reasonsOf(thrown)).toContain('inactive-participant');
      log('      · a fixed assignment on a suspended member refuses the build');
    } finally {
      await setMembershipStatus(assignee, 'active');
    }

    /* The control: with the member active again the same build assembles. */
    await expect(
      run(async (uow) =>
        assembleCanonicalInput(uow, {
          periodId: pinned.periodId,
          versionId,
          at: fixtureInstant('2027-09-06', 12),
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe('the refusal decision, exercised directly over hand-built documents', () => {
  const base = (): SolverInputSnapshotDocument => syntheticProblem();

  it('names exactly six refusal classes, and no more', () => {
    /* The closed set doc 35 §6a enumerates. A seventh class appearing without a
     * ruling is the kind of quiet scope drift the packet's Escalate row exists
     * for. */
    expect([...SNAPSHOT_REFUSAL_REASONS]).toEqual([
      'ambiguous',
      'stale-revision',
      'cross-group',
      'inactive-participant',
      'invalid-date',
      'missing-required-input',
    ]);
  });

  it('AMBIGUOUS: two rows claiming one slot', () => {
    const document = base();
    const duplicated: SolverInputSnapshotDocument = {
      ...document,
      demand: [...document.demand, document.demand[0]!],
      participants: [...document.participants, document.participants[0]!],
    };
    const reasons = snapshotRefusals(duplicated).map((r) => r.reason);
    expect(reasons).toContain('ambiguous');
  });

  it('INVALID DATE: an impossible calendar date, and an inverted range', () => {
    expect(
      snapshotRefusals({ ...base(), startDate: '2027-02-29' }).map((r) => r.reason),
    ).toContain('invalid-date');
    expect(
      snapshotRefusals({ ...base(), startDate: '2027-13-01' }).map((r) => r.reason),
    ).toContain('invalid-date');

    const document = base();
    const inverted = { ...document, startDate: document.endDate, endDate: document.startDate };
    expect(snapshotRefusals(inverted).map((r) => r.reason)).toContain('invalid-date');
    /* 0014's calendar constraints refuse all three at the DATABASE, so an
     * assembly cannot produce them. The decision still carries the arm, because
     * the document is built in TypeScript from several reads and a future
     * assembly defect could compose one. */
  });

  it('CROSS-GROUP: a demand cell naming a shift type that is not in the set', () => {
    const document = base();
    const foreign: SolverInputSnapshotDocument = {
      ...document,
      demand: [
        ...document.demand,
        {
          source: 'period-requirement',
          shiftTypeId: '00000000-0000-4000-8000-00000000dead',
          on: document.startDate,
          requiredCount: 1,
        },
      ],
    };
    expect(snapshotRefusals(foreign).map((r) => r.reason)).toContain('cross-group');
  });

  it('INACTIVE PARTICIPANT: a non-active participant in the set', () => {
    const document = base();
    const suspended: SolverInputSnapshotDocument = {
      ...document,
      participants: document.participants.map((participant, index) =>
        index === 0 ? { ...participant, status: 'suspended' as const } : participant,
      ),
    };
    expect(snapshotRefusals(suspended).map((r) => r.reason)).toContain('inactive-participant');
  });

  it('MISSING REQUIRED INPUT: each of the four things a problem cannot be posed without', () => {
    expect(snapshotRefusals({ ...base(), shiftTypes: [] }).map((r) => r.subject)).toContain(
      'shiftTypes',
    );
    expect(snapshotRefusals({ ...base(), demand: [] }).map((r) => r.subject)).toContain('demand');
    expect(snapshotRefusals({ ...base(), participants: [] }).map((r) => r.subject)).toContain(
      'participants',
    );
    const document = base();
    expect(
      snapshotRefusals({ ...document, timezone: { ...document.timezone, basis: '  ' } }).map(
        (r) => r.subject,
      ),
    ).toContain('timezone.basis');
  });

  it('STALE REVISION: both a moved revision and a constituent that has GONE', () => {
    const document = base();
    const moved = snapshotRefusals(document, [
      { kind: 'period', key: document.periodId, revision: '999' },
    ]);
    expect(moved.map((r) => r.reason)).toContain('stale-revision');

    /* The direction a naive comparison misses: the caller read something that is
     * no longer part of the build input at all — a retired shift type, a deleted
     * requirement. */
    const gone = snapshotRefusals(document, [
      { kind: 'rule', key: 'a-rule-that-was-archived', revision: '1' },
    ]);
    expect(gone.map((r) => r.reason)).toContain('stale-revision');
    expect(gone[0]?.detail).toContain('no longer part of this build input');
  });

  it('MUTATION CONTROL: a well-formed document produces NO refusals', () => {
    /* Without this, `snapshotRefusals` could refuse everything and every case
     * above would pass while no build could ever be assembled. */
    expect(snapshotRefusals(base())).toEqual([]);
    log('      · MUTATION CONTROL: the clean document is accepted');
  });
});
