import type pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AUDIT_PAYLOAD_KEY_PATTERN,
  AUDIT_PAYLOAD_MAX_KEYS,
  AUDIT_PAYLOAD_MAX_VALUE_LENGTH,
  auditPayloadSchema,
} from '@schedulepoint/contracts';
import { SYSTEM_ROLE_CAPABILITIES } from '@schedulepoint/domain';

import { adminClient } from '../support/admin-client.js';
import { REPO_ROOT } from '../support/env.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * The audit READ surface, and the group-scope verification fix (OPUS-M3-008).
 *
 * Two deliverables meet here because they are two halves of one confusion:
 * `audit_events.sequence` is gapless per ORGANIZATION and `audit_events` is
 * readable per GROUP, so a group-scoped VERIFICATION reports gaps that are not
 * there (the M3-003 review's N-8) while a group-scoped READ legitimately sees
 * those same gaps. The fix is to make one refuse and the other say what it is.
 *
 * ## Every deny is preceded by the same request ALLOWED
 *
 * FAD-15 vacuity discipline. A 403 on a route nobody can reach proves nothing,
 * so each denial below differs from a success in exactly one fact — the grant.
 */

const multi = ownedMulti('audit-read-surface', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  /* The DECLARED precondition: `audit.read` is grant-only and no role holds it,
   * so a read test needs the grant to exist before it runs — in any order. */
  const alpha = multi().alpha;
  const granted = await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    capabilities: ['audit.read'],
  });
  if (granted.grantIds.length !== 1) {
    throw new Error('the audit-read grant precondition did not write exactly one row');
  }
}, 180_000);

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

function auditPath(groupId?: string): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${groupId ?? alpha.groupOne.id}/audit-events`;
}

async function countersFor(userId: string, groupId?: string): Promise<DeclaredCounters> {
  const alpha = multi().alpha;
  return currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: groupId ?? alpha.groupOne.id,
    userId,
  });
}

async function call(
  url: string,
  userId: string,
  groupId?: string,
): Promise<{ statusCode: number; body: Record<string, unknown> | undefined }> {
  const response = await harness.app.inject({
    method: 'GET',
    url,
    headers: contextHeaders(userId, await countersFor(userId, groupId)),
  });
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  return { statusCode: response.statusCode, body: parsed };
}

interface AuditEventWire {
  readonly id: string;
  readonly sequence: string;
  readonly eventName: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly entryHash: string;
  readonly prevHash: string;
  readonly payload: Record<string, unknown>;
  readonly groupId: string | null;
}

function eventsOf(body: Record<string, unknown> | undefined): readonly AuditEventWire[] {
  return (body?.['events'] ?? []) as readonly AuditEventWire[];
}

describe('the audit read surface is capability-gated, and the key is held by no role', () => {
  it('the key is held by NO system role — it is granted, never inherited', () => {
    for (const [role, keys] of Object.entries(SYSTEM_ROLE_CAPABILITIES)) {
      expect(keys, `${role} holds audit.read by role`).not.toContain('audit.read');
    }
  });

  it('a principal WITHOUT the grant is denied, and one WITH it is allowed — one fact apart', async () => {
    const alpha = multi().alpha;

    /* `member` holds a group membership and no audit grant; `scheduler` holds
     * the grant written in `beforeAll`. They differ in exactly that, and the
     * ALLOW is asserted in the same test so a 403 cannot be a route that answers
     * nothing to anybody. */
    const denied = await call(auditPath(), alpha.users.member.id);
    expect(denied.statusCode).toBe(403);
    // No reason on the wire (P-3): the body is the fixed envelope.
    expect(JSON.stringify(denied.body)).not.toContain('audit.read');

    const allowed = await call(auditPath(), alpha.users.scheduler.id);
    expect(allowed.statusCode).toBe(200);
    expect(eventsOf(allowed.body).length).toBeGreaterThan(0);
    expect(allowed.body?.['sequenceIsOrganizationWide']).toBe(true);
  });

  it('the surface reads the CHAIN: hashes and payloads are what the rows hold', async () => {
    const alpha = multi().alpha;
    const response = await call(`${auditPath()}?limit=5`, alpha.users.scheduler.id);
    expect(response.statusCode).toBe(200);
    const events = eventsOf(response.body);
    expect(events.length).toBeGreaterThan(0);

    const first = events[0];
    if (first === undefined) throw new Error('no events');

    // The row the surface returned, read independently as the owner.
    const row = await admin.query<{ entry_hash: string; prev_hash: string; event_name: string }>(
      `select encode(entry_hash, 'hex') as entry_hash,
              encode(prev_hash, 'hex')  as prev_hash,
              event_name
         from audit_events where id = $1`,
      [first.id],
    );
    expect(row.rows[0]?.entry_hash).toBe(first.entryHash);
    expect(row.rows[0]?.prev_hash).toBe(first.prevHash);
    expect(row.rows[0]?.event_name).toBe(first.eventName);
  });

  it('is GROUP-scoped: a sibling group\'s events are invisible', async () => {
    const alpha = multi().alpha;
    const catalogue = multi().catalogue?.alpha;
    if (catalogue === undefined) throw new Error('needs the catalogue seed');

    const mine = await call(auditPath(), alpha.users.scheduler.id);
    expect(mine.statusCode).toBe(200);
    const groupIds = new Set(eventsOf(mine.body).map((event) => event.groupId));
    // Organization-scoped events carry a null group and are legitimately visible;
    // no OTHER group's id may appear.
    groupIds.delete(null);
    groupIds.delete(alpha.groupOne.id);
    expect([...groupIds], 'a sibling group id appeared in a group-scoped audit read').toEqual([]);

    // Non-vacuity: the sibling group DOES hold audit rows, so the emptiness above
    // is the predicate rather than an empty table.
    const siblingRows = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events where group_id = $1`,
      [catalogue.sibling.groupId],
    );
    expect(Number(siblingRows.rows[0]?.n ?? '0')).toBeGreaterThan(0);
  });

  it('narrows by subject, and a malformed query is 422 AFTER the verdict', async () => {
    const alpha = multi().alpha;
    const schedule = multi().schedule;
    if (schedule === undefined) throw new Error('needs the schedule seed');

    const filtered = await call(
      `${auditPath()}?subjectType=schedule_version&subjectId=${schedule.groupOne.currentVersionId}`,
      alpha.users.scheduler.id,
    );
    expect(filtered.statusCode).toBe(200);
    const events = eventsOf(filtered.body);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((event) => event.subjectType))).toEqual(
      new Set(['schedule_version']),
    );

    const invalid = await call(`${auditPath()}?limit=nonsense`, alpha.users.scheduler.id);
    expect(invalid.statusCode).toBe(422);

    /* The SBX-001 disclosure property: an UNAUTHORIZED caller sending the same
     * malformed query gets the denial, not the validation error — otherwise the
     * 422 would tell them the route exists. `member` holds no audit grant. */
    const unauthorized = await call(`${auditPath()}?limit=nonsense`, alpha.users.member.id);
    expect(unauthorized.statusCode).toBe(403);
  });

  it('reports truncation rather than presenting a partial history as complete', async () => {
    const alpha = multi().alpha;
    const page = await call(`${auditPath()}?limit=1`, alpha.users.scheduler.id);
    expect(page.statusCode).toBe(200);
    expect(eventsOf(page.body)).toHaveLength(1);
    expect(page.body?.['truncated']).toBe(true);

    const everything = await call(`${auditPath()}?limit=200`, alpha.users.scheduler.id);
    expect(everything.body?.['truncated']).toBe(false);
  });
});

describe('the wire payload schema mirrors the DATABASE constraint (N-5)', () => {
  /**
   * The period-length argument, applied to the audit payload.
   *
   * `app_audit_payload_is_closed` is what makes an audit payload publishable —
   * I-07's enforcement, in the database. The contract now re-states its three
   * bounds, and these assertions are what keep the two from drifting: they read
   * the CHECK's own text out of migration 0003 and compare the numbers.
   */
  it('the contract constants are the numbers migration 0003 actually enforces', () => {
    const migration = readFileSync(
      resolve(REPO_ROOT, 'apps/api/migrations/0003_audit_outbox.sql'),
      'utf8',
    );
    const body = migration.slice(
      migration.indexOf('app_audit_payload_is_closed'),
      migration.indexOf('app_audit_payload_is_closed') + 1500,
    );
    expect(body).toContain(`<= ${String(AUDIT_PAYLOAD_MAX_KEYS)}`);
    expect(body).toContain(`> ${String(AUDIT_PAYLOAD_MAX_VALUE_LENGTH)}`);
    expect(body).toContain(AUDIT_PAYLOAD_KEY_PATTERN.source.replace(/\\/g, ''));
  });

  it('accepts what the database accepts and refuses what it refuses', () => {
    // A real payload shape, from the publication transaction.
    expect(
      auditPayloadSchema.safeParse({ period: 'p', number: 2, affected: 2, changes: 2 }).success,
    ).toBe(true);

    // 16 keys is the ceiling; 17 is refused, exactly as the CHECK refuses it.
    const keyed = (n: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${String(i)}`, i]));
    expect(auditPayloadSchema.safeParse(keyed(AUDIT_PAYLOAD_MAX_KEYS)).success).toBe(true);
    expect(auditPayloadSchema.safeParse(keyed(AUDIT_PAYLOAD_MAX_KEYS + 1)).success).toBe(false);

    // 64 characters is the ceiling; 65 is refused.
    expect(auditPayloadSchema.safeParse({ a: 'x'.repeat(64) }).success).toBe(true);
    expect(auditPayloadSchema.safeParse({ a: 'x'.repeat(65) }).success).toBe(false);

    // Keys are `^[a-z][a-zA-Z0-9]{0,39}$`: no underscore, no leading capital.
    expect(auditPayloadSchema.safeParse({ Bad: 1 }).success).toBe(false);
    expect(auditPayloadSchema.safeParse({ bad_key: 1 }).success).toBe(false);

    // Printable ASCII only — the half that carries I-07. A newline, a tab or any
    // non-ASCII character is what free text looks like when it arrives.
    expect(auditPayloadSchema.safeParse({ a: 'line\nbreak' }).success).toBe(false);
    expect(auditPayloadSchema.safeParse({ a: 'e\u0301' }).success).toBe(false);
  });

  it('every payload the REAL surface returns parses under it', async () => {
    // The layers agreeing in theory is not the claim; the claim is that the rows
    // this group actually holds pass both.
    const alpha = multi().alpha;
    const response = await call(`${auditPath()}?limit=200`, alpha.users.scheduler.id);
    expect(response.statusCode).toBe(200);
    const events = eventsOf(response.body);
    expect(events.length).toBeGreaterThan(10);
    for (const event of events) {
      expect(auditPayloadSchema.safeParse(event.payload).success, event.eventName).toBe(true);
    }
  });
});

describe('N-8 — chain verification refuses a GROUP-scoped invocation at the function', () => {
  it('a group-scoped call raises instead of reporting gaps that are not there', async () => {
    const alpha = multi().alpha;

    /* The control FIRST: organization-scoped verification of the same chain
     * answers cleanly. Without it, the raise below could be a broken function
     * rather than a scope guard. */
    const clean = await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: null,
        correlationId: 'audit-verify-org',
      },
      async (uow) =>
        sql<{
          problem: string;
        }>`select p.problem from app_verify_audit_chain(${alpha.organizationId}::uuid) p`.execute(
          uow.query,
        ),
    );
    expect(clean.rows, 'the organization-scoped chain must verify clean first').toEqual([]);

    // The same call under a GROUP-scoped context now refuses explicitly.
    await expect(
      runtime.runner.run(
        {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          membershipId: alpha.users.scheduler.membershipId,
          correlationId: 'audit-verify-group',
        },
        async (uow) =>
          sql`select * from app_verify_audit_chain(${alpha.organizationId}::uuid)`.execute(
            uow.query,
          ),
      ),
    ).rejects.toThrow(/organization-scoped context/);
  });

  it('the group-scoped read the function refuses WOULD have seen a gapped subset', async () => {
    /* This is the measurement that makes the guard load-bearing rather than
     * defensive: under a group context the rows the walk would have seen are a
     * strict, non-contiguous subset of the organization's chain. If it were
     * contiguous the false alarm would never have existed and the guard would be
     * decoration. */
    const alpha = multi().alpha;
    const sequences = await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        membershipId: alpha.users.scheduler.membershipId,
        correlationId: 'audit-subset',
      },
      async (uow) =>
        sql<{
          sequence: string;
        }>`select e.sequence::text as sequence from audit_events e order by e.sequence`.execute(
          uow.query,
        ),
    );
    const numbers = sequences.rows.map((row) => Number(row.sequence));
    expect(numbers.length).toBeGreaterThan(1);
    const contiguous = numbers.every(
      (value, index) => index === 0 || value === (numbers[index - 1] ?? 0) + 1,
    );
    expect(contiguous, 'the group subset is contiguous, so N-8 could not have occurred').toBe(
      false,
    );
  });
});
