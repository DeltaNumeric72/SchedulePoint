import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  addManualAssignment,
  assertAssignableMembership,
  createDraftVersion,
  createPeriod,
  reassignAssignment,
  removeAssignment,
  setPin,
} from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';

/**
 * Membership semantics for scheduling (OPUS-M4-000B; doc 34 §4-C).
 *
 * Doc 34 §4-C: "define and enforce membership kind, active/inactive behaviour,
 * effective dates, ended membership behaviour, and functional/placeholder
 * participants". The rules, as authored in migration 0014 §9c and offered for
 * FAD ratification:
 *
 *   **R-B1** A NEW assignment target must be an `active` membership. `invited`,
 *           `suspended` and `ended` are refused.
 *   **R-B2** A NEW assignment must fall inside the membership's effective
 *           window: `starts_at >= valid_from`, and `ends_at <= valid_to` when
 *           `valid_to` is set.
 *   **R-B3** EXISTING assignments are RETAINED when a membership later changes
 *           state. The guard fires on INSERT and on a change of
 *           `membership_id`, and on nothing else.
 *
 * ## There is deliberately NO override arm, and this file pins that
 *
 * The packet says "with the manual-override arm and reason where FAD-23
 * sanctions it". FAD-23 does not sanction it here. Its override exists because
 * an eligibility ABSENCE can be an access-control artefact —
 * `staffing.qualification_holding.read` is grant-only, so a scheduler may be
 * unable to SEE a credential that exists, and rendering that as "not qualified"
 * would manufacture a false safety statement. Membership state has no such
 * ambiguity: it is fully visible to every principal who can reach this surface,
 * and an `ended` membership is not a person with a relationship to this group to
 * be scheduled into. An override would be an override of a FACT, not of a
 * judgement.
 *
 * ## Placeholder / functional participants
 *
 * Explicitly OUT OF SCOPE for M4 solver input, recorded here and in the return
 * report so the exclusion is owner-visible rather than discovered later. The
 * schema has no placeholder participant: `assignment_snapshots.membership_id`
 * is NOT NULL and now composite-FKs to a real group membership, so an
 * unfilled-but-planned slot is representable only as demand
 * (`schedule_requirements.required_count`) that no assignment satisfies — which
 * is what the solver will consume. Nothing here invents one.
 */

/**
 * The shape a typed refusal is read through.
 *
 * Declared once, at module scope, because `error as typeof refusal` inside the
 * catch resolves against the CONTROL-FLOW-narrowed type of the variable (which
 * is `null` at that point), collapsing every later property read to `never`. A
 * named type is what keeps the assertions readable and type-checked.
 */
interface Refusal {
  readonly code?: string;
  readonly message?: string;
  readonly recordedZone?: string;
  readonly currentZone?: string;
}

const multi = ownedMulti('schedule-membership-semantics', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;
let assigneeB: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/**
 * Move a membership's lifecycle fields.
 *
 * Through `app_runtime` under the group context, using the column-level UPDATE
 * grant migration 0001 already gives it — not through a superuser, because a
 * state a superuser can reach and the application cannot is not a state this
 * enforcement will ever meet.
 */
async function setMembership(
  membershipId: string,
  values: { status?: string; validFrom?: string; validTo?: string | null },
): Promise<void> {
  const sets: string[] = [];
  if (values.status !== undefined) sets.push(`status = '${values.status}'`);
  if (values.validFrom !== undefined) sets.push(`valid_from = '${values.validFrom}'`);
  if (values.validTo !== undefined) {
    sets.push(`valid_to = ${values.validTo === null ? 'NULL' : `'${values.validTo}'`}`);
  }
  await run(async ({ query }) => {
    await sql
      .raw(`UPDATE memberships SET ${sets.join(', ')} WHERE id = '${membershipId}'`)
      .execute(query);
  });
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
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
    correlationId: 'membership-semantics',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;
  assigneeB = fixture.alpha.users.member.membershipId;

  /* Moving a membership's lifecycle is `organization.membership.administer`,
   * enforced by a database guard from migration 0001. The fixture scheduler
   * does not hold it by role, so it is GRANTED through the production grant
   * path. The alternative — a superuser UPDATE — would set up a state the
   * application itself can never reach, and enforcement proven against an
   * unreachable state proves nothing. */
  await grantStaffingCapabilities(runtime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    capabilities: ['organization.membership.administer'],
  });
});

afterAll(async () => {
  // Leave the fixture as found: every test restores what it moved, and this is
  // the belt-and-braces for a failure between the move and the restore.
  await setMembership(assigneeB, { status: 'active', validTo: null });
  await runtime?.destroy();
});

async function draftAt(label: string, date: string): Promise<string> {
  const periodId = await run(async (uow) =>
    createPeriod(uow, actor, { name: `${label} period`, startDate: date, endDate: date }),
  );
  return run(async (uow) => createDraftVersion(uow, actor, periodId));
}

async function assign(versionId: string, date: string, membershipId: string): Promise<string> {
  const added = await run(async (uow) =>
    addManualAssignment(uow, actor, {
      versionId,
      membershipId,
      shiftTypeId,
      date,
      startsAt: fixtureInstant(date, 8),
      endsAt: fixtureInstant(date, 16),
    }),
  );
  return added.assignmentIdentityId;
}

/* ────────────────────────────────────────────────────────────────────────────
 * R-B1 — only an active membership is a NEW target
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-B1 — only an `active` membership is a NEW assignment target', () => {
  it.each(['suspended', 'ended', 'invited'])(
    'a %s membership is refused, with a typed error naming the state',
    async (status) => {
      await setMembership(assigneeB, { status });
      const versionId = await draftAt(`rb1-${status}`, `2037-01-1${status.length % 9}`);

      let refusal: Refusal | null = null;
      try {
        await assign(versionId, `2037-01-1${status.length % 9}`, assigneeB);
      } catch (error) {
        refusal = error as Refusal;
      }
      expect(refusal, `a ${status} membership must be refused`).not.toBeNull();
      expect(refusal?.code).toBe('ASSIGNEE_NOT_ACTIVE');
      expect(refusal?.message).toContain(status);

      await setMembership(assigneeB, { status: 'active' });
    },
  );

  it('and the DATABASE refuses it independently of the service', async () => {
    /* The service check produces the readable error; the trigger is the control.
     * Proven by issuing the INSERT in raw SQL as `app_runtime`, which no service
     * code is in front of. */
    await setMembership(assigneeB, { status: 'suspended' });
    const date = '2037-01-20';
    const versionId = await draftAt('rb1-db', date);
    const identity = await assign(versionId, date, assigneeA);
    const shift = await run(async (uow) =>
      uow.query
        .selectFrom('shifts')
        .select('id')
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );

    let error: string | null = null;
    try {
      await run(async ({ query }) => {
        await sql
          .raw(
            `UPDATE assignment_snapshots SET membership_id = '${assigneeB}'
               WHERE version_id = '${versionId}' AND assignment_identity_id = '${identity}'`,
          )
          .execute(query);
      });
    } catch (caught) {
      error = (caught as Error).message;
    }
    expect(error, 'the database must refuse a suspended target on its own').not.toBeNull();
    expect(error).toMatch(/SCHEDULE_ASSIGNEE_NOT_ACTIVE/);
    expect(shift.id).toBeTypeOf('string');

    await setMembership(assigneeB, { status: 'active' });
  });

  it('CONTROL: the same assignment succeeds while the membership is active', async () => {
    const date = '2037-01-25';
    const versionId = await draftAt('rb1-control', date);
    await expect(assign(versionId, date, assigneeB)).resolves.toBeTypeOf('string');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-B2 — the effective window
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-B2 — a NEW assignment falls inside the membership’s effective window', () => {
  it('an assignment that ENDS after the membership ends is refused', async () => {
    await setMembership(assigneeB, { validTo: '2037-02-10T00:00:00Z' });
    const date = '2037-02-15';
    const versionId = await draftAt('rb2-after', date);

    let refusal: Refusal | null = null;
    try {
      await assign(versionId, date, assigneeB);
    } catch (error) {
      refusal = error as Refusal;
    }
    expect(refusal?.code).toBe('ASSIGNEE_AFTER_MEMBERSHIP');

    await setMembership(assigneeB, { validTo: null });
  });

  it('an assignment that STARTS before the membership begins is refused', async () => {
    await setMembership(assigneeB, { validFrom: '2037-03-20T00:00:00Z' });
    const date = '2037-03-05';
    const versionId = await draftAt('rb2-before', date);

    let refusal: Refusal | null = null;
    try {
      await assign(versionId, date, assigneeB);
    } catch (error) {
      refusal = error as Refusal;
    }
    expect(refusal?.code).toBe('ASSIGNEE_BEFORE_MEMBERSHIP');

    await setMembership(assigneeB, { validFrom: '2020-01-01T00:00:00Z' });
  });

  it('an assignment INSIDE the window is accepted — the check is not a blanket refusal', async () => {
    await setMembership(assigneeB, {
      validFrom: '2020-01-01T00:00:00Z',
      validTo: '2038-01-01T00:00:00Z',
    });
    const date = '2037-04-05';
    const versionId = await draftAt('rb2-inside', date);
    await expect(assign(versionId, date, assigneeB)).resolves.toBeTypeOf('string');
    await setMembership(assigneeB, { validTo: null });
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-B3 — existing assignments are retained
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-B3 — an EXISTING assignment survives the membership changing state', () => {
  it('a later suspension neither deletes the assignment nor blocks editing it', async () => {
    const date = '2037-05-05';
    const versionId = await draftAt('rb3-retain', date);
    const identity = await assign(versionId, date, assigneeB);

    // The membership is suspended AFTER the assignment exists.
    await setMembership(assigneeB, { status: 'suspended' });

    // RETAINED.
    const snapshot = await run(async (uow) =>
      uow.query
        .selectFrom('assignment_snapshots')
        .select(['id', 'membership_id', 'status'])
        .where('version_id', '=', versionId)
        .where('assignment_identity_id', '=', identity)
        .executeTakeFirstOrThrow(),
    );
    expect(snapshot.membership_id).toBe(assigneeB);
    expect(snapshot.status).toBe('active');

    /* And still EDITABLE. A suspension must not retroactively freeze a rota:
     * pinning and cancelling are exactly the operations a scheduler needs in
     * order to REACT to the suspension, and a guard that fired on every UPDATE
     * would take them away at the worst moment. */
    await expect(
      run(async (uow) => setPin(uow, actor, versionId, identity, true)),
    ).resolves.toBeUndefined();
    await expect(
      run(async (uow) => removeAssignment(uow, actor, versionId, identity, 'member suspended')),
    ).resolves.toBeUndefined();

    await setMembership(assigneeB, { status: 'active' });
  });

  it('but REASSIGNING ONTO a suspended membership is refused — it is a NEW target', async () => {
    const date = '2037-05-09';
    const versionId = await draftAt('rb3-reassign', date);
    const identity = await assign(versionId, date, assigneeA);

    await setMembership(assigneeB, { status: 'suspended' });

    let refusal: Refusal | null = null;
    try {
      await run(async (uow) =>
        reassignAssignment(uow, actor, versionId, identity, assigneeB, 'cover'),
      );
    } catch (error) {
      refusal = error as Refusal;
    }
    expect(
      refusal?.code,
      'preserving the identity does not make the new target any more available',
    ).toBe('ASSIGNEE_NOT_ACTIVE');

    await setMembership(assigneeB, { status: 'active' });
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The shared assertion, reachable on its own
 * ──────────────────────────────────────────────────────────────────────────── */

describe('assertAssignableMembership is one rule, callable by every future writer', () => {
  it('reports the group boundary as "not in this group", never as a different code', async () => {
    const fixture = multi();
    let refusal: Refusal | null = null;
    try {
      await run(async (uow) =>
        assertAssignableMembership(
          uow,
          fixture.alpha.users.organizationAdmin.membershipId,
          new Date('2037-06-01T08:00:00Z'),
          new Date('2037-06-01T16:00:00Z'),
        ),
      );
    } catch (error) {
      refusal = error as Refusal;
    }
    /* An ORGANIZATION membership is invisible under a group-scoped context
     * (0001's `memberships_group_scope` policy), so "not yours" and "not there"
     * are deliberately the same reply — the T-05b rule, applied here. */
    expect(refusal?.code).toBe('ASSIGNEE_NOT_IN_GROUP');
  });

  it('accepts an ordinary active member', async () => {
    await expect(
      run(async (uow) =>
        assertAssignableMembership(
          uow,
          assigneeA,
          new Date('2037-06-01T08:00:00Z'),
          new Date('2037-06-01T16:00:00Z'),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
