import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The COMPOSED system, over the real HTTP routes (OPUS-M3-008).
 *
 * ## Why re-prove things that already have proofs
 *
 * Every claim below has a service-level proof from an earlier packet. The point
 * of re-proving them here is that the earlier proofs each ran against ONE
 * module's surface, and this milestone is the first time authoring, publication,
 * staff views, settings, rules and the audit read exist in one server at once.
 * M2-004's own finding was that composition surfaces behaviour no component test
 * sees; packet 32 §6 names exactly that as the integration packet's trigger.
 *
 * So these run through `app.inject` against the registered routes, with real
 * authorization, real RLS, real transactions — not against the services.
 *
 * ## Every denial has an ALLOW control on the same route
 *
 * FAD-15's vacuity discipline. A `403` or `404` from a route that answers
 * nothing to anybody proves nothing at all, so each denial below is measured
 * against the same request succeeding for an actor who differs in exactly one
 * fact.
 */

const multi = ownedMulti('composed-integration', {
  profile: 'full',
  seed: { catalogue: ['alpha'], schedule: true },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 6 });
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

interface Reply {
  readonly statusCode: number;
  readonly body: Record<string, unknown> | undefined;
  readonly raw: string;
}

async function countersFor(userId: string, groupId: string): Promise<DeclaredCounters> {
  return currentCounters(admin, {
    organizationId: multi().alpha.organizationId,
    groupId,
    userId,
  });
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  userId: string,
  options: { body?: unknown; groupId?: string } = {},
): Promise<Reply> {
  const groupId = options.groupId ?? multi().alpha.groupOne.id;
  const response = await harness.app.inject({
    method,
    url,
    headers: {
      ...contextHeaders(userId, await countersFor(userId, groupId)),
      'content-type': 'application/json',
    },
    ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
  });
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  return { statusCode: response.statusCode, body: parsed, raw: response.body };
}

/** Every composed READ surface, as `(label, url-builder)`. */
function composedReads(groupId: string): readonly { label: string; url: string }[] {
  const alpha = multi().alpha;
  const schedule = multi().schedule;
  const base = `/organizations/${alpha.organizationId}/groups/${groupId}`;
  const periodId = schedule?.groupOne.periodId ?? '00000000-0000-4000-8000-000000000000';
  const versionId = schedule?.groupOne.currentVersionId ?? '00000000-0000-4000-8000-000000000000';
  return [
    { label: 'authoring · periods', url: `${base}/schedule/periods` },
    { label: 'publication · review', url: `${base}/schedule/versions/${versionId}/publication-review` },
    { label: 'publication · history', url: `${base}/schedule/periods/${periodId}/history` },
    { label: 'publication · published', url: `${base}/schedule/periods/${periodId}/published` },
    { label: 'publication · records', url: `${base}/schedule/periods/${periodId}/publication-records` },
    { label: 'catalogue · shift types', url: `${base}/catalogue/shift-types` },
    { label: 'catalogue · holidays', url: `${base}/catalogue/holidays` },
    { label: 'rules · list', url: `${base}/rules` },
    { label: 'settings · group', url: `${base}/settings` },
    { label: 'audit · events', url: `${base}/audit-events` },
  ];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Cross-GROUP and cross-TENANT denial at EVERY composed surface
 * ──────────────────────────────────────────────────────────────────────────── */

describe('cross-group and cross-tenant denial, at every composed surface', () => {
  it('an actor with no membership in the target group is refused on all of them', async () => {
    const alpha = multi().alpha;
    const catalogue = multi().catalogue?.alpha;
    if (catalogue === undefined) throw new Error('needs the catalogue seed');
    const sibling = catalogue.sibling.groupId;

    /* The ALLOW control comes first, on every surface: the scheduler reads its
     * OWN group. Without it a wall of 403/404 would be indistinguishable from a
     * server that answers nothing. */
    const allowed: string[] = [];
    const unexpected: string[] = [];
    for (const surface of composedReads(alpha.groupOne.id)) {
      const reply = await call('GET', surface.url, alpha.users.scheduler.id, {
        groupId: alpha.groupOne.id,
      });
      // 200 or a *stated* denial for a key this actor does not hold; either is a
      // real answer. What must not happen is a 5xx.
      if (reply.statusCode >= 500) unexpected.push(`${surface.label}: ${String(reply.statusCode)}`);
      if (reply.statusCode === 200) allowed.push(surface.label);
    }
    expect(unexpected, 'a composed read surface answered 5xx for its own group').toEqual([]);
    expect(
      allowed.length,
      'no composed surface answered 200, so the denials below would be vacuous',
    ).toBeGreaterThan(4);

    /* Now the SIBLING group, with the same principal. `groupOnly` holds a
     * membership in Group One and in no other group, so every one of these is
     * "you are not in that group" rather than "you lack a key". */
    const leaks: string[] = [];
    for (const surface of composedReads(sibling)) {
      const reply = await call('GET', surface.url, alpha.users.groupOnly.id, { groupId: sibling });
      if (reply.statusCode === 200) leaks.push(`${surface.label}: 200`);
    }
    expect(leaks, 'a composed surface answered a group the actor does not belong to').toEqual([]);
  });

  it('a BETA principal is refused on every ALPHA surface, with the single 404 body', async () => {
    const alpha = multi().alpha;
    const beta = multi().beta;

    const bodies = new Set<string>();
    for (const surface of composedReads(alpha.groupOne.id)) {
      const response = await harness.app.inject({
        method: 'GET',
        url: surface.url,
        headers: contextHeaders(
          beta.users.scheduler.id,
          await currentCounters(admin, {
            organizationId: alpha.organizationId,
            groupId: alpha.groupOne.id,
            userId: beta.users.scheduler.id,
          }),
        ),
      });
      expect(response.statusCode, `${surface.label} answered a foreign organization`).not.toBe(200);
      bodies.add(response.body.replace(/"correlationId":"[^"]+"/, '"correlationId":"<id>"'));
    }

    // Cross-TENANT refusals must be byte-identical to one another: a body that
    // varied by surface would tell a probe which surfaces exist.
    expect([...bodies]).toEqual([
      '{"error":{"code":"NOT_FOUND","message":"Not found.","correlationId":"<id>"}}',
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Authorization freshness ON THE COMPOSED SURFACES (I-19)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('authorization freshness — a mid-flight revocation denies across surfaces', () => {
  it('revoking the audit-read grant denies the audit surface on the very next request', async () => {
    const alpha = multi().alpha;
    const auditUrl = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/audit-events`;

    /* GRANT, through the production path (the organization administrator, whose
     * principal is not the grantee — `app_guard_capability_grant_administration`
     * refuses a self-grant and is not worked around). */
    const grantId = await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: alpha.users.organizationAdmin.membershipId,
        correlationId: 'composed-grant',
      },
      async (uow) => {
        const id = crypto.randomUUID();
        await uow.query
          .insertInto('capability_grants')
          .values({
            id,
            organization_id: alpha.organizationId,
            group_id: alpha.groupOne.id,
            membership_id: alpha.users.groupOnly.membershipId,
            capability_key: 'audit.read',
            granted: true,
            granted_by_membership_id: alpha.users.organizationAdmin.membershipId,
          })
          .execute();
        return id;
      },
    );

    const before = await call('GET', auditUrl, alpha.users.groupOnly.id);
    expect(before.statusCode, 'the grant did not take effect, so the revocation proves nothing').toBe(
      200,
    );

    /* REVOKE by row id — never by predicate (FAD-15 as corrected, E-01). A
     * capability is taken away by an auditable `granted = false`, so the window
     * closes rather than the row disappearing. */
    await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: null,
        membershipId: alpha.users.organizationAdmin.membershipId,
        correlationId: 'composed-revoke',
      },
      async (uow) => {
        await uow.query
          .updateTable('capability_grants')
          .set({ granted: false })
          .where('id', '=', grantId)
          .execute();
      },
    );

    const after = await call('GET', auditUrl, alpha.users.groupOnly.id);
    expect(after.statusCode, 'a revoked grant still authorized the next request (I-19)').toBe(403);
  });

  it('revoking the ENTITLEMENT denies every core-scheduling surface at L1, not at L4', async () => {
    /* The gamma organization exists precisely so this can be measured without
     * mutating Alpha's entitlements in place — which was itself a coupling
     * (EV-M2-NR13). Gamma is administrable and has NO `core_scheduling`. */
    const gamma = multi().gamma;
    if (gamma === undefined) throw new Error('needs the full profile (gamma)');

    const base = `/organizations/${gamma.organizationId}/groups/${gamma.groupOne.id}`;
    const denied: string[] = [];
    for (const url of [`${base}/schedule/periods`, `${base}/catalogue/shift-types`, `${base}/rules`]) {
      const response = await harness.app.inject({
        method: 'GET',
        url,
        headers: contextHeaders(
          gamma.users.scheduler.id,
          await currentCounters(admin, {
            organizationId: gamma.organizationId,
            groupId: gamma.groupOne.id,
            userId: gamma.users.scheduler.id,
          }),
        ),
      });
      if (response.statusCode === 200) denied.push(url);
    }
    expect(denied, 'an unentitled organization reached a core-scheduling surface').toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Duplicate-request handling on the composed publication path
 * ──────────────────────────────────────────────────────────────────────────── */

describe('duplicate requests and publication concurrency, through the real routes', () => {
  /** An approved draft on its own period, built entirely over HTTP. */
  async function approvedDraft(label: string, month: number): Promise<{
    periodId: string;
    versionId: string;
    date: string;
  }> {
    const alpha = multi().alpha;
    const catalogue = multi().catalogue?.alpha;
    if (catalogue === undefined) throw new Error('needs the catalogue seed');
    const shiftTypeId = catalogue.shiftTypeIds[0];
    if (shiftTypeId === undefined) throw new Error('no shift type');
    const base = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule`;
    const date = `2036-${String(month).padStart(2, '0')}-05`;

    const period = await call('POST', `${base}/periods`, alpha.users.scheduler.id, {
      body: { name: `${label} ${String(month)}`, startDate: date, endDate: date },
    });
    expect(period.statusCode, period.raw).toBe(200);
    const periodId = (period.body?.['period'] as { id: string } | undefined)?.id ?? '';

    const version = await call(
      'POST',
      `${base}/periods/${periodId}/versions`,
      alpha.users.scheduler.id,
      { body: {} },
    );
    expect(version.statusCode, version.raw).toBe(200);
    const versionId = (version.body?.['version'] as { id: string } | undefined)?.id ?? '';

    /* The cell revision is READ from the grid, not invented: the authoring
     * surface is server-authoritative compare-and-set (PO-DEC-18), so an
     * assignment without the token the server issued is refused — which is the
     * control working, and is why this helper cannot shortcut it. */
    const grid = await call('GET', `${base}/versions/${versionId}/grid`, alpha.users.scheduler.id);
    expect(grid.statusCode, grid.raw).toBe(200);
    const emptyCellRevision = (grid.body as { emptyCellRevision?: string } | undefined)
      ?.emptyCellRevision;
    if (emptyCellRevision === undefined) throw new Error('the grid carried no empty-cell revision');

    const assignment = await call(
      'POST',
      `${base}/versions/${versionId}/assignments`,
      alpha.users.scheduler.id,
      {
        body: {
          membershipId: alpha.users.member.membershipId,
          shiftTypeId,
          date,
          expectedCellRevision: emptyCellRevision,
        },
      },
    );
    expect(assignment.statusCode, assignment.raw).toBe(200);

    for (const to of ['in_review', 'approved'] as const) {
      const moved = await call('POST', `${base}/versions/${versionId}/state`, alpha.users.scheduler.id, {
        body: { to },
      });
      expect(moved.statusCode, moved.raw).toBe(200);
    }

    return { periodId, versionId, date };
  }

  /**
   * The publication body the SERVER asked for.
   *
   * Read from the review rather than constructed: the digest and the
   * prior-current id are compare-and-set tokens the server issues, and a test
   * that made them up would be testing a request shape no client can produce.
   */
  async function publishBody(
    versionId: string,
    key: string,
  ): Promise<Record<string, unknown>> {
    const alpha = multi().alpha;
    const base = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule`;
    const review = await call(
      'GET',
      `${base}/versions/${versionId}/publication-review`,
      alpha.users.scheduler.id,
    );
    expect(review.statusCode, review.raw).toBe(200);
    const body = review.body as {
      expectedPriorCurrentVersionId: string | null;
      reviewDigest: string;
      frictionTier: string;
      confirmationPhrase?: string;
      blockers: unknown[];
    };
    // Non-vacuity: a blocked review would make every publication below a 409 for
    // the wrong reason.
    expect(body.blockers, `${versionId} is blocked before the race even starts`).toEqual([]);
    return {
      idempotencyKey: key,
      expectedPriorCurrentVersionId: body.expectedPriorCurrentVersionId,
      expectedReviewDigest: body.reviewDigest,
      acknowledged: true,
      ...(body.frictionTier === 'type-to-confirm'
        ? { confirmationPhrase: body.confirmationPhrase }
        : {}),
    };
  }

  it('two RACING publications of the same version, over HTTP: one wins, one is explicit', async () => {
    const alpha = multi().alpha;
    const base = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule`;
    const draft = await approvedDraft('race', 1);
    const shared = `composed-race-${crypto.randomUUID()}`;

    /* DIFFERENT idempotency keys, so the race is decided by the period lock and
     * the state check rather than by D-17's replay. A shared key would prove
     * idempotency, which is the next test. */
    const bodyA = await publishBody(draft.versionId, `${shared}-a`);
    const bodyB = await publishBody(draft.versionId, `${shared}-b`);

    const [first, second] = await Promise.all([
      call('POST', `${base}/versions/${draft.versionId}/publication`, alpha.users.scheduler.id, {
        body: bodyA,
      }),
      call('POST', `${base}/versions/${draft.versionId}/publication`, alpha.users.scheduler.id, {
        body: bodyB,
      }),
    ]);

    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes[0], `${first.raw} / ${second.raw}`).toBe(200);
    // The loser is a stated conflict, never a 500 and never a second success.
    expect(codes[1]).toBe(409);

    // …and the database agrees: exactly one publication record, one outbox event.
    const records = await admin.query<{ n: string }>(
      `select count(*)::text as n from publication_records where version_id = $1`,
      [draft.versionId],
    );
    expect(records.rows[0]?.n).toBe('1');
    const events = await admin.query<{ n: string }>(
      `select count(*)::text as n from outbox_events
        where payload->>'version' = $1`,
      [draft.versionId],
    );
    expect(events.rows[0]?.n).toBe('1');
  });

  it('the SAME idempotency key sent twice publishes once and replays honestly', async () => {
    const alpha = multi().alpha;
    const base = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule`;
    const draft = await approvedDraft('replay', 2);
    const key = `composed-replay-${crypto.randomUUID()}`;
    const body = await publishBody(draft.versionId, key);

    const first = await call(
      'POST',
      `${base}/versions/${draft.versionId}/publication`,
      alpha.users.scheduler.id,
      { body },
    );
    expect(first.statusCode, first.raw).toBe(200);
    expect(first.body?.['replay']).toBe(false);

    /* The retry carries the SAME body a client retained, digest included — which
     * is what a dropped connection produces. */
    const retry = await call(
      'POST',
      `${base}/versions/${draft.versionId}/publication`,
      alpha.users.scheduler.id,
      { body },
    );
    expect(retry.statusCode, retry.raw).toBe(200);
    // The replay says it is one. A retry after a dropped connection must not be
    // told it published a second time, and must not be told nobody was affected.
    expect(retry.body?.['replay']).toBe(true);

    const records = await admin.query<{ n: string }>(
      `select count(*)::text as n from publication_records
        where version_id = $1 and publication_idempotency_key = $2`,
      [draft.versionId, key],
    );
    expect(records.rows[0]?.n).toBe('1');
  });
});
