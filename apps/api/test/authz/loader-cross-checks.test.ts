import { authorize, type EvaluationContext } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actionInputOf } from '../../src/authz/authorize-request.js';
import { loadPolicyInput } from '../../src/authz/load-policy-input.js';
import { GROUP_SCOPED_CONFIG, ORGANIZATION_SCOPED_CONFIG } from '../../src/http/routes/context-probe.route.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant.
 *
 * It used to write to the shared MULTI baseline, which every other file also read.
 * NR-13 measured what that cost: six order-dependent tests across five files, and
 * eleven of twenty-four files modifying rows the shared seed created. The fixture
 * below has the same shape and fresh identifiers, and RLS — not agreement — is what
 * keeps it out of everybody else's queries.
 */
const multi = ownedMulti('authz-loader-cross-checks');


/**
 * **S-04 — the loader's snapshot cross-checks, each one made necessary.**
 *
 * `loadPolicyInput` discards a membership row that does not match the context on
 * four counts: kind, principal, organization and group. An independent review
 * replaced the whole predicate with `membershipRow !== undefined` and **all 212
 * API tests still passed** — the cross-checks were unexecuted code guarding the
 * step that decides who is acting.
 *
 * They are hard to reach through HTTP precisely because the middleware resolves
 * the membership correctly, so these call the loader directly with a doctored
 * `EvaluationContext` inside a real unit of work. Each test removes exactly one
 * agreement between the context and the row, and asserts the membership slot
 * comes back **null** — which the evaluator turns into `NO_MEMBERSHIP`, a 404.
 *
 * Deleting any single clause from `kindMatches` turns one of these red.
 */

let admin: pg.Client;
let runtime: Runtime;
/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const alpha = () => multi().alpha;
/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const beta = () => multi().beta;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

const groupAction = actionInputOf(GROUP_SCOPED_CONFIG);
const organizationAction = actionInputOf(ORGANIZATION_SCOPED_CONFIG);

function contextOf(overrides: Partial<EvaluationContext>): EvaluationContext {
  return {
    principalUserId: alpha().users.scheduler.id,
    expectedOrganizationId: alpha().organizationId,
    expectedGroupId: alpha().groupOne.id,
    membershipId: alpha().users.scheduler.membershipId,
    ...overrides,
  };
}

describe('the honest baseline', () => {
  it('a context that agrees with the row resolves the membership and ALLOWS', async () => {
    const input = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId),
      async ({ query }) =>
        loadPolicyInput(query, { context: contextOf({}), action: groupAction, now: new Date() }),
    );
    expect(input.membership, 'the baseline itself resolves nothing — every test below is vacuous').not.toBeNull();
    expect(authorize(input).allowed).toBe(true);
  });
});

describe('S-04 — each cross-check, individually necessary', () => {
  it('KIND: an ORGANIZATION membership does not satisfy a group-scoped action', async () => {
    // Under an organization-scoped unit of work the group membership rows are
    // visible (EX-2's organization-wide read), so the row IS fetched. The kind
    // clause is the only thing that rejects it.
    const input = await runtime.runner.run(
      organizationContext(alpha().organizationId),
      async ({ query }) =>
        loadPolicyInput(query, {
          // An organization-scoped action pointed at a GROUP membership.
          context: contextOf({
            expectedGroupId: null,
            membershipId: alpha().users.scheduler.membershipId,
          }),
          action: organizationAction,
          now: new Date(),
        }),
    );
    expect(
      input.organizationMembership,
      'a group membership satisfied an organization-scoped action — the kind clause is gone',
    ).toBeNull();
    const decision = authorize(input);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('NO_ORG_MEMBERSHIP');
  });

  it('KIND, the other direction: a GROUP membership does not satisfy an organization-scoped action', async () => {
    const input = await runtime.runner.run(
      organizationContext(alpha().organizationId),
      async ({ query }) =>
        loadPolicyInput(query, {
          context: contextOf({
            principalUserId: alpha().users.organizationAdmin.id,
            expectedGroupId: null,
            // The organization admin's ORGANIZATION membership, evaluated as if
            // the action were group-scoped.
            membershipId: alpha().users.organizationAdmin.membershipId,
          }),
          action: groupAction,
          now: new Date(),
        }),
    );
    expect(input.membership, 'an organization membership satisfied a group-scoped action').toBeNull();
  });

  it('PRINCIPAL: a membership belonging to somebody else is discarded', async () => {
    // The row is the Alpha scheduler's; the context claims a different user is
    // acting. Without this clause, holding another member's membership id would
    // be enough to act as them.
    const input = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId),
      async ({ query }) =>
        loadPolicyInput(query, {
          context: contextOf({ principalUserId: alpha().users.member.id }),
          action: groupAction,
          now: new Date(),
        }),
    );
    expect(
      input.membership,
      'a membership belonging to another principal was accepted — the principal clause is gone',
    ).toBeNull();
    const decision = authorize(input);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('NO_MEMBERSHIP');
  });

  it('ORGANIZATION: a row from a different organization than the context declares is discarded', async () => {
    // Reachable only by calling the loader directly: RLS confines the row to the
    // unit of work's organization, so through HTTP the two can never disagree.
    // The clause is defence in depth against a resolver bug, and defence in
    // depth that is never executed is a comment.
    const input = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId),
      async ({ query }) =>
        loadPolicyInput(query, {
          context: contextOf({ expectedOrganizationId: beta().organizationId }),
          action: groupAction,
          now: new Date(),
        }),
    );
    expect(
      input.membership,
      'a membership from another organization was accepted — the organization clause is gone',
    ).toBeNull();
  });

  it('GROUP: a membership in a sibling group is discarded', async () => {
    // The unit of work is Group One's, so Group One's row is visible; the
    // context declares Group Two. Without this clause the actor would act in
    // Group Two on the strength of a Group One membership — the CAR-001 defect
    // class, one layer below the middleware that also prevents it.
    const input = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId),
      async ({ query }) =>
        loadPolicyInput(query, {
          context: contextOf({ expectedGroupId: alpha().groupTwo.id }),
          action: groupAction,
          now: new Date(),
        }),
    );
    expect(
      input.membership,
      'a sibling group\'s membership was accepted — the group clause is gone',
    ).toBeNull();
    log('all four loader cross-checks reject a mismatched context');
  });

  it('a membership id that resolves to nothing is null too — the trivial case still holds', async () => {
    const input = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId),
      async ({ query }) =>
        loadPolicyInput(query, {
          context: contextOf({ membershipId: '00000000-0000-4000-8000-0000000000ee' }),
          action: groupAction,
          now: new Date(),
        }),
    );
    expect(input.membership).toBeNull();
  });

  it('a discarded membership takes its ROLE with it — no capabilities leak through', async () => {
    // The role and its capability set are resolved from the row's role key. If a
    // rejected membership still populated them, L4.2 would read a capability set
    // for a membership L3.1 refused.
    const input = await runtime.runner.run(
      groupContext(alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId),
      async ({ query }) =>
        loadPolicyInput(query, {
          context: contextOf({ principalUserId: alpha().users.member.id }),
          action: groupAction,
          now: new Date(),
        }),
    );
    expect(input.role).toBeNull();
    expect(input.roleCapabilities).toEqual([]);
    expect(input.organizationRole).toBeNull();
    expect(input.organizationRoleCapabilities).toEqual([]);
  });
});
