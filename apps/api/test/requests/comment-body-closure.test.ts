import { randomUUID } from 'node:crypto';

import {
  REQUEST_REASON_CODES,
  auditPayloadViolations,
  isClosedAuditPayload,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { appendSchedulerComment, attachReasonCode } from '../../src/requests/comments.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **I-07 / FAD-58.5: a comment BODY never enters an audit payload, an outbox
 * row, or a log — and neither does the reason CODE, for a different reason**
 * (OPUS-M5-00C, doc 42 §5g).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The obligation, in the register's own words
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > the audit/outbox payload closure (reason-closure pattern) is proven for
 * > comment bodies (a comment body NEVER enters an audit payload, an outbox row,
 * > or a log — rule 9); every store port takes the unit of work.
 *
 * This file is `decision-reason-closure.test.ts` applied one table over, with
 * ONE structural difference that is the whole reason it is a separate file
 * rather than four added cases:
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The two absences are NOT the same strength, and only one is mechanical
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  * **The scheduler's BODY could not be in a payload anyway.**
 *    `auditPayloadViolations` requires every payload string to match `^[!-~]*$`
 *    — printable ASCII with **no space** — and to be at most 64 characters.
 *    `app_audit_payload_is_closed` (migration 0003) applies the same rules as a
 *    CHECK. A comment is prose; prose contains spaces. So it is refused before
 *    any statement issues, on every path, including one that bypassed the
 *    service entirely. That is the M5-002 argument, unchanged.
 *
 *  * **The requester's CODE *could* be in a payload, and is left out by
 *    RULING.** `childcare` is a token: no space, nine characters. **The
 *    validator ADMITS it**, and this file proves that it does — which is what
 *    makes the absence a decision with a reason rather than a control somebody
 *    inherited and described as a choice.
 *
 *    The reason, ruled at this packet's visibility round under
 *    narrower-never-wider: the audit chain is IMMUTABLE and has its own reader
 *    population behind `audit.export`, which is not the population migration
 *    0026's three policy arms admit. A code in a payload would put a fact about
 *    the requester's own circumstances somewhere the comment table's RLS does
 *    not reach, and no later narrowing could take it back out. **The chain
 *    records THAT a code was attached, by whom, and when — never WHICH.**
 *
 * A test that proved only the mechanical half would leave the ruled half resting
 * on a comment, and the ruled half is the one a future packet could undo by
 * adding one key to one object.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## And NO OUTBOX ROW AT ALL — FAD-58.5
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Comment events may enqueue nothing in this packet." `apps/api/src/requests/
 * comments.ts` imports no publisher, so the absence is structural — but a
 * structural absence is worth confirming behaviourally, because "the import is
 * not there" and "no row appeared" are different claims and only the second is
 * about the database. The assertion below is over the outbox rows for the
 * request, before and after: the count does not move.
 *
 * ## Synthetic only
 *
 * The bodies below are the fixture's own words about a synthetic roster. No
 * organization, site or person name from the research appears here, and nothing
 * clinical does either — a scheduler comment is an administrative note, never a
 * diagnosis, and the requester never types at all.
 */

const multi = ownedMulti('requests-comment-closure', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
let admin: pg.Client;
/** The DECIDER context — a `scheduler`, so `requests.administer` is theirs by role. */
let scheduler: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
/** The REQUESTER context — a `member`. */
let member: typeof scheduler;

/**
 * Comments a scheduler would actually type. Every one is multi-word, and that is
 * the property under test rather than an incidental one.
 */
const REALISTIC_COMMENTS = [
  'The department is short-staffed that week.',
  'Two colleagues already have that Friday off.',
  'Noted — the rota already has cover for this.',
  'Discussed at the rota meeting; nothing to change.',
] as const;

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();
  const alpha = multi().alpha;
  scheduler = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'comment-closure-scheduler',
  };
  member = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: 'comment-closure-member',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

describe('half one — the payload validator REFUSES a comment body, in both layers', () => {
  it('the domain validator rejects every realistic comment, and names why', () => {
    for (const body of REALISTIC_COMMENTS) {
      const violations = auditPayloadViolations({ requestId: randomUUID(), body });
      expect(isClosedAuditPayload({ body }), body).toBe(false);
      /* The rule that does the work is the TOKEN rule, not the length rule — a
       * SHORT comment with a space is refused just as a long one is, which is
       * what makes this about free text rather than about size. */
      expect(violations.map((violation) => violation.code), body).toContain('string_not_a_token');
    }
  });

  it('a SHORT comment is refused too — the rule is about prose, not length', () => {
    const short = 'no cover';
    expect(short.length).toBeLessThan(64);
    expect(auditPayloadViolations({ body: short }).map((v) => v.code)).toEqual([
      'string_not_a_token',
    ]);
  });

  it('the SQL mirror refuses the same comments', async () => {
    for (const body of REALISTIC_COMMENTS) {
      const result = await admin.query<{ closed: boolean }>(
        'select app_audit_payload_is_closed($1::jsonb) as closed',
        [JSON.stringify({ requestId: randomUUID(), body })],
      );
      expect(result.rows[0]?.closed, body).toBe(false);
    }
  });

  it('and the two layers AGREE on every one of them, refusal for refusal', async () => {
    /* Two validators that disagreed would make the weaker one the real rule.
     * `test/audit/payload-closedness.test.ts` holds them to a shared corpus; this
     * asserts the agreement over the corpus FAD-58 actually cares about. */
    for (const body of REALISTIC_COMMENTS) {
      const payload = { requestId: randomUUID(), body };
      const sqlAnswer = await admin.query<{ closed: boolean }>(
        'select app_audit_payload_is_closed($1::jsonb) as closed',
        [JSON.stringify(payload)],
      );
      expect(sqlAnswer.rows[0]?.closed, body).toBe(isClosedAuditPayload(payload));
    }
  });

  it('the RECORDER refuses before any statement issues — the transaction is untouched', async () => {
    const before = await countAuditEvents();
    await expect(
      runtime.runner.run(scheduler, async (uow) =>
        recordAuditEvent(uow, {
          eventName: 'requests.request.comment_appended',
          subjectType: 'request',
          subjectId: randomUUID(),
          payload: { body: REALISTIC_COMMENTS[0] },
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
      await runtime.runner.run(scheduler, async (uow) =>
        recordAuditEvent(uow, {
          eventName: 'requests.request.comment_appended',
          subjectType: 'request',
          subjectId: randomUUID(),
          payload: { body: 'The department is short-staffed that week.' },
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('AUDIT_PAYLOAD_NOT_CLOSED');
    expect(message).toContain('body');
    expect(message, 'the rejected text must not appear in the message').not.toContain(
      'short-staffed',
    );
  });
});

describe('half two — the reason CODE is ADMISSIBLE, and deliberately absent anyway', () => {
  /* ── The non-vacuous half, and the reason this file exists separately ────────
   *
   * Everything in half one would be equally true of a packet that emitted the
   * code and never thought about it, because the code passes every control in
   * half one. These three cases separate "the validator stopped us" from "we
   * decided not to". */

  it('every one of the nine codes PASSES the payload validator, in both layers', async () => {
    for (const code of REQUEST_REASON_CODES) {
      expect(
        isClosedAuditPayload({ requestId: randomUUID(), reasonCode: code }),
        `${code} is a token; the validator has no objection to it`,
      ).toBe(true);
      const sqlAnswer = await admin.query<{ closed: boolean }>(
        'select app_audit_payload_is_closed($1::jsonb) as closed',
        [JSON.stringify({ requestId: randomUUID(), reasonCode: code })],
      );
      expect(sqlAnswer.rows[0]?.closed, code).toBe(true);
    }
  });

  it('a REAL code attachment stores the code and puts it in NO payload', async () => {
    const requestId = await memberRequest();

    const attached = await runtime.runner.run(member, async (uow) =>
      attachReasonCode(uow, { requestId, membershipId: member.membershipId, reasonCode: 'childcare' }),
    );
    expect(attached.ok, JSON.stringify(attached)).toBe(true);

    /* The code IS stored — this test would be satisfied by a service that
     * silently dropped it, and that service would be wrong in the other
     * direction. FAD-58.1 makes the code the requester's whole channel; what it
     * may not do is travel. */
    const stored = await admin.query<{ reason_code: string | null; channel: string }>(
      'select reason_code, channel from request_comments where request_id = $1::uuid',
      [requestId],
    );
    expect(stored.rows[0]?.reason_code).toBe('childcare');
    expect(stored.rows[0]?.channel).toBe('requester');

    /* …and it is in NO audit payload for this subject. Asserted over the VALUES
     * as well as the keys, so a code smuggled under a different key name is
     * caught too — and the audit row EXISTS, so this is not passing because
     * nothing was recorded. */
    const audits = await admin.query<{ event_name: string; payload: Record<string, unknown> }>(
      'select event_name, payload from audit_events where subject_id = $1::uuid',
      [requestId],
    );
    expect(
      audits.rows.map((row) => row.event_name),
      'the attachment must have been audited',
    ).toContain('requests.request.reason_code_attached');
    for (const row of audits.rows) {
      expect(Object.keys(row.payload)).not.toContain('reasonCode');
      for (const value of Object.values(row.payload)) {
        if (typeof value !== 'string') continue;
        expect(value, 'a payload value carries the code').not.toBe('childcare');
      }
    }

    /* The payload carries the three tokens it is supposed to, so the assertion
     * above is about the code's absence rather than about an empty payload. */
    const attachment = audits.rows.find(
      (row) => row.event_name === 'requests.request.reason_code_attached',
    );
    expect(Object.keys(attachment?.payload ?? {}).sort()).toEqual([
      'channel',
      'commentId',
      'requestId',
    ]);
    expect(attachment?.payload['channel']).toBe('requester');
  });

  it('a REAL scheduler comment stores its body and puts it in no payload either', async () => {
    const requestId = await memberRequest();
    const body = 'The department is short-staffed that week.';

    const appended = await runtime.runner.run(scheduler, async (uow) =>
      appendSchedulerComment(uow, {
        requestId,
        membershipId: scheduler.membershipId,
        body,
      }),
    );
    expect(appended.ok, JSON.stringify(appended)).toBe(true);

    const stored = await admin.query<{ body: string | null }>(
      "select body from request_comments where request_id = $1::uuid and channel = 'scheduler'",
      [requestId],
    );
    expect(stored.rows[0]?.body).toBe(body);

    const audits = await admin.query<{ event_name: string; payload: Record<string, unknown> }>(
      'select event_name, payload from audit_events where subject_id = $1::uuid',
      [requestId],
    );
    expect(audits.rows.map((row) => row.event_name)).toContain(
      'requests.request.comment_appended',
    );
    for (const row of audits.rows) {
      expect(Object.keys(row.payload)).not.toContain('body');
      for (const value of Object.values(row.payload)) {
        if (typeof value === 'string') expect(value).not.toContain(' ');
        if (typeof value === 'string') expect(value).not.toContain('short-staffed');
      }
    }
  });
});

describe('half three — FAD-58.5: a comment enqueues NOTHING', () => {
  it('neither channel writes an outbox row, measured before and after', async () => {
    /* The service imports no publisher, so this is structurally impossible — and
     * "the import is not there" and "no row appeared" are different claims. Only
     * the second is about the database, and only the second would notice a
     * publisher reached through some other module.
     *
     * Counted over the WHOLE organization rather than by request id, because an
     * outbox payload keyed on something other than `requestId` would slip a
     * request-scoped query. Nothing else runs in this transaction, so the count
     * is stable across the two reads. */
    const requestId = await memberRequest();
    const before = await countOutboxEvents();

    const attached = await runtime.runner.run(member, async (uow) =>
      attachReasonCode(uow, { requestId, membershipId: member.membershipId, reasonCode: 'travel' }),
    );
    expect(attached.ok).toBe(true);

    const appended = await runtime.runner.run(scheduler, async (uow) =>
      appendSchedulerComment(uow, {
        requestId,
        membershipId: scheduler.membershipId,
        body: 'Two colleagues already have that Friday off.',
      }),
    );
    expect(appended.ok).toBe(true);

    expect(
      await countOutboxEvents(),
      'FAD-58.5: comment events may enqueue nothing in this packet',
    ).toBe(before);

    /* …and the AUDIT rows DID appear, so the outbox assertion is about the
     * outbox rather than about nothing having happened. This is the pair that
     * distinguishes "we enqueued nothing" from "we did nothing". */
    const audits = await admin.query<{ n: string }>(
      'select count(*)::text as n from audit_events where subject_id = $1::uuid',
      [requestId],
    );
    expect(Number(audits.rows[0]?.n ?? '0')).toBe(2);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture helpers
 * ──────────────────────────────────────────────────────────────────────────── */

async function countAuditEvents(): Promise<number> {
  const result = await admin.query<{ n: string }>(
    'select count(*)::text as n from audit_events where organization_id = $1::uuid',
    [scheduler.organizationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function countOutboxEvents(): Promise<number> {
  const result = await admin.query<{ n: string }>(
    'select count(*)::text as n from outbox_events where organization_id = $1::uuid',
    [scheduler.organizationId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

/**
 * A `submitted` time-off request owned by the MEMBER.
 *
 * The member is the requester throughout this file and the scheduler is the
 * decider, which is the shape FAD-58's two channels describe — unlike
 * `decision-reason-closure.test.ts`, which keeps both roles on one membership
 * because its assertions are about payloads rather than about channels. Here the
 * channels ARE the subject, and the own-arm and administration arm of migration
 * 0026 admit different people.
 */
async function memberRequest(): Promise<string> {
  return runtime.runner.run(member, async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${member.membershipId}::uuid, ${'time-off'},
              app_request_initial_status(${'time-off'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`ccl.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into request_time_off (request_id, organization_id, group_id, target_date)
      values (${id}::uuid, ${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${'2047-07-05'}::date)
    `.execute(query);
    await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
    return id;
  });
}
