import { randomUUID } from 'node:crypto';

import { auditPayloadViolations, isClosedAuditPayload } from '@schedulepoint/domain';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { decideRequest, reverseDecision } from '../../src/requests/decisions.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **I-07: a decision REASON never enters an audit payload, an outbox payload, or
 * a notification** — proven in both layers (OPUS-M5-002, doc 42 §5d Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The obligation, in the register's own words
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > The `override_reason`/denial-reason I-07 posture (binding, from §5b/§5c):
 * > reason text is scheduler-authored bounded free text on the DECISION record
 * > only — it never enters an audit payload, an outbox payload, or a
 * > notification (the audit payload validator enforces the closed shape; **prove
 * > it**).
 *
 * "Prove it" is two different claims and this file separates them, because a test
 * that proved only one would leave the other resting on a comment:
 *
 *  1. **The validator refuses a reason.** A realistic multi-word reason is fed to
 *     the domain validator, to the recorder, and to the SQL mirror
 *     `app_audit_payload_is_closed`, and all three refuse it. This is the control
 *     that holds for a writer nobody has written yet.
 *  2. **The payloads this packet emits carry no reason field.** A real decision is
 *     driven with a reason, and the audit and outbox rows it produced are read
 *     back and inspected. This is the control that holds for the writers that DO
 *     exist, and it is behavioural rather than a grep — a `reason` key spelled
 *     `note` or `why` would still be caught, because the assertion is over the
 *     VALUES as well as the keys.
 *
 * ## Why the mechanism is stronger than "we remembered not to"
 *
 * `auditPayloadViolations` requires every payload string to match `^[!-~]*$` —
 * printable ASCII with **no space** — and to be at most 64 characters.
 * `app_audit_payload_is_closed` (migration 0003) applies the same rules as a
 * CHECK. A reason is prose; prose contains spaces. So a payload carrying one is
 * refused before any statement issues, on every path, including one that bypassed
 * this module entirely.
 *
 * The two validators are already held to each other by
 * `test/audit/payload-closedness.test.ts` over a shared corpus. This file adds the
 * corpus entry that matters for SPEC-08: an actual decision reason.
 *
 * ## Synthetic only
 *
 * The reasons below are the fixture's own words about a synthetic roster. No
 * organization, site or person name from the research appears here, and nothing
 * clinical does either — a reason is an administrative note, never a diagnosis.
 */

const multi = ownedMulti('requests-reason-closure', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
let admin: pg.Client;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};

/**
 * Reasons a scheduler would actually type. Every one is multi-word, and that is
 * the property under test rather than an incidental one.
 */
const REALISTIC_REASONS = [
  'The department is short-staffed that week.',
  'Two colleagues already have that Friday off.',
  'Approved over quota because the rota would otherwise be unfilled.',
  'Denied: the request arrived after the published deadline.',
] as const;

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();
  const alpha = multi().alpha;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'reason-closure',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

describe('half one — the payload validator REFUSES a decision reason, in both layers', () => {
  it('the domain validator rejects every realistic reason, and names why', () => {
    for (const reason of REALISTIC_REASONS) {
      const violations = auditPayloadViolations({ requestId: randomUUID(), reason });
      expect(isClosedAuditPayload({ reason }), reason).toBe(false);
      /* The rule that does the work is the token rule, not the length rule — a
       * SHORT reason with a space is refused just as a long one is, which is what
       * makes this about free text rather than about size. */
      expect(
        violations.map((violation) => violation.code),
        reason,
      ).toContain('string_not_a_token');
    }
  });

  it('a SHORT reason is refused too — the rule is about prose, not length', () => {
    const short = 'too busy';
    expect(short.length).toBeLessThan(64);
    const violations = auditPayloadViolations({ reason: short });
    expect(violations.map((violation) => violation.code)).toEqual(['string_not_a_token']);
  });

  it('the SQL mirror refuses the same reasons', async () => {
    for (const reason of REALISTIC_REASONS) {
      const result = await admin.query<{ closed: boolean }>(
        'select app_audit_payload_is_closed($1::jsonb) as closed',
        [JSON.stringify({ requestId: randomUUID(), reason })],
      );
      expect(result.rows[0]?.closed, reason).toBe(false);
    }
  });

  it('and the two layers AGREE on every one of them, refusal for refusal', async () => {
    /* Two validators that disagreed would make the weaker one the real rule.
     * `test/audit/payload-closedness.test.ts` holds them to a shared corpus; this
     * asserts the agreement over the corpus SPEC-08 actually cares about. */
    for (const reason of REALISTIC_REASONS) {
      const payload = { requestId: randomUUID(), reason };
      const sqlAnswer = await admin.query<{ closed: boolean }>(
        'select app_audit_payload_is_closed($1::jsonb) as closed',
        [JSON.stringify(payload)],
      );
      expect(sqlAnswer.rows[0]?.closed, reason).toBe(isClosedAuditPayload(payload));
    }
  });

  it('the RECORDER refuses before any statement issues — the transaction is untouched', async () => {
    /* `assertClosedAuditPayload` runs before the INSERT is built, so a caller who
     * tried to file a reason gets an error and a transaction that can still
     * commit whatever else it holds. A validator that ran after the statement
     * would leave the caller with a poisoned transaction and the same rule. */
    const before = await countAuditEvents();
    await expect(
      runtime.runner.run(context, async (uow) =>
        recordAuditEvent(uow, {
          eventName: 'requests.request.denied',
          subjectType: 'request',
          subjectId: randomUUID(),
          payload: { reason: REALISTIC_REASONS[0] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'AUDIT_PAYLOAD_NOT_CLOSED' });
    expect(await countAuditEvents()).toBe(before);
  });

  it('the error message does NOT quote the text it rejected (non-bypass rule 9)', async () => {
    /* An error that echoed the free text would put that free text into a log,
     * which is the thing being prevented. Keys and rule codes only. */
    let message = '';
    try {
      await runtime.runner.run(context, async (uow) =>
        recordAuditEvent(uow, {
          eventName: 'requests.request.denied',
          subjectType: 'request',
          subjectId: randomUUID(),
          payload: { reason: 'The department is short-staffed that week.' },
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('AUDIT_PAYLOAD_NOT_CLOSED');
    expect(message).toContain('reason');
    expect(message, 'the rejected text must not appear in the message').not.toContain(
      'short-staffed',
    );
  });
});

describe('half two — the payloads THIS packet emits carry no reason at all', () => {
  it('a real denial stores its reason on the decision row and in NO payload', async () => {
    const requestId = await submittedRequest();
    const reason = 'The department is short-staffed that week.';

    const decided = await runtime.runner.run(context, async (uow) => {
      const root = await sql<{ version: number }>`
        select version from requests where id = ${requestId}::uuid
      `.execute(uow.query);
      return decideRequest(uow, {
        requestId,
        expectedVersion: root.rows[0]?.version ?? 1,
        decision: 'denied',
        reason,
        decidedBy: context.membershipId,
        now: new Date(),
      });
    });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);

    /* The reason IS stored — the test would be satisfied by a service that
     * silently dropped it, and that service would be wrong in the other
     * direction. §4 makes the reason mandatory; what it may not do is travel. */
    const stored = await admin.query<{ reason: string | null }>(
      'select reason from approvals where request_id = $1::uuid',
      [requestId],
    );
    expect(stored.rows[0]?.reason).toBe(reason);

    /* …and it is in NO audit payload for this subject. Asserted over the VALUES
     * as well as the keys, so a reason smuggled under a different key name is
     * caught too. */
    const audits = await admin.query<{ payload: Record<string, unknown> }>(
      'select payload from audit_events where subject_id = $1::uuid',
      [requestId],
    );
    expect(audits.rows.length, 'no audit row was written for the decision').toBeGreaterThan(0);
    for (const row of audits.rows) {
      expect(Object.keys(row.payload)).not.toContain('reason');
      for (const value of Object.values(row.payload)) {
        if (typeof value !== 'string') continue;
        expect(value, `a payload value carries prose: ${value}`).not.toContain(' ');
        expect(value).not.toContain('short-staffed');
      }
    }

    /* …and in no OUTBOX payload either, which is the one a notification is built
     * from. `publishOutboxEvent` runs the same validator, so this is the
     * behavioural confirmation of a structural fact. */
    const outbox = await admin.query<{ payload: Record<string, unknown> }>(
      `select o.payload from outbox_events o
        where o.payload ->> 'requestId' = $1`,
      [requestId],
    );
    expect(outbox.rows.length, 'no outbox row was written for the decision').toBeGreaterThan(0);
    for (const row of outbox.rows) {
      expect(Object.keys(row.payload)).not.toContain('reason');
      for (const value of Object.values(row.payload)) {
        if (typeof value === 'string') expect(value).not.toContain(' ');
      }
    }
  });

  it('the same holds for a REVERSAL, whose reason is equally mandatory', async () => {
    const requestId = await submittedRequest();
    const reversalReason = 'Reversed because the cover was found elsewhere.';

    await runtime.runner.run(context, async (uow) => {
      const root = await sql<{ version: number }>`
        select version from requests where id = ${requestId}::uuid
      `.execute(uow.query);
      const approved = await decideRequest(uow, {
        requestId,
        expectedVersion: root.rows[0]?.version ?? 1,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      });
      expect(approved.ok, JSON.stringify(approved)).toBe(true);
    });

    const reversed = await runtime.runner.run(context, async (uow) => {
      const root = await sql<{ version: number }>`
        select version from requests where id = ${requestId}::uuid
      `.execute(uow.query);
      return reverseDecision(uow, {
        requestId,
        expectedVersion: root.rows[0]?.version ?? 1,
        reason: reversalReason,
        reversedBy: context.membershipId,
        now: new Date(),
      });
    });
    expect(reversed.ok, JSON.stringify(reversed)).toBe(true);

    const stored = await admin.query<{ decision: string; reason: string | null }>(
      "select decision, reason from approvals where request_id = $1::uuid and decision = 'reversed'",
      [requestId],
    );
    expect(stored.rows[0]?.reason).toBe(reversalReason);

    const audits = await admin.query<{ payload: Record<string, unknown> }>(
      'select payload from audit_events where subject_id = $1::uuid',
      [requestId],
    );
    for (const row of audits.rows) {
      for (const value of Object.values(row.payload)) {
        if (typeof value === 'string') expect(value).not.toContain('cover was found');
      }
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function countAuditEvents(): Promise<number> {
  const result = await admin.query<{ n: string }>(
    'select count(*)::text as n from audit_events where organization_id = $1::uuid',
    [context.organizationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/**
 * A `submitted` time-off request owned by the acting scheduler.
 *
 * The scheduler is both requester and decider here, which is legitimate in a
 * small group and is not what this file is about — it keeps the fixture to one
 * membership so the assertions are about payloads rather than about tenancy.
 */
async function submittedRequest(): Promise<string> {
  return runtime.runner.run(context, async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${'time-off'},
              app_request_initial_status(${'time-off'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`closure.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into request_time_off (request_id, organization_id, group_id, target_date)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${'2047-07-05'}::date)
    `.execute(query);
    await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
    return id;
  });
}
