import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { createDraftVersion } from '../../src/schedule/service.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { seedSolverFixture, type SolverFixture } from '../support/solver.js';

/**
 * **SPEC-08 R-14 — the REBUILD invariant, on a real build-pipeline assembly**
 * (OPUS-M5-004, doc 42 §5h).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## R-14's own words, and why this file exists beside two others
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > **R-14** — Solver projection over mixed statuses, **including
 * > `reflected_in_version` on a rebuild of the same period**. Only eligible rows
 * > appear, **and a time-off request already honoured in a published version is
 * > still `HardOff` on the rebuild** — the rebuild cannot schedule the person on
 * > their approved day off.
 *
 * Three claims, and they need three different kinds of proof:
 *
 * | Claim | Where |
 * |---|---|
 * | which statuses project at all | `packages/domain/test/requests/solver-projection.test.ts` — pure, checkable against §6 |
 * | a `HardOff` row stops the model | `request-projection.test.ts` — the REAL worker subprocess, with its mutation falsifier |
 * | **`reflected_in_version` survives a REBUILD** | **HERE**, through `assembleCanonicalInput` — the real pipeline's phase one, twice, over the same period |
 *
 * V-31 is the amendment this file exists for. Before it,
 * `reflected_in_version` appeared in neither §6 list, so a request a published
 * version already honoured had UNDEFINED projection membership on a rebuild —
 * and §6 is the only gate. "Undefined" fails silently in the dangerous
 * direction, which is why the assertion is about the SECOND assembly.
 *
 * ## Nothing here is a stub
 *
 * The period, the requirement and the versions come through
 * `seedSolverFixture`'s production paths; the second version is a real
 * `createDraftVersion`; and both documents are produced by the same
 * `assembleCanonicalInput` a build runs. The only thing written by hand is the
 * request's STATUS WALK, one statement per §2 edge, because migration 0021's
 * guard evaluates one edge at a time and there is no shipped route that drives a
 * request all the way to `reflected_in_version` yet.
 *
 * ## Synthetic only
 *
 * Every date is 2027's and every label is the fixture's own.
 */

const multi = ownedMulti('solver-rebuild-hard-off', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
let fixture: SolverFixture;
let absentMembershipId: string;

const OFF_DATE = '2027-06-09';
const BUILD_AT = fixtureInstant('2027-06-07', 12);

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

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
    correlationId: 'solver-rebuild-hard-off',
  };
  absentMembershipId = alpha.users.member.membershipId;

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
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

/**
 * A `time-off` request for `OFF_DATE`, walked to `status`.
 *
 * ONE STATEMENT PER EDGE, because 0021's `app_guard_request_transition`
 * evaluates one edge at a time — the same reason `test/support/requests.ts`'s
 * seeding walk is a loop rather than a single update.
 */
async function timeOffAt(status: string): Promise<string> {
  return run(async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${absentMembershipId}::uuid, ${'time-off'},
              app_request_initial_status(${'time-off'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`rebuild.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into request_time_off (request_id, organization_id, group_id, target_date)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${OFF_DATE}::date)
    `.execute(query);

    const walk = [
      'submitted',
      'under_review',
      'approved',
      'consumed_by_build',
      'reflected_in_version',
    ];
    for (const step of walk) {
      await sql`update requests set status = ${step} where id = ${id}::uuid`.execute(query);
      if (step === status) return id;
    }
    return id;
  });
}

function hardOffDatesFor(
  document: Awaited<ReturnType<typeof assembleCanonicalInput>>['document'],
  membershipId: string,
): readonly string[] {
  return document.requestProjection.hardOff
    .filter((row) => row.membershipId === membershipId)
    .map((row) => row.date);
}

describe('SPEC-08 R-14 — the rebuild honours what a published version promised', () => {
  it('a `reflected_in_version` time-off request is still HardOff on the REBUILD', async () => {
    /* THE CONTROL, first and non-negotiable (FAD-15 red case 4): with no request
     * at all the projection is empty for this person, so the assertion below is
     * about the request rather than about a projection that says "off" for
     * everybody. */
    const before = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      }),
    );
    expect(
      hardOffDatesFor(before.document, absentMembershipId),
      'the control must start empty, or nothing below is about the request',
    ).toEqual([]);

    /* The request, walked to the status V-31 is about: a PUBLISHED version
     * already honours this day off. */
    await timeOffAt('reflected_in_version');

    /* THE REBUILD. A second DRAFT version of the SAME period, created through the
     * production path — which is what a rebuild is: doc 42 §5h's "on a REBUILD of
     * the same period", not a re-read of the first version. */
    const rebuildVersionId = await run(async (uow) =>
      createDraftVersion(uow, scheduleActor(multi().alpha.users.scheduler.id), fixture.periodId),
    );
    expect(rebuildVersionId, 'the rebuild must target a NEW version').not.toBe(fixture.versionId);

    const rebuild = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: rebuildVersionId,
        at: BUILD_AT,
      }),
    );

    /* R-14's sentence, as an assertion: the day off survives the rebuild. */
    expect(
      hardOffDatesFor(rebuild.document, absentMembershipId),
      'R-14: a request a published version already honours is still HardOff on the rebuild',
    ).toEqual([OFF_DATE]);

    /* And the document the rebuild would dispatch is a v3 one, which is what
     * makes the required field safe to require: a v2 document carrying no
     * absences would be REFUSED by version rather than read as a period that
     * happens to have none. */
    expect(rebuild.document.snapshotSchemaVersion).toBe(3);
  }, 240_000);

  it('only ELIGIBLE rows appear — a withdrawn request is not projected', async () => {
    /* R-14's other half: "Only eligible rows appear". A withdrawal is §6's own
     * named exclusion and it is the one a scheduler would most expect to see
     * disappear — measured on the same real assembly rather than argued from the
     * rule module. */
    const withdrawn = await run(async ({ query }) => {
      const id = randomUUID();
      await sql`
        insert into requests
          (id, organization_id, group_id, membership_id, subtype, status, expires_at,
           idempotency_key)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${absentMembershipId}::uuid, ${'time-off'},
                app_request_initial_status(${'time-off'}),
                ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                ${`rebuild.wd.${randomUUID().slice(0, 12)}`})
      `.execute(query);
      await sql`
        insert into request_time_off (request_id, organization_id, group_id, target_date)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${'2027-06-11'}::date)
      `.execute(query);
      await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
      await sql`update requests set status = 'withdrawn' where id = ${id}::uuid`.execute(query);
      return id;
    });
    expect(withdrawn).toBeTruthy();

    const document = await run(async (uow) =>
      assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      }),
    );
    /* The `reflected_in_version` row from the previous case IS there — the
     * non-vacuity control — and the withdrawn day is NOT. */
    const dates = hardOffDatesFor(document.document, absentMembershipId);
    expect(dates, 'the honoured day is still projected').toContain(OFF_DATE);
    expect(dates, "a withdrawn request never enters the projection").not.toContain('2027-06-11');
  }, 240_000);

  it('the projection is assembled on the BUILDER\'s transaction and needs no read capability', async () => {
    /* Migration 0027 §6's read plane, exercised through the real assembly rather
     * than through a hand-written `set_config`. The acting membership here is a
     * SCHEDULER — who does hold `requests.read_any` by role — so this case is not
     * the plane's proof (that is the populated cycle's, measured as a MEMBER).
     * What it proves is that the assembly composes: the plane opens, the reads
     * run, the plane clears, and the transaction continues to work afterwards.
     *
     * The `finally`-clear is what the last assertion is about: a plane left open
     * would still be open for this second read. */
    const document = await run(async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      });
      const token = await sql<{ value: string }>`
        select coalesce(nullif(current_setting('app.solver_projection_read', true), ''), '')
               as value
      `.execute(uow.query);
      expect(
        token.rows[0]?.value,
        'the purpose token must be cleared before the assembly returns',
      ).toBe('');
      return assembled;
    });
    expect(document.document.requestProjection.hardOff.length).toBeGreaterThan(0);
  }, 240_000);
});
