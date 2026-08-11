import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  publishVersion,
  publishRevert,
  reconcileStalePublishing,
} from '../../src/schedule/publication.js';
import {
  calendarDate,
  digestRows,
  renderCalendarFeed,
  renderVersionReport,
  sha256,
} from '../../src/schedule/render.js';
import {
  addManualAssignment,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  reassignAssignment,
  transitionVersion,
} from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import {
  fixtureInstant,
  grantScheduleCapabilities,
  publicationKey,
  scheduleActor,
} from '../support/schedule.js';

/**
 * SPEC-05 §8 — the CAR-007 regression proof, V-01..V-19, executed.
 *
 * The SPEC calls this "a database-level design test. Not executed." This file
 * is what executes it. Every row of the table is implemented — the
 * authorization's V-01..V-16 plus the dated V-15b/V-15c and V-17..V-19
 * additions — and **each row reports its own result**, because a harness that
 * reports one aggregate pass cannot tell a reviewer which row was the one that
 * mattered.
 *
 * ## The byte-identity rows, stated precisely
 *
 * V-02 captures "sha256 of every V1 row". Read literally that would include
 * V1's own `schedule_versions` row — which V-08 then legitimately changes,
 * because publishing V2 sets V1's `is_current`, `state`, `superseded_at` and
 * `superseded_by_version_id` through D-15b's permitted transitions. A proof that
 * demanded that row be frozen would contradict §4.1 and would have to be
 * "fixed" by weakening it.
 *
 * So the harness splits the claim in two, and proves both:
 *
 *   - **content byte-identity** — every CHILD row of the version (snapshots,
 *     shifts, credits) plus the rendered report and calendar feed. This is what
 *     "the schedule staff saw" means, and it is frozen absolutely;
 *   - **version-row discipline** — V1's own row changes ONLY in the four
 *     columns §4.1 permits, and V-17/18/19 prove the trigger enforces exactly
 *     that set and exactly those transitions.
 *
 * Reporting one number for both would have hidden which of the two held.
 */

const multi = ownedMulti('schedule-v-harness', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

/** Every row's verdict, printed at the end so a reviewer reads 19 lines. */
const verdicts = new Map<string, string>();
function record(row: string, detail: string): void {
  verdicts.set(row, detail);
}

let runtime: Runtime;
let migrator: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;
let assigneeB: string;

/* State carried across the ordered rows. */
let periodId: string;
let v1 = '';
let v2 = '';
let v3 = '';
let v1ContentDigest = '';
let v1ReportHash = '';
let v1FeedHash = '';
let v2ContentDigest = '';
let v1RowAtBaseline: Record<string, unknown> = {};

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** Run a statement expected to RAISE, in its own transaction, and return the error. */
async function expectRaises(statement: (uow: PgUnitOfWork) => Promise<unknown>): Promise<Error> {
  try {
    await run(async (uow) => statement(uow));
  } catch (error) {
    return error as Error;
  }
  throw new Error('the statement was expected to raise and did not');
}

/** A version's CHILD rows — the content whose immutability is the claim. */
async function contentDigestOf(versionId: string): Promise<string> {
  return run(async ({ query }) => {
    const snapshots = await query
      .selectFrom('assignment_snapshots')
      .selectAll()
      .where('version_id', '=', versionId)
      .execute();
    const shifts = await query
      .selectFrom('shifts')
      .selectAll()
      .where('version_id', '=', versionId)
      .execute();
    const credits = await query
      .selectFrom('credits')
      .selectAll()
      .where('source_version_id', '=', versionId)
      .execute();
    return digestRows([
      ...(snapshots as unknown as Record<string, unknown>[]),
      ...(shifts as unknown as Record<string, unknown>[]),
      ...(credits as unknown as Record<string, unknown>[]),
    ]);
  });
}

async function renderablesOf(versionId: string): Promise<
  {
    assignmentIdentityId: string;
    membershipId: string;
    date: string;
    startsAt: Date;
    endsAt: Date;
    shiftTypeId: string;
    status: string;
    isPinned: boolean;
  }[]
> {
  return run(async ({ query }) => {
    const rows = await query
      .selectFrom('assignment_snapshots')
      .innerJoin('shifts', 'shifts.id', 'assignment_snapshots.shift_id')
      .select([
        'assignment_snapshots.assignment_identity_id as assignmentIdentityId',
        'assignment_snapshots.membership_id as membershipId',
        'assignment_snapshots.date as date',
        'assignment_snapshots.starts_at as startsAt',
        'assignment_snapshots.ends_at as endsAt',
        'shifts.shift_type_id as shiftTypeId',
        'assignment_snapshots.status as status',
        'assignment_snapshots.is_pinned as isPinned',
      ])
      .where('assignment_snapshots.version_id', '=', versionId)
      .execute();
    // `date` arrives as a Date (OID 1082); normalise before rendering so the
    // artifact is the same on any machine.
    return rows.map((row) => ({
      ...(row as never as { date: string | Date }),
      date: calendarDate((row as never as { date: string | Date }).date),
    })) as never;
  });
}

async function versionRow(versionId: string): Promise<Record<string, unknown>> {
  return run(async ({ query }) => {
    const row = await query
      .selectFrom('schedule_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirstOrThrow();
    return row as unknown as Record<string, unknown>;
  });
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  // The role that CAN write every column and CAN delete — so a refusal observed
  // under it is the trigger's, never a missing grant's (V-07, V-17, V-18, V-19).
  migrator = createRuntime('app_migrator', { max: 2 });
  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('the harness needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[0];
  if (type === undefined) throw new Error('no shift type seeded');
  shiftTypeId = type;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'v-harness',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;
  assigneeB = fixture.alpha.users.member.membershipId;

  // `schedule.revert` is grant-only (doc 08 §4) and no role carries it, so V-10
  // must be granted it exactly as production would — through the organization
  // administrator, satisfying the two-person rule.
  await grantScheduleCapabilities(runtime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    capabilities: ['schedule.revert'],
  });

  periodId = await run(async (uow) =>
    createPeriod(uow, actor, {
      name: 'V-harness period',
      startDate: '2028-01-03',
      endDate: '2028-01-30',
    }),
  );
});

afterAll(async () => {
  if (verdicts.size > 0) {
    const lines = [...verdicts.entries()].map(([row, detail]) => `      · ${row}: ${detail}`);
    console.log(`\n    SPEC-05 §8 proof table — ${verdicts.size} rows\n${lines.join('\n')}\n`);
  }
  await runtime?.destroy();
  await migrator?.destroy();
});

describe('SPEC-05 §8 — V-01..V-19', () => {
  /**
   * V-01..V-11 — the V1 -> V2 -> V3 chain, as ONE test.
   *
   * These eleven rows are a SEQUENCE by construction: V-02 hashes what V-01
   * published, V-04 re-hashes it after V-03's clone, V-08 re-hashes it after a
   * second publication, V-11 after a third. Run out of order they are
   * meaningless, and `fixture-regression` shuffles test order within a file
   * deliberately — which is how this was found: all fourteen seeds failed, not
   * one, because the chain was expressed as eleven independent `it()`s that
   * vitest was free to reorder.
   *
   * Splitting them was the defect; the per-row REPORTING was never the problem.
   * Each row is still asserted separately and still records its own verdict, so
   * the printed proof table is unchanged — and `step` names the row in the
   * failure message, so a break still says which row broke.
   */
  it('V-01..V-11 — the V1 -> V2 -> V3 chain (ordered by construction)', async () => {
    const step = async (row: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        throw new Error(`${row} FAILED: ${(error as Error).message}`, { cause: error });
      }
    };

    await step('V-01 — create period, build content, approve, publish V1', async () => {
      v1 = await run(async (uow) => {
        const versionId = await createDraftVersion(uow, actor, periodId);
        await addManualAssignment(uow, actor, {
          versionId,
          membershipId: assigneeA,
          shiftTypeId,
          date: '2028-01-03',
          startsAt: fixtureInstant('2028-01-03', 8),
          endsAt: fixtureInstant('2028-01-03', 16),
        });
        await addManualAssignment(uow, actor, {
          versionId,
          membershipId: assigneeB,
          shiftTypeId,
          date: '2028-01-04',
          startsAt: fixtureInstant('2028-01-04', 8),
          endsAt: fixtureInstant('2028-01-04', 16),
        });
        await transitionVersion(uow, actor, versionId, 'in_review');
        await transitionVersion(uow, actor, versionId, 'approved');
        await publishVersion(uow, actor, {
          periodId,
          versionId,
          idempotencyKey: publicationKey('v01'),
          expectedPriorCurrentVersionId: null,
        });
        return versionId;
    });

      const row = await versionRow(v1);
      expect(row.state).toBe('published');
      expect(row.is_current).toBe(true);
      expect(row.version_number).toBe(1);
      record('V-01', `V1 published, is_current, version_number=${String(row.version_number)}`);
    });

    await step('V-02 — capture the baseline hashes of V1', async () => {
      v1ContentDigest = await contentDigestOf(v1);
      const rows = await renderablesOf(v1);
      v1ReportHash = sha256(renderVersionReport(v1, rows));
      v1FeedHash = sha256(renderCalendarFeed(v1, rows));
      v1RowAtBaseline = await versionRow(v1);

      expect(v1ContentDigest).toMatch(/^[0-9a-f]{64}$/);
      record(
        'V-02',
        `baseline content=${v1ContentDigest.slice(0, 12)} report=${v1ReportHash.slice(0, 12)} feed=${v1FeedHash.slice(0, 12)}`,
      );
    });

    await step('V-03 — clone V1 into V2 (draft), unchanged — the clone SUCCEEDS', async () => {
      v2 = await run(async (uow) => cloneVersion(uow, actor, v1));
      const row = await versionRow(v2);
      expect(row.state).toBe('draft');
      expect(row.cloned_from_version_id).toBe(v1);

      const clonedSnapshots = await run(async ({ query }) =>
        query
          .selectFrom('assignment_snapshots')
          .select(['assignment_identity_id'])
          .where('version_id', '=', v2)
          .execute(),
      );
      expect(clonedSnapshots).toHaveLength(2);
      record(
        'V-03',
        `clone succeeded — impossible under the old D-1; ${clonedSnapshots.length} snapshots, identities preserved`,
      );
    });

    await step('V-04 — re-hash V1: byte-identical to the V-02 baseline', async () => {
      const again = await contentDigestOf(v1);
      expect(again).toBe(v1ContentDigest);
      record('V-04', `content digest unchanged by the clone (${again.slice(0, 12)})`);
    });

    await step('V-05 — amend one assignment in V2: only V2 changes', async () => {
      const identities = await run(async ({ query }) =>
        query
          .selectFrom('assignment_snapshots')
          .select(['assignment_identity_id'])
          .where('version_id', '=', v2)
          .orderBy('assignment_identity_id')
          .execute(),
      );
      const target = identities[0]?.assignment_identity_id;
      expect(target).toBeDefined();

      await run(async (uow) =>
        reassignAssignment(uow, actor, v2, target as string, assigneeB, 'V-05 amendment'),
      );

      const v1After = await contentDigestOf(v1);
      v2ContentDigest = await contentDigestOf(v2);
      expect(v1After, 'V1 must be untouched by an edit to V2').toBe(v1ContentDigest);
      expect(v2ContentDigest).not.toBe(v1ContentDigest);
      record('V-05', 'V2 changed; V1 content digest unchanged');
    });

    await step('V-06 — UPDATE on a V1 snapshot raises (D-15a)', async () => {
      const error = await expectRaises(async ({ query }) => {
        const snapshot = await query
          .selectFrom('assignment_snapshots')
          .select('id')
          .where('version_id', '=', v1)
          .executeTakeFirstOrThrow();
        return sql`UPDATE assignment_snapshots SET is_pinned = true WHERE id = ${snapshot.id}`.execute(
          query,
        );
    });
      expect(error.message).toContain('SCHEDULE_PUBLISHED_IMMUTABLE');

      /* The INSERT arm (FAD-22(1)). D-15a was `BEFORE UPDATE OR DELETE` only,
       * so the published version's child SET could still GROW — every existing
       * row stayed immutable while the version's content changed. I-18's "every
       * child row is immutable" is set-immutability, and this is the arm that
       * makes the harness say so. */
      const before = await run(async ({ query }) =>
        query.selectFrom('assignment_snapshots').select('id').where('version_id', '=', v1).execute(),
      );
      const insertError = await expectRaises(async ({ query }) => {
        const existing = await query
          .selectFrom('assignment_snapshots')
          .select(['shift_id', 'assignment_identity_id'])
          .where('version_id', '=', v1)
          .executeTakeFirstOrThrow();
        return sql`
          INSERT INTO assignment_snapshots
            (id, organization_id, group_id, assignment_identity_id, version_id,
             membership_id, shift_id, date, starts_at, ends_at, origin, status)
          VALUES (gen_random_uuid(), ${context.organizationId}, ${context.groupId},
                  ${existing.assignment_identity_id}, ${v1}, ${assigneeB},
                  ${existing.shift_id}, '2028-01-03',
                  '2028-01-03T18:00:00Z'::timestamptz, '2028-01-03T22:00:00Z'::timestamptz,
                  'manual', 'active')
        `.execute(query);
      });
      expect(insertError.message).toContain('SCHEDULE_PUBLISHED_IMMUTABLE');

      const after = await run(async ({ query }) =>
        query.selectFrom('assignment_snapshots').select('id').where('version_id', '=', v1).execute(),
      );
      expect(after.length, 'the published content set did not grow').toBe(before.length);

      record(
        'V-06',
        `D-15a raised SCHEDULE_PUBLISHED_IMMUTABLE on a published snapshot UPDATE and on INSERT (FAD-22(1)); content set stayed ${before.length}`,
      );
    });

    await step('V-07 — DELETE of the V1 version row raises (D-15c)', async () => {
      // Two independent refusals, and the distinction matters.
      //
      // `app_runtime` holds no DELETE grant at all, so it never reaches the
      // trigger — a real control, but it proves the GRANT, not D-15c. The trigger
      // is what must stop a role that CAN delete, so the row is proven against
      // `app_migrator`: the role SPEC-05 §4 deliberately leaves able to perform a
      // reviewed corrective migration. Even it cannot delete published history.
      const runtimeRefusal = await expectRaises(async ({ query }) =>
        sql`DELETE FROM schedule_versions WHERE id = ${v1}`.execute(query),
      );
      expect(runtimeRefusal.message).toMatch(/permission denied/i);

      let triggerRefusal: Error | undefined;
      try {
        await migrator.runner.run(context, async ({ query }) =>
          sql`DELETE FROM schedule_versions WHERE id = ${v1}`.execute(query),
        );
      } catch (error) {
        triggerRefusal = error as Error;
      }
      expect(triggerRefusal?.message).toContain('SCHEDULE_VERSION_NO_DELETE');
      record(
        'V-07',
        'app_runtime refused by the absent DELETE grant; app_migrator refused by D-15c (SCHEDULE_VERSION_NO_DELETE)',
      );
    });

    await step('V-08 — approve and publish V2: V2 current, V1 superseded, V1 content identical', async () => {
      await run(async (uow) => {
        await transitionVersion(uow, actor, v2, 'in_review');
        await transitionVersion(uow, actor, v2, 'approved');
        await publishVersion(uow, actor, {
          periodId,
          versionId: v2,
          idempotencyKey: publicationKey('v08'),
          // V1 is the version this publication supersedes (FAD-22(2)).
          expectedPriorCurrentVersionId: v1,
        });
    });

      const v1Row = await versionRow(v1);
      const v2Row = await versionRow(v2);
      expect(v2Row.is_current).toBe(true);
      expect(v2Row.version_number).toBe(2);
      expect(v1Row.state).toBe('superseded');
      expect(v1Row.is_current).toBe(false);
      expect(v1Row.superseded_by_version_id).toBe(v2);

      const v1Content = await contentDigestOf(v1);
      expect(v1Content, 'V1 content must survive V2 becoming current').toBe(v1ContentDigest);

      // The version ROW changed only within D-15b's permitted set.
      const permitted = new Set(['is_current', 'state', 'superseded_at', 'superseded_by_version_id']);
      const moved = Object.keys(v1RowAtBaseline).filter(
        (key) => String(v1RowAtBaseline[key]) !== String(v1Row[key]),
      );
      expect(moved.every((key) => permitted.has(key)), `columns moved: ${moved.join(', ')}`).toBe(
        true,
      );
      record(
        'V-08',
        `V2 current (n=2); V1 superseded; V1 content byte-identical; version row moved only in [${moved.join(', ')}]`,
      );
    });

    await step('V-09 — regenerate V1 report and calendar feed by version_id: byte-identical', async () => {
      const rows = await renderablesOf(v1);
      const report = sha256(renderVersionReport(v1, rows));
      const feed = sha256(renderCalendarFeed(v1, rows));
      expect(report).toBe(v1ReportHash);
      expect(feed).toBe(v1FeedHash);
      record('V-09', `report and calendar feed regenerated byte-identically (${report.slice(0, 12)})`);
    });

    await step('V-10 — revert: clone V1 into V3 and publish forward', async () => {
      v3 = await run(async (uow) => {
        const clone = await cloneVersion(uow, actor, v1);
        await transitionVersion(uow, actor, clone, 'in_review');
        await transitionVersion(uow, actor, clone, 'approved');
        await publishRevert(uow, actor, {
          periodId,
          versionId: clone,
          idempotencyKey: publicationKey('v10'),
          // The revert supersedes V2, which is current when V-10 runs.
          expectedPriorCurrentVersionId: v2,
          revertedToVersionId: v1,
        });
        return clone;
    });

      const v3Row = await versionRow(v3);
      const v1Row = await versionRow(v1);
      const v2Row = await versionRow(v2);
      expect(v3Row.is_current).toBe(true);
      expect(v3Row.version_number).toBe(3);
      expect(v2Row.state).toBe('superseded');
      expect(v1Row.state).toBe('superseded');
      record('V-10', 'V3 current (n=3) carrying V1 content; V1 and V2 both retained and readable');
    });

    await step('V-11 — re-hash V1 and V2: both byte-identical', async () => {
      const v1Now = await contentDigestOf(v1);
      const v2Now = await contentDigestOf(v2);
      expect(v1Now).toBe(v1ContentDigest);
      expect(v2Now).toBe(v2ContentDigest);
      record('V-11', 'V1 and V2 content digests both unchanged after the revert');
    });
  });

  it('V-13 — replaying a publication with the same idempotency key publishes once', async () => {
    const key = publicationKey('v13');
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-13 period',
        startDate: '2028-03-06',
        endDate: '2028-03-26',
      }),
    );
    const version = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-03-06',
        startsAt: fixtureInstant('2028-03-06', 8),
        endsAt: fixtureInstant('2028-03-06', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    const first = await run(async (uow) =>
      publishVersion(uow, actor, { periodId: period, versionId: version, idempotencyKey: key, expectedPriorCurrentVersionId: null }),
    );
    const second = await run(async (uow) =>
      publishVersion(uow, actor, { periodId: period, versionId: version, idempotencyKey: key, expectedPriorCurrentVersionId: null }),
    );

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.outboxEventId).toBeNull();

    const events = await run(async ({ query }) =>
      query
        .selectFrom('outbox_events' as never)
        .select(sql<string>`count(*)`.as('n'))
        .where(sql`idempotency_key`, '=', `schedule-publish:${period}:${key}`)
        .execute(),
    );
    expect(Number((events[0] as { n: string }).n)).toBe(1);

    const records = await run(async ({ query }) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM publication_records
                          WHERE period_id = ${period} AND publication_idempotency_key = ${key}`.execute(
        query,
      ),
    );
    expect(Number(records.rows[0]?.n)).toBe(1);
    record('V-13', 'replay returned the recorded result; exactly 1 outbox event, 1 publication record');
  });

  it('V-14 — double-booking a membership within one version is rejected by D-1a', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-14 period',
        startDate: '2028-04-03',
        endDate: '2028-04-23',
      }),
    );

    const error = await expectRaises(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-04-03',
        startsAt: fixtureInstant('2028-04-03', 8),
        endsAt: fixtureInstant('2028-04-03', 16),
      });
      // Overlaps the first by four hours, same membership, same version.
      return addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-04-03',
        startsAt: fixtureInstant('2028-04-03', 12),
        endsAt: fixtureInstant('2028-04-03', 20),
      });
    });
    expect(error.message).toMatch(/no_overlap_in_version|exclusion|conflicting key/i);
    record('V-14', 'D-1a exclusion rejected an in-version overlap for one membership');
  });

  it('V-14b — D-1a catches an overlap that spans MIDNIGHT', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-14b period',
        startDate: '2028-06-05',
        endDate: '2028-06-25',
      }),
    );

    const error = await expectRaises(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      // 22:00 on the 5th to 06:00 on the 6th — an overnight shift.
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-06-05',
        startsAt: fixtureInstant('2028-06-05', 22),
        endsAt: fixtureInstant('2028-06-06', 6),
      });
      // 02:00 to 10:00 on the 6th — overlaps the tail of the overnight shift.
      // A date-keyed constraint would MISS this; the tstzrange does not.
      return addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-06-06',
        startsAt: fixtureInstant('2028-06-06', 2),
        endsAt: fixtureInstant('2028-06-06', 10),
      });
    });
    expect(error.message).toMatch(/no_overlap_in_version|exclusion|conflicting key/i);
    record('V-14b', 'D-1a rejected a midnight-spanning overlap a date-keyed constraint would miss');
  });

  /* ── V-12: concurrency ────────────────────────────────────────────────────
   *
   * Two arms, because the row's two clauses need different races to be real.
   *
   * SPEC-05 §6's note explains the mechanism for the SAME version: "Both contend
   * on step 02. The first commits; the second finds `state != 'approved'` at
   * step 03 and fails with an explicit conflict." That is arm (a), and it is
   * doc 07 §3.1's scenario — "two schedulers publishing the same period
   * concurrently must not both succeed".
   *
   * V-12 is written as "publish V2 and V3 concurrently" — DIFFERENT versions of
   * one period. Those would both succeed in sequence, which is legitimate
   * (publishing V2 then V3 is a valid history) but is not what the row asserts.
   * Arm (b) supplies the caller's expected-current view, which makes the second
   * publication a stale decision and refuses it explicitly. Both arms assert the
   * binding invariants: exactly one current version, exactly one outbox event
   * per publication that committed. */

  it('V-12a — two concurrent publications of the SAME version: exactly one wins', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-12a period',
        startDate: '2028-08-07',
        endDate: '2028-08-27',
      }),
    );
    const version = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-08-07',
        startsAt: fixtureInstant('2028-08-07', 8),
        endsAt: fixtureInstant('2028-08-07', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    // Two independent connections, released together. The period lock at step 02
    // serialises them; the loser then fails at step 03.
    const attempt = (label: string): Promise<unknown> =>
      runtime.runner.run(context, async (uow) =>
        publishVersion(uow, actor, {
          periodId: period,
          versionId: version,
          idempotencyKey: publicationKey(label),
          expectedPriorCurrentVersionId: null,
        }),
      );
    const outcomes = await Promise.allSettled([attempt('v12a-1'), attempt('v12a-2')]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The CODE is the contract; the message is human text that may be reworded.
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('VERSION_STATE_UNEXPECTED');

    const current = await run(async ({ query }) =>
      query
        .selectFrom('schedule_versions')
        .select('id')
        .where('period_id', '=', period)
        .where('is_current', '=', true)
        .execute(),
    );
    expect(current).toHaveLength(1);

    const events = await run(async ({ query }) =>
      sql<{ n: string }>`SELECT count(*) AS n FROM outbox_events
                          WHERE idempotency_key LIKE ${'schedule-publish:' + period + ':%'}`.execute(
        query,
      ),
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
    record(
      'V-12a',
      'same version raced: 1 winner, loser failed explicitly (VERSION_STATE_UNEXPECTED), 1 current, exactly 1 outbox event',
    );
  });

  it('V-12b — concurrent publications of DIFFERENT versions: the stale one fails explicitly', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-12b period',
        startDate: '2028-09-04',
        endDate: '2028-09-24',
      }),
    );
    // A first published version, so both racers share a known "current".
    const base = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2028-09-04',
        startsAt: fixtureInstant('2028-09-04', 8),
        endsAt: fixtureInstant('2028-09-04', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId: period,
        versionId: draft,
        idempotencyKey: publicationKey('v12b-base'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const makeCandidate = async (): Promise<string> =>
      run(async (uow) => {
        const clone = await cloneVersion(uow, actor, base);
        await transitionVersion(uow, actor, clone, 'in_review');
        await transitionVersion(uow, actor, clone, 'approved');
        return clone;
      });
    const candidateOne = await makeCandidate();
    const candidateTwo = await makeCandidate();

    /* Both decided against the same view of the world: "base is current".
     *
     * `expectedPriorCurrentVersionId` is now REQUIRED (FAD-22(2)) — the type
     * makes omitting it impossible, which is the point: an optional CAS is
     * indistinguishable from a caller that never considered concurrency, and
     * under the optional form BOTH of these publications succeeded, one
     * instantly superseding the other. */
    const attempt = (versionId: string, label: string): Promise<unknown> =>
      runtime.runner.run(context, async (uow) =>
        publishVersion(uow, actor, {
          periodId: period,
          versionId,
          idempotencyKey: publicationKey(label),
          expectedPriorCurrentVersionId: base,
        }),
      );
    const outcomes = await Promise.allSettled([
      attempt(candidateOne, 'v12b-1'),
      attempt(candidateTwo, 'v12b-2'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('CURRENT_VERSION_MOVED');

    const current = await run(async ({ query }) =>
      query
        .selectFrom('schedule_versions')
        .select('id')
        .where('period_id', '=', period)
        .where('is_current', '=', true)
        .execute(),
    );
    expect(current).toHaveLength(1);
    record(
      'V-12b',
      'different versions raced under the MANDATORY compare-and-set (FAD-22(2)): 1 winner, stale loser failed explicitly (CURRENT_VERSION_MOVED), exactly 1 current version',
    );
  });

  it('V-15 — publishing a version that double-books across periods is rejected by D-1b', async () => {
    // Period A, published, holds assigneeA from 08:00 to 16:00 on 2029-01-08.
    const periodA = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-15 period A',
        startDate: '2029-01-01',
        endDate: '2029-01-28',
      }),
    );
    await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodA);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2029-01-08',
        startsAt: fixtureInstant('2029-01-08', 8),
        endsAt: fixtureInstant('2029-01-08', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId: periodA,
        versionId: draft,
        idempotencyKey: publicationKey('v15-a'),
        expectedPriorCurrentVersionId: null,
      });
    });

    /* Period B is a DIFFERENT, non-overlapping period (D-2 forbids overlapping
     * periods), but its content puts the same membership at an instant already
     * committed in period A. Draft versions are allowed to conflict — they are
     * proposals — so the collision must surface at PUBLICATION, which is exactly
     * what D-1b is for. */
    const periodB = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-15 period B',
        startDate: '2029-02-01',
        endDate: '2029-02-25',
      }),
    );
    const versionB = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodB);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2029-01-08',
        startsAt: fixtureInstant('2029-01-08', 12),
        endsAt: fixtureInstant('2029-01-08', 20),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    const error = await expectRaises(async (uow) =>
      publishVersion(uow, actor, {
        periodId: periodB,
        versionId: versionB,
        idempotencyKey: publicationKey('v15-b'),
        expectedPriorCurrentVersionId: null,
      }),
    );
    expect(error.message).toMatch(/no_double_book|exclusion|conflicting key/i);

    // The publication ABORTED: period B still has no current version, and the
    // version is not published.
    const state = await run(async ({ query }) =>
      query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current'])
        .where('id', '=', versionB)
        .executeTakeFirstOrThrow(),
    );
    expect(state.state).toBe('approved');
    expect(state.is_current).toBe(false);
    record(
      'V-15',
      'D-1b aborted the PUBLISHING transaction on a cross-period double-booking; version left approved, not current',
    );
  });

  it('V-15b — concurrent publications for different memberships in different periods both succeed', async () => {
    const build = async (
      name: string,
      start: string,
      membershipId: string,
    ): Promise<{ period: string; version: string }> => {
      const period = await run(async (uow) =>
        createPeriod(uow, actor, { name, startDate: start, endDate: start }),
      );
      const version = await run(async (uow) => {
        const draft = await createDraftVersion(uow, actor, period);
        await addManualAssignment(uow, actor, {
          versionId: draft,
          membershipId,
          shiftTypeId,
          date: start,
          startsAt: fixtureInstant(start, 8),
          endsAt: fixtureInstant(start, 16),
        });
        await transitionVersion(uow, actor, draft, 'in_review');
        await transitionVersion(uow, actor, draft, 'approved');
        return draft;
      });
      return { period, version };
    };

    const one = await build('V-15b period one', '2029-04-02', assigneeA);
    const two = await build('V-15b period two', '2029-05-07', assigneeB);

    const outcomes = await Promise.allSettled([
      runtime.runner.run(context, async (uow) =>
        publishVersion(uow, actor, {
          periodId: one.period,
          versionId: one.version,
          idempotencyKey: publicationKey('v15b-1'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
      runtime.runner.run(context, async (uow) =>
        publishVersion(uow, actor, {
          periodId: two.period,
          versionId: two.version,
          idempotencyKey: publicationKey('v15b-2'),
          expectedPriorCurrentVersionId: null,
        }),
      ),
    ]);

    expect(
      outcomes.every((o) => o.status === 'fulfilled'),
      `outcomes: ${outcomes.map((o) => o.status).join(', ')}`,
    ).toBe(true);
    record(
      'V-15b',
      'different memberships in different periods published concurrently — both succeeded; contention is per-membership, not global',
    );
  });

  it('V-16 — a publication killed mid-flight leaves no partial state; the reconciler recovers', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-16 period',
        startDate: '2029-07-02',
        endDate: '2029-07-22',
      }),
    );
    const version = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2029-07-02',
        startsAt: fixtureInstant('2029-07-02', 8),
        endsAt: fixtureInstant('2029-07-02', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      return draft;
    });

    /* Arm A — the process dies after the publication has done all its work but
     * before the transaction commits. Everything rolls back together. */
    await expect(
      runtime.runner.run(context, async (uow) => {
        await publishVersion(uow, actor, {
          periodId: period,
          versionId: version,
          idempotencyKey: publicationKey('v16'),
          expectedPriorCurrentVersionId: null,
        });
        throw new Error('SIMULATED_PROCESS_KILL');
      }),
    ).rejects.toThrow('SIMULATED_PROCESS_KILL');

    const afterKill = await run(async ({ query }) => {
      const row = await query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current', 'version_number'])
        .where('id', '=', version)
        .executeTakeFirstOrThrow();
      const reality = await query
        .selectFrom('current_published_assignments')
        .select('id')
        .where('period_id', '=', period)
        .execute();
      const records = await sql<{ n: string }>`SELECT count(*) AS n FROM publication_records
                                                WHERE version_id = ${version}`.execute(query);
      return { row, reality: reality.length, records: Number(records.rows[0]?.n) };
    });
    expect(afterKill.row.state, 'no partial publication survived').toBe('approved');
    expect(afterKill.row.is_current).toBe(false);
    expect(afterKill.row.version_number).toBeNull();
    expect(afterKill.reality, 'reality reflects the prior current version only').toBe(0);
    expect(afterKill.records).toBe(0);

    /* Arm B — a DURABLE `publishing` row, however it arose, is returned to
     * `approved` by the reconciler and never forward to `published`. Under this
     * module's single-transaction publication arm A cannot produce one, so the
     * state is constructed directly; "cannot arise" is a claim about today's
     * implementation, and the reconciler is what makes being wrong survivable. */
    await run(async ({ query }) =>
      query
        .updateTable('schedule_versions')
        .set({ state: 'publishing' })
        .where('id', '=', version)
        .execute(),
    );
    const recovered = await run(async (uow) => reconcileStalePublishing(uow));
    expect(recovered).toContain(version);

    const afterReconcile = await run(async ({ query }) =>
      query
        .selectFrom('schedule_versions')
        .select(['state', 'is_current'])
        .where('id', '=', version)
        .executeTakeFirstOrThrow(),
    );
    expect(afterReconcile.state).toBe('approved');
    expect(afterReconcile.is_current).toBe(false);
    record(
      'V-16',
      'kill mid-publication: nothing committed (approved, no number, 0 reality rows, 0 publication records); reconciler returned a durable publishing row to approved',
    );
  });

  it('V-15c — current_published_assignments equals the active snapshots of every current version', async () => {
    const drift = await run(async ({ query }) => {
      const result = await sql<{ n: string }>`
        WITH expected AS (
          SELECT s.id AS snapshot_id
            FROM assignment_snapshots s
            JOIN schedule_versions v ON v.id = s.version_id
           WHERE v.is_current AND s.status = 'active'),
        actual AS (SELECT source_snapshot_id AS snapshot_id FROM current_published_assignments)
        SELECT count(*) AS n FROM (
          (SELECT snapshot_id FROM expected EXCEPT SELECT snapshot_id FROM actual)
          UNION ALL
          (SELECT snapshot_id FROM actual EXCEPT SELECT snapshot_id FROM expected)) AS d
      `.execute(query);
      return Number(result.rows[0]?.n ?? -1);
    });
    expect(drift, 'current_published_assignments must have no stale or missing rows').toBe(0);
    record('V-15c', 'reality equals the active snapshots of every current version — 0 rows of drift');
  });

  /* ── V-17/18/19: the D-15b per-column matrix ──────────────────────────────
   *
   * Run as `app_migrator`, which can write every column. Under `app_runtime`
   * the column-level GRANT would refuse several of them before the trigger was
   * ever consulted, and the row would then be measuring the grant rather than
   * D-15b — the same mistake V-07 caught. */

  /** The five columns SPEC-05 §4.1 permits on a frozen row. */
  const PERMITTED = ['is_current', 'lock_state', 'state', 'superseded_at', 'superseded_by_version_id'];

  /**
   * A sibling DRAFT version in the same period, used as a supersede TARGET.
   *
   * The matrix rows used the chain's `v3`, which made them depend on the chain
   * having run first — invisible until `--sequence.shuffle` reordered them and
   * an empty string reached PostgreSQL as a uuid. A row that proves a trigger
   * must not need any other row to have run.
   */
  const siblingVersion = async (periodId: string): Promise<string> =>
    run(async (uow) => createDraftVersion(uow, actor, periodId));

  /**
   * Clear a version's reality rows, as app_migrator.
   *
   * The matrix rows deliberately drive a published version through D-15b's
   * PERMITTED transitions with raw SQL — clearing `is_current`, marking it
   * superseded — WITHOUT running the publication transaction that also
   * maintains `current_published_assignments`. That leaves rows whose source
   * version is no longer current: real drift, which V-15c would correctly
   * report. Cleaning up is the honest fix — these rows prove the TRIGGER, not
   * reality maintenance, and leaving their debris behind would make a global
   * invariant depend on test order.
   */
  const dropRealityFor = async (versionId: string): Promise<void> => {
    await migrator.runner.run(context, async ({ query }) => {
      await sql`DELETE FROM current_published_assignments
                 WHERE source_version_id = ${versionId}`.execute(query);
    });
  };

  /** Attempt an UPDATE as app_migrator; return the error, or null if it succeeded. */
  const attemptAsMigrator = async (setClause: string, versionId: string): Promise<Error | null> => {
    try {
      await migrator.runner.run(context, async ({ query }) =>
        sql.raw(`UPDATE schedule_versions SET ${setClause} WHERE id = '${versionId}'`).execute(query),
      );
      return null;
    } catch (error) {
      return error as Error;
    }
  };

  it('V-17 — each individually permitted change succeeds via its defined transition', async () => {
    // A dedicated published version, so the matrix cannot disturb the chain
    // V-01..V-11 asserted against.
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-17 period',
        startDate: '2030-01-07',
        endDate: '2030-01-27',
      }),
    );
    const target = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2030-01-07',
        startsAt: fixtureInstant('2030-01-07', 8),
        endsAt: fixtureInstant('2030-01-07', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId: period,
        versionId: draft,
        idempotencyKey: publicationKey('v17'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const supersededBy = await siblingVersion(period);
    const results: string[] = [];

    // is_current: true -> false on the outgoing version.
    expect(await attemptAsMigrator('is_current = false', target)).toBeNull();
    results.push('is_current(true->false) permitted');

    // superseded_at + superseded_by + state, together, in one statement — the
    // supersession transition, which is the ONLY way §4.1 permits any of them.
    expect(
      await attemptAsMigrator(
        `state = 'superseded', superseded_at = now(), superseded_by_version_id = '${supersededBy}'`,
        target,
      ),
    ).toBeNull();
    results.push('state(published->superseded)+superseded_at+superseded_by permitted together');

    /* lock_state is the interesting one, and §4.1 predicts exactly this: the
     * TRIGGER permits the column, and the §3.2 CHECK refuses the value on a
     * frozen row. Observing WHICH control refuses is the point — a trigger
     * refusal here would mean the permitted set was narrower than §4.1 says. */
    const lockError = await attemptAsMigrator("lock_state = 'locked'", target);
    expect(lockError, 'locking a frozen version must be refused').not.toBeNull();
    expect(
      lockError?.message,
      'the refusal must come from the CHECK, not from D-15b',
    ).toMatch(/no_lock_when_frozen|violates check constraint/i);
    expect(lockError?.message).not.toContain('SCHEDULE_VERSION_FROZEN_COLUMN');
    results.push('lock_state permitted by D-15b, refused by the §3.2 CHECK (as §4.1 predicts)');

    // This row drove a published version out of `is_current` by hand; clear the
    // reality rows it orphaned so V-15c's global invariant stays order-free.
    await dropRealityFor(target);
    record('V-17', results.join('; '));
  });

  it('V-18 — every OTHER column raises (D-15b). One case per column, none skipped', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-18 period',
        startDate: '2030-03-04',
        endDate: '2030-03-24',
      }),
    );
    const target = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2030-03-04',
        startsAt: fixtureInstant('2030-03-04', 8),
        endsAt: fixtureInstant('2030-03-04', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId: period,
        versionId: draft,
        idempotencyKey: publicationKey('v18'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    /* The column list is read from the DATABASE, not hand-written. A migration
     * that adds a column to `schedule_versions` and forgets this proof would
     * otherwise leave it untested while the row still claimed "no column is
     * untested" — which is the failure mode V-18 exists to prevent. */
    const columns = await run(async ({ query }) => {
      const result = await sql<{ column_name: string; data_type: string }>`
        SELECT column_name, data_type
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'schedule_versions'
         ORDER BY column_name`.execute(query);
      return result.rows;
    });
    expect(columns.length).toBeGreaterThan(10);

    const frozen = columns.filter((c) => !PERMITTED.includes(c.column_name));
    // Every column is either permitted or tested below — nothing falls through.
    expect(frozen.length + PERMITTED.length).toBe(columns.length);

    const untested: string[] = [];
    const refused: string[] = [];
    for (const column of frozen) {
      // A type-appropriate DIFFERENT value. `NULL` is never used as the probe
      // value on its own: a column already NULL would be an unchanged write and
      // the trigger would (correctly) not fire, which would look like a pass.
      const literal =
        column.data_type === 'uuid'
          ? `'00000000-0000-0000-0000-0000000000ff'::uuid`
          : column.data_type === 'integer'
            ? '999'
            : column.data_type.includes('timestamp')
              ? `'2031-01-01T00:00:00Z'::timestamptz`
              : column.column_name === 'circulation_state'
                ? `'circulated'`
                : `'v18-probe'`;
      const error = await attemptAsMigrator(`${column.column_name} = ${literal}`, target);
      if (error === null) untested.push(`${column.column_name} (SUCCEEDED — not frozen)`);
      else if (error.message.includes('SCHEDULE_VERSION_FROZEN_COLUMN')) {
        refused.push(column.column_name);
      } else {
        untested.push(`${column.column_name} (refused by something else: ${error.message.slice(0, 60)})`);
      }
    }

    expect(untested, `columns not refused by D-15b: ${untested.join(' | ')}`).toEqual([]);
    expect(refused.length).toBe(frozen.length);
    record(
      'V-18',
      `all ${refused.length} frozen columns individually refused by D-15b (enumerated from information_schema, none skipped): ${refused.join(', ')}`,
    );
  });

  it('V-19 — a permitted column changed OUTSIDE its transition raises', async () => {
    const period = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'V-19 period',
        startDate: '2030-05-06',
        endDate: '2030-05-26',
      }),
    );
    const target = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, period);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2030-05-06',
        startsAt: fixtureInstant('2030-05-06', 8),
        endsAt: fixtureInstant('2030-05-06', 16),
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId: period,
        versionId: draft,
        idempotencyKey: publicationKey('v19'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const cases: { readonly label: string; readonly set: string }[] = [
      {
        label: 'superseded_at set WITHOUT state -> superseded',
        set: `superseded_at = now()`,
      },
      {
        label: 'superseded_by_version_id set WITHOUT state -> superseded',
        set: `superseded_by_version_id = '${await siblingVersion(period)}'`,
      },
      {
        label: 'is_current false -> true on a row that is not being published',
        set: `is_current = true`,
      },
      {
        label: 'state published -> draft (not the permitted supersession)',
        set: `state = 'draft'`,
      },
    ];

    const outcomes: string[] = [];
    // `is_current` is true on this freshly published version, so clear it first
    // for the false->true case to be reachable at all.
    await attemptAsMigrator('is_current = false', target);

    for (const probe of cases) {
      const error = await attemptAsMigrator(probe.set, target);
      expect(error, `${probe.label} must raise`).not.toBeNull();
      expect(error?.message, probe.label).toMatch(
        /SCHEDULE_VERSION_(ISCURRENT|STATE|SUPERSEDED_AT|SUPERSEDED_BY)_TRANSITION/,
      );
      outcomes.push(probe.label);
    }

    await dropRealityFor(target);
    record('V-19', `${outcomes.length} out-of-transition changes each raised: ${outcomes.join('; ')}`);
  });
});
