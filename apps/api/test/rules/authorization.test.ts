import { AUDIT_EVENT_NAMES, AUDIT_SUBJECT_TYPES } from '@schedulepoint/domain';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import { RULES_AUDIT_EVENTS, RULES_CAPABILITY_KEYS } from '../../src/rules/policies.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Allow AND deny for every capability this slice reaches, plus the audit
 * vocabulary and the escape-hatch refusals** (OPUS-M3-002).
 *
 * ## An ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a deny test whose subject does not exist denies for
 * the wrong reason and passes anyway. Every deny below is preceded by the same
 * request succeeding for an authorized actor against the same route and the same
 * body shape, so a 403 can only mean the capability gate.
 *
 * ## The layer each denial comes from is asserted, not assumed
 *
 * SPEC-06 P-5/P-6: a denial at L0–L2 is a `404` (the module's existence is not
 * disclosed) and a denial at L3–L6 is a `403` where the actor already knows the
 * tenant exists.
 */

const multi = ownedMulti('rules-authorization', { profile: 'full' });

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

function rulesPath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/rules`;
}

async function countersFor(userId: string): Promise<DeclaredCounters> {
  const alpha = multi().alpha;
  return currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    userId,
  });
}

/** POST to the rules route as `userId`, through the real HTTP surface. */
async function postRule(
  userId: string,
  body: unknown,
): Promise<{ statusCode: number; body: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: rulesPath(),
    headers: {
      ...contextHeaders(userId, await countersFor(userId)),
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
  return { statusCode: response.statusCode, body: response.body };
}

/**
 * A rule key nothing else in this run will collide with.
 *
 * The first version of the self-sufficient tests tolerated a `409` "in case the
 * key already existed", which quietly also tolerated the OTHER 409 the stack can
 * produce — `SESSION_STALE` from the context middleware — and then asserted
 * against a rule that had never been authored. A unique key per invocation means
 * `200` is the only acceptable answer, so the assertion cannot be satisfied by a
 * request that did nothing.
 */
let keyCounter = 0;
function uniqueKey(prefix: string): string {
  keyCounter += 1;
  return `${prefix}_${String(keyCounter)}`;
}

function validBody(ruleKey: string): Record<string, unknown> {
  return {
    ruleKey,
    name: 'Cover the day shift',
    classification: 'HARD',
    scope: {},
    predicate: { kind: 'RequiredCount', count: 1 },
  };
}

describe('the audit vocabulary is a contract, not strings in handlers', () => {
  it('every name this slice emits is in AUDIT_EVENT_NAMES', () => {
    for (const name of Object.values(RULES_AUDIT_EVENTS)) {
      expect(AUDIT_EVENT_NAMES).toContain(name);
      expect(name.startsWith('rules.'), `${name} is outside this packet's namespace`).toBe(true);
    }
  });

  it('the subject types this slice files under exist', () => {
    expect(AUDIT_SUBJECT_TYPES).toContain('rule');
    expect(AUDIT_SUBJECT_TYPES).toContain('rule_set');
  });
});

describe('allow and deny, per capability', () => {
  it(`ALLOW control — an authorized actor can author a rule (${RULES_CAPABILITY_KEYS.join(', ')})`, async () => {
    const response = await postRule(
      multi().alpha.users.scheduler.id,
      validBody('authz_allow_control'),
    );
    expect(response.statusCode, response.body).toBe(200);
  });

  it('DENY — a member (no catalogue/rules capability) gets 403 on the SAME route and body', async () => {
    const response = await postRule(multi().alpha.users.member.id, validBody('authz_deny_member'));
    expect(response.statusCode).toBe(403);
    // P-3: no reason on the wire.
    expect(response.body).not.toMatch(/capability|schedule\.catalogue|rule/i);
  });

  it('DENY — nothing was written by the denied request', async () => {
    // Establishes its own precondition rather than reading what a sibling test
    // left behind (FAD-15: a test that depends on execution order fails under
    // the shuffled seeds and passes in file order, which is the worst of both).
    const response = await postRule(multi().alpha.users.member.id, validBody('authz_deny_written'));
    expect(response.statusCode).toBe(403);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from rules where rule_key = 'authz_deny_written'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('the escape hatch is refused at every layer (SPEC-04 §3.1)', () => {
  it('a raw-JSON predicate is rejected — there is no custom-expression node', async () => {
    const response = await postRule(multi().alpha.users.scheduler.id, {
      ruleKey: 'escape_hatch',
      name: 'Raw predicate',
      classification: 'HARD',
      scope: {},
      predicate: { kind: 'RawJson', sql: 'true' },
    });
    expect(response.statusCode, 'a raw predicate was accepted').toBe(422);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from rules where rule_key = 'escape_hatch'`,
    );
    expect(rows[0]?.n, 'an unmappable rule reached the table').toBe('0');
  });

  it('an unknown extra key on the predicate is rejected, not carried', async () => {
    const response = await postRule(multi().alpha.users.scheduler.id, {
      ruleKey: 'strict_extra',
      name: 'Extra key',
      classification: 'HARD',
      scope: {},
      predicate: { kind: 'RequiredCount', count: 1, sql: 'DROP TABLE rules' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('DATABASE ARM — the closed-node CHECK refuses an unmappable predicate as the OWNER', async () => {
    // The application arms above could both be bypassed by a future writer that
    // skipped the service. This proves the storage layer refuses it too, which is
    // what makes "no escape hatch" a property of the data rather than of the code
    // path that happens to be in front of it.
    const alpha = multi().alpha;
    await expect(
      admin.query(
        `insert into rules
           (id, organization_id, group_id, rule_key, name, rule_schema_version,
            classification, weight, category, scope, predicate)
         values (gen_random_uuid(), $1::uuid, $2::uuid, 'db_escape', 'db', 1,
                 'HARD', null, 'general', '{}'::jsonb, '{"kind":"RawJson"}'::jsonb)`,
        [alpha.organizationId, alpha.groupOne.id],
      ),
    ).rejects.toThrow();
  });
});

describe('the hard/soft invariant is refused at the database (CAR-006, named proof 4)', () => {
  it('HARD with a weight is rejected', async () => {
    const alpha = multi().alpha;
    await expect(
      admin.query(
        `insert into rules
           (id, organization_id, group_id, rule_key, name, rule_schema_version,
            classification, weight, category, scope, predicate)
         values (gen_random_uuid(), $1::uuid, $2::uuid, 'hard_weighted', 'x', 1,
                 'HARD', 5, 'general', '{}'::jsonb, '{"kind":"RequiredCount","count":1}'::jsonb)`,
        [alpha.organizationId, alpha.groupOne.id],
      ),
    ).rejects.toThrow();
  });

  it('SOFT without a weight is rejected', async () => {
    const alpha = multi().alpha;
    await expect(
      admin.query(
        `insert into rules
           (id, organization_id, group_id, rule_key, name, rule_schema_version,
            classification, weight, category, scope, predicate)
         values (gen_random_uuid(), $1::uuid, $2::uuid, 'soft_unweighted', 'x', 1,
                 'SOFT', null, 'general', '{}'::jsonb, '{"kind":"RequiredCount","count":1}'::jsonb)`,
        [alpha.organizationId, alpha.groupOne.id],
      ),
    ).rejects.toThrow();
  });
});

/**
 * Runs one statement as the table OWNER but under a capability-holding context,
 * inside a transaction that is always rolled back.
 *
 * Needed because trigger firing order is by name: `rules_guard_administration`
 * sorts first and refuses an owner-direct write outright, so a probe aimed at a
 * CHECK constraint never reaches it. Supplying the production
 * `set_config(..., true)` context lets the guard pass and the constraint answer,
 * which is the control this file is actually probing.
 */
async function asOwnerWithCapability(
  run: (probe: pg.Client) => Promise<unknown>,
): Promise<unknown> {
  const alpha = multi().alpha;
  const probe = adminClient();
  await probe.connect();
  try {
    await probe.query('BEGIN');
    await probe.query(
      `select set_config('app.organization_id', $1, true),
              set_config('app.group_id', $2, true),
              set_config('app.membership_id', $3, true)`,
      [alpha.organizationId, alpha.groupOne.id, alpha.users.scheduler.membershipId],
    );
    return await run(probe);
  } finally {
    await probe.query('ROLLBACK').catch(() => undefined);
    await probe.end();
  }
}

describe('the staff-category invariant is bidirectional (N-2)', () => {
  it('RED: category=staff with NO memberships is refused', async () => {
    // Before the `coalesce`, `scope->'memberships'` was SQL NULL, the conjunction
    // was NULL, and `NULL = (category = 'staff')` is NULL — which a CHECK
    // ACCEPTS. A row could be `staff`-category while naming nobody.
    await expect(
      asOwnerWithCapability((probe) =>
        probe.query(
          `insert into rules
             (id, organization_id, group_id, rule_key, name, rule_schema_version,
              classification, weight, category, scope, predicate)
           values (gen_random_uuid(),
                   nullif(current_setting('app.organization_id', true), '')::uuid,
                   nullif(current_setting('app.group_id', true), '')::uuid,
                   'staff_no_members', 'x', 1,
                   'HARD', null, 'staff', '{}'::jsonb,
                   '{"kind":"RequiredCount","count":1}'::jsonb)`,
        ),
      ),
    ).rejects.toThrow(/rules_staff_category_matches_scope/);
  });

  it('RED: category=staff with an EMPTY memberships array is refused', async () => {
    await expect(
      asOwnerWithCapability((probe) =>
        probe.query(
          `insert into rules
             (id, organization_id, group_id, rule_key, name, rule_schema_version,
              classification, weight, category, scope, predicate)
           values (gen_random_uuid(),
                   nullif(current_setting('app.organization_id', true), '')::uuid,
                   nullif(current_setting('app.group_id', true), '')::uuid,
                   'staff_empty_members', 'x', 1,
                   'HARD', null, 'staff', '{"memberships":[]}'::jsonb,
                   '{"kind":"RequiredCount","count":1}'::jsonb)`,
        ),
      ),
    ).rejects.toThrow(/rules_staff_category_matches_scope/);
  });

  it('RED: memberships present but category=general is refused (the other direction)', async () => {
    await expect(
      asOwnerWithCapability((probe) =>
        probe.query(
          `insert into rules
             (id, organization_id, group_id, rule_key, name, rule_schema_version,
              classification, weight, category, scope, predicate)
           values (gen_random_uuid(),
                   nullif(current_setting('app.organization_id', true), '')::uuid,
                   nullif(current_setting('app.group_id', true), '')::uuid,
                   'members_not_staff', 'x', 1,
                   'HARD', null, 'general', '{"memberships":["m01"]}'::jsonb,
                   '{"kind":"RequiredCount","count":1}'::jsonb)`,
        ),
      ),
    ).rejects.toThrow(/rules_staff_category_matches_scope/);
  });

  it("RED: the reviewer's app_runtime UPDATE to category=staff without memberships is refused", async () => {
    // The runtime role's own path, not just the owner's: `category` IS in the
    // UPDATE grant, so this is the probe a real writer could attempt.
    const alpha = multi().alpha;
    const subjectKey = uniqueKey('staff_flip');
    const created = await postRule(alpha.users.scheduler.id, validBody(subjectKey));
    expect(created.statusCode, created.body).toBe(200);

    await expect(
      runtime.runner.run(
        {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          membershipId: alpha.users.scheduler.membershipId,
          correlationId: 'rules-staff-flip',
        },
        async ({ query }) =>
          sql`update rules set category = 'staff' where rule_key = ${subjectKey}`.execute(query),
      ),
    ).rejects.toThrow(/rules_staff_category_matches_scope/);
  });

  it('GREEN: a genuine staff rule — memberships present AND category=staff — is accepted', async () => {
    // The control. Without it the four refusals above could all be the constraint
    // refusing everything, which would prove nothing about its shape.
    const key = uniqueKey('staff_genuine');
    const result = (await asOwnerWithCapability((probe) =>
      probe.query(
        `insert into rules
           (id, organization_id, group_id, rule_key, name, rule_schema_version,
            classification, weight, category, scope, predicate)
         values (gen_random_uuid(),
                 nullif(current_setting('app.organization_id', true), '')::uuid,
                 nullif(current_setting('app.group_id', true), '')::uuid,
                 $1, 'x', 1,
                 'HARD', null, 'staff', '{"memberships":["m01"]}'::jsonb,
                 '{"kind":"AvoidDate","date":"2026-12-25"}'::jsonb)
         returning id`,
        [key],
      ),
    )) as { rows: unknown[] };
    expect(result.rows).toHaveLength(1);
  });
});

describe('the stable identifier cannot drift (non-bypass rule 13)', () => {
  it('a rule_key UPDATE is refused at BOTH layers', async () => {
    // The row is authored through the REAL route: an owner-direct insert is
    // itself refused by `app_guard_rule_administration` (0002's guard binds the
    // owner too), which is asserted separately. What this test needs is a row
    // that EXISTS — a trigger cannot fire on zero rows, and an UPDATE that
    // matches nothing resolves happily and proves nothing.
    const stableKey = uniqueKey('stable_key');
    const created = await postRule(multi().alpha.users.scheduler.id, validBody(stableKey));
    expect(created.statusCode, created.body).toBe(200);

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from rules where rule_key = $1`,
      [stableKey],
    );
    expect(rows[0]?.n, 'the subject row does not exist — the trigger cannot fire').toBe('1');

    const alpha = multi().alpha;

    /* ── LAYER 1: the GRANT ────────────────────────────────────────────────
     * `rule_key` is absent from the column-level UPDATE grant, so a runtime
     * role cannot even NAME it: 42501, before any trigger runs. This is the
     * layer that actually protects production, because production never runs
     * as the owner. */
    await expect(
      runtime.runner.run(
        {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          membershipId: alpha.users.scheduler.membershipId,
          correlationId: 'rules-stable-key-grant',
        },
        async ({ query }) =>
          sql`update rules set rule_key = 'renamed' where rule_key = ${stableKey}`.execute(query),
      ),
    ).rejects.toThrow(/permission denied/i);

    /* ── LAYER 2: the TRIGGER ──────────────────────────────────────────────
     * The grant stops the runtime roles; the trigger is what stops the OWNER,
     * which is the path a migration or a maintenance session would take. It
     * cannot be reached by a raw owner UPDATE, because trigger firing order is
     * by name and `rules_guard_administration` sorts first — so the probe
     * supplies a capability-holding context with the production
     * `set_config(..., true)` spelling, inside a transaction that is rolled
     * back. Without this arm, the key trigger could be missing entirely and
     * layer 1 would still pass.  */
    const probe = adminClient();
    await probe.connect();
    try {
      await probe.query('BEGIN');
      await probe.query(
        `select set_config('app.organization_id', $1, true),
                set_config('app.group_id', $2, true),
                set_config('app.membership_id', $3, true)`,
        [alpha.organizationId, alpha.groupOne.id, alpha.users.scheduler.membershipId],
      );
      await expect(
        probe.query(`update rules set rule_key = 'renamed' where rule_key = $1`, [stableKey]),
      ).rejects.toThrow(/RULE_KEY_IMMUTABLE/);
    } finally {
      await probe.query('ROLLBACK');
      await probe.end();
    }
  });

  it('an owner-direct INSERT is refused too — the guard is not role-conditional', async () => {
    const alpha = multi().alpha;
    await expect(
      admin.query(
        `insert into rules
           (id, organization_id, group_id, rule_key, name, rule_schema_version,
            classification, weight, category, scope, predicate)
         values (gen_random_uuid(), $1::uuid, $2::uuid, 'owner_insert', 'x', 1,
                 'HARD', null, 'general', '{}'::jsonb, '{"kind":"RequiredCount","count":1}'::jsonb)`,
        [alpha.organizationId, alpha.groupOne.id],
      ),
    ).rejects.toThrow(/schedule\.catalogue\.administer/);
  });

  it('a rule DELETE is refused even as the OWNER — archive, never delete', async () => {
    // Authors its own row: a BEFORE DELETE trigger cannot fire on zero rows, so
    // a DELETE matching nothing resolves happily and proves nothing. That is
    // exactly what this test did before the shuffled seeds separated it from the
    // sibling whose row it had been relying on (FAD-15).
    const doomedKey = uniqueKey('delete_subject');
    const created = await postRule(multi().alpha.users.scheduler.id, validBody(doomedKey));
    expect(created.statusCode, created.body).toBe(200);

    await expect(admin.query(`delete from rules where rule_key = $1`, [doomedKey])).rejects.toThrow(
      /RULE_DELETE_FORBIDDEN/,
    );
  });
});

describe('cross-group and cross-tenant access is denied', () => {
  it('a rule authored in Group One is invisible under a Group Two context', async () => {
    const alpha = multi().alpha;
    // Authors the subject itself — see the FAD-15 note above.
    const subjectKey = uniqueKey('isolation_subject');
    const created = await postRule(alpha.users.scheduler.id, validBody(subjectKey));
    expect(created.statusCode, created.body).toBe(200);
    const visible = await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: alpha.groupTwo.id,
        membershipId: alpha.users.scheduler.groupTwoMembershipId,
        correlationId: 'rules-cross-group',
      },
      async ({ query }) =>
        query
          .selectFrom('rules')
          .select('rule_key')
          .where('rule_key', '=', 'authz_allow_control')
          .execute(),
    );
    expect(visible, 'a Group One rule was visible from Group Two').toEqual([]);
  });

  it("Beta's context sees none of Alpha's rules", async () => {
    const beta = multi().beta;
    const subjectKey = uniqueKey('isolation_subject');
    const created = await postRule(multi().alpha.users.scheduler.id, validBody(subjectKey));
    expect(created.statusCode, created.body).toBe(200);
    const visible = await runtime.runner.run(
      {
        organizationId: beta.organizationId,
        groupId: beta.groupOne.id,
        membershipId: beta.users.scheduler.membershipId,
        correlationId: 'rules-cross-tenant',
      },
      async ({ query }) =>
        query
          .selectFrom('rules')
          .select('rule_key')
          .where('rule_key', '=', 'authz_allow_control')
          .execute(),
    );
    expect(visible).toEqual([]);
  });
});

describe('the audit chain', () => {
  it('records the authoring under rules.* and verifies clean afterwards', async () => {
    const alpha = multi().alpha;
    // Authors its own subject. Reading the row a sibling test happened to write
    // is an order dependence, and the rotating fixture seeds find it (FAD-15).
    const subjectKey = uniqueKey('audit_subject');
    const authored = await postRule(alpha.users.scheduler.id, validBody(subjectKey));
    expect(authored.statusCode, authored.body).toBe(200);
    const { rows } = await admin.query<{
      event_name: string;
      subject_type: string;
      subject_id: string;
      payload: Record<string, unknown> | null;
    }>(
      `select event_name, subject_type, subject_id, payload from audit_events
        where organization_id = $1::uuid and event_name like 'rules.%'
        order by sequence`,
      [alpha.organizationId],
    );
    expect(rows.length, 'no rules.* audit row was written').toBeGreaterThan(0);
    const created = rows.find((row) => row.event_name === RULES_AUDIT_EVENTS.ruleCreated);
    expect(created?.subject_type).toBe('rule');
    // `audit_events.subject_id` is a uuid column, so the subject is the row id
    // and the STABLE `rule_key` travels in the closed payload beside it. Both
    // are asserted: filing under the row alone would make "everything that
    // happened to this rule_key" unanswerable, which is what the key is for.
    expect(created?.subject_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const withKey = rows.find(
      (row) =>
        row.event_name === RULES_AUDIT_EVENTS.ruleCreated &&
        row.payload?.['ruleKey'] === subjectKey,
    );
    expect(withKey, 'no rules.rule.created row carries the authored rule_key').toBeDefined();

    const verification = await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: alpha.users.organizationAdmin.membershipId,
        correlationId: 'rules-chain',
      },
      async (uow) => verifyAuditChain(uow),
    );
    expect(verification.problems, JSON.stringify(verification.problems)).toEqual([]);
    log(`      · ${String(rows.length)} rules.* audit row(s); chain verified clean`);
  });
});
