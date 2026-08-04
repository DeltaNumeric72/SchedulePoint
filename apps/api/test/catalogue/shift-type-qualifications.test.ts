import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATALOGUE_AUDIT_EVENTS } from '../../src/catalogue/policies.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * `shift_type_qualifications` — the M2-002 x M2-003 join (OPUS-M2-004,
 * migration 0006).
 *
 * ## What is proven here, and at which layer
 *
 * | Claim | Layer |
 * |---|---|
 * | RLS enabled AND forced, with a group-scoped policy | `pg_class` / `pg_policies` |
 * | composite tenant FK to BOTH parents | a cross-group INSERT is refused `23503` |
 * | archive-not-delete | no DELETE grant for any runtime role **and** the OWNER is refused by trigger |
 * | writes are gated by the catalogue-authoring capability | allow AND deny, through the route |
 * | the set write audits, before/after | one audit row, carrying the counts |
 * | registered in `TENANT_TABLES` | the registry, in the same change as the migration |
 *
 * ## The ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a refusal proves nothing unless the same shape
 * succeeds when it should. Every refusal below is preceded by the statement it
 * mirrors succeeding — otherwise a typo in a table name, an empty table, or an
 * already-aborted transaction all produce the same green.
 */

const multi = ownedMulti('catalogue-shift-type-qualifications', {
  profile: 'full',
  seed: { catalogue: ['alpha', 'beta'] },
});

let admin: pg.Client;
let runtime: Runtime;
let harness: HttpHarness;

const alpha = () => multi().alpha;
const beta = () => multi().beta;
const gamma = () => {
  const value = multi().gamma;
  if (value === undefined) throw new Error('the full profile provisions Gamma; it is missing');
  return value;
};

const base = (organizationId: string, groupId: string): string =>
  `/organizations/${organizationId}/groups/${groupId}/catalogue`;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
  harness = await buildHttpHarness();
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await harness.close();
  await admin.end();
});

async function call(
  method: 'GET' | 'PUT',
  userId: string,
  path: string,
  payload?: unknown,
  groupId = alpha().groupOne.id,
  organizationId = alpha().organizationId,
): Promise<{ statusCode: number; body: string }> {
  const counters = await currentCounters(admin, { organizationId, groupId, userId });
  const response = await harness.app.inject({
    method,
    url: `${base(organizationId, groupId)}${path}`,
    headers: {
      ...contextHeaders(userId, counters),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { statusCode: response.statusCode, body: response.body };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The schema
 * ──────────────────────────────────────────────────────────────────────────── */

describe('shift_type_qualifications — the schema', () => {
  it('is registered in TENANT_TABLES, in the same change as its migration', () => {
    const registered = TENANT_TABLES.find((table) => table.name === 'shift_type_qualifications');
    expect(
      registered,
      'a new tenant table missing from the registry is never probed by anything',
    ).toBeDefined();
    expect(registered?.scope).toBe('organization-and-group');
    log(`TENANT_TABLES holds ${String(TENANT_TABLES.length)} tables, including this one`);
  });

  it('has RLS ENABLED and FORCED, with a group-scoped policy', async () => {
    const flags = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = $1`,
      ['shift_type_qualifications'],
    );
    expect(flags.rows[0]?.relrowsecurity, 'RLS is not enabled').toBe(true);
    expect(flags.rows[0]?.relforcerowsecurity, 'RLS is not FORCED — the owner bypasses it').toBe(
      true,
    );

    const policies = await admin.query<{ policyname: string; qual: string }>(
      `select policyname, qual from pg_policies where tablename = $1`,
      ['shift_type_qualifications'],
    );
    expect(policies.rows).toHaveLength(1);
    const predicate = policies.rows[0]?.qual ?? '';
    // All three clauses of V-09's conjunctive group predicate, individually.
    expect(predicate).toContain('organization_id');
    expect(predicate).toContain('group_id');
    // Every `current_setting` occurrence nullif-guarded (A-03b).
    const occurrences = predicate.split('current_setting').length - 1;
    const guarded = predicate.split('NULLIF').length - 1 + (predicate.split('nullif').length - 1);
    expect(occurrences, 'the policy reads no setting at all').toBeGreaterThan(0);
    expect(guarded, 'an unguarded current_setting is in the predicate').toBeGreaterThanOrEqual(
      occurrences,
    );
    log(`policy ${policies.rows[0]?.policyname ?? '?'}: ${String(occurrences)} guarded settings`);
  });

  it('carries a composite tenant foreign key to BOTH parents', async () => {
    const constraints = await admin.query<{ conname: string; definition: string }>(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'shift_type_qualifications'::regclass and contype = 'f'
        order by conname`,
    );
    const definitions = constraints.rows.map((row) => row.definition);

    const toShiftTypes = definitions.find((d) => d.includes('REFERENCES shift_types'));
    const toQualifications = definitions.find((d) => d.includes('REFERENCES qualifications'));
    expect(toShiftTypes, 'no foreign key to shift_types').toBeDefined();
    expect(toQualifications, 'no foreign key to qualifications').toBeDefined();

    // BOTH tenant columns in BOTH keys: a single-column key would be satisfied
    // by a parent in another organization entirely, and RLS would only hide the
    // consequence afterwards.
    for (const definition of [toShiftTypes ?? '', toQualifications ?? '']) {
      expect(definition).toContain('organization_id');
      expect(definition).toContain('group_id');
    }
    log(constraints.rows.map((row) => row.conname).join(', '));
  });

  it('refuses a requirement whose qualification lives in ANOTHER group', async () => {
    /* This test OWNS its shift type.
     *
     * It did not, and `fixture-regression`'s shuffled gate found the consequence
     * on the fifth fixed seed: the ALLOW control inserted a requirement for a
     * shift type the audit test also writes a requirement for, so whichever ran
     * second hit the tenant-qualified unique key and the control reported 0 rows
     * inserted. The subject is now created here, which is what "every test owns
     * its state" means (FAD-15) — and the shuffled gate is why it is stated as a
     * fix rather than as a flake. */
    const context = groupContext(
      alpha().organizationId,
      alpha().groupOne.id,
      alpha().users.scheduler.membershipId,
      'stq-fk-proof',
    );

    const { createShiftType } = await import('../../src/catalogue/service.js');
    const shiftTypeId = await runtime.runner.run(context, async (uow) => {
      const created = await createShiftType(uow, {
        code: 'FKPROOF',
        name: 'Foreign-key proof shift',
        description: null,
        displayPaletteKey: 'neutral',
        displayTextStyle: 'regular',
        startTime: '08:00',
        endTime: '16:00',
        isOnCall: false,
        attractsStipend: false,
        isManualOnly: false,
        isDailyPick: false,
        includeInStatistics: true,
        isLeaveOfAbsence: false,
        allowOnRequest: false,
        allowOffRequest: false,
        reportOrder: 0,
        creditWeight: 1,
      });
      if (created.kind !== 'ok') throw new Error(`setup reported ${created.kind}`);
      return created.value.shiftTypeId;
    });

    // ALLOW control: the same shape, both ends in the same group, succeeds.
    const ok = await runtime.runner.run(context, async ({ query }) => {
      const inserted = await query
        .insertInto('shift_type_qualifications')
        .values({
          id: randomUUID(),
          organization_id: alpha().organizationId,
          group_id: alpha().groupOne.id,
          shift_type_id: shiftTypeId,
          qualification_id: multi.catalogue().qualificationId,
        })
        .returning('id')
        .execute();
      return inserted.length;
    });
    expect(ok, 'the control insert did not land').toBe(1);

    // The refusal: the SIBLING group's qualification, named from Group One.
    let code: string | undefined;
    try {
      await runtime.runner.run(context, async ({ query }) => {
        await query
          .insertInto('shift_type_qualifications')
          .values({
            id: randomUUID(),
            organization_id: alpha().organizationId,
            group_id: alpha().groupOne.id,
            shift_type_id: shiftTypeId,
            qualification_id: multi.catalogue().sibling.qualificationId,
          })
          .execute();
      });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code, 'a cross-group requirement was accepted').toBe('23503');
    log('a requirement pointing at another group\'s qualification is refused 23503');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Archive, never delete
 * ──────────────────────────────────────────────────────────────────────────── */

describe('archive-not-delete, proven at the database', () => {
  it('no runtime role holds DELETE on the table', async () => {
    // The application roles only. `app_migrator` OWNS the table, and an owner's
    // implicit privileges are not a grant anybody made — which is exactly why
    // the trigger below exists and why "no DELETE grant" was never the whole
    // control.
    const grants = await admin.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.table_privileges
        where table_name = $1 and privilege_type = 'DELETE'
          and grantee in ('app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass')`,
      ['shift_type_qualifications'],
    );
    expect(
      grants.rows.map((row) => `${row.grantee}:${row.privilege_type}`),
      'a runtime role holds DELETE',
    ).toEqual([]);

    // ALLOW control: the roles DO hold the privileges the application needs, so
    // the empty list above is about DELETE rather than about an empty table name.
    const tableLevel = await admin.query<{ privilege_type: string }>(
      `select distinct privilege_type from information_schema.table_privileges
        where table_name = $1 and grantee = 'app_runtime' order by privilege_type`,
      ['shift_type_qualifications'],
    );
    expect(tableLevel.rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);

    // UPDATE is COLUMN-level and therefore not in `table_privileges` at all —
    // which is the point: `status` and `updated_at` are updatable and nothing
    // else is, so `version` cannot be forged and a row cannot be re-tenanted or
    // re-pointed at another qualification.
    const updatable = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_name = $1 and grantee = 'app_runtime' and privilege_type = 'UPDATE'
        order by column_name`,
      ['shift_type_qualifications'],
    );
    expect(updatable.rows.map((row) => row.column_name)).toEqual(['status', 'updated_at']);
    log('app_runtime: INSERT + SELECT, UPDATE on (status, updated_at) only, no DELETE');
  });

  it('the OWNER is refused too, by the guard trigger', async () => {
    const target = await admin.query<{ id: string }>(
      `select id::text as id from shift_type_qualifications
        where organization_id = $1::uuid and group_id = $2::uuid limit 1`,
      [alpha().organizationId, alpha().groupOne.id],
    );
    const id = target.rows[0]?.id;
    expect(id, 'the fixture wrote no requirement row — this proof would be vacuous').toBeDefined();

    /* ALLOW control: the same predicate, as the same connection, MATCHES a row.
     *
     * Not an UPDATE — `shift_type_qualifications_guard_administration` fires for
     * the superuser too (a trigger is not RLS), so an UPDATE here would be
     * refused by the capability gate and would say nothing about DELETE. What
     * this needs to rule out is a refusal that is really "the predicate matched
     * nothing", and a SELECT with the identical WHERE clause rules exactly that
     * out. */
    const addressable = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_type_qualifications where id = $1::uuid',
      [id],
    );
    expect(addressable.rows[0]?.n, 'the delete predicate matches no row at all').toBe(1);

    let message = '';
    try {
      await admin.query('delete from shift_type_qualifications where id = $1::uuid', [id]);
    } catch (error) {
      message = String((error as { message?: string }).message ?? '');
    }
    expect(message).toContain('SHIFT_TYPE_QUALIFICATION_RETAINED');

    const survivors = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_type_qualifications where id = $1::uuid',
      [id],
    );
    expect(survivors.rows[0]?.n, 'the row was deleted anyway').toBe(1);
    log('the table OWNER is refused a DELETE by app_guard_shift_type_qualification_delete');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The authorized API
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the requirement set, through the route', () => {
  it('ALLOW: a scheduler reads and replaces the set, and removal ARCHIVES rather than deletes', async () => {
    const scheduler = alpha().users.scheduler.id;
    const shiftTypeId = multi.catalogue().shiftTypeIds[0] as string;
    const qualificationId = multi.catalogue().qualificationId;

    const before = await call('GET', scheduler, `/shift-types/${shiftTypeId}/qualifications`);
    expect(before.statusCode, before.body).toBe(200);
    expect(
      (JSON.parse(before.body).requirements as { qualificationId: string }[]).map(
        (r) => r.qualificationId,
      ),
      'the fixture seeded no requirement — every assertion below would be vacuous',
    ).toContain(qualificationId);

    // Remove it: the row must survive with `active: false`.
    const emptied = await call('PUT', scheduler, `/shift-types/${shiftTypeId}/qualifications`, {
      qualificationIds: [],
    });
    expect(emptied.statusCode, emptied.body).toBe(200);
    const archived = JSON.parse(emptied.body).requirements as {
      qualificationId: string;
      active: boolean;
    }[];
    const archivedRow = archived.find((r) => r.qualificationId === qualificationId);
    expect(archivedRow, 'the removed requirement disappeared instead of being archived')
      .toBeDefined();
    expect(archivedRow?.active).toBe(false);

    const stored = await admin.query<{ n: number; status: string }>(
      `select count(*)::int as n, min(status) as status from shift_type_qualifications
        where shift_type_id = $1::uuid and qualification_id = $2::uuid`,
      [shiftTypeId, qualificationId],
    );
    expect(stored.rows[0]?.n, 'the row was deleted').toBe(1);
    expect(stored.rows[0]?.status).toBe('archived');

    // Re-add it: the SAME row reactivates. A second row would make "does this
    // shift type require X?" a question with more than one answer.
    const restored = await call('PUT', scheduler, `/shift-types/${shiftTypeId}/qualifications`, {
      qualificationIds: [qualificationId],
    });
    expect(restored.statusCode, restored.body).toBe(200);

    const after = await admin.query<{ n: number; status: string }>(
      `select count(*)::int as n, min(status) as status from shift_type_qualifications
        where shift_type_id = $1::uuid and qualification_id = $2::uuid`,
      [shiftTypeId, qualificationId],
    );
    expect(after.rows[0]?.n, 're-adding inserted a SECOND row').toBe(1);
    expect(after.rows[0]?.status).toBe('active');
    log('remove archives, re-add reactivates the same row — one row, one answer');
  });

  it('DENY: a member holds no catalogue key and is refused on both the read and the write', async () => {
    const member = alpha().users.member.id;
    const shiftTypeId = multi.catalogue().shiftTypeIds[0] as string;

    const read = await call('GET', member, `/shift-types/${shiftTypeId}/qualifications`);
    expect(read.statusCode).toBe(403);
    expect(read.body, 'the denial disclosed its reason').not.toContain('capability');

    const write = await call('PUT', member, `/shift-types/${shiftTypeId}/qualifications`, {
      qualificationIds: [],
    });
    expect(write.statusCode).toBe(403);

    // And nothing was written by the refused attempt.
    const rows = await admin.query<{ n: number }>(
      `select count(*)::int as n from shift_type_qualifications
        where shift_type_id = $1::uuid and status = 'active'`,
      [shiftTypeId],
    );
    expect(rows.rows[0]?.n).toBeGreaterThan(0);
    log('member → 403 on read and write, with no reason on the wire (P-3)');
  });

  it('DENY: an organization with no core_scheduling entitlement gets 404, not 403', async () => {
    // SPEC-06 P-5/P-6: a denial at L0–L2 must not disclose that the module
    // exists, so it is a 404; a role-level denial is a 403. Both arms matter and
    // this is the L1 one — Gamma is the entitlement-off organization.
    const response = await call(
      'GET',
      gamma().users.scheduler.id,
      `/shift-types/${randomUUID()}/qualifications`,
      undefined,
      gamma().groupOne.id,
      gamma().organizationId,
    );
    expect(response.statusCode).toBe(404);
    log('entitlement-off organization → 404 (L1), not 403');
  });

  it('a malformed shift-type id is refused on its SHAPE — 404, never a 500', async () => {
    // SBX-001 sends every registered route a request whose unsubstituted path
    // parameters arrive as literal text. This route answered 500 — the 22P02
    // uuid-syntax error escaping an uncaught read — which tells an unauthorized
    // caller that the parameter is a uuid while an absent route says 404.
    //
    // It is now refused by `requireUuid` BEFORE any statement runs, so the 22P02
    // class never reaches the database at all (review finding V-02). The catch
    // below it is narrowed to SQLSTATE-bearing errors, which is what makes that
    // layering worth having.
    const response = await call(
      'GET',
      alpha().users.scheduler.id,
      '/shift-types/:shiftTypeId/qualifications',
    );
    expect(response.statusCode, response.body).toBe(404);
    log('a non-uuid shift-type id is refused on shape → 404, no statement issued');
  });

  it('ABSENT, RLS-HIDDEN and CROSS-TENANT are indistinguishable — the identity that matters', async () => {
    /* The security-relevant identity, and only it: these are the three states an
     * actor probes to learn whether a row exists in a tenant they cannot see
     * (T-05b, SPEC-06 P-3). All three ids below are WELL-FORMED uuids, so the
     * shape check passes and each answer comes from the lookup itself.
     *
     * A malformed id is deliberately NOT in this comparison. It is refused
     * before any lookup, so it discloses nothing about any row; that it happens
     * to produce a 404 envelope is a consequence of `sendNotFound` being the
     * single not-found responder, not a claim this test makes (finding V-03). */
    const scheduler = alpha().users.scheduler.id;

    // 1. absent: a well-formed uuid naming nothing anywhere.
    const absent = await call('GET', scheduler, `/shift-types/${randomUUID()}/qualifications`);

    // 2. cross-tenant: a real shift type, in BETA, asked for from ALPHA.
    const betaShiftTypeId = multi.catalogue('beta').shiftTypeIds[0] as string;
    const crossTenant = await call('GET', scheduler, `/shift-types/${betaShiftTypeId}/qualifications`);

    // 3. RLS-hidden: a real shift type in THIS organization's SIBLING group,
    //    asked for from Group One.
    const siblingShiftTypeId = multi.catalogue().sibling.shiftTypeIds[0] as string;
    const hidden = await call('GET', scheduler, `/shift-types/${siblingShiftTypeId}/qualifications`);

    // The control first: both real subjects must exist where the test says they
    // do, or "indistinguishable" would be three ways of saying "absent".
    const truth = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_types where id = any($1::uuid[])',
      [[betaShiftTypeId, siblingShiftTypeId]],
    );
    expect(truth.rows[0]?.n, 'the cross-tenant and sibling subjects do not exist').toBe(2);

    // And the sibling subject really does carry requirements, read outside RLS —
    // so "the caller sees none" is isolation rather than an empty neighbour.
    const siblingRows = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_type_qualifications where shift_type_id = $1::uuid',
      [siblingShiftTypeId],
    );
    expect(siblingRows.rows[0]?.n, 'the sibling subject has no requirements to hide').toBeGreaterThan(0);

    /* The answer this read gives for all three is `200` with an EMPTY
     * requirement list, and that is the behaviour as shipped — asserted here
     * rather than changed, because the three being identical is the property
     * that matters and it holds.
     *
     * It does mean the read does not distinguish "no such shift type" from
     * "that shift type requires nothing". That conflation is recorded in
     * `docs/evidence/EV-M2-INTEGRATION/INDEX.md` as an authoring-usability
     * observation, not closed here: the WRITE path does check the subject and
     * answers 404, so a fix would be making the read consistent with it, which
     * is a behaviour change and not this round's. */
    const canonical = (response: { statusCode: number; body: string }): string => {
      const parsed = JSON.parse(response.body) as Record<string, unknown>;
      return JSON.stringify({
        status: response.statusCode,
        ...parsed,
        shiftTypeId: '<echoed back>',
        correlationId: '<per-request>',
      });
    };

    expect(canonical(crossTenant), 'cross-tenant is distinguishable from absent').toBe(
      canonical(absent),
    );
    expect(canonical(hidden), 'rls-hidden is distinguishable from absent').toBe(canonical(absent));

    // Stated positively as well, so a future change that made all three 404
    // together would still satisfy the identity and still pass.
    expect((JSON.parse(hidden.body) as { requirements: unknown[] }).requirements).toEqual([]);

    log(
      `absent = cross-tenant = rls-hidden: all ${String(absent.statusCode)}, identical apart ` +
        'from the echoed id and the correlation id',
    );
  });

  it('the write lands exactly one audit row, carrying its before/after counts', async () => {
    const scheduler = alpha().users.scheduler.id;
    const shiftTypeId = multi.catalogue().shiftTypeIds[1] as string;

    const head = await admin.query<{ seq: string }>(
      `select coalesce(max(sequence), 0)::text as seq from audit_events
        where organization_id = $1::uuid`,
      [alpha().organizationId],
    );
    const marker = BigInt(head.rows[0]?.seq ?? '0');

    const response = await call('PUT', scheduler, `/shift-types/${shiftTypeId}/qualifications`, {
      qualificationIds: [multi.catalogue().qualificationId],
    });
    expect(response.statusCode, response.body).toBe(200);

    const rows = await admin.query<{ event_name: string; subject_type: string; payload: unknown }>(
      `select event_name, subject_type, payload from audit_events
        where organization_id = $1::uuid and sequence > $2::bigint
        order by audit_events.sequence`,
      [alpha().organizationId, marker.toString()],
    );
    const emitted = rows.rows.filter(
      (row) => row.event_name === CATALOGUE_AUDIT_EVENTS.shiftTypeQualificationsSet,
    );
    expect(emitted, 'not exactly one audit row for the requirement write').toHaveLength(1);
    expect(emitted[0]?.subject_type).toBe('shift_type');

    const payload = emitted[0]?.payload as Record<string, unknown>;
    expect(payload['mechanism']).toBe('set');
    expect(payload).toHaveProperty('beforeActiveCount');
    expect(payload).toHaveProperty('afterActiveCount');
    expect(payload['afterActiveCount']).toBe(1);
    log(`audit payload: ${JSON.stringify(payload)}`);
  });

  it('cross-tenant: Beta cannot see or address Alpha\'s requirement rows', async () => {
    // Ground truth first, as the superuser: BOTH tenants really do hold rows, so
    // "Beta sees none of Alpha's" is not a statement about an empty table.
    const truth = await admin.query<{ organizations: number; total: number }>(
      `select count(distinct organization_id)::int as organizations, count(*)::int as total
         from shift_type_qualifications where organization_id = any($1::uuid[])`,
      [[alpha().organizationId, beta().organizationId]],
    );
    expect(truth.rows[0]?.organizations, 'only one tenant holds requirement rows').toBe(2);

    const visible = await runtime.runner.run(
      groupContext(
        beta().organizationId,
        beta().groupOne.id,
        beta().users.scheduler.membershipId,
        'stq-cross-tenant',
      ),
      async ({ query }) => {
        const rows = await query
          .selectFrom('shift_type_qualifications')
          .select('id')
          .where('organization_id', '=', alpha().organizationId)
          .execute();
        return rows.length;
      },
    );
    expect(visible, 'Beta read Alpha\'s requirement rows').toBe(0);
    log(`${String(truth.rows[0]?.total ?? 0)} rows across two tenants; Beta sees 0 of Alpha's`);
  });
});
