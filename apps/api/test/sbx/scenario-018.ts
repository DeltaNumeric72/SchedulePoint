import { ProbeFalsified, type SbxScenario } from './contract.js';
import type { ScenarioDependencies } from './scenarios.js';
import { differenceByIdentity, type DiffSnapshot } from '../../src/schedule/diff.js';
import { publishRevert, publishVersion } from '../../src/schedule/publication.js';
import {
  addManualAssignment,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  reassignAssignment,
  transitionVersion,
} from '../../src/schedule/service.js';
import {
  fixtureInstant,
  grantScheduleCapabilities,
  publicationKey,
  scheduleActor,
} from '../support/schedule.js';

/**
 * SBX-018 — publication, versioning, revision, and revert.
 *
 * Research report 18 §5.3: "Prove published schedules are versioned and
 * revertible — the capability the source **entirely lacks**." Its pass criteria
 * are three, and all three are objective:
 *
 *   1. **no version is ever destroyed** — the set of version ids only grows, and
 *      every version ever published stays readable with its content intact;
 *   2. **concurrent publication is serialised** — two schedulers publishing one
 *      period produce exactly one winner and exactly one current version;
 *   3. **affected staff are notified, others are not** — the notified set equals
 *      the changed set exactly. Not a superset: telling everyone is the failure
 *      mode this clause exists to catch, and a diff that returned "everyone"
 *      would satisfy a subset-only check.
 *
 * The scenario lives in its own module rather than in `scenarios.ts` because
 * that file is a shared integration surface during the parallel M3 window; this
 * keeps the change there to one import and one array entry.
 */
export function buildScenario018(deps: () => ScenarioDependencies): SbxScenario {
  /**
   * The oracle, extracted so the PROBE re-executes exactly what ships.
   *
   * Returns the problems it found. Empty means the oracle accepted.
   */
  const notificationOracle = (
    before: readonly DiffSnapshot[],
    after: readonly DiffSnapshot[],
    notified: readonly string[],
    everyMembership: readonly string[],
  ): readonly string[] => {
    const difference = differenceByIdentity(before, after);
    const expected = [...difference.affectedMembershipIds].sort();
    const actual = [...notified].sort();
    const problems: string[] = [];

    if (expected.join(',') !== actual.join(',')) {
      problems.push(
        `notified set != affected set (expected [${expected.join(', ')}], got [${actual.join(', ')}])`,
      );
    }
    // The "others are NOT notified" half, asserted directly rather than inferred
    // from set equality, so the failure message names the person told in error.
    const unaffected = everyMembership.filter((m) => !expected.includes(m));
    for (const membership of unaffected) {
      if (actual.includes(membership)) {
        problems.push(`unaffected membership ${membership} was notified`);
      }
    }
    return problems;
  };

  return {
    id: 'SBX-018',
    title: 'Publication, versioning, revision, and revert',
    // G-PROD depends on this evidence (SPEC-05 §10, report 18 §5.3), so an
    // EVIDENCE_BLOCKED here would fail the run rather than rest acceptably.
    gateRequired: true,
    contract: {
      owner: 'OPUS-M3-003 (implementer) / Fable (acceptance)',
      fixtureProvenance:
        'MULTI `full` profile with `seed.catalogue: [alpha]` and `seed.schedule: true`, ' +
        'provisioned by apps/api/test/support/multi.ts from a slug — the single fixture owner. ' +
        'The schedule history is written through the PRODUCTION services (createPeriod, ' +
        'addManualAssignment, publishVersion), never by direct INSERT, so the scenario measures ' +
        'states the application can actually produce. Synthetic throughout; far-future 2027+ ' +
        'dates; every address at example.invalid.',
      deterministicSetup:
        'One embedded PostgreSQL cluster per run, initialised from empty; migrations up -> down ' +
        '-> up; the fixture seeded through the unit of work. Every instant is constructed in UTC ' +
        'by `fixtureInstant`; no wall-clock reading and no sleep anywhere. The one concurrent ' +
        'arm releases two publications together and asserts on the OUTCOME SET (one fulfilled, ' +
        'one rejected), never on which of them won — so the result does not depend on ' +
        'interleaving.',
      externalDependency: 'None. Nothing outside this process and its local cluster.',
      faultControls:
        'Two injected. (1) A concurrent publication of the same period, released simultaneously ' +
        'on two independent pooled connections, to force the step-02 period lock to arbitrate. ' +
        '(2) The falsifiability probe substitutes a deliberately wrong notified set (every ' +
        'membership, including provably unaffected ones) and requires the oracle to reject it. ' +
        'No delivery is attempted to any destination: notifications are outbox INTENTS only.',
      objectiveOracle:
        'Three conjuncts, all counted rather than judged: (1) NO VERSION DESTROYED — the set of ' +
        'version ids observed before the revision is a subset of the set observed after, and ' +
        'every one still resolves to a readable row; (2) CONCURRENCY SERIALISED — of two ' +
        'simultaneous publications of one period exactly 1 is fulfilled and exactly 1 is ' +
        'rejected, and the period holds exactly 1 `is_current` version afterwards; (3) ' +
        'NOTIFICATION EXACTNESS — the affected-membership set from the version difference equals ' +
        'the notified set EXACTLY (not a superset), and no unaffected membership appears in it.',
      retainedArtifact: 'docs/evidence/EV-M3-PUBLICATION/sbx-018.txt',
      environment: 'CONC',
      earliestExecutionPoint: 'E0',
    },

    run: async (context) => {
      const { fixture, runtimes } = deps();
      const runtime = runtimes.get('app_runtime');
      if (runtime === undefined) throw new Error('runtimes missing');

      const alpha = fixture.alpha;
      const catalogue = fixture.catalogue?.alpha;
      if (catalogue === undefined) throw new Error('SBX-018 needs seed.catalogue: [alpha]');
      /* Index 1 since OPUS-M4-000A: publication enforces the shift-type
       * qualification requirement edge structurally, `shiftTypeIds[0]` carries
       * a requirement, and this scenario's assignees are deliberately
       * uncredentialed — the unencumbered type keeps SBX-018 a publication
       * scenario rather than a qualification one. */
      const shiftTypeId = catalogue.shiftTypeIds[1];
      if (shiftTypeId === undefined) throw new Error('no shift type seeded');

      const actor = scheduleActor(alpha.users.scheduler.id);
      const tenant = {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        membershipId: alpha.users.scheduler.membershipId,
        correlationId: 'sbx-018',
      };
      const run = async <T>(fn: (uow: never) => Promise<T>): Promise<T> =>
        runtime.runner.run(tenant, fn as never);

      const assigneeA = alpha.users.scheduler.membershipId;
      const assigneeB = alpha.users.member.membershipId;
      const assigneeC = alpha.users.groupOnly.membershipId;
      const everyMembership = [assigneeA, assigneeB, assigneeC];

      // `schedule.revert` is grant-only; step 4 needs it, granted the production way.
      await grantScheduleCapabilities(runtime.runner, fixture, {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        membershipId: alpha.users.scheduler.membershipId,
        capabilities: ['schedule.revert'],
      });

      /* ── Step 1 — publish ─────────────────────────────────────────────── */
      const period = await run(async (uow) =>
        createPeriod(uow as never, actor, {
          name: 'SBX-018 period',
          startDate: '2031-02-03',
          endDate: '2031-02-23',
        }),
      );
      context.tableExercised('schedule_periods');

      const v1 = await run(async (uow) => {
        const draft = await createDraftVersion(uow as never, actor, period);
        await addManualAssignment(uow as never, actor, {
          versionId: draft,
          membershipId: assigneeA,
          shiftTypeId,
          date: '2031-02-03',
          startsAt: fixtureInstant('2031-02-03', 8),
          endsAt: fixtureInstant('2031-02-03', 16),
        });
        await addManualAssignment(uow as never, actor, {
          versionId: draft,
          membershipId: assigneeB,
          shiftTypeId,
          date: '2031-02-04',
          startsAt: fixtureInstant('2031-02-04', 8),
          endsAt: fixtureInstant('2031-02-04', 16),
        });
        await transitionVersion(uow as never, actor, draft, 'in_review');
        await transitionVersion(uow as never, actor, draft, 'approved');
        await publishVersion(uow as never, actor, {
          periodId: period,
          versionId: draft,
          idempotencyKey: publicationKey('sbx018-v1'),
          expectedPriorCurrentVersionId: null,
        });
        return draft;
      });
      context.tableExercised('schedule_versions');
      context.tableExercised('assignment_identities');
      context.tableExercised('assignment_snapshots');
      context.tableExercised('shifts');
      context.tableExercised('current_published_assignments');
      context.tableExercised('publication_records');
      context.policyExercised('schedule.publish (grant-only, evaluated in-transaction)');
      context.observe('step-1-publish', `V1 ${v1} published in period ${period}`);

      const idsBefore = await runtime.runner.run(tenant, async ({ query }) => {
        const rows = await query
          .selectFrom('schedule_versions')
          .select('id')
          .where('period_id', '=', period)
          .execute();
        return rows.map((r) => r.id);
      });

      /* ── Step 2 — amend AFTER publication: clone, change, publish ─────── */
      const beforeRows = await runtime.runner.run(tenant, async ({ query }) => {
        const rows = await query
          .selectFrom('assignment_snapshots')
          .select(['assignment_identity_id', 'membership_id', 'starts_at', 'ends_at', 'status'])
          .where('version_id', '=', v1)
          .execute();
        return rows.map((row) => ({
          assignmentIdentityId: row.assignment_identity_id,
          membershipId: row.membership_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
        }));
      });

      const v2 = await run(async (uow) => {
        const clone = await cloneVersion(uow as never, actor, v1);
        // A's row SPECIFICALLY, found by membership rather than by position: row
        // order is not guaranteed, and picking `[0]` made this assertion depend
        // on which row the planner returned first.
        const target = beforeRows.find((row) => row.membershipId === assigneeA)
          ?.assignmentIdentityId;
        if (target === undefined) throw new Error('no snapshot held by A to amend');
        // Reassign A's shift to C: A loses it, C gains it, B is untouched.
        await reassignAssignment(uow as never, actor, clone, target, assigneeC, 'SBX-018 amendment');
        await transitionVersion(uow as never, actor, clone, 'in_review');
        await transitionVersion(uow as never, actor, clone, 'approved');
        return clone;
      });

      const publication = await run(async (uow) =>
        publishVersion(uow as never, actor, {
          periodId: period,
          versionId: v2,
          idempotencyKey: publicationKey('sbx018-v2'),
          expectedPriorCurrentVersionId: v1,
        }),
      );
      context.tableExercised('version_supersessions');
      context.observe('step-2-amend', `V2 ${v2} published; V1 superseded, not modified`);

      /* ── Step 3 — a new version exists and history is retained ────────── */
      const idsAfter = await runtime.runner.run(tenant, async ({ query }) => {
        const rows = await query
          .selectFrom('schedule_versions')
          .select(['id', 'state'])
          .where('period_id', '=', period)
          .execute();
        return rows;
      });
      const idsAfterSet = new Set(idsAfter.map((r) => r.id));
      const destroyed = idsBefore.filter((id) => !idsAfterSet.has(id));
      if (destroyed.length > 0) {
        throw new Error(`versions were DESTROYED: ${destroyed.join(', ')}`);
      }
      if (!idsAfterSet.has(v2)) throw new Error('the amendment produced no new version');
      context.observe(
        'step-3-history',
        `${idsAfter.length} versions retained (${idsAfter.map((r) => r.state).join(', ')}); 0 destroyed`,
      );

      /* ── Notification exactness, for the step-2 publication ───────────── */
      const afterRows = await runtime.runner.run(tenant, async ({ query }) => {
        const rows = await query
          .selectFrom('assignment_snapshots')
          .select(['assignment_identity_id', 'membership_id', 'starts_at', 'ends_at', 'status'])
          .where('version_id', '=', v2)
          .execute();
        return rows.map((row) => ({
          assignmentIdentityId: row.assignment_identity_id,
          membershipId: row.membership_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
        }));
      });

      const notified = publication.difference.affectedMembershipIds;
      const problems = notificationOracle(beforeRows, afterRows, notified, everyMembership);
      if (problems.length > 0) throw new Error(`notification oracle rejected: ${problems.join('; ')}`);
      // The reassignment must have affected exactly A (lost it) and C (gained it).
      if (!notified.includes(assigneeA) || !notified.includes(assigneeC)) {
        throw new Error('a reassignment must affect BOTH the losing and the gaining membership');
      }
      if (notified.includes(assigneeB)) {
        throw new Error('B was untouched by the amendment and must not be notified');
      }
      context.observe(
        'notification-exactness',
        `affected == notified == [${[...notified].sort().join(', ')}]; unaffected B not notified`,
      );
      context.tableExercised('outbox_events');
      context.policyExercised('I-11 outbox intent (no delivery attempted)');

      /* ── Steps 4 and 5 — revert PUBLISHES FORWARD ─────────────────────── */
      const v3 = await run(async (uow) => {
        const clone = await cloneVersion(uow as never, actor, v1);
        await transitionVersion(uow as never, actor, clone, 'in_review');
        await transitionVersion(uow as never, actor, clone, 'approved');
        await publishRevert(uow as never, actor, {
          periodId: period,
          versionId: clone,
          idempotencyKey: publicationKey('sbx018-v3'),
          expectedPriorCurrentVersionId: v2,
          revertedToVersionId: v1,
        });
        return clone;
      });

      const afterRevert = await runtime.runner.run(tenant, async ({ query }) =>
        query
          .selectFrom('schedule_versions')
          .select(['id', 'state', 'is_current', 'version_number'])
          .where('period_id', '=', period)
          .execute(),
      );
      const stillThere = new Set(afterRevert.map((r) => r.id));
      for (const id of [v1, v2, v3]) {
        if (!stillThere.has(id)) throw new Error(`the revert destroyed version ${id}`);
      }
      const currentAfterRevert = afterRevert.filter((r) => r.is_current);
      if (currentAfterRevert.length !== 1) {
        throw new Error(`expected exactly 1 current version, found ${currentAfterRevert.length}`);
      }
      if (currentAfterRevert[0]?.id !== v3) throw new Error('the revert did not become current');
      // Publishing FORWARD: the revert is a NEW, higher-numbered version, not a
      // resurrection of the old one.
      const v3Number = currentAfterRevert[0]?.version_number ?? 0;
      if (v3Number !== 3) throw new Error(`the revert must publish forward as n=3, got n=${v3Number}`);
      context.observe(
        'step-4-5-revert',
        `revert published FORWARD as version_number=3 (${v3}); V1 and V2 both retained`,
      );

      /* ── Step 6 — two schedulers publish the same period concurrently ── */
      const contender = await run(async (uow) => {
        const clone = await cloneVersion(uow as never, actor, v3);
        await transitionVersion(uow as never, actor, clone, 'in_review');
        await transitionVersion(uow as never, actor, clone, 'approved');
        return clone;
      });

      const attempt = (label: string): Promise<unknown> =>
        runtime.runner.run(tenant, async (uow) =>
          publishVersion(uow as never, actor, {
            periodId: period,
            versionId: contender,
            idempotencyKey: publicationKey(label),
            // Both racers decided against the same view: v3 is current. The
            // loser therefore fails explicitly rather than silently layering.
            expectedPriorCurrentVersionId: v3,
          }),
        );
      const outcomes = await Promise.allSettled([attempt('sbx018-c1'), attempt('sbx018-c2')]);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').length;
      const rejected = outcomes.filter((o) => o.status === 'rejected').length;
      if (fulfilled !== 1 || rejected !== 1) {
        throw new Error(
          `concurrent publication was not serialised: ${fulfilled} fulfilled, ${rejected} rejected`,
        );
      }

      const finalCurrent = await runtime.runner.run(tenant, async ({ query }) =>
        query
          .selectFrom('schedule_versions')
          .select('id')
          .where('period_id', '=', period)
          .where('is_current', '=', true)
          .execute(),
      );
      if (finalCurrent.length !== 1) {
        throw new Error(`expected exactly 1 current version, found ${finalCurrent.length}`);
      }
      context.observe(
        'step-6-concurrency',
        'two simultaneous publications of one period: 1 fulfilled, 1 rejected, exactly 1 current version',
      );
      context.policyExercised('SPEC-05 §6 step-02 period lock (single-writer point)');
    },

    /**
     * The probe: the scenario's own notification oracle, given a deliberately
     * wrong notified set.
     *
     * "Everyone was told" is the realistic failure — a diff that gives up and
     * notifies the whole group looks correct to any subset-only check, and it is
     * exactly what pass criterion 3 forbids. The probe therefore feeds the
     * oracle a notified set containing a provably UNAFFECTED membership and
     * requires the oracle to reject it. It throws `ProbeFalsified` only after
     * OBSERVING that rejection — a crash, a typo or an empty sweep would be a
     * `PROBE_ERROR` and fail the run instead.
     */
    probe: async (context) => {
      const identity = '11111111-1111-4111-8111-111111111111';
      const held = '22222222-2222-4222-8222-222222222222';
      const other = '33333333-3333-4333-8333-333333333333';
      const unaffected = '44444444-4444-4444-8444-444444444444';

      const at = (hour: number): Date => fixtureInstant('2031-02-03', hour);
      const before: DiffSnapshot[] = [
        { assignmentIdentityId: identity, membershipId: held, startsAt: at(8), endsAt: at(16), status: 'active' },
      ];
      const after: DiffSnapshot[] = [
        { assignmentIdentityId: identity, membershipId: other, startsAt: at(8), endsAt: at(16), status: 'active' },
      ];

      // The truth: this reassignment affects `held` and `other`, and nobody else.
      const truthful = notificationOracle(before, after, [held, other], [held, other, unaffected]);
      if (truthful.length > 0) {
        // The oracle rejects the CORRECT answer — the probe has not falsified
        // anything, it has found the oracle broken. Not a ProbeFalsified.
        throw new Error(`the oracle rejected a correct notified set: ${truthful.join('; ')}`);
      }
      context.observe('probe-control', 'the oracle accepts the correct notified set');

      // The broken world: everyone is notified, including a membership with no
      // stake in the change at all.
      const problems = notificationOracle(before, after, [held, other, unaffected], [
        held,
        other,
        unaffected,
      ]);
      if (problems.length === 0) {
        // The oracle accepted "notify everyone". It cannot fail for the right
        // reason, so the scenario proves nothing — return, and the harness
        // records VACUOUS.
        return;
      }

      throw new ProbeFalsified(
        `notifying an unaffected membership was rejected by the scenario's own oracle: ${problems.join('; ')}`,
      );
    },
  };
}
