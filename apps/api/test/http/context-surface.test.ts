import { CONTEXT_HEADER } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { FIXTURE, NONEXISTENT_ID } from '../support/fixtures.js';
import { log } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  lastActiveAt,
  TEST_PRINCIPAL_HEADER,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';

/**
 * **SPEC-01 §7.1 — cross-tab and stale context (CAR-001), over HTTP.**
 *
 * | # | Scenario | Required outcome |
 * |---|---|---|
 * | T-01  | Two contexts, one session; switch group in B; submit a mutation from A | A's declared group is honoured; **no write against B** |
 * | T-02  | Same, but A's membership was revoked meanwhile | **no write, no event, no audit mutation** |
 * | T-04  | Forged `expected_group_id` naming a group the user does not belong to | `404`; logged as a security event |
 * | T-05  | Target from another group, actor **is** authorized in the declared group | `409 CONTEXT_TARGET_MISMATCH` before any write |
 * | T-05b | Same, actor holds **no** capability in the declared group | `404` — **byte-identical** to a non-existent id |
 * | T-06  | Long-lived form submitted after an entitlement is revoked | Fails with no partial effect |
 * | T-06b | Organization-scoped action, actor holds an active organization membership and role | Accepted; `membership_id` is the organization membership |
 * | T-06c | Organization-scoped action, actor holds only a **group** membership | `404` |
 * | T-06d | Group-scoped action with `expected_group_id = null` | `404` |
 *
 * **T-03 is partially in scope by packet decision**: the *mutation* surface is
 * every test below, and the *job-enqueue* surface is
 * `apps/api/test/jobs/job-context.test.ts`. The publication, report-request,
 * document-upload and WebSocket surfaces do not exist yet and are deferred to
 * their own milestones — tracked in the return report, not silently dropped.
 *
 * ### A recorded conflict, in T-02
 *
 * SPEC-01 §7.1's T-02 row says `409 CONTEXT_STALE` for a revoked membership. But
 * §2.3 runs step 2 (membership exists **and is active**) *before* step 4
 * (freshness), and §2.4 states that a **departed member** "receives `404` and
 * learns nothing". A revoked membership therefore cannot reach step 4, and
 * answering `409` would tell a departed member that their context is merely
 * stale — which is the disclosure §2.4 exists to prevent. This suite implements
 * §2.3 + §2.4 and asserts `404`; the substantive requirement common to both
 * readings — **no write, no event, no audit mutation** — is asserted either way.
 * The status-code conflict is escalated in the return report for a recorded
 * decision, and `T-02b` covers the unambiguous half: an active membership whose
 * counters advanced gets `409 CONTEXT_STALE`.
 */

let harness: HttpHarness;
let admin: pg.Client;

const alpha = FIXTURE.alpha;
const beta = FIXTURE.beta;

const groupOnePath = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`;
const groupTwoPath = `/organizations/${alpha.organizationId}/groups/${alpha.groupTwo.id}/context-probe/touch`;
const organizationPath = `/organizations/${alpha.organizationId}/context-probe/touch`;
const groupScopedWithoutGroupPath = `/organizations/${alpha.organizationId}/context-probe/group-scoped-touch`;

function targetPath(groupId: string, targetMembershipId: string): string {
  return `/organizations/${alpha.organizationId}/groups/${groupId}/context-probe/targets/${targetMembershipId}`;
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
});

afterAll(async () => {
  await harness.close();
  await admin.end();
});

/**
 * **The counters are deliberately NOT reset between tests, and cannot be.**
 *
 * An earlier draft of this suite reset them to `1` in an `afterEach`. That is now
 * impossible by design: the triggers added for R-05 raise `restrict_violation`
 * on any attempt to move a freshness counter backwards, for anyone, including a
 * superuser. Monotonicity is the property — a counter that can be rewound is a
 * counter a `409 CONTEXT_STALE` cannot be trusted to mean anything.
 *
 * Order-independence comes from the tests instead: every test that needs a fresh
 * context reads the CURRENT counters immediately before its request
 * (`countersFor`), and the handful that hard-code `1` are all cases that must be
 * refused at §2.3 steps 1–3, which run before freshness is even consulted. A
 * wrong counter cannot change their outcome, and if it ever could, the assertion
 * would fail rather than silently pass.
 */
afterEach(() => {
  harness.jobQueue.clear();
});

async function countersFor(
  userId: string,
  groupId: string | null,
  organizationId = alpha.organizationId,
): Promise<DeclaredCounters> {
  return currentCounters(admin, { organizationId, groupId, userId });
}

describe('the middleware cannot be skipped', () => {
  it('denies every capability route without a session (401)', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: {
        [CONTEXT_HEADER]: JSON.stringify({
          contextVersion: { organizationVersion: 1, groupVersion: 1, membershipSetVersion: 1 },
          sessionEpoch: 1,
        }),
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a capability route with no context header (400) — the path segment is not enough', async () => {
    // SPEC-01 §2.2: "The path segment is not sufficient on its own — it
    // identifies the tenant but not the freshness. Both are required."
    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: { [TEST_PRINCIPAL_HEADER]: JSON.stringify({ userId: alpha.users.scheduler.id, sessionEpoch: 1 }) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CONTEXT_MALFORMED');
  });

  it('the production principal resolver denies everything', async () => {
    // The shipped default, asserted directly rather than inferred from its
    // absence: a server with no session backend serves no authenticated traffic.
    const { denyAllPrincipalResolver } = await import('../../src/http/context/principal.js');
    const resolution = await denyAllPrincipalResolver.resolve({ headers: {} });
    expect(resolution.authenticated).toBe(false);
  });
});

describe('SPEC-01 §7.1 — declared context is honoured, never substituted', () => {
  it('T-01 ONE principal, two tabs: A\'s declared group is honoured, no write against B', async () => {
    // ── The CAR-001 scenario, with the fixture that can actually detect it ──
    //
    // ONE principal (`alpha.users.scheduler`) holds a group membership in BOTH
    // Alpha groups. Tab B switches to Group Two and acts there; Tab A then
    // submits a long-open form that still declares Group One.
    //
    // Why one principal matters: with a different user per group, a server that
    // kept a session-global "active group" would still route each request to the
    // only group that user belonged to, and this test would pass with the defect
    // present. With one principal and two declared contexts, a session-global
    // implementation MUST get one of them wrong — either Tab A's write lands on
    // Group Two's membership, or Tab A's response reports Group Two. Both are
    // asserted below, so either failure mode turns this test red.
    const groupOneMembership = alpha.users.scheduler.membershipId;
    const groupTwoMembership = alpha.users.scheduler.groupTwoMembershipId;

    const groupOneBefore = await lastActiveAt(admin, groupOneMembership);

    // Tab B: the user switches to Group Two and acts there.
    const tabB = await harness.app.inject({
      method: 'POST',
      url: groupTwoPath,
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupTwo.id),
      ),
    });
    expect(tabB.statusCode).toBe(200);
    expect(tabB.json<{ membershipId: string }>().membershipId).toBe(groupTwoMembership);

    // Group Two's state AFTER B and BEFORE A. Taking it before B would make the
    // assertion measure B's own write and pass for the wrong reason.
    const groupTwoAfterB = await lastActiveAt(admin, groupTwoMembership);
    expect(groupTwoAfterB, 'Tab B did not write, so the T-01 assertion would be vacuous').not.toBeNull();

    // Tab A: the long-open form, still declaring Group One, same session.
    const tabA = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      ),
    });
    expect(tabA.statusCode).toBe(200);

    // (1) The RESPONSE reports the declared group and the Group One membership.
    //     A session-global implementation would report Group Two here.
    const body = tabA.json<{ groupId: string; membershipId: string; organizationId: string }>();
    expect(body.groupId, 'the declared group was substituted').toBe(alpha.groupOne.id);
    expect(
      body.membershipId,
      'membership_id resolved against the session\'s last-selected group, not the declared one',
    ).toBe(groupOneMembership);
    expect(body.organizationId).toBe(alpha.organizationId);

    // (2) GROUND TRUTH: the row that moved is the one in the DECLARED group, and
    //     Group Two is exactly where Tab B left it.
    const groupOneAfter = await lastActiveAt(admin, groupOneMembership);
    const groupTwoAfter = await lastActiveAt(admin, groupTwoMembership);

    expect(
      groupOneAfter?.getTime() ?? null,
      'Tab A declared Group One but nothing in Group One moved',
    ).not.toBe(groupOneBefore?.getTime() ?? null);
    expect(
      groupTwoAfter?.getTime(),
      "Tab A's submission wrote against Group Two — the CAR-001 defect",
    ).toBe(groupTwoAfterB?.getTime());

    log(
      `one principal, two memberships: Tab A declared and wrote Group One; Group Two unchanged since Tab B at ${groupTwoAfterB?.toISOString() ?? 'null'}`,
    );
  });

  it('T-01b the same principal is refused a group it does NOT belong to', async () => {
    // The other half of the fixture's honesty: holding two memberships must not
    // become "holds every group". Beta Group One is declared under Alpha's
    // organization by this dual-member principal, and it is still a 404.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${beta.groupOne.id}/context-probe/touch`,
      headers: contextHeaders(alpha.users.scheduler.id, {
        organizationVersion: 1,
        groupVersion: 1,
        membershipSetVersion: 1,
        sessionEpoch: 1,
      }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('T-02 a revoked membership: no write, no event — and 404, not a stale-context hint', async () => {
    const before = await lastActiveAt(admin, alpha.users.departed.membershipId);

    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(alpha.users.departed.id, {
        organizationVersion: 1,
        groupVersion: 1,
        membershipSetVersion: 1,
        sessionEpoch: 1,
      }),
    });

    // The substantive requirement, common to both readings of T-02.
    const after = await lastActiveAt(admin, alpha.users.departed.membershipId);
    expect(after?.getTime() ?? null, 'a revoked member wrote a row').toBe(before?.getTime() ?? null);
    expect(harness.jobQueue.jobs, 'a revoked member enqueued a job').toHaveLength(0);

    // The status: §2.3 step 2 precedes step 4, and §2.4 says a departed member
    // learns nothing. See the suite docblock for the recorded conflict with the
    // §7.1 T-02 row.
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    log('revoked membership: 404, no write, no job enqueued');
  });

  it('T-02b an ACTIVE membership whose counters advanced: 409 CONTEXT_STALE, no write', async () => {
    // The unambiguous half of T-02, and the mechanism SPEC-01 §3's worked
    // example describes: a privilege change bumps `membership_set_version`, the
    // long-open tab submits the version it read earlier, and step 4 rejects it.
    const stale = await countersFor(alpha.users.scheduler.id, alpha.groupOne.id);
    const before = await lastActiveAt(admin, alpha.users.scheduler.membershipId);

    await admin.query('update users set membership_set_version = membership_set_version + 1 where id = $1', [
      alpha.users.scheduler.id,
    ]);

    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(alpha.users.scheduler.id, stale),
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string; recover: string } }>();
    expect(body.error.code).toBe('CONTEXT_STALE');
    expect(body.error.recover).toBe('refetch-context');

    const after = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    expect(after?.getTime() ?? null).toBe(before?.getTime() ?? null);
    log('membership_set_version advanced: 409 CONTEXT_STALE with a re-fetch directive, no write');
  });

  it('SESSION_STALE is distinct from CONTEXT_STALE', async () => {
    const counters = await countersFor(alpha.users.scheduler.id, alpha.groupOne.id);
    await admin.query('update users set session_epoch = session_epoch + 1 where id = $1', [
      alpha.users.scheduler.id,
    ]);

    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(alpha.users.scheduler.id, counters),
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string; recover: string } }>();
    expect(body.error.code).toBe('SESSION_STALE');
    expect(body.error.recover).toBe('reauthenticate');
  });

  it('T-04 a forged group id: 404 byte-identical to a non-existent id, AND a security event', async () => {
    // SPEC-01 §7.1 T-04 requires two things and this asserts both. The status
    // half was covered before; the "logged as a security event" half was not,
    // and an unasserted logging requirement is an unimplemented one.
    const correlationId = 'forged12345678';
    const counters = {
      organizationVersion: 1,
      groupVersion: 1,
      membershipSetVersion: 1,
      sessionEpoch: 1,
    };

    harness.clearLogs();

    // Beta's group, declared under Alpha's organization, by an Alpha member.
    const forged = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${beta.groupOne.id}/context-probe/touch`,
      headers: contextHeaders(alpha.users.member.id, counters, correlationId),
    });

    // The same declaration, against a group that exists nowhere at all.
    const absent = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${NONEXISTENT_ID}/context-probe/touch`,
      headers: contextHeaders(alpha.users.member.id, counters, correlationId),
    });

    // (1) BYTE-IDENTICAL, the same comparison T-05b makes. A forged group and a
    //     non-existent group must be indistinguishable on the wire.
    expect(forged.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    expect(forged.body, 'a forged group id and a non-existent one differ on the wire').toBe(
      absent.body,
    );
    expect(forged.headers['content-type']).toBe(absent.headers['content-type']);
    expect(forged.headers['content-length']).toBe(absent.headers['content-length']);

    // (2) SECURITY EVENT. Indistinguishable to the CLIENT, fully distinguished
    //     in the server's own log — which is the whole point of §2.4: the
    //     operator learns what happened, the prober does not.
    const events = harness.logs.filter(
      (line) => (line['contextSecurityEvent'] as { correlationId?: string } | undefined) !== undefined,
    );
    expect(events.length, 'no security event was logged for a forged declaration').toBeGreaterThan(0);

    const event = events[0]?.['contextSecurityEvent'] as {
      correlationId: string;
      code: string;
      step: number;
      securityEvent: boolean;
      declaredGroupId: string | null;
      reason: string;
    };
    expect(event.securityEvent).toBe(true);
    expect(event.code).toBe('NOT_FOUND');
    expect(event.correlationId).toBe(correlationId);
    expect(event.declaredGroupId).toBe(beta.groupOne.id);
    expect(event.step, 'a forged group should be caught at step 2 or 3').toBeGreaterThanOrEqual(2);

    // (3) And the diagnostic that makes it useful to an operator is the one
    //     thing that must NEVER reach the client (§2.4).
    expect(event.reason.length).toBeGreaterThan(0);
    expect(forged.body).not.toContain(event.reason);
    expect(forged.body).not.toContain(beta.groupOne.id);

    log(
      `forged and non-existent group ids are byte-identical (${forged.body}); security event logged at step ${String(event.step)}`,
    );
  });

  it('a forged ORGANIZATION id answers 404 and reveals nothing about the other tenant', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${beta.organizationId}/groups/${beta.groupOne.id}/context-probe/touch`,
      headers: contextHeaders(alpha.users.scheduler.id, {
        organizationVersion: 1,
        groupVersion: 1,
        membershipSetVersion: 1,
        sessionEpoch: 1,
      }),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('SPEC-01 §7.1 T-05 / T-05b — target aggregate binding and its disclosure rule', () => {
  it('T-05 authorized actor, target in a sibling group: 409 CONTEXT_TARGET_MISMATCH, before any write', async () => {
    const targetMembershipId = alpha.users.groupTwoScheduler.membershipId;
    const before = await lastActiveAt(admin, targetMembershipId);

    const response = await harness.app.inject({
      method: 'POST',
      url: targetPath(alpha.groupOne.id, targetMembershipId),
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      ),
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('CONTEXT_TARGET_MISMATCH');

    const after = await lastActiveAt(admin, targetMembershipId);
    expect(after?.getTime() ?? null, 'the target was written before the mismatch was detected').toBe(
      before?.getTime() ?? null,
    );
    log('authorized actor + sibling-group target: 409 CONTEXT_TARGET_MISMATCH, target unmodified');
  });

  it('T-05b unauthorized actor: 404, BYTE-IDENTICAL to a non-existent id', async () => {
    // The actor is `member`, whose role is not in the route's provisional
    // allow-list. Both requests carry the SAME correlation id so the two bodies
    // are comparable byte for byte — the correlation id is the only field that
    // legitimately varies between two responses, and it is client-supplied here.
    const correlationId = 'redcase12345678';
    const counters = await countersFor(alpha.users.member.id, alpha.groupOne.id);

    const crossTenant = await harness.app.inject({
      method: 'POST',
      url: targetPath(alpha.groupOne.id, alpha.users.groupTwoScheduler.membershipId),
      headers: contextHeaders(alpha.users.member.id, counters, correlationId),
    });

    const nonExistent = await harness.app.inject({
      method: 'POST',
      url: targetPath(alpha.groupOne.id, NONEXISTENT_ID),
      headers: contextHeaders(alpha.users.member.id, counters, correlationId),
    });

    expect(crossTenant.statusCode).toBe(404);
    expect(nonExistent.statusCode).toBe(404);
    expect(crossTenant.body, 'the two 404 bodies differ').toBe(nonExistent.body);
    expect(crossTenant.headers['content-type']).toBe(nonExistent.headers['content-type']);
    expect(crossTenant.headers['content-length']).toBe(nonExistent.headers['content-length']);

    log(
      `unauthorized cross-group target and non-existent id are byte-identical: ${crossTenant.body}`,
    );
  });

  it('a target in the actor\'s OWN group binds and is accepted', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: targetPath(alpha.groupOne.id, alpha.users.member.membershipId),
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      ),
    });
    expect(response.statusCode).toBe(200);
  });

  it('an authorized actor is still denied a target in another ORGANIZATION — 404, never 409', async () => {
    // §2.4: no cross-tenant existence is disclosed. The organization is the
    // boundary RLS never lets anyone cross, so a Beta membership id is
    // indistinguishable from an id that does not exist.
    const response = await harness.app.inject({
      method: 'POST',
      url: targetPath(alpha.groupOne.id, beta.users.scheduler.membershipId),
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      ),
    });
    expect(response.statusCode).toBe(404);
    log('cross-ORGANIZATION target: 404 even for an authorized actor — no 409, no disclosure');
  });
});

describe('SPEC-01 §7.1 T-06 — entitlement-class change, and the scope branches', () => {
  it('T-06 an organization-version change invalidates a long-lived form with no partial effect', async () => {
    // SPEC-06 §4: `organization_version` is bumped by an org status, ENTITLEMENT,
    // or module-dependency change, in the same transaction as the change.
    //
    // SCOPE NOTE, recorded rather than implied: the `entitlements` table and the
    // L1 `NOT_ENTITLED` denial are OPUS-M1-002's. What this milestone owns, and
    // what this test proves, is that an entitlement-class change is a
    // context-freshness input and that the long-open submission fails closed
    // with no partial effect. The entitlement-LAYER denial is asserted in
    // OPUS-M1-002 against the same route.
    const stale = await countersFor(alpha.users.scheduler.id, alpha.groupOne.id);
    const before = await lastActiveAt(admin, alpha.users.scheduler.membershipId);

    await admin.query(
      'update organizations set organization_version = organization_version + 1 where id = $1',
      [alpha.organizationId],
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(alpha.users.scheduler.id, stale),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CONTEXT_STALE');

    const after = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    expect(after?.getTime() ?? null, 'a partial effect landed').toBe(before?.getTime() ?? null);
    log('organization_version advanced: 409 CONTEXT_STALE, no partial effect');
  });

  it('T-06b organization-scoped action with an active organization membership and role: accepted', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: organizationPath,
      headers: contextHeaders(
        alpha.users.organizationAdmin.id,
        await countersFor(alpha.users.organizationAdmin.id, null),
      ),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ membershipId: string; groupId: string | null; actionScope: string }>();
    expect(body.actionScope).toBe('organization');
    expect(body.groupId, 'an organization-scoped action must declare no group').toBeNull();
    expect(
      body.membershipId,
      'membership_id must resolve to the ORGANIZATION membership',
    ).toBe(alpha.users.organizationAdmin.membershipId);
    log('organization-scoped action accepted; membership_id resolved to the organization membership');
  });

  it('T-06c organization-scoped action, actor holds only a GROUP membership: 404', async () => {
    // SPEC-06 P-9: a group role never satisfies an organization-scoped action.
    // The two capability namespaces are disjoint, deliberately.
    const response = await harness.app.inject({
      method: 'POST',
      url: organizationPath,
      headers: contextHeaders(alpha.users.groupOnly.id, {
        organizationVersion: 1,
        groupVersion: null,
        membershipSetVersion: 1,
        sessionEpoch: 1,
      }),
    });
    expect(response.statusCode).toBe(404);
    log('group-only member attempting an organization-scoped action: 404');
  });

  it('T-06d group-scoped action declaring no group: 404 — the branch follows the ROUTE\'s scope', async () => {
    // The route at this path declares `actionScope: 'group'` and carries no
    // group segment. SPEC-01 §2.1 (V-06): "the branch is selected by the route's
    // declared scope, never by the presence or absence of the field." It must
    // fail closed rather than quietly becoming an organization-scoped action.
    const response = await harness.app.inject({
      method: 'POST',
      url: groupScopedWithoutGroupPath,
      headers: contextHeaders(
        alpha.users.organizationAdmin.id,
        await countersFor(alpha.users.organizationAdmin.id, null),
      ),
    });
    expect(response.statusCode).toBe(404);

    // And the same route is equally closed to a group member with a group role.
    const asGroupMember = await harness.app.inject({
      method: 'POST',
      url: groupScopedWithoutGroupPath,
      headers: contextHeaders(alpha.users.scheduler.id, {
        organizationVersion: 1,
        groupVersion: 1,
        membershipSetVersion: 1,
        sessionEpoch: 1,
      }),
    });
    expect(asGroupMember.statusCode).toBe(404);
    log('group-scoped route with no declared group: 404 for every actor');
  });
});

describe('deny-by-default holds for the provisional policies', () => {
  it('an actor whose role is not listed is denied 403, and writes nothing', async () => {
    const before = await lastActiveAt(admin, alpha.users.member.membershipId);
    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(
        alpha.users.member.id,
        await countersFor(alpha.users.member.id, alpha.groupOne.id),
      ),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    const after = await lastActiveAt(admin, alpha.users.member.membershipId);
    expect(after?.getTime() ?? null).toBe(before?.getTime() ?? null);
    log('role `member` is not in the provisional allow-list: 403, no write');
  });

  it('an organization role never satisfies a group-scoped action (P-8)', async () => {
    // `org_admin` holds no group membership in Group One, so this is a 404 at
    // step 2 — the earlier and stricter of the two possible refusals.
    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(alpha.users.organizationAdmin.id, {
        organizationVersion: 1,
        groupVersion: 1,
        membershipSetVersion: 1,
        sessionEpoch: 1,
      }),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('FAD-12 — authorization and mutation share one unit of work', () => {
  /**
   * Changes a group role THROUGH a unit of work.
   *
   * Not through the superuser client: a privilege-bearing membership change
   * outside a unit of work is refused by the counter-maintenance trigger (I-15),
   * which is itself asserted in `roles-and-schema.test.ts`. The interleaving has
   * to use the same path the product uses — which is also the more faithful
   * simulation of "an administrator revokes the role mid-request".
   *
   * It runs on `harness.runtime.runner` — the plain runner — rather than on
   * `harness.runner`, so the demotion does not itself count towards the
   * interleaving index it is being triggered from.
   */
  async function setGroupRole(membershipId: string, role: string): Promise<void> {
    await harness.runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        membershipId: null,
        correlationId: 'fad-12-role-change',
      },
      async ({ query }) => {
        await query
          .updateTable('memberships')
          .set({ group_role: role })
          .where('id', '=', membershipId)
          .execute();
      },
    );
  }

  it('a request opens exactly TWO transactions: the §2.3 snapshot, then the command', async () => {
    // The structural half of FAD-12. If the handler ever splits its role check
    // and its write across two transactions again, this count goes to three and
    // the test fails before anyone has to reason about the race.
    harness.runner.resetCalls();

    const response = await harness.app.inject({
      method: 'POST',
      url: groupOnePath,
      headers: contextHeaders(
        alpha.users.scheduler.id,
        await countersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(
      harness.runner.calls,
      'the command must be ONE unit of work: read the role and write in the same transaction',
    ).toBe(2);
    log('one request = 1 resolution transaction + 1 command transaction');
  });

  it('a role revoked BETWEEN the snapshot and the command is caught by the command itself', async () => {
    // The behavioural half, and the race FAD-12 exists to close.
    //
    // The demotion is committed after the middleware's §2.3 snapshot has read
    // the old role and before the command transaction opens. A server that
    // trusted the snapshot's verdict would authorize the write on evidence that
    // was already stale. The handler re-reads inside its own transaction, so it
    // denies — and because that read and the write share the transaction, there
    // is no remaining window between them either.
    const membershipId = alpha.users.scheduler.membershipId;
    const counters = await countersFor(alpha.users.scheduler.id, alpha.groupOne.id);
    const before = await lastActiveAt(admin, membershipId);

    let demoted = false;
    harness.runner.resetCalls();
    harness.runner.beforeRun = async (callIndex) => {
      // Call 1 is the resolution snapshot; call 2 is the command. Demote in the
      // gap between them — deterministically, not by sleeping and hoping.
      if (callIndex === 2 && !demoted) {
        demoted = true;
        await setGroupRole(membershipId, 'member');
      }
    };

    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: groupOnePath,
        headers: contextHeaders(alpha.users.scheduler.id, counters),
      });

      expect(demoted, 'the interleaving never fired — the test proved nothing').toBe(true);
      expect(response.statusCode, 'a revoked role was authorized by a stale snapshot').toBe(403);

      const after = await lastActiveAt(admin, membershipId);
      expect(after?.getTime() ?? null, 'the mutation landed despite the revocation').toBe(
        before?.getTime() ?? null,
      );
      log('role revoked between snapshot and command: 403, no write');
    } finally {
      harness.runner.beforeRun = undefined;
      await setGroupRole(membershipId, 'scheduler');
    }
  });

  it('the same holds for the job-enqueue surface: no enqueue on a revoked role', async () => {
    const membershipId = alpha.users.scheduler.membershipId;
    const counters = await countersFor(alpha.users.scheduler.id, alpha.groupOne.id);
    harness.jobQueue.clear();

    let demoted = false;
    harness.runner.resetCalls();
    harness.runner.beforeRun = async (callIndex) => {
      if (callIndex === 2 && !demoted) {
        demoted = true;
        await setGroupRole(membershipId, 'member');
      }
    };

    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/enqueue`,
        headers: contextHeaders(alpha.users.scheduler.id, counters),
      });
      expect(demoted).toBe(true);
      expect(response.statusCode).toBe(403);
      expect(harness.jobQueue.jobs, 'a job was enqueued on a revoked role').toHaveLength(0);
    } finally {
      harness.runner.beforeRun = undefined;
      await setGroupRole(membershipId, 'scheduler');
    }
  });
});
