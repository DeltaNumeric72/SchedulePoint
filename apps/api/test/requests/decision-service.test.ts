import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  decideRequest,
  decideRequestsBatch,
  reverseDecision,
} from '../../src/requests/decisions.js';
import { requestStore } from '../../src/requests/store.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **SPEC-08 §4 — the decision service, over the real database** (OPUS-M5-002,
 * doc 42 §5d Parts A and C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What this file proves that the domain tests cannot
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain/test/requests/transitions.test.ts` proves the MATRIX — which
 * (subtype × status × operation) cells are legal, and that every permitted
 * operation walks a path §2 carries. It cannot prove that the writer actually
 * walks that path, that the conditional update is conditional, or that a decision
 * row is unoverwritable, because none of those is a property of a pure function.
 *
 * This file drives the shipped service inside real units of work and reads the
 * result back with the superuser, so every claim below is about rows.
 *
 * ## The two-step, made observable
 *
 * M5-000b finding #1 is binding: §2 has no `submitted → approved` cell, so an
 * approval from `submitted` must walk `submitted → under_review → approved`
 * inside ONE transaction. That is not directly observable — the intermediate is
 * never committed — so it is observed by its TRACE: the row's `version` rises by
 * **two**, one per edge, and by one when the row was already `under_review`. A
 * single-statement spelling would leave a version that rose by one from
 * `submitted`, and 0021's transition guard would have refused it anyway.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own.
 */

const multi = ownedMulti('requests-decision-service', {
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
 * A SECOND group in the SAME organization, and a scheduler inside it (C-1).
 *
 * Same organization deliberately: a different tenant would be proven invisible
 * by X-11 and by every RLS arm in the suite, and would tell us nothing about the
 * GROUP predicate. The interesting boundary is the one inside a tenant, where
 * both rows are equally visible to the organization and only
 * `requests_group_read_any`'s `group_id = current_setting('app.group_id')`
 * clause separates them.
 */
let siblingContext: typeof context;
let shiftTypeId: string;

const asScheduler = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  admin = adminClient();
  await admin.connect();
  const alpha = multi().alpha;
  const seededShiftType = multi.catalogue('alpha').shiftTypeIds[0];
  if (seededShiftType === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = seededShiftType;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'decision-service',
  };
  /* `groupTwoScheduler` holds the `scheduler` group role in Group Two, so it
   * carries the four decision keys by role exactly as the Group One scheduler
   * does (doc 08 §6). That symmetry is what makes the positive control below
   * mean something: the two actors differ ONLY in which group they are in. */
  siblingContext = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupTwo.id,
    membershipId: alpha.users.groupTwoScheduler.membershipId,
    correlationId: 'decision-service-sibling',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A request at `submitted`, written under the acting context and walked one edge.
 *
 * `subtype` is a parameter because two of the refusals below are ABOUT the
 * subtype: a shift preference is never approved (§2.1, R-03) and a vacation
 * selection is decided by §5.4's writer (§5.3's one writer).
 */
async function requestAtSubmitted(
  subtype: 'time-off' | 'availability' | 'shift-preference',
  /**
   * Whose group the request lands in. Defaults to the acting scheduler's, so
   * every existing call site is unchanged; C-1's cross-group case is the only
   * caller that passes anything else.
   */
  where: typeof context = context,
): Promise<string> {
  return runtime.runner.run(where, async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${where.organizationId}::uuid, ${where.groupId}::uuid,
              ${where.membershipId}::uuid, ${subtype},
              app_request_initial_status(${subtype}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`decide.${randomUUID().slice(0, 12)}`})
    `.execute(query);

    if (subtype === 'shift-preference') {
      await sql`
        insert into request_shift_preference
          (request_id, organization_id, group_id, target_date, shift_type_id, preference_strength)
        values (${id}::uuid, ${where.organizationId}::uuid, ${where.groupId}::uuid,
                ${'2047-09-06'}::date, ${shiftTypeId}::uuid, ${'medium'})
      `.execute(query);
    } else if (subtype === 'availability') {
      await sql`
        insert into request_availability (request_id, organization_id, group_id, target_date)
        values (${id}::uuid, ${where.organizationId}::uuid, ${where.groupId}::uuid,
                ${'2047-09-07'}::date)
      `.execute(query);
    } else {
      await sql`
        insert into request_time_off (request_id, organization_id, group_id, target_date)
        values (${id}::uuid, ${where.organizationId}::uuid, ${where.groupId}::uuid,
                ${'2047-09-08'}::date)
      `.execute(query);
    }

    await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
    return id;
  });
}

async function rowState(
  requestId: string,
): Promise<{ status: string; version: number; decided_by: string | null }> {
  const result = await admin.query<{ status: string; version: number; decided_by: string | null }>(
    'select status, version, decided_by from requests where id = $1::uuid',
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fixture request is missing');
  return row;
}

async function versionOf(requestId: string): Promise<number> {
  return (await rowState(requestId)).version;
}

/* ────────────────────────────────────────────────────────────────────────────
 * §4 — approval and denial, through the binding two-step
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§4 — the decision, and M5-000b finding #1\'s two-step', () => {
  it('an approval from `submitted` walks TWO edges in one transaction', async () => {
    const requestId = await requestAtSubmitted('time-off');
    const before = await versionOf(requestId);

    const outcome = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId,
        expectedVersion: before,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);

    const after = await rowState(requestId);
    expect(after.status).toBe('approved');
    /* The trace of the two-step. `+1` would mean a single statement had been
     * accepted, which §2's matrix and 0021's guard both forbid. */
    expect(after.version, 'the two-step must leave a version that rose by two').toBe(before + 2);
    /* And the decider is stamped on the LAST edge only, so the row is never
     * "decided by somebody, status under_review". */
    expect(after.decided_by).toBe(context.membershipId);
  });

  it('a DENIAL walks the same two edges, and stores its mandatory reason', async () => {
    const requestId = await requestAtSubmitted('time-off');
    const before = await versionOf(requestId);
    const reason = 'The department is short-staffed that week.';

    const outcome = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId,
        expectedVersion: before,
        decision: 'denied',
        reason,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect((await rowState(requestId)).status).toBe('denied');
    expect(await versionOf(requestId)).toBe(before + 2);

    const stored = await admin.query<{ reason: string | null; decision: string }>(
      'select reason, decision from approvals where request_id = $1::uuid',
      [requestId],
    );
    expect(stored.rows[0]?.decision).toBe('denied');
    expect(stored.rows[0]?.reason).toBe(reason);
  });

  it('a request already at `under_review` takes the SECOND edge only', async () => {
    const requestId = await requestAtSubmitted('availability');
    await asScheduler(
      async ({ query }) =>
        await sql`update requests set status = 'under_review' where id = ${requestId}::uuid`.execute(
          query,
        ),
    );
    const before = await versionOf(requestId);

    const outcome = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId,
        expectedVersion: before,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await versionOf(requestId)).toBe(before + 1);
  });

  it('§4 FIRST DECISION WINS: the loser is refused, and told the MORE informative thing', async () => {
    /* §4: "conditional update on `expected_version`; **first decision wins**, the
     * second gets an explicit conflict — never a silent overwrite."
     *
     * The loser's refusal has TWO shapes, and asserting only one would leave the
     * other unexercised. Which one a caller gets depends on what changed:
     *
     *   the row LEFT a decidable status  →  `illegal-operation`
     *   the row is still decidable, the
     *   version moved                    →  `version-conflict`
     *
     * The first is checked FIRST, deliberately: **"somebody already decided this"
     * is strictly more informative than "your version is stale", and it is the
     * answer with a different remedy** — a version conflict says reload and retry,
     * an already-decided row says there is nothing to retry. Both are §4's
     * "explicit conflict"; neither is a silent overwrite. */
    const decided = await requestAtSubmitted('time-off');
    const staleOnDecided = await versionOf(decided);

    const first = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: decided,
        expectedVersion: staleOnDecided,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(first.ok).toBe(true);

    /* The second caller presents the version it read before the first decided —
     * two tabs, or two schedulers. The row is now `approved`, which is not a
     * status a decision acts from. */
    const second = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: decided,
        expectedVersion: staleOnDecided,
        decision: 'denied',
        reason: 'A second decision that must not land.',
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure).toBe('illegal-operation');

    /* The first decision stands, and the second wrote NOTHING — not a status,
     * not an approvals row. */
    expect((await rowState(decided)).status).toBe('approved');
    const rows = await admin.query<{ n: string }>(
      'select count(*)::text as n from approvals where request_id = $1::uuid',
      [decided],
    );
    expect(rows.rows[0]?.n).toBe('1');

    /* ── the OTHER branch: the conditional UPDATE itself ──────────────────────
     *
     * The row stays in a decidable status and only its VERSION moves, so the
     * domain verdict passes and the store's `WHERE version = ?` is the thing that
     * refuses. Without this case the conditional update would be untested — the
     * assertion above never reaches it. */
    const stillDecidable = await requestAtSubmitted('time-off');
    const staleVersion = await versionOf(stillDecidable);
    await asScheduler(
      async ({ query }) =>
        await sql`
          update requests set version = version + 1 where id = ${stillDecidable}::uuid
        `.execute(query),
    );
    expect(await versionOf(stillDecidable), 'the row must still be decidable').toBeGreaterThan(
      staleVersion,
    );
    expect((await rowState(stillDecidable)).status).toBe('submitted');

    const raced = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: stillDecidable,
        expectedVersion: staleVersion,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.failure).toBe('version-conflict');
    expect((await rowState(stillDecidable)).status, 'nothing may have moved').toBe('submitted');
  });

  it('an APPROVAL may not carry a reason, and a DENIAL may not omit one', async () => {
    /* Both directions, because migration 0024's CHECK says both and a service
     * that enforced only the mandatory half would let new free text onto a
     * SENSITIVE-PII aggregate that no specification asks for. */
    const withReason = await requestAtSubmitted('time-off');
    const withReasonVersion = await versionOf(withReason);
    const refusedApproval = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: withReason,
        expectedVersion: withReasonVersion,
        decision: 'approved',
        reason: 'An approval needs no explanation.',
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(refusedApproval.ok).toBe(false);
    if (!refusedApproval.ok) expect(refusedApproval.failure).toBe('reason-required');
    expect((await rowState(withReason)).status, 'nothing may have moved').toBe('submitted');

    const withoutReason = await requestAtSubmitted('time-off');
    const withoutReasonVersion = await versionOf(withoutReason);
    const refusedDenial = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: withoutReason,
        expectedVersion: withoutReasonVersion,
        decision: 'denied',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(refusedDenial.ok).toBe(false);
    if (!refusedDenial.ok) expect(refusedDenial.failure).toBe('reason-required');

    /* Whitespace is not a reason. The wire schema trims and the database CHECK
     * uses `btrim`; the service agrees with both. */
    const blank = await requestAtSubmitted('time-off');
    const blankVersion = await versionOf(blank);
    const refusedBlank = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: blank,
        expectedVersion: blankVersion,
        decision: 'denied',
        reason: '   ',
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(refusedBlank.ok).toBe(false);
  });

  it('R-03 at the OPERATION layer: a shift preference is never approved or denied', async () => {
    /* §2.1: a preference is non-binding, so nobody approves or denies it. The
     * database refuses the VALUE (D-20) and the matrix refuses the EDGE; this is
     * the third refusal, at the service, with a reason a caller can branch on. */
    const requestId = await requestAtSubmitted('shift-preference');
    const version = await versionOf(requestId);
    for (const decision of ['approved', 'denied'] as const) {
      const outcome = await asScheduler((uow) =>
        decideRequest(uow, {
          requestId,
          expectedVersion: version,
          decision,
          reason: decision === 'denied' ? 'A preference cannot be denied.' : null,
          decidedBy: context.membershipId,
          now: new Date(),
        }),
      );
      expect(outcome.ok, decision).toBe(false);
      if (!outcome.ok) expect(outcome.failure).toBe('subtype-not-decidable-here');
    }
    expect((await rowState(requestId)).status).toBe('submitted');
  });

  it('a request that is not visible here is `not-found`, never a different answer', async () => {
    const outcome = await asScheduler((uow) =>
      decideRequest(uow, {
        requestId: randomUUID(),
        expectedVersion: 1,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('not-found');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * §4's reversal — "a new approvals record; the prior decision is never
 * overwritten"
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§4 — reversal writes a NEW record and cannot touch the old one', () => {
  it('a reversal names its predecessor and leaves it byte-identical', async () => {
    const requestId = await requestAtSubmitted('time-off');
    const approved = await asScheduler(async (uow) =>
      decideRequest(uow, {
        requestId,
        expectedVersion: await versionOf(requestId),
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(approved.ok, JSON.stringify(approved)).toBe(true);

    const original = await admin.query<{ id: string; decided_at: Date; decision: string }>(
      'select id, decided_at, decision from approvals where request_id = $1::uuid',
      [requestId],
    );
    const first = original.rows[0];
    expect(first?.decision).toBe('approved');

    const reversal = await asScheduler(async (uow) =>
      reverseDecision(uow, {
        requestId,
        expectedVersion: await versionOf(requestId),
        reason: 'Reversed because the cover was found elsewhere.',
        reversedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(reversal.ok, JSON.stringify(reversal)).toBe(true);

    /* TWO rows now, and the first is untouched — same id, same instant, same
     * decision. §4's sentence, asserted rather than asserted-about. */
    const after = await admin.query<{ id: string; decided_at: Date; decision: string; supersedes_approval_id: string | null }>(
      'select id, decided_at, decision, supersedes_approval_id from approvals where request_id = $1::uuid order by decided_at',
      [requestId],
    );
    expect(after.rows).toHaveLength(2);
    expect(after.rows[0]?.id).toBe(first?.id);
    expect(after.rows[0]?.decision).toBe('approved');
    expect(after.rows[0]?.decided_at.getTime()).toBe(first?.decided_at.getTime());
    expect(after.rows[1]?.decision).toBe('reversed');
    expect(after.rows[1]?.supersedes_approval_id).toBe(first?.id);

    /* And the ROOT moved to the one status §2 carries out of `approved` for a
     * scheduler. */
    expect((await rowState(requestId)).status).toBe('superseded_by_revision');
  });

  it('"never overwritten" is a PRIVILEGE: no runtime role holds UPDATE or DELETE', async () => {
    /* The mechanism behind the assertion above. A rule enforced by code review is
     * a rule that holds until the review that misses it; this one is enforced by
     * the grant not existing, so there is no statement `app_runtime` could issue
     * that would overwrite a decision. */
    const grants = await admin.query<{ privilege_type: string; grantee: string }>(
      `select privilege_type, grantee
         from information_schema.role_table_grants
        where table_name = 'approvals'
          and grantee in ('app_runtime', 'app_worker')
        order by grantee, privilege_type`,
    );
    const held = grants.rows.map((row) => `${row.grantee}:${row.privilege_type}`).sort();
    expect(held).toEqual([
      'app_runtime:INSERT',
      'app_runtime:SELECT',
      'app_worker:INSERT',
      'app_worker:SELECT',
    ]);
  });

  it('a reversal is refused from every status except `approved`', async () => {
    const requestId = await requestAtSubmitted('time-off');
    const outcome = await asScheduler(async (uow) =>
      reverseDecision(uow, {
        requestId,
        expectedVersion: await versionOf(requestId),
        reason: 'There is nothing here to reverse.',
        reversedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('illegal-operation');
  });

  it('a DENIAL cannot be reversed — the recorded §2 gap, asserted rather than worked around', async () => {
    /* §4 says reversal is "a new `approvals` record", and §2 gives `denied` NO
     * outgoing edge for any subtype. So a denial-side reversal would need a cell
     * the matrix does not have, and §4's sentence does not name one — unlike
     * FAD-55, where §4 and R-10 named the missing transition in terms admitting no
     * other reading. Nothing is invented here; the refusal is asserted so the gap
     * cannot be closed by accident. Sixth item on the M5 exit sweep's SPEC-08
     * clarification docket. */
    const requestId = await requestAtSubmitted('time-off');
    await asScheduler(async (uow) =>
      decideRequest(uow, {
        requestId,
        expectedVersion: await versionOf(requestId),
        decision: 'denied',
        reason: 'Denied for the purposes of this case.',
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect((await rowState(requestId)).status).toBe('denied');

    const outcome = await asScheduler(async (uow) =>
      reverseDecision(uow, {
        requestId,
        expectedVersion: await versionOf(requestId),
        reason: 'A denial has no reversal in SPEC-08 as it stands.',
        reversedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('illegal-operation');
    expect((await rowState(requestId)).status).toBe('denied');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The batch — per-item outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the batch answers EVERY item, and a partial failure is per-item', () => {
  it('a mixed batch returns one outcome per item, in the order sent', async () => {
    const good = await requestAtSubmitted('time-off');
    const alsoGood = await requestAtSubmitted('availability');
    const stale = await requestAtSubmitted('time-off');
    const preference = await requestAtSubmitted('shift-preference');
    const absent = randomUUID();

    /* `stale` has its VERSION moved by somebody else first, while staying in a
     * decidable status — so the batch reaches it holding a stale token and the
     * store's conditional update is what refuses. Bumping the version rather than
     * deciding the row is deliberate: a decided row would come back
     * `illegal-operation`, which is a different (and separately asserted) branch,
     * and this case is here to prove the CONDITIONAL UPDATE fires inside a batch. */
    const staleVersion = await versionOf(stale);
    await asScheduler(
      async ({ query }) =>
        await sql`update requests set version = version + 1 where id = ${stale}::uuid`.execute(
          query,
        ),
    );

    const items = [
      { requestId: good, expectedVersion: await versionOf(good) },
      { requestId: absent, expectedVersion: 1 },
      { requestId: stale, expectedVersion: staleVersion },
      { requestId: preference, expectedVersion: await versionOf(preference) },
      { requestId: alsoGood, expectedVersion: await versionOf(alsoGood) },
    ];

    const outcomes = await asScheduler((uow) =>
      decideRequestsBatch(uow, {
        items,
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );

    expect(outcomes).toHaveLength(items.length);
    expect(outcomes.map((outcome) => outcome.requestId)).toEqual(
      items.map((item) => item.requestId),
    );
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]).toMatchObject({ ok: false, failure: 'not-found' });
    expect(outcomes[2]).toMatchObject({ ok: false, failure: 'version-conflict' });
    expect(outcomes[3]).toMatchObject({ ok: false, failure: 'subtype-not-decidable-here' });
    expect(outcomes[4]?.ok).toBe(true);

    /* **The successes COMMITTED.** A batch that rolled back on the first refusal
     * would satisfy the shape assertions above and be exactly the all-or-nothing
     * behaviour doc 42 §5d forbids. */
    expect((await rowState(good)).status).toBe('approved');
    expect((await rowState(alsoGood)).status).toBe('approved');
    /* …and the refused ones did not move. */
    expect((await rowState(preference)).status).toBe('submitted');
  });

  it('a denial batch carries ONE reason, stored on every decision it makes', async () => {
    const first = await requestAtSubmitted('time-off');
    const second = await requestAtSubmitted('time-off');
    const reason = 'The rota cannot lose two people that week.';

    const outcomes = await asScheduler(async (uow) =>
      decideRequestsBatch(uow, {
        items: [
          { requestId: first, expectedVersion: await versionOf(first) },
          { requestId: second, expectedVersion: await versionOf(second) },
        ],
        decision: 'denied',
        reason,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);

    const stored = await admin.query<{ reason: string | null }>(
      'select reason from approvals where request_id = any($1::uuid[])',
      [[first, second]],
    );
    expect(stored.rows).toHaveLength(2);
    /* Each decision carries its own explanation when read back alone, which is
     * what makes ONE reason for the batch honest rather than lossy. */
    for (const row of stored.rows) expect(row.reason).toBe(reason);
  });

  it('a batch over the bound is REFUSED rather than truncated', async () => {
    /* Truncating would decide the first hundred and say nothing about the rest,
     * which is the silent partial this design exists to avoid — in the one place
     * a caller could not tell. */
    const items = Array.from({ length: 101 }, () => ({
      requestId: randomUUID(),
      expectedVersion: 1,
    }));
    await expect(
      asScheduler((uow) =>
        decideRequestsBatch(uow, {
          items,
          decision: 'approved',
          reason: null,
          decidedBy: context.membershipId,
          now: new Date(),
        }),
      ),
    ).rejects.toThrow(/DECISION_BATCH_TOO_LARGE/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The queue
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the pending-review queue', () => {
  it('shows undecided requests, oldest deadline first, and drops the decided', async () => {
    const pending = await requestAtSubmitted('time-off');
    const decided = await requestAtSubmitted('time-off');
    await asScheduler(async (uow) =>
      decideRequest(uow, {
        requestId: decided,
        expectedVersion: await versionOf(decided),
        decision: 'approved',
        reason: null,
        decidedBy: context.membershipId,
        now: new Date(),
      }),
    );

    const rows = await asScheduler((uow) => requestStore.listPendingReview(uow, { limit: 200 }));
    const ids = rows.map((row) => row.root.id);
    expect(ids).toContain(pending);
    expect(ids, 'a decided request is not pending review').not.toContain(decided);

    /* Ordered by DEADLINE. A queue sorted newest-first is a queue whose oldest
     * request ages forever, and the sweeper orders the same way — so the queue
     * and the sweeper agree about which request is most at risk. */
    const deadlines = rows.map((row) => row.root.expiresAt.getTime());
    expect([...deadlines].sort((a, b) => a - b)).toEqual(deadlines);
  });

  it('the subtype filter narrows, and never widens', async () => {
    await requestAtSubmitted('time-off');
    await requestAtSubmitted('availability');

    const filtered = await asScheduler((uow) =>
      requestStore.listPendingReview(uow, { subtypes: ['availability'], limit: 200 }),
    );
    expect(filtered.length).toBeGreaterThan(0);
    for (const row of filtered) expect(row.root.subtype).toBe('availability');
  });

  it('a scheduler sees only their OWN GROUP\'s requests (doc 42 §5d, C-1)', async () => {
    /* **The half of §5d's queue-authorization requirement that had no test.**
     * The register asks for "a member cannot reach the queue; a scheduler sees
     * only their group's requests". The first half is
     * `decision-authority.test.ts`'s six route refusals; this is the second.
     *
     * Neither neighbouring proof covers it, and it is worth saying why rather
     * than leaving a reader to assume one of them did:
     *   * migration 0023's cycle proves own-vs-colleague WITHIN one group;
     *   * migration 0021's X-11 case proves foreign-TENANT invisibility.
     * Cross-GROUP scoping inside ONE tenant is a third boundary, and the clause
     * that carries it is `requests_group_read_any`'s
     * `AND group_id = nullif(current_setting('app.group_id', true), '')::uuid`
     * (0023). The property held; the proof was missing.
     *
     * `listPendingReview` takes no group parameter BY DESIGN — the store's own
     * docblock says a filter there would be a second, weaker copy of a control
     * that already holds. This test is what makes that claim checkable: if the
     * predicate were the only thing scoping the queue and it were removed, the
     * store would have nothing left and this assertion would fail. */
    const mine = await requestAtSubmitted('time-off');
    const theirs = await requestAtSubmitted('time-off', siblingContext);
    expect(mine).not.toBe(theirs);

    const ourQueue = await asScheduler((uow) =>
      requestStore.listPendingReview(uow, { limit: 200 }),
    );
    const ourIds = ourQueue.map((row) => row.root.id);
    expect(ourIds, 'the group-one scheduler must see their own group\'s request').toContain(mine);
    expect(
      ourIds,
      'a sibling GROUP\'s request must not appear in this group\'s queue',
    ).not.toContain(theirs);

    /* THE POSITIVE CONTROL, without which the exclusion above could pass for the
     * most boring possible reason — that the second request was never written,
     * or was written somewhere no queue can see. The sibling scheduler differs
     * from ours only in which group they act in, so the row being visible THERE
     * and invisible HERE isolates the group predicate as the thing doing the
     * work. */
    const theirQueue = await runtime.runner.run(siblingContext, (uow) =>
      requestStore.listPendingReview(uow, { limit: 200 }),
    );
    const theirIds = theirQueue.map((row) => row.root.id);
    expect(theirIds, 'the sibling request must be visible in its OWN group').toContain(theirs);
    expect(theirIds, 'and the boundary holds in both directions').not.toContain(mine);

    /* And every row either queue returns carries its own group, so the exclusion
     * is a property of the whole result rather than of the two ids named above. */
    for (const row of ourQueue) expect(row.root.groupId).toBe(context.groupId);
    for (const row of theirQueue) expect(row.root.groupId).toBe(siblingContext.groupId);
  });

  it('a VACATION root does not appear — the round has its own surface', async () => {
    /* `loadRecord` does not read `vacation_selections`, because §5.3 gives that
     * lifecycle one reader and it is not the request store. So the queue shows the
     * five non-vacation subtypes, which is exactly the set §4's decision verbs act
     * on. Asserted rather than assumed, because "it happens not to be there" and
     * "it is deliberately excluded" look identical from a passing test. */
    const rows = await asScheduler((uow) => requestStore.listPendingReview(uow, { limit: 200 }));
    for (const row of rows) expect(row.root.subtype).not.toBe('vacation-selection');
  });
});
