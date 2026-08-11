import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  QualificationRuleError,
  StaleRowVersionError,
  changeHoldingStatus,
  createQualification,
  grantHolding,
  setQualificationStatus,
} from '../../src/profiles/qualifications.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **Migration 0012's database boundaries, red-cased at both layers**
 * (OPUS-M4-000A; doc 34 §4-B; doc 35 §3 Required behaviour clauses 2–4).
 *
 * Every rule here is enforced twice — a typed service refusal (the 422 the
 * form can address) and a trigger (what binds every writer that is not the
 * service) — and every rule is proven at BOTH layers:
 *
 *   service layer   the typed error class, thrown before any statement
 *   database layer  the raw statement as the OWNER (`session_replication_role`
 *                   untouched — the triggers must fire), refused by SQLSTATE
 *
 * The MUTATION CONTROLS run each violation with the triggers suspended inside
 * a transaction that is ALWAYS rolled back, and observe the violation SUCCEED
 * — proving each refusal is the trigger's doing and each test can fail. The
 * rolled-back state is verified gone (the sweep-mutation discipline).
 */

const multi = ownedMulti('staffing-integrity', { seed: { catalogue: ['alpha'] } });

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

function actorContext(correlationId: string) {
  return groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    alpha().users.groupOnly.membershipId,
    correlationId,
  );
}

/** Run inside the ACTOR's unit of work (the granted staffing administrator). */
async function run<T>(
  correlationId: string,
  fn: Parameters<Runtime['runner']['run']>[1] extends (uow: infer U) => unknown
    ? (uow: U) => Promise<T>
    : never,
): Promise<T> {
  return runtime.runner.run(actorContext(correlationId), fn as never) as Promise<T>;
}

async function sqlstateOfOwner(text: string, values: unknown[]): Promise<string | 'ACCEPTED'> {
  try {
    await admin.query(text, values);
    return 'ACCEPTED';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

/**
 * The DATABASE arm: a raw statement issued under the granted actor's unit of
 * work — the SERVICE layer is bypassed entirely, the 0004/0006 capability
 * guards are satisfied, and whatever refuses is migration 0012's trigger.
 * (The OWNER cannot demonstrate these triggers directly: the 0004 capability
 * guards fire first for a context-less owner and refuse with 42501 before the
 * 0012 rule is reached.)
 */
async function sqlstateOfActor(
  correlationId: string,
  build: (tag: typeof sql) => ReturnType<typeof sql>,
): Promise<string | 'ACCEPTED'> {
  return sqlstateOfMembership(alpha().users.groupOnly.membershipId, correlationId, build);
}

/**
 * The same raw arm under an ARBITRARY group-one membership — the same
 * `app_runtime` role and therefore the same table grants, a different acting
 * membership and therefore a different capability answer. This is what makes
 * the 0013 gate observable: the grant is per ROLE, the capability is per
 * MEMBERSHIP, and before 0013 the DELETE guards only ever asked the first.
 */
async function sqlstateOfMembership(
  membershipId: string,
  correlationId: string,
  build: (tag: typeof sql) => ReturnType<typeof sql>,
): Promise<string | 'ACCEPTED'> {
  const context = groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    membershipId,
    correlationId,
  );
  try {
    await runtime.runner.run(context, async (uow) => {
      await build(sql).execute(uow.query as never);
    });
    return 'ACCEPTED';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

let requiresExpiryQualificationId: string;
let retiredQualificationId: string;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 4 });

  // The seeding actor: `groupOnly` holds no other membership, and the grants
  // are left OPEN for this file's lifetime — this fixture is owned, and no
  // SBX matrix runs against it.
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.groupOnly.membershipId,
    capabilities: [
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
      'staffing.work_profile.administer',
    ],
  });
  // The requirement-edge arms write `shift_type_qualifications`, whose 0006
  // guard wants the catalogue key — role-implied for the scheduler, granted
  // here to the same seeding actor for symmetry.
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.groupOnly.membershipId,
    capabilities: ['schedule.catalogue.administer'],
  });

  requiresExpiryQualificationId = (
    await run('seed-expiring', (uow) =>
      createQualification(uow as never, {
        key: 'expiring-credential',
        name: 'Synthetic expiring credential',
        requiresExpiry: true,
      }),
    )
  ).id;

  const retired = await run('seed-retired', (uow) =>
    createQualification(uow as never, {
      key: 'withdrawn-credential',
      name: 'Synthetic withdrawn credential',
    }),
  );
  retiredQualificationId = retired.id;
  await run('retire-it', (uow) =>
    setQualificationStatus(uow as never, {
      qualificationId: retiredQualificationId,
      status: 'retired',
      expectedVersion: retired.version,
    }),
  );
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * requires_expiry — service AND database (packet clause 2)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('requires_expiry, at both layers', () => {
  it('SERVICE: an open-ended holding of a requires-expiry qualification is refused, typed, with nothing written', async () => {
    let error: unknown;
    try {
      await run('svc-expiry', (uow) =>
        grantHolding(uow as never, {
          membershipId: alpha().users.member.membershipId,
          qualificationId: requiresExpiryQualificationId,
          status: 'valid',
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QualificationRuleError);
    expect((error as QualificationRuleError).code).toBe('QUALIFICATION_REQUIRES_EXPIRY');

    const rows = await admin.query<{ n: number }>(
      'select count(*)::int as n from qualification_holdings where qualification_id = $1::uuid',
      [requiresExpiryQualificationId],
    );
    expect(rows.rows[0]?.n, 'the refused grant left a row').toBe(0);
    log('service: QUALIFICATION_REQUIRES_EXPIRY before any statement');
  });

  it('DATABASE: the same raw INSERT, service bypassed, is refused by the trigger, 23001', async () => {
    const code = await sqlstateOfActor('db-expiry', (tag) =>
      tag`insert into qualification_holdings
            (id, organization_id, group_id, membership_id, qualification_id, status)
          values (${randomUUID()}::uuid, ${alpha().organizationId}::uuid,
                  ${alpha().groupOne.id}::uuid, ${alpha().users.member.membershipId}::uuid,
                  ${requiresExpiryQualificationId}::uuid, 'valid')`,
    );
    expect(code, 'the raw write bypassed the requires-expiry trigger').toBe('23001');
    log('database: raw INSERT without valid_until → restrict_violation');
  });

  it('DATABASE: flipping requires_expiry ON over live open-ended holdings is refused', async () => {
    // A plain qualification with an open-ended holding…
    const plain = await run('flip-seed', (uow) =>
      createQualification(uow as never, { key: 'flip-subject', name: 'Flip subject' }),
    );
    await run('flip-hold', (uow) =>
      grantHolding(uow as never, {
        membershipId: alpha().users.member.membershipId,
        qualificationId: plain.id,
        status: 'valid',
      }),
    );
    // …cannot become requires-expiry by a later flip: the two-statement bypass.
    const code = await sqlstateOfActor('db-flip', (tag) =>
      tag`update qualifications set requires_expiry = true where id = ${plain.id}::uuid`,
    );
    expect(code, 'the flip bypass is open').toBe('23001');
    log('database: requires_expiry flip over open-ended live holdings → 23001');
  });

  it('MUTATION CONTROL: with the trigger suspended, the violation SUCCEEDS (rolled back)', async () => {
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      const code = await sqlstateOfOwner(
        `insert into qualification_holdings
           (id, organization_id, group_id, membership_id, qualification_id, status)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'valid')`,
        [
          randomUUID(),
          alpha().organizationId,
          alpha().groupOne.id,
          alpha().users.member.membershipId,
          requiresExpiryQualificationId,
        ],
      );
      expect(code, 'the refusal is NOT the trigger — the red case is measuring something else').toBe(
        'ACCEPTED',
      );
    } finally {
      await admin.query('rollback');
    }
    const rows = await admin.query<{ n: number }>(
      'select count(*)::int as n from qualification_holdings where qualification_id = $1::uuid',
      [requiresExpiryQualificationId],
    );
    expect(rows.rows[0]?.n, 'the mutation control leaked state').toBe(0);
    log('mutation control: trigger suspended → violation lands; rolled back clean');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Retired qualifications — the three authored rulings (packet clause 3)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('retired qualifications, at both layers', () => {
  it('SERVICE: a NEW holding naming a retired qualification is refused, typed', async () => {
    let error: unknown;
    try {
      await run('svc-retired', (uow) =>
        grantHolding(uow as never, {
          membershipId: alpha().users.member.membershipId,
          qualificationId: retiredQualificationId,
          status: 'valid',
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QualificationRuleError);
    expect((error as QualificationRuleError).code).toBe('QUALIFICATION_RETIRED');
    log('service: QUALIFICATION_RETIRED on a new holding');
  });

  it('DATABASE: the same raw INSERT, service bypassed, is refused, 23001', async () => {
    const code = await sqlstateOfActor('db-retired', (tag) =>
      tag`insert into qualification_holdings
            (id, organization_id, group_id, membership_id, qualification_id, status)
          values (${randomUUID()}::uuid, ${alpha().organizationId}::uuid,
                  ${alpha().groupOne.id}::uuid, ${alpha().users.member.membershipId}::uuid,
                  ${retiredQualificationId}::uuid, 'valid')`,
    );
    expect(code).toBe('23001');
    log('database: raw INSERT of a retired-qualification holding → 23001');
  });

  it('EXISTING holdings are retained, readable, and their status machine keeps working', async () => {
    // Issue while active, THEN retire — the retained-holding arm.
    const subject = await run('retain-seed', (uow) =>
      createQualification(uow as never, { key: 'retire-with-holdings', name: 'Retire with holdings' }),
    );
    const holding = await run('retain-hold', (uow) =>
      grantHolding(uow as never, {
        membershipId: alpha().users.member.membershipId,
        qualificationId: subject.id,
        status: 'valid',
      }),
    );
    await run('retain-retire', (uow) =>
      setQualificationStatus(uow as never, {
        qualificationId: subject.id,
        status: 'retired',
        expectedVersion: subject.version,
      }),
    );

    // Retained and readable…
    const rows = await admin.query<{ status: string }>(
      'select status from qualification_holdings where id = $1::uuid',
      [holding.id],
    );
    expect(rows.rows[0]?.status).toBe('valid');

    // …and still governable: revoking a holding of a retired qualification
    // must remain possible (the status machine is about the HOLDING).
    const revoked = await run('retain-revoke', (uow) =>
      changeHoldingStatus(uow as never, {
        holdingId: holding.id,
        status: 'revoked',
        expectedVersion: holding.version,
      }),
    );
    expect(revoked?.status).toBe('revoked');
    log('retirement retains holdings and leaves their status machine live');
  });

  it('DATABASE: a NEW shift_type_qualifications row naming a retired qualification is refused', async () => {
    const shiftTypeId = multi.catalogue().shiftTypeIds[0];
    const code = await sqlstateOfActor('db-stq-new', (tag) =>
      tag`insert into shift_type_qualifications
            (id, organization_id, group_id, shift_type_id, qualification_id)
          values (${randomUUID()}::uuid, ${alpha().organizationId}::uuid,
                  ${alpha().groupOne.id}::uuid, ${shiftTypeId}::uuid,
                  ${retiredQualificationId}::uuid)`,
    );
    expect(code).toBe('23001');
    log('database: new requirement edge to a retired qualification → 23001');
  });

  it('DATABASE: REACTIVATING an archived requirement of a now-retired qualification is refused', async () => {
    /* The second "new requirement" shape: archive an active requirement, retire
     * its qualification, then attempt status archived -> active — the path the
     * set-replacement's re-add takes (0006: re-adding reactivates). */
    const subject = await run('reactivation-seed', (uow) =>
      createQualification(uow as never, { key: 'reactivation-subject', name: 'Reactivation subject' }),
    );
    const shiftTypeId = multi.catalogue().shiftTypeIds[1];
    const rowId = randomUUID();
    // Planted ARCHIVED while the qualification is still active — my trigger
    // only gates rows ENTERING the active set, so this insert is admitted.
    expect(
      await sqlstateOfActor('reactivation-plant', (tag) =>
        tag`insert into shift_type_qualifications
              (id, organization_id, group_id, shift_type_id, qualification_id, status)
            values (${rowId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${shiftTypeId}::uuid,
                    ${subject.id}::uuid, 'archived')`,
      ),
    ).toBe('ACCEPTED');
    await run('reactivation-retire', (uow) =>
      setQualificationStatus(uow as never, {
        qualificationId: subject.id,
        status: 'retired',
        expectedVersion: subject.version,
      }),
    );

    const code = await sqlstateOfActor('reactivation-attempt', (tag) =>
      tag`update shift_type_qualifications set status = 'active' where id = ${rowId}::uuid`,
    );
    expect(code).toBe('23001');

    // The retained-archived row is untouched — and an UPDATE that leaves an
    // ACTIVE row active is admitted (existing requirements are retained), which
    // the trigger distinguishes by the OLD status.
    const status = await admin.query<{ status: string }>(
      'select status from shift_type_qualifications where id = $1::uuid',
      [rowId],
    );
    expect(status.rows[0]?.status).toBe('archived');
    log('database: archived→active reactivation naming a retired qualification → 23001');
  });

  it('MUTATION CONTROL: with the trigger suspended the retired INSERT lands (rolled back)', async () => {
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      const code = await sqlstateOfOwner(
        `insert into qualification_holdings
           (id, organization_id, group_id, membership_id, qualification_id, status)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'valid')`,
        [
          randomUUID(),
          alpha().organizationId,
          alpha().groupOne.id,
          alpha().users.member.membershipId,
          retiredQualificationId,
        ],
      );
      expect(code).toBe('ACCEPTED');
    } finally {
      await admin.query('rollback');
    }
    log('mutation control: the retired refusal is the trigger, and only the trigger');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Row CAS — holding/qualification mutations carry expectedVersion (clause 4)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('row-version CAS on qualification and holding mutations', () => {
  it('a stale expectedVersion is refused, typed, and the row does not move', async () => {
    const subject = await run('cas-seed', (uow) =>
      createQualification(uow as never, { key: 'cas-subject', name: 'CAS subject' }),
    );
    // First mutation wins at version 1…
    await run('cas-first', (uow) =>
      setQualificationStatus(uow as never, {
        qualificationId: subject.id,
        status: 'retired',
        expectedVersion: subject.version,
      }),
    );
    // …the second presents the version the first consumed.
    let error: unknown;
    try {
      await run('cas-stale', (uow) =>
        setQualificationStatus(uow as never, {
          qualificationId: subject.id,
          status: 'active',
          expectedVersion: subject.version,
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StaleRowVersionError);

    const status = await admin.query<{ status: string }>(
      'select status from qualifications where id = $1::uuid',
      [subject.id],
    );
    expect(status.rows[0]?.status, 'the stale writer won anyway').toBe('retired');
    log('row CAS: stale expectedVersion → StaleRowVersionError, no movement');
  });

  it('the counters are DATABASE-owned: naming version in an UPDATE raises 42501 for the runtime', async () => {
    for (const table of ['qualifications', 'qualification_holdings']) {
      const allowed = await admin.query<{ allowed: boolean }>(
        `select has_column_privilege('app_runtime', $1, 'version', 'UPDATE') as allowed`,
        [table],
      );
      expect(allowed.rows[0]?.allowed, `${table}.version is app-writable`).toBe(false);
    }
    log('qualifications.version / qualification_holdings.version: outside every UPDATE grant');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The aggregate counter table itself
 * ──────────────────────────────────────────────────────────────────────────── */

describe('staffing_set_versions is database-owned and monotonic', () => {
  it('no runtime role holds INSERT, UPDATE or DELETE on the counter', async () => {
    for (const role of ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
        const result = await admin.query<{ allowed: boolean }>(
          `select has_table_privilege($1, 'staffing_set_versions', $2) as allowed`,
          [role, privilege],
        );
        expect(result.rows[0]?.allowed, `${role} holds ${privilege} on the counter`).toBe(false);
      }
    }
    log('the trigger is the only writer of staffing_set_versions');
  });

  it('the OWNER cannot rewind a counter — 23001', async () => {
    // A counter row exists for the catalogue seed's demand aggregate.
    const row = await admin.query<{ id: string; version: number }>(
      `select id, version from staffing_set_versions where scope = 'weekday_demand' limit 1`,
    );
    const counter = row.rows[0];
    expect(counter, 'no counter row exists — the trigger never fired').toBeDefined();
    const code = await sqlstateOfOwner(
      `update staffing_set_versions set version = version - 1 where id = $1::uuid`,
      [counter?.id],
    );
    expect(code).toBe('23001');
    log('owner UPDATE lowering an aggregate version → restrict_violation');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Work-profile deletion: future-only, for the OWNER too (clause 5's DB half)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('work-profile deletion is future-only', () => {
  it('an IN-FORCE row is refused (23001, owner too) and a strictly-FUTURE row is admitted', async () => {
    const membershipId = alpha().users.groupOnly.membershipId;
    const inForceId = randomUUID();
    const futureId = randomUUID();
    // Planted through the granted actor: an in-force open row bounded by a
    // future change — the ordinary supersession shape.
    expect(
      await sqlstateOfActor('wp-plant', (tag) =>
        tag`insert into membership_work_profiles
              (id, organization_id, group_id, membership_id,
               effective_from, effective_to, work_percentage)
            values (${inForceId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${membershipId}::uuid,
                    '2026-01-01T00:00:00Z', '2090-01-01T00:00:00Z', '60.00'),
                   (${futureId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${membershipId}::uuid,
                    '2090-01-01T00:00:00Z', null, '80.00')`,
      ),
    ).toBe('ACCEPTED');

    // The in-force row: refused for the RUNTIME (which now holds DELETE)…
    expect(
      await sqlstateOfActor('wp-delete-inforce', (tag) =>
        tag`delete from membership_work_profiles where id = ${inForceId}::uuid`,
      ),
      'a window whose time has begun was deletable by the runtime',
    ).toBe('23001');
    // …and for the OWNER, who is not capability-gated on DELETE, so the
    // refusal observed here is 0012's narrowed guard itself.
    expect(
      await sqlstateOfOwner('delete from membership_work_profiles where id = $1::uuid', [inForceId]),
      'a window whose time has begun was deletable by the owner',
    ).toBe('23001');

    // The strictly-future row: the cancellation arm is open.
    expect(
      await sqlstateOfActor('wp-delete-future', (tag) =>
        tag`delete from membership_work_profiles where id = ${futureId}::uuid`,
      ),
    ).toBe('ACCEPTED');
    const remaining = await admin.query<{ n: number }>(
      'select count(*)::int as n from membership_work_profiles where id = $1::uuid',
      [futureId],
    );
    expect(remaining.rows[0]?.n).toBe(0);
    log('delete guard: in-force refused (runtime AND owner); strictly-future admitted');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Work-profile deletion is CAPABILITY-gated too (migration 0013 — the
 * independent review's finding F-1, closed as condition C1)
 *
 * 0012 narrowed the two DELETE guards to admit a strictly-future cancellation
 * and granted `app_runtime` the DELETE to carry it — but the narrowed bodies
 * asked only whether the window was future, never whether the acting
 * membership could cancel anything. The HTTP route is gated
 * (`AUTHOR_WORK_PROFILE_CONFIG`, action key `staffing.work_profile.administer`),
 * so this was a defence-in-depth asymmetry rather than a live hole: every
 * OTHER statement class on these tables is capability-gated at the database
 * (0004), and this one was not.
 *
 * The subject rows here belong to these cases alone (FAD-15): windows on
 * `member`, which no other case in this file ever gives a work profile, each
 * authored and removed inside its own case. The three windows are also
 * DISJOINT (2026→2094, 2095→2096, 2097→2098), so the EXCLUDE constraint cannot
 * turn a failure in one case into a misleading `23P01` in another under
 * test-order shuffle.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('work-profile deletion is capability-gated (0013)', () => {
  it('an UNCAPABILITIED runtime principal is refused 42501 on a strictly-future row and its weekday target; the granted one still cancels', async () => {
    const subject = alpha().users.member.membershipId;
    // `member` holds role `member` and no staffing grant — the staffing
    // capabilities are grant-only, so no system role supplies one.
    const uncapabilitied = alpha().users.member.membershipId;
    const futureId = randomUUID();
    const targetId = randomUUID();

    expect(
      await sqlstateOfActor('cap-plant-profile', (tag) =>
        tag`insert into membership_work_profiles
              (id, organization_id, group_id, membership_id,
               effective_from, effective_to, work_percentage)
            values (${futureId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${subject}::uuid,
                    '2095-01-01T00:00:00Z', '2096-01-01T00:00:00Z', '70.00')`,
      ),
      'the granted actor could not author the future window this case needs',
    ).toBe('ACCEPTED');
    expect(
      await sqlstateOfActor('cap-plant-target', (tag) =>
        tag`insert into membership_weekday_fte
              (id, organization_id, group_id, work_profile_id, day, fte_fraction)
            values (${targetId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${futureId}::uuid, 'mon', '0.700')`,
      ),
    ).toBe('ACCEPTED');

    // The child first — the order the service uses, and the order the FK forces.
    expect(
      await sqlstateOfMembership(uncapabilitied, 'cap-delete-target', (tag) =>
        tag`delete from membership_weekday_fte where id = ${targetId}::uuid`,
      ),
      'a weekday target of a future window was deletable without the capability',
    ).toBe('42501');
    expect(
      await sqlstateOfMembership(uncapabilitied, 'cap-delete-profile', (tag) =>
        tag`delete from membership_work_profiles where id = ${futureId}::uuid`,
      ),
      'a strictly-future work-profile window was deletable without the capability',
    ).toBe('42501');

    // Nothing left: the refusals were refusals, not partial work.
    const survived = await admin.query<{ profiles: number; targets: number }>(
      `select (select count(*)::int from membership_work_profiles where id = $1::uuid) as profiles,
              (select count(*)::int from membership_weekday_fte    where id = $2::uuid) as targets`,
      [futureId, targetId],
    );
    expect(survived.rows[0]?.profiles, 'the refused DELETE removed the profile anyway').toBe(1);
    expect(survived.rows[0]?.targets, 'the refused DELETE removed the target anyway').toBe(1);

    // The LEGITIMATE path is untouched: the same statements, from the granted
    // membership, still cancel the future window.
    expect(
      await sqlstateOfActor('cap-cancel-target', (tag) =>
        tag`delete from membership_weekday_fte where id = ${targetId}::uuid`,
      ),
      '0013 closed the legitimate cancellation path',
    ).toBe('ACCEPTED');
    expect(
      await sqlstateOfActor('cap-cancel-profile', (tag) =>
        tag`delete from membership_work_profiles where id = ${futureId}::uuid`,
      ),
      '0013 closed the legitimate cancellation path',
    ).toBe('ACCEPTED');

    const remaining = await admin.query<{ n: number }>(
      'select count(*)::int as n from membership_work_profiles where id = $1::uuid',
      [futureId],
    );
    expect(remaining.rows[0]?.n).toBe(0);
    log('0013: future-row DELETE without staffing.work_profile.administer → 42501; granted → accepted');
  });

  it('the RETENTION rule still answers FIRST: an in-force row is 23001, not 42501, for the owner too', async () => {
    // Ordering is load-bearing. If 0013 had asked the capability question
    // first, 0012's proof that the retention guard binds the OWNER would have
    // become unobservable — the owner holds no capability, so every refusal
    // would read 42501 and the retention rule would never be reached.
    const subject = alpha().users.member.membershipId;
    const inForceId = randomUUID();
    expect(
      await sqlstateOfActor('cap-order-plant', (tag) =>
        tag`insert into membership_work_profiles
              (id, organization_id, group_id, membership_id,
               effective_from, effective_to, work_percentage)
            values (${inForceId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${subject}::uuid,
                    '2026-02-01T00:00:00Z', '2094-01-01T00:00:00Z', '55.00')`,
      ),
    ).toBe('ACCEPTED');

    expect(
      await sqlstateOfOwner('delete from membership_work_profiles where id = $1::uuid', [inForceId]),
      'the retention rule no longer answers first for the owner',
    ).toBe('23001');
    expect(
      await sqlstateOfMembership(alpha().users.member.membershipId, 'cap-order-uncap', (tag) =>
        tag`delete from membership_work_profiles where id = ${inForceId}::uuid`,
      ),
      'the retention rule no longer answers first for an uncapabilitied principal',
    ).toBe('23001');
    log('0013 ordering: retention (23001) before capability (42501), owner included');
  });

  it('MUTATION CONTROL: with the guards suspended, the uncapabilitied DELETE SUCCEEDS (rolled back)', async () => {
    const subject = alpha().users.member.membershipId;
    const futureId = randomUUID();
    expect(
      await sqlstateOfActor('cap-control-plant', (tag) =>
        tag`insert into membership_work_profiles
              (id, organization_id, group_id, membership_id,
               effective_from, effective_to, work_percentage)
            values (${futureId}::uuid, ${alpha().organizationId}::uuid,
                    ${alpha().groupOne.id}::uuid, ${subject}::uuid,
                    '2097-01-01T00:00:00Z', '2098-01-01T00:00:00Z', '65.00')`,
      ),
    ).toBe('ACCEPTED');

    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      expect(
        await sqlstateOfOwner('delete from membership_work_profiles where id = $1::uuid', [
          futureId,
        ]),
        'the refusal is NOT the trigger — this red case is measuring something else',
      ).toBe('ACCEPTED');
    } finally {
      await admin.query('rollback');
    }

    const survived = await admin.query<{ n: number }>(
      'select count(*)::int as n from membership_work_profiles where id = $1::uuid',
      [futureId],
    );
    expect(survived.rows[0]?.n, 'the mutation control leaked state').toBe(1);

    // Clean up through the granted path, so the case owns its subject end to end.
    expect(
      await sqlstateOfActor('cap-control-cleanup', (tag) =>
        tag`delete from membership_work_profiles where id = ${futureId}::uuid`,
      ),
    ).toBe('ACCEPTED');
    log('mutation control: guards suspended → the delete lands; rolled back clean');
  });
});
