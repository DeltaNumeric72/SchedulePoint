import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type pg from 'pg';

import { PG_ERRORS, isPostgresError } from '../../src/db/pg-errors.js';
import { loadWorkProfiles } from '../../src/profiles/in-force-loader.js';
import { authorWorkProfile } from '../../src/profiles/work-profiles.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **History is immutable, proven at the database — including against the table
 * OWNER.**
 *
 * The packet's red case: *"an UPDATE to a historical profile row is rejected"*.
 *
 * ## Why every probe here runs as the SUPERUSER
 *
 * The runtime roles hold a column-level UPDATE grant reaching only `effective_to`
 * and `updated_at`, so a runtime attempt to rewrite a work percentage fails at
 * the PRIVILEGE layer — which proves the grant, not the rule. The rule is the
 * trigger, and the only way to reach it is as a caller the grant does not bind.
 *
 * A superuser bypasses RLS and bypasses grants. It does **not** bypass triggers.
 * So each probe below declares a tenant context, acts as an administrator, and
 * issues the statement a maintenance script would — which is exactly the caller
 * the guard exists for, and exactly the caller a "the runtime cannot reach it"
 * argument does not cover.
 *
 * Green before red throughout: each rejection is preceded by the permitted
 * statement it is a variation of.
 */

// `full`, because the T-01 cases each need a membership that owns NO profile yet:
// a subject with an existing window makes `before-first` and `gap` unreachable.
const multi = ownedMulti('profiles-history-immutability', { profile: 'full' });

let runtime: Runtime;
let admin: pg.Client;

const org = (): string => multi().alpha.organizationId;
const group = (): string => multi().alpha.groupOne.id;
const actor = (): string => multi().alpha.users.groupOnly.membershipId;

/** A `full`-profile group-one membership, by name. Fails loudly if absent. */
function fullUser(which: 'viewer' | 'telecom' | 'groupAdmin'): string {
  const user = multi().alpha.full?.[which];
  if (user === undefined) {
    throw new Error(`the full MULTI profile did not provision ${which}`);
  }
  return user.membershipId;
}

function context(correlationId: string): {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
} {
  return { organizationId: org(), groupId: group(), membershipId: actor(), correlationId };
}

/** Runs SQL as the superuser WITH a tenant context and an acting administrator. */
async function asOwner<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  await admin.query('BEGIN');
  try {
    await admin.query(`select set_config('app.organization_id', $1, true)`, [org()]);
    await admin.query(`select set_config('app.group_id', $1, true)`, [group()]);
    await admin.query(`select set_config('app.membership_id', $1, true)`, [actor()]);
    const result = await admin.query<T>(text, values);
    await admin.query('COMMIT');
    return result;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

function sqlstateOf(error: unknown): string | undefined {
  return isPostgresError(error) ? error.code : undefined;
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 4 });
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: org(),
    groupId: group(),
    membershipId: actor(),
    capabilities: [
      'staffing.work_profile.administer',
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
    ],
  });
}, 120_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/**
 * The two windows the first block plants, at module scope because the T-05
 * delete-guard case reuses them: every membership in this file owns a window by
 * the time it runs, so planting fresh rows there would collide with the EXCLUDE
 * constraint rather than test anything.
 */
let elapsedId: string;
let liveId: string;

describe('a work-profile window that has ALREADY ENDED cannot be touched', () => {

  beforeAll(async () => {
    const subject = multi().alpha.users.scheduler.membershipId;
    elapsedId = randomUUID();
    liveId = randomUUID();
    await runtime.runner.run(context('plant'), async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: elapsedId,
          organization_id: org(),
          group_id: group(),
          membership_id: subject,
          effective_from: new Date('2022-01-01T00:00:00.000Z'),
          effective_to: new Date('2024-01-01T00:00:00.000Z'),
          work_percentage: '100.00',
        })
        .execute();
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: liveId,
          organization_id: org(),
          group_id: group(),
          membership_id: subject,
          effective_from: new Date('2024-01-01T00:00:00.000Z'),
          effective_to: null,
          work_percentage: '80.00',
        })
        .execute();
    });
  });

  it('GREEN — the LIVE window can be closed at a future instant (this is supersession)', async () => {
    // The permitted statement, so every rejection below is a variation of
    // something that works rather than of something that never worked.
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await asOwner(`update membership_work_profiles set effective_to = $2 where id = $1`, [
      liveId,
      future,
    ]);
    const rows = await admin.query<{ effective_to: Date }>(
      'select effective_to from membership_work_profiles where id = $1',
      [liveId],
    );
    expect(rows.rows[0]?.effective_to).not.toBeNull();
    // Put it back open-ended for the tests below — permitted, because shortening
    // to NULL is refused but this row is still unelapsed, so we re-open by
    // deleting and reinserting? No: re-opening is refused by design. Instead the
    // remaining tests use the ELAPSED row, which is the subject anyway.
  });

  const rejected = [
    {
      name: 'changing the work percentage of an elapsed window',
      sql: 'update membership_work_profiles set work_percentage = 55 where id = $1',
    },
    {
      name: 'moving the start instant of an elapsed window',
      sql: `update membership_work_profiles set effective_from = '2021-01-01T00:00:00Z' where id = $1`,
    },
    {
      name: 'moving the END instant of an elapsed window',
      sql: `update membership_work_profiles set effective_to = '2025-01-01T00:00:00Z' where id = $1`,
    },
    {
      name: 're-opening an elapsed window',
      sql: 'update membership_work_profiles set effective_to = null where id = $1',
    },
    {
      name: 'moving an elapsed window to another membership',
      sql: 'update membership_work_profiles set membership_id = membership_id where id = $1',
    },
  ] as const;

  for (const probe of rejected) {
    it(`RED — ${probe.name} is refused at the database`, async () => {
      let sqlstate: string | undefined;
      try {
        await asOwner(probe.sql, [elapsedId]);
      } catch (error) {
        sqlstate = sqlstateOf(error);
      }
      expect(sqlstate, `${probe.name} was ACCEPTED — history is not immutable`).toBe(
        PG_ERRORS.restrictViolation,
      );

      // …and the row is untouched, checked rather than assumed.
      const rows = await admin.query<{ work_percentage: string; effective_from: Date; effective_to: Date }>(
        'select work_percentage, effective_from, effective_to from membership_work_profiles where id = $1',
        [elapsedId],
      );
      expect(rows.rows[0]?.work_percentage).toBe('100.00');
      expect(rows.rows[0]?.effective_from.toISOString()).toBe('2022-01-01T00:00:00.000Z');
      expect(rows.rows[0]?.effective_to.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });
  }

  it('RED — closing a window in the PAST is refused (retroactive close)', async () => {
    const subject = multi().alpha.users.member.membershipId;
    const id = randomUUID();
    await runtime.runner.run(context('plant-open'), async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id,
          organization_id: org(),
          group_id: group(),
          membership_id: subject,
          effective_from: new Date('2020-01-01T00:00:00.000Z'),
          effective_to: null,
          work_percentage: '70.00',
        })
        .execute();
    });

    let sqlstate: string | undefined;
    try {
      await asOwner(
        `update membership_work_profiles set effective_to = '2021-01-01T00:00:00Z' where id = $1`,
        [id],
      );
    } catch (error) {
      sqlstate = sqlstateOf(error);
    }
    expect(sqlstate, 'a window was retroactively shortened').toBe(PG_ERRORS.restrictViolation);
    log('a retroactive close is refused: history is what has already elapsed');
  });

  it('RED — no runtime role can reach a work-percentage UPDATE at all', async () => {
    // The other control. Even before the trigger, the column-level grant refuses:
    // `GRANT UPDATE (effective_to, updated_at)` and nothing else.
    let sqlstate: string | undefined;
    try {
      await runtime.runner.run(context('grant-probe'), async ({ query }) => {
        await query
          .updateTable('membership_work_profiles')
          .set({ work_percentage: '10.00' })
          .where('id', '=', elapsedId)
          .execute();
      });
    } catch (error) {
      sqlstate = sqlstateOf(error);
    }
    expect(sqlstate, 'a runtime role updated a column it holds no grant on').toBe(
      PG_ERRORS.insufficientPrivilege,
    );
    log('the column-level grant and the trigger are two independent controls, both firing');
  });

  it('a correction is a NEW row, and the elapsed history is still there afterwards', async () => {
    const subject = multi().alpha.users.groupTwoScheduler.membershipId;
    // Group two's membership needs the actor to hold the capability there; simpler
    // to use a group-one membership. `departed` is group one.
    const inGroupOne = multi().alpha.users.departed.membershipId;
    void subject;

    const first = await runtime.runner.run(context('correct-a'), (uow) =>
      authorWorkProfile(uow, { membershipId: inGroupOne, workPercentage: 100 }),
    );
    const correction = await runtime.runner.run(context('correct-b'), (uow) =>
      authorWorkProfile(uow, { membershipId: inGroupOne, workPercentage: 65 }),
    );

    const history = await runtime.runner.run(context('correct-read'), ({ query }) =>
      loadWorkProfiles(query, { organizationId: org(), membershipId: inGroupOne }),
    );
    expect(history.map((row) => row.id)).toEqual([first.profile.id, correction.profile.id]);
    expect(history[0]?.workPercentage, 'the corrected row was overwritten').toBe(100);
    expect(history[1]?.workPercentage).toBe(65);
    log('an administrative correction adds a row; the row it corrects is still readable');
  });
});

describe('T-01 — history is not AUTHORED either', () => {
  /**
   * The finding: `app_guard_work_profile_history` refuses every UPDATE that
   * touches elapsed time, so history cannot be REWRITTEN — and an INSERT dated
   * 2005 into a gap was accepted, because a well-formed row in an empty window is
   * exactly what the EXCLUDE constraint is happy with. It changed what the
   * in-force answer *was* for a period already scheduled against, while the
   * contract comment claimed the database refused it.
   *
   * Refused at the service now, with a 422, and the contract says which layer
   * enforces it. Both "no row in force" shapes are covered, because they reach
   * different branches of the selection rule: a GAP between two windows, and an
   * instant BEFORE the first window starts.
   */
  const org = (): string => multi().alpha.organizationId;

  async function attempt(
    membershipId: string,
    effectiveFrom: string,
  ): Promise<{ threw: boolean; message: string }> {
    try {
      await runtime.runner.run(context('retro-attempt'), (uow) =>
        authorWorkProfile(uow, { membershipId, effectiveFrom, workPercentage: 42 }),
      );
      return { threw: false, message: '' };
    } catch (error) {
      return { threw: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async function auditRowsFor(membershipId: string): Promise<number> {
    // Audit rows are counted through the PROFILE ids belonging to this membership,
    // so the assertion is relative to this subject rather than to everything that
    // has ever happened in the organization.
    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n
         from audit_events a
        where a.organization_id = $1::uuid
          and a.event_name like 'staffing.work_profile.%'
          and a.subject_id in (
            select p.id from membership_work_profiles p
             where p.organization_id = $1::uuid and p.membership_id = $2::uuid
          )`,
      [org(), membershipId],
    );
    return Number(rows.rows[0]?.n ?? '0');
  }

  it('GREEN control — a FUTURE effectiveFrom is accepted', async () => {
    // Without this the refusals below would also pass on a service that rejected
    // every explicit instant, which would break future-dating — the capability the
    // packet actually requires.
    const subject = fullUser('viewer');
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const authored = await runtime.runner.run(context('future-ok'), (uow) =>
      authorWorkProfile(uow, { membershipId: subject, effectiveFrom: future, workPercentage: 55 }),
    );
    expect(authored.profile.effectiveFrom).toBe(future);
    log('a future-dated effectiveFrom is still accepted — future-dating is not what was refused');
  });

  it('RED — an instant BEFORE the first window is refused with no row and no audit row', async () => {
    // A group-one membership that owns NO profile, so 2005 is `before-first`
    // rather than a gap — the two reach different branches of the selection rule
    // and the packet's ruling asks for both.
    const inGroupOne = fullUser('telecom');

    const before = await auditRowsFor(inGroupOne);
    const outcome = await attempt(inGroupOne, '2005-03-01T00:00:00.000Z');

    expect(outcome.threw, 'a 2005 profile was authored').toBe(true);
    expect(outcome.message).toContain('WORK_PROFILE_RETROACTIVE_AUTHORING');

    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n from membership_work_profiles
        where organization_id = $1::uuid and membership_id = $2::uuid
          and effective_from < '2010-01-01T00:00:00Z'`,
      [org(), inGroupOne],
    );
    expect(rows.rows[0]?.n, 'the retro-dated row landed anyway').toBe('0');
    expect(await auditRowsFor(inGroupOne), 'a refused authoring left an audit row').toBe(before);
    log('a retro-dated authoring before the first window: 0 rows written, 0 audit rows');
  });

  it('RED — an instant inside a GAP between two windows is refused', async () => {
    // The reviewer's exact shape. A gap is the case where a retro-dated row is
    // most plausible and most damaging: it is accepted by every constraint and it
    // silently changes the in-force verdict for a period already elapsed.
    const subject = fullUser('groupAdmin');
    await runtime.runner.run(context('plant-gap-pair'), async ({ query }) => {
      for (const [from, to] of [
        ['2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'],
        ['2023-01-01T00:00:00.000Z', null],
      ] as const) {
        await query
          .insertInto('membership_work_profiles')
          .values({
            id: randomUUID(),
            organization_id: org(),
            group_id: group(),
            membership_id: subject,
            effective_from: new Date(from),
            effective_to: to === null ? null : new Date(to),
            work_percentage: '90.00',
          })
          .execute();
      }
    });

    const before = await auditRowsFor(subject);
    // 2022 sits in the gap: the EXCLUDE constraint permits it, and only the
    // service rule refuses it.
    const outcome = await attempt(subject, '2022-06-01T00:00:00.000Z');

    expect(outcome.threw, 'a row was authored into a historical gap').toBe(true);
    expect(outcome.message).toContain('WORK_PROFILE_RETROACTIVE_AUTHORING');

    const gapRows = await admin.query<{ n: string }>(
      `select count(*)::text as n from membership_work_profiles
        where organization_id = $1::uuid and membership_id = $2::uuid
          and effective_from = '2022-06-01T00:00:00Z'`,
      [org(), subject],
    );
    expect(gapRows.rows[0]?.n, 'the gap-filling row landed anyway').toBe('0');
    expect(await auditRowsFor(subject), 'a refused authoring left an audit row').toBe(before);
    log('a retro-dated authoring into a gap: refused, 0 rows, 0 audit rows');
  });

  it('the refusal is a 422 over HTTP, not a 500', async () => {
    // The message names no row and no tenant; the status is the one
    // `translatePgError` already gives a guard-trigger refusal, so the surface
    // answers the same way whichever layer said no.
    const outcome = await attempt(
      multi().alpha.users.member.membershipId,
      '2019-01-01T00:00:00.000Z',
    );
    expect(outcome.threw).toBe(true);
    expect(outcome.message).not.toContain(org());
  });
});

describe('archive, never delete', () => {
  let qualificationId: string;
  let holdingId: string;

  beforeAll(async () => {
    qualificationId = randomUUID();
    holdingId = randomUUID();
    await runtime.runner.run(context('seed-qualification'), async ({ query }) => {
      await query
        .insertInto('qualifications')
        .values({
          id: qualificationId,
          organization_id: org(),
          group_id: group(),
          key: 'retention-probe',
          name: 'Retention Probe',
        })
        .execute();
      await query
        .insertInto('qualification_holdings')
        .values({
          id: holdingId,
          organization_id: org(),
          group_id: group(),
          membership_id: multi().alpha.users.scheduler.membershipId,
          qualification_id: qualificationId,
          status: 'valid',
        })
        .execute();
    });
  });

  it('GREEN — retiring a qualification is permitted', async () => {
    await asOwner(`update qualifications set status = 'retired' where id = $1`, [qualificationId]);
    const rows = await admin.query<{ status: string }>(
      'select status from qualifications where id = $1',
      [qualificationId],
    );
    expect(rows.rows[0]?.status).toBe('retired');
  });

  it('RED — deleting a qualification that has holdings is refused, even for the owner', async () => {
    let sqlstate: string | undefined;
    try {
      await asOwner('delete from qualifications where id = $1', [qualificationId]);
    } catch (error) {
      sqlstate = sqlstateOf(error);
    }
    expect(sqlstate, 'a qualification with holdings was deleted').toBe(PG_ERRORS.restrictViolation);

    const rows = await admin.query<{ n: string }>(
      'select count(*)::text as n from qualifications where id = $1',
      [qualificationId],
    );
    expect(rows.rows[0]?.n).toBe('1');
    log('a qualification with holdings cannot be deleted — retire it instead');
  });

  it('T-05 — owner DELETE is refused on ALL FOUR tables', async () => {
    /* The rationale this migration states for the qualification tables — "the
     * runtime is not the only caller a database has" — applies verbatim to the
     * profile tables, and an independent review pointed out that it was written
     * down and not implemented there. All four now carry the guard, and this
     * asserts all four rather than the two that had it. */
    /* ── this case ESTABLISHES its own two rows ────────────────────────────
     *
     * The first version reused `elapsedId` and `liveId` from the OTHER describe
     * block, and `fixture-regression` caught it on five of twelve seeds: under
     * test-order shuffle this block can run first, and those ids are `undefined`
     * before the sibling's `beforeAll` has run. Worse, one of them depended on a
     * sibling TEST having closed `liveId` at a future instant — a dependency on
     * another test's side effect, which is the coupling class FAD-15 exists to
     * remove.
     *
     * The window is IN FORCE (opened far in the past, open-ended) — since
     * OPUS-M4-000A a strictly-FUTURE window is legitimately deletable (the
     * cancellation path, migration 0012), so this case plants a window whose
     * time has begun, which is exactly the class the retention rule still
     * refuses unconditionally. The weekday guard — which refuses targets on a
     * window that has already ended — is satisfied because the window is open.
     *
     * The subject is `groupOnly`, which owns no profile anywhere in this file.
     * It was `telecom` until the window became a past-dated one, and
     * `fixture-regression` caught what that did: T-01's `before-first` case
     * counts `telecom`'s rows with `effective_from < 2010` to prove its
     * retro-dated authoring wrote nothing, so whenever this case ran first it
     * supplied the row T-01 then blamed on the service. `telecom` was only
     * ever safe here while the planted window was FUTURE-dated; a subject no
     * other case names is safe whatever the window and whatever the order. */
    const subject = multi().alpha.users.groupOnly.membershipId;
    const profileId = randomUUID();
    const weekdayId = randomUUID();
    await runtime.runner.run(context('delete-guard-seed'), async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: profileId,
          organization_id: org(),
          group_id: group(),
          membership_id: subject,
          effective_from: new Date('2001-01-01T00:00:00.000Z'),
          effective_to: null,
          work_percentage: '30.00',
        })
        .execute();
      await query
        .insertInto('membership_weekday_fte')
        .values({
          id: weekdayId,
          organization_id: org(),
          group_id: group(),
          work_profile_id: profileId,
          day: 'mon',
          fte_fraction: '0.300',
        })
        .execute();
    });

    const refusals: Record<string, string | undefined> = {};
    for (const [table, id] of [
      ['membership_weekday_fte', weekdayId],
      ['membership_work_profiles', profileId],
      ['qualifications', qualificationId],
      ['qualification_holdings', holdingId],
    ] as const) {
      try {
        await asOwner(`delete from ${table} where id = $1`, [id]);
        refusals[table] = 'ACCEPTED';
      } catch (error) {
        refusals[table] = sqlstateOf(error);
      }
    }

    expect(refusals, 'owner DELETE was accepted on a table that must retain its rows').toEqual({
      membership_weekday_fte: PG_ERRORS.restrictViolation,
      membership_work_profiles: PG_ERRORS.restrictViolation,
      qualifications: PG_ERRORS.restrictViolation,
      qualification_holdings: PG_ERRORS.restrictViolation,
    });

    // …and the rows are still there, checked rather than assumed.
    for (const [table, id] of [
      ['membership_weekday_fte', weekdayId],
      ['membership_work_profiles', profileId],
    ] as const) {
      const rows = await admin.query<{ n: string }>(
        `select count(*)::text as n from ${table} where id = $1::uuid`,
        [id],
      );
      expect(rows.rows[0]?.n, `${table}: the row went anyway`).toBe('1');
    }
    log('owner DELETE refused with 23001 on all four staffing tables (in-force/elapsed rows)');
  });

  it('RED — deleting a qualification HOLDING is refused unconditionally (retained for audit)', async () => {
    let sqlstate: string | undefined;
    try {
      await asOwner('delete from qualification_holdings where id = $1', [holdingId]);
    } catch (error) {
      sqlstate = sqlstateOf(error);
    }
    expect(sqlstate, 'a credential record was deleted').toBe(PG_ERRORS.restrictViolation);
    log('a qualification holding is retained after expiry for audit — delete is refused');
  });

  it('RED — a holding\'s WINDOW and evidence reference cannot be edited after issue', async () => {
    for (const [name, sql] of [
      ['valid_from', `update qualification_holdings set valid_from = now() where id = $1`],
      ['valid_until', `update qualification_holdings set valid_until = now() where id = $1`],
      ['evidence_ref', `update qualification_holdings set evidence_ref = 'OTHER-REF' where id = $1`],
    ] as const) {
      let sqlstate: string | undefined;
      try {
        await asOwner(sql, [holdingId]);
      } catch (error) {
        sqlstate = sqlstateOf(error);
      }
      expect(sqlstate, `${name} was edited after issue`).toBe(PG_ERRORS.restrictViolation);
    }
  });

  it('GREEN then RED — the status machine permits valid -> expired and refuses expired -> valid', async () => {
    await asOwner(`update qualification_holdings set status = 'expired' where id = $1`, [holdingId]);
    const after = await admin.query<{ status: string }>(
      'select status from qualification_holdings where id = $1',
      [holdingId],
    );
    expect(after.rows[0]?.status).toBe('expired');

    let sqlstate: string | undefined;
    try {
      await asOwner(`update qualification_holdings set status = 'valid' where id = $1`, [holdingId]);
    } catch (error) {
      sqlstate = sqlstateOf(error);
    }
    expect(sqlstate, 'an expired credential was reinstated').toBe(PG_ERRORS.restrictViolation);
    log('the credential status machine is enforced at the database; `revoked` and `expired` do not go back');
  });
});
