import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities, revokeGrantsById } from '../support/staffing.js';
import { createPool } from '../../src/db/pool.js';
import { ProcessAlertSink } from '../../src/db/alerts.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';

/**
 * **NAMED-CONDITION PROOF 1 — the eligibility read answers per shift type, with
 * zero cross-tenant leakage.** (OPUS-M2-004, packet 30 §6a.)
 *
 * Two questions, one requirement edge:
 *
 *   * which qualifications does shift type X require?
 *   * which shift types is member M qualified for?
 *
 * The second is the one worth proving carefully, because its input is
 * `qualification_holdings` — `SENSITIVE-PII` in doc 06 §3.2 — and its output
 * names shift types. A read that crossed a tenant boundary in either direction
 * would leak a credential fact into another organization's roster surface.
 *
 * ## What this proves, in order
 *
 * | # | Claim | How a failure would look |
 * |---|---|---|
 * | 1 | **ALLOW control** — a member holding the required credential reads `eligible: true` for the shift type that requires it | the fixture is wrong and every later zero means nothing |
 * | 2 | the answer is **per shift type**: the one WITH a requirement and the one WITHOUT are answered differently | a blanket true/false |
 * | 3 | a member **without** the credential reads `eligible: false`, naming the missing qualification | eligibility ignores holdings |
 * | 4 | **zero cross-tenant leakage**: Beta's identical membership id space is asked about from Alpha and answers with ALPHA's shift types only, never Beta's | ids from the neighbour tenant in the response |
 * | 5 | **zero cross-GROUP leakage**: asked in Group One, the answer names Group One's shift types and not the sibling group's | the CAR-001 defect class |
 * | 6 | expiry is honoured **at the evaluated instant** | an expired credential still confers eligibility |
 *
 * Claim 4 is the one that needs a control of its own, and it has one: the test
 * asserts first that Beta's catalogue really does hold shift types with
 * requirements — read as the superuser, outside RLS — so "Alpha's answer names
 * none of them" is a statement about isolation rather than about an empty
 * neighbour.
 *
 * ## What this deliberately does NOT prove
 *
 * That anything is ENFORCED. `eligible` is arithmetic over the requirements and
 * the holdings the caller can see; enforcement belongs to the M4 engine and is
 * explicitly not in this milestone.
 */

const multi = ownedMulti('catalogue-eligibility-read', {
  seed: { catalogue: ['alpha', 'beta'] },
});

let admin: pg.Client;
let harness: HttpHarness;
let runner: PgUnitOfWorkRunner;
let closePool: (() => Promise<void>) | undefined;

const alpha = () => multi().alpha;
const beta = () => multi().beta;

/**
 * The membership the credential is issued to, and the one the reads ask about.
 *
 * `groupOnly` is in Alpha GROUP ONE, which is load-bearing:
 * `qualification_holdings` refuses a holding naming a membership the declared
 * context cannot see, and the requirement being read lives in Group One.
 */
const subject = () => alpha().users.groupOnly.membershipId;
/** The reader: Group One's scheduler, who will be granted `…read_any`. */
const reader = () => alpha().users.scheduler;

let holdingId = '';
const expiredHoldingId = randomUUID();
let readerGrantIds: readonly string[] = [];

interface EligibilityRow {
  shiftTypeId: string;
  shiftTypeCode: string;
  requiredQualificationIds: string[];
  missingQualificationIds: string[];
  eligible: boolean;
}

async function eligibility(
  userId: string,
  membershipId: string,
  organizationId: string,
  groupId: string,
): Promise<{ statusCode: number; shiftTypes: EligibilityRow[]; body: string }> {
  const counters = await currentCounters(admin, { organizationId, groupId, userId });
  const response = await harness.app.inject({
    method: 'GET',
    url:
      `/organizations/${organizationId}/groups/${groupId}/catalogue` +
      `/memberships/${membershipId}/eligible-shift-types`,
    headers: contextHeaders(userId, counters),
  });
  const parsed =
    response.statusCode === 200
      ? ((JSON.parse(response.body) as { shiftTypes: EligibilityRow[] }).shiftTypes ?? [])
      : [];
  return { statusCode: response.statusCode, shiftTypes: parsed, body: response.body };
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();

  const pool = createPool('app_runtime', { max: 3, allowExitOnIdle: true });
  closePool = () => pool.end();
  runner = new PgUnitOfWorkRunner({
    role: 'app_runtime',
    pool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });

  /* ── the precondition, ESTABLISHED rather than assumed ────────────────────
   *
   * The holding is written the way production writes one: an
   * administrator-granted capability, a real guard trigger, a real unit of work.
   * The issuer is `member` and the subject is `groupOnly` — two different Group
   * One memberships, so the guard's two-person rule is satisfied without
   * contrivance. The issuing grant is closed again immediately: a principal left
   * holding a staffing key changes what SBX-001's matrix sees on the profiles
   * routes, which is the reasoning the fixture's own staffing seeding records. */
  const issuerGrants = await grantStaffingCapabilities(runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.member.membershipId,
    capabilities: ['staffing.qualification_holding.administer'],
  });

  holdingId = randomUUID();
  await runner.run(
    {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      membershipId: alpha().users.member.membershipId,
      correlationId: 'eligibility-seed',
    },
    async ({ query }) => {
      await query
        .insertInto('qualification_holdings')
        .values({
          id: holdingId,
          organization_id: alpha().organizationId,
          group_id: alpha().groupOne.id,
          membership_id: subject(),
          qualification_id: multi.catalogue().qualificationId,
          valid_until: new Date('2035-01-01T00:00:00.000Z'),
          evidence_ref: 'SYNTH-ELIG-0001',
          status: 'valid',
        })
        .execute();
    },
  );
  /* A SECOND holding, already out of force, on a different Group One membership.
   *
   * Expiry is proven by a holding whose window has closed rather than by moving
   * an in-force one: `valid_until` is in NO update grant (0004 — a credential
   * window is superseded, never rewritten), so mutating one would have needed a
   * privilege the application deliberately does not have, and the test would
   * have been about the superuser rather than about the read. */
  await runner.run(
    {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      membershipId: alpha().users.member.membershipId,
      correlationId: 'eligibility-seed-expired',
    },
    async ({ query }) => {
      await query
        .insertInto('qualification_holdings')
        .values({
          id: expiredHoldingId,
          organization_id: alpha().organizationId,
          group_id: alpha().groupOne.id,
          membership_id: alpha().users.departed.membershipId,
          qualification_id: multi.catalogue().qualificationId,
          valid_from: new Date('2019-01-01T00:00:00.000Z'),
          valid_until: new Date('2020-01-01T00:00:00.000Z'),
          evidence_ref: 'SYNTH-ELIG-EXPIRED',
          status: 'valid',
        })
        .execute();
    },
  );

  await revokeGrantsById(runner, multi(), {
    organizationId: alpha().organizationId,
    grantIds: issuerGrants.grantIds,
  });

  // The reader needs `…read_any` to see somebody else's holdings at all. Left
  // open for the life of this file and closed in `afterAll` by row id.
  const granted = await grantStaffingCapabilities(runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: reader().membershipId,
    capabilities: [
      'staffing.qualification_holding.read',
      'staffing.qualification_holding.read_any',
    ],
  });
  readerGrantIds = granted.grantIds;
}, 180_000);

afterAll(async () => {
  if (readerGrantIds.length > 0) {
    await revokeGrantsById(runner, multi(), {
      organizationId: alpha().organizationId,
      grantIds: readerGrantIds,
    });
  }
  await harness.close();
  if (closePool !== undefined) await closePool();
  await admin.end();
});

describe('the eligibility read (named-condition proof 1)', () => {
  it('CONTROL: the credentialed member is eligible for the shift type that requires it', async () => {
    const answer = await eligibility(
      reader().id,
      subject(),
      alpha().organizationId,
      alpha().groupOne.id,
    );
    expect(answer.statusCode, answer.body).toBe(200);

    const requiring = answer.shiftTypes.filter((row) => row.requiredQualificationIds.length > 0);
    expect(
      requiring.length,
      'no shift type in this group requires anything — every assertion below would be vacuous',
    ).toBeGreaterThan(0);

    for (const row of requiring) {
      expect(row.requiredQualificationIds).toContain(multi.catalogue().qualificationId);
      expect(row.missingQualificationIds, `${row.shiftTypeCode} reported a missing credential`)
        .toEqual([]);
      expect(row.eligible, `${row.shiftTypeCode} is not eligible`).toBe(true);
    }
    log(
      `credentialed member: ${String(requiring.length)} shift type(s) with requirements, all eligible`,
    );
  });

  it('answers PER SHIFT TYPE — the unconstrained one is not the constrained one', async () => {
    const answer = await eligibility(
      reader().id,
      subject(),
      alpha().organizationId,
      alpha().groupOne.id,
    );
    const constrained = answer.shiftTypes.filter((r) => r.requiredQualificationIds.length > 0);
    const unconstrained = answer.shiftTypes.filter((r) => r.requiredQualificationIds.length === 0);

    // Both populations must be non-empty, or "per shift type" is untested.
    expect(constrained.length).toBeGreaterThan(0);
    expect(
      unconstrained.length,
      'every shift type carries a requirement — the per-shift-type claim is untested',
    ).toBeGreaterThan(0);

    for (const row of unconstrained) {
      expect(row.eligible, 'an unconstrained shift type reported ineligible').toBe(true);
      expect(row.missingQualificationIds).toEqual([]);
    }
    log(
      `${String(constrained.length)} constrained + ${String(unconstrained.length)} unconstrained ` +
        'shift type(s), answered separately',
    );
  });

  it('a member WITHOUT the credential is ineligible, and the missing one is named', async () => {
    // `member` holds no credential at all. Same route, same group, same reader.
    const answer = await eligibility(
      reader().id,
      alpha().users.member.membershipId,
      alpha().organizationId,
      alpha().groupOne.id,
    );
    expect(answer.statusCode, answer.body).toBe(200);

    const constrained = answer.shiftTypes.filter((r) => r.requiredQualificationIds.length > 0);
    expect(constrained.length).toBeGreaterThan(0);
    for (const row of constrained) {
      expect(row.eligible, `${row.shiftTypeCode} was eligible without the credential`).toBe(false);
      expect(row.missingQualificationIds).toContain(multi.catalogue().qualificationId);
    }
    log('uncredentialed member: ineligible for every constrained shift type, with the id named');
  });

  it('ZERO CROSS-TENANT LEAKAGE: Alpha\'s answer names none of Beta\'s shift types', async () => {
    // Ground truth as the superuser, outside RLS: Beta really does hold shift
    // types AND requirement rows, so "Alpha names none of them" is isolation
    // rather than an empty neighbour.
    const betaTruth = await admin.query<{ shift_types: number; requirements: number }>(
      `select (select count(*)::int from shift_types
                where organization_id = $1::uuid)             as shift_types,
              (select count(*)::int from shift_type_qualifications
                where organization_id = $1::uuid)             as requirements`,
      [beta().organizationId],
    );
    expect(betaTruth.rows[0]?.shift_types, 'Beta holds no shift types').toBeGreaterThan(0);
    expect(betaTruth.rows[0]?.requirements, 'Beta holds no requirement rows').toBeGreaterThan(0);

    const betaShiftTypeIds = new Set(
      (
        await admin.query<{ id: string }>(
          'select id::text as id from shift_types where organization_id = $1::uuid',
          [beta().organizationId],
        )
      ).rows.map((row) => row.id),
    );
    const betaQualificationIds = new Set(
      (
        await admin.query<{ id: string }>(
          'select id::text as id from qualifications where organization_id = $1::uuid',
          [beta().organizationId],
        )
      ).rows.map((row) => row.id),
    );

    const answer = await eligibility(
      reader().id,
      subject(),
      alpha().organizationId,
      alpha().groupOne.id,
    );
    expect(answer.statusCode).toBe(200);
    expect(answer.shiftTypes.length).toBeGreaterThan(0);

    for (const row of answer.shiftTypes) {
      expect(betaShiftTypeIds.has(row.shiftTypeId), `${row.shiftTypeCode} belongs to Beta`).toBe(
        false,
      );
      for (const qualificationId of [
        ...row.requiredQualificationIds,
        ...row.missingQualificationIds,
      ]) {
        expect(
          betaQualificationIds.has(qualificationId),
          'a Beta qualification id appeared in Alpha\'s answer',
        ).toBe(false);
      }
    }
    log(
      `Beta holds ${String(betaTruth.rows[0]?.shift_types ?? 0)} shift types and ` +
        `${String(betaTruth.rows[0]?.requirements ?? 0)} requirements; Alpha's answer names 0 of them`,
    );
  });

  it('ZERO CROSS-GROUP LEAKAGE: the Group One answer names none of the sibling group\'s shift types', async () => {
    const siblingIds = new Set(multi.catalogue().sibling.shiftTypeIds);
    expect(siblingIds.size, 'the sibling group holds no shift types').toBeGreaterThan(0);

    const answer = await eligibility(
      reader().id,
      subject(),
      alpha().organizationId,
      alpha().groupOne.id,
    );
    for (const row of answer.shiftTypes) {
      expect(
        siblingIds.has(row.shiftTypeId),
        `${row.shiftTypeCode} belongs to the sibling group`,
      ).toBe(false);
      expect(row.requiredQualificationIds).not.toContain(multi.catalogue().sibling.qualificationId);
    }
    log(
      `sibling group holds ${String(siblingIds.size)} shift types; the Group One answer names 0`,
    );
  });

  it('an EXPIRED credential does not confer eligibility', async () => {
    /* Two memberships, one qualification, one shift type requiring it. They
     * differ in exactly one thing: whose holding is still in force. Without the
     * in-force arm this assertion would pass against a read that ignored
     * holdings entirely, which is the vacuity shape the discipline names. */
    const inForce = await eligibility(
      reader().id,
      subject(),
      alpha().organizationId,
      alpha().groupOne.id,
    );
    const expired = await eligibility(
      reader().id,
      alpha().users.departed.membershipId,
      alpha().organizationId,
      alpha().groupOne.id,
    );
    expect(inForce.statusCode, inForce.body).toBe(200);
    expect(expired.statusCode, expired.body).toBe(200);

    const constrained = (rows: EligibilityRow[]): EligibilityRow[] =>
      rows.filter((row) => row.requiredQualificationIds.length > 0);

    expect(constrained(inForce.shiftTypes).length).toBeGreaterThan(0);
    expect(constrained(expired.shiftTypes).length).toBe(constrained(inForce.shiftTypes).length);

    for (const row of constrained(inForce.shiftTypes)) {
      expect(row.eligible, 'the IN-FORCE arm is not eligible — the comparison is meaningless')
        .toBe(true);
    }
    for (const row of constrained(expired.shiftTypes)) {
      expect(row.eligible, `${row.shiftTypeCode} stayed eligible on an expired credential`)
        .toBe(false);
      expect(row.missingQualificationIds).toContain(multi.catalogue().qualificationId);
    }

    // And the expired holding really does exist, so "ineligible" is not
    // "no holding was ever written".
    const stored = await admin.query<{ n: number }>(
      'select count(*)::int as n from qualification_holdings where id = $1::uuid',
      [expiredHoldingId],
    );
    expect(stored.rows[0]?.n, 'the expired holding was never written').toBe(1);

    log('an expired credential confers nothing; the in-force one, on the same shift type, does');
  });
});
