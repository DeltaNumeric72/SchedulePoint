import { AUDIT_EVENT_NAMES, AUDIT_SUBJECT_TYPES } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import { CATALOGUE_AUDIT_EVENTS } from '../../src/catalogue/policies.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Every catalogue mutation lands exactly one audit row, in the same
 * transaction, under a name from the closed vocabulary.**
 *
 * ## Why this is driven over HTTP rather than scanned
 *
 * `apps/api/test/audit/emission-coverage.test.ts` scans `http/routes` and `jobs`
 * for a write and asserts the module also records. That scanner cannot see this
 * slice: the catalogue's writes live in `src/catalogue/service.ts` and its audit
 * emission in `src/http/routes/catalogue.route.ts`, so a regex over either file
 * alone reports the wrong answer — the route "records but never writes" and the
 * service "writes but never records", and both readings are wrong about the
 * pair.
 *
 * **Extending the scanner's root list would therefore have made it fail for a
 * true system**, which is the worst kind of gate change. So the coverage is
 * asserted empirically instead, which is stronger: every one of the ten declared
 * event names is DRIVEN through its real route and the resulting row is read
 * back from `audit_events`. A name nothing emits fails here, and a mutation that
 * emits nothing fails here.
 *
 * ## And the chain still verifies
 *
 * SPEC-11: the per-organization hash chain must verify clean after the suite.
 * Ten new appends through a new surface is exactly when a chain breaks.
 */

// The catalogue seeding grants the two group-settings capabilities to the
// scheduler and lays down a baseline catalogue, so the routes below have
// subjects to act on. Since the D-1 ruling it is `provisionMulti`'s work,
// declared here rather than called afterwards.
const multi = ownedMulti('catalogue-audit', {
  profile: 'full',
  // Staffing too, since OPUS-M2-004: the eleventh mutation sets a shift type's
  // qualification requirements, and the qualification it names has to exist in
  // the same group. The seeding creates one; creating it here would need
  // `staffing.qualification.administer`, which is grant-only.
  seed: { staffing: true, catalogue: ['alpha'] },
});

let admin: pg.Client;
let harness: HttpHarness;
let runtime: Runtime;

const alpha = () => multi().alpha;
const base = () =>
  `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/catalogue`;

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  userId: string,
  path: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const counters = await currentCounters(admin, {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    userId,
  });
  const response = await harness.app.inject({
    method,
    url: `${base()}${path}`,
    headers: {
      ...contextHeaders(userId, counters),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { statusCode: response.statusCode, body: response.body };
}

/** The audit rows written since a marker sequence, for this organization. */
async function eventsSince(sequence: number): Promise<{ event_name: string; subject_type: string }[]> {
  const result = await admin.query<{ event_name: string; subject_type: string }>(
    `select event_name, subject_type from audit_events
      where organization_id = $1 and sequence > $2 order by sequence`,
    [alpha().organizationId, sequence],
  );
  return result.rows;
}

async function headSequence(): Promise<number> {
  const result = await admin.query<{ head: string | null }>(
    'select max(sequence)::text as head from audit_events where organization_id = $1',
    [alpha().organizationId],
  );
  return Number(result.rows[0]?.head ?? 0);
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await harness.close();
  await admin.end();
});

describe('the catalogue audit vocabulary', () => {
  it('every declared event name is in the closed vocabulary', () => {
    for (const name of Object.values(CATALOGUE_AUDIT_EVENTS)) {
      expect(AUDIT_EVENT_NAMES as readonly string[], name).toContain(name);
    }
    log(`${String(Object.keys(CATALOGUE_AUDIT_EVENTS).length)} catalogue event names, all declared`);
  });

  it('every catalogue subject type is in the closed vocabulary', () => {
    for (const subject of ['shift_type', 'shift_group', 'staff_group', 'valid_group', 'group_holiday']) {
      expect(AUDIT_SUBJECT_TYPES as readonly string[], subject).toContain(subject);
    }
  });
});

describe('every catalogue mutation emits, and emits exactly once', () => {
  it('drives all eleven mutations and reads back one audit row each', async () => {
    const scheduler = alpha().users.scheduler.id;
    const marker = await headSequence();

    /* ── the eleven mutations, in dependency order ──────────────────────── */

    const created = await request('POST', scheduler, '/shift-types', {
      code: 'AUD',
      name: 'Audited shift',
      startTime: '06:00',
      endTime: '14:00',
    });
    expect(created.statusCode, created.body).toBe(200);
    const shiftTypeId = JSON.parse(created.body).shiftType.shiftTypeId as string;

    expect(
      (await request('PATCH', scheduler, `/shift-types/${shiftTypeId}`, { name: 'Renamed' }))
        .statusCode,
    ).toBe(200);

    expect(
      (
        await request('PUT', scheduler, `/shift-types/${shiftTypeId}/weekday-demand`, {
          // OPUS-M4-000A: the whole-set replacement carries the aggregate CAS;
          // a fresh shift type's never-written aggregate presents version 1.
          demand: [{ day: 'wed', demandCount: 2 }],
          expectedVersion: 1,
        })
      ).statusCode,
    ).toBe(200);

    const shiftGroup = await request('POST', scheduler, '/shift-groups', {
      name: 'Audited bundle',
      scoring: { scoringMode: 'hard' },
      request: { allowRequest: false },
      shiftTypeIds: [shiftTypeId],
    });
    expect(shiftGroup.statusCode, shiftGroup.body).toBe(200);
    const shiftGroupId = JSON.parse(shiftGroup.body).shiftGroup.shiftGroupId as string;

    expect(
      (await request('PATCH', scheduler, `/shift-groups/${shiftGroupId}`, { name: 'Renamed bundle' }))
        .statusCode,
    ).toBe(200);

    expect(
      (await request('POST', scheduler, '/staff-groups', { name: 'Audited pool' })).statusCode,
    ).toBe(200);

    const validGroup = await request('POST', scheduler, '/valid-groups', {
      name: 'Audited combination',
      shiftTypeIds: [shiftTypeId],
      allowedPickPositions: [1, 2],
    });
    expect(validGroup.statusCode, validGroup.body).toBe(200);

    const picks = await request('PUT', scheduler, '/pick-positions', { pickPositionCount: 7 });
    expect(picks.statusCode, picks.body).toBe(200);

    const holiday = await request('POST', scheduler, '/holidays', {
      holidayDate: '2029-07-04',
      name: 'Audited holiday',
    });
    expect(holiday.statusCode, holiday.body).toBe(200);

    // The eleventh (OPUS-M2-004): the qualification requirement set. Filed under
    // the shift type, because a requirement has no life apart from the type it
    // constrains.
    const requirements = await request(
      'PUT',
      scheduler,
      `/shift-types/${shiftTypeId}/qualifications`,
      // OPUS-M4-000A: the aggregate CAS; a fresh shift type presents 1.
      { qualificationIds: [multi().staffing?.qualificationId], expectedVersion: 1 },
    );
    expect(requirements.statusCode, requirements.body).toBe(200);

    // Retirement last, which must produce `archived` rather than `updated`.
    expect(
      (await request('PATCH', scheduler, `/shift-types/${shiftTypeId}`, { status: 'retired' }))
        .statusCode,
    ).toBe(200);

    /* ── what landed ────────────────────────────────────────────────────── */

    const rows = await eventsSince(marker);
    const names = rows.map((row) => row.event_name);

    for (const expected of Object.values(CATALOGUE_AUDIT_EVENTS)) {
      expect(names, `no audit row for ${expected}`).toContain(expected);
    }

    // Exactly one per mutation: eleven mutations, eleven catalogue rows. A second
    // row per mutation would mean the emission ran twice, which is a different and
    // equally serious defect from emitting none.
    const catalogueRows = rows.filter((row) => row.event_name.startsWith('catalogue.'));
    expect(catalogueRows).toHaveLength(11);

    // And the subject types are the aggregates, not a catch-all.
    const bySubject = new Map(catalogueRows.map((row) => [row.event_name, row.subject_type]));
    expect(bySubject.get('catalogue.shift_type.created')).toBe('shift_type');
    expect(bySubject.get('catalogue.shift_type_demand.set')).toBe('shift_type');
    expect(bySubject.get('catalogue.shift_group.created')).toBe('shift_group');
    expect(bySubject.get('catalogue.staff_group.created')).toBe('staff_group');
    expect(bySubject.get('catalogue.valid_group.created')).toBe('valid_group');
    expect(bySubject.get('catalogue.group_holiday.created')).toBe('group_holiday');
    // The pick-position count is a property of the GROUP, not of a catalogue
    // aggregate — filing it elsewhere would make "what changed about this
    // group?" unanswerable.
    expect(bySubject.get('catalogue.pick_positions.increased')).toBe('group');
    expect(bySubject.get('catalogue.shift_type_qualifications.set')).toBe('shift_type');

    log(`11 catalogue mutations → 11 audit rows: ${catalogueRows.map((r) => r.event_name).join(', ')}`);
  });

  it('a DENIED mutation writes neither the change nor an audit row', async () => {
    // FAD-12's ordering, from the outside: the evaluation comes first, so a
    // refusal leaves no audit row claiming a change happened. An audit trail
    // that records refused attempts as changes is worse than none.
    const marker = await headSequence();
    const denied = await request('POST', alpha().users.member.id, '/shift-types', {
      code: 'DENIED',
      name: 'Never created',
      startTime: '09:00',
      endTime: '17:00',
    });
    expect(denied.statusCode).toBe(403);

    const rows = await eventsSince(marker);
    expect(rows.filter((row) => row.event_name.startsWith('catalogue.'))).toEqual([]);

    const stored = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_types where code = $1',
      ['DENIED'],
    );
    expect(stored.rows[0]?.n).toBe(0);
    log('denied POST /shift-types → 403, 0 audit rows, 0 shift types');
  });

  it('the audit chain verifies clean after every catalogue append', async () => {
    /* Drives its OWN append first.
     *
     * It used to assert `entries > 10`, which is a statement about the
     * ten-mutation test having already run — order dependence, and
     * `corepack pnpm fixture-regression`'s shuffled run found it. A chain
     * verification is meaningful over whatever the chain contains; what it must
     * not be is meaningful over an EMPTY chain, so this establishes at least one
     * entry of its own and asserts against that floor. */
    const appended = await request('POST', alpha().users.scheduler.id, '/shift-types', {
      code: 'CHAIN',
      name: 'Chain verification subject',
      startTime: '05:00',
      endTime: '13:00',
    });
    expect(appended.statusCode, appended.body).toBe(200);

    const verification = await runtime.runner.run(
      {
        organizationId: alpha().organizationId,
        groupId: null,
        membershipId: alpha().users.organizationAdmin.membershipId,
        correlationId: 'catalogue-audit-verify',
      },
      (uow) => verifyAuditChain(uow),
    );
    expect(verification.problems, JSON.stringify(verification.problems)).toEqual([]);
    // A verification over an empty chain is the vacuous pass this floor exists
    // to refuse; the exact count depends on which tests have run and is not the
    // property being asserted.
    expect(verification.entries).toBeGreaterThan(0);
    log(
      `chain verified: ${String(verification.entries)} entries, head ${verification.headSequence ?? 'none'}, 0 problems`,
    );
  });
});
