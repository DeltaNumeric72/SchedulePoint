import { CAPABILITIES, authorize, policyInputFor, type CrossProductCase } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { FIXTURE, administratorContext } from '../support/fixtures.js';
import { log } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';

/**
 * **A denial explanation must never reach a client.**
 *
 * SPEC-06 P-3 — "a user must not learn a module's shape from a permission error"
 * — and SPEC-01 §2.4 — every forgery and cross-tenant probe answers a
 * byte-identical `404` — mean the evaluator's `explanation` is a server-side
 * diagnostic and nothing else. The evaluator produces a specific, useful English
 * sentence for every denial; a single `reply.send({ reason })` anywhere would
 * turn the whole of P-3 into a comment.
 *
 * So this file does the only check worth doing: it **drives real denials from
 * every layer through the real server** and asserts the explanation text — and
 * the reason code, and the step, and the capability key — appear in **no**
 * response body and **no** response header.
 */

let harness: HttpHarness;
let admin: pg.Client;
const alpha = FIXTURE.alpha;
const groupPath = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
});

afterAll(async () => {
  await harness.close();
  await admin.end();
});

afterEach(() => {
  harness.clearLogs();
});

async function headersFor(userId: string, groupId: string | null): Promise<Record<string, string>> {
  return contextHeaders(
    userId,
    await currentCounters(admin, { organizationId: alpha.organizationId, groupId, userId }),
  );
}

/** Every distinct explanation the evaluator can emit, harvested from the battery. */
function everyExplanation(): readonly string[] {
  const explanations = new Set<string>();
  const base: CrossProductCase = {
    capabilityKey: 'membership.touch_self',
    scope: 'group',
    orgStatus: 'active',
    groupStatus: 'active',
    entitlement: 'active',
    window: 'within',
    dependencySatisfied: true,
    available: true,
    membershipStatus: 'active',
    membershipWindow: 'within',
    role: 'scheduler',
    organizationMembershipStatus: 'active',
    organizationRole: 'absent',
    grant: 'absent',
    ownership: 'absent',
    proxy: 'none',
    impersonation: 'none',
  };
  const patches: Partial<CrossProductCase>[] = [
    { orgStatus: 'inactive' },
    { groupStatus: 'inactive' },
    { entitlement: 'absent' },
    { entitlement: 'suspended' },
    { entitlement: 'revoked' },
    { window: 'after' },
    { capabilityKey: 'connectors.manage', dependencySatisfied: false, grant: 'allow' },
    { available: false },
    { membershipStatus: 'absent' },
    { membershipStatus: 'suspended' },
    { membershipWindow: 'expired' },
    { grant: 'deny' },
    { role: 'member' },
    { ownership: 'other' },
    { proxy: 'expired' },
    { proxy: 'notifications-only' },
    { proxy: 'grantor-denied' },
    { impersonation: 'expired' },
    { impersonation: 'credential-surface' },
  ];
  for (const patch of patches) {
    const decision = authorize(policyInputFor({ ...base, ...patch }));
    if (!decision.allowed) explanations.add(decision.explanation);
  }
  return [...explanations];
}

describe('the evaluator produces real explanations — the check below is not vacuous', () => {
  it('there are many distinct explanations, and each is a sentence', () => {
    const explanations = everyExplanation();
    expect(explanations.length, 'the evaluator emits no explanations to leak').toBeGreaterThan(12);
    for (const explanation of explanations) {
      expect(explanation.length).toBeGreaterThan(15);
    }
    log(`${String(explanations.length)} distinct denial explanations exist and must never ship`);
  });
});

describe('no denial explanation, reason code, step or capability key reaches the client', () => {
  /** Everything that must not appear in a response, in one list. */
  function forbiddenStrings(): readonly string[] {
    return [
      ...everyExplanation(),
      // Reason codes and step labels are internal identifiers too.
      'NO_CAPABILITY',
      'EXPLICIT_DENY',
      'NOT_ENTITLED',
      'ENTITLEMENT_SUSPENDED',
      'MEMBERSHIP_SUSPENDED',
      'MODULE_UNAVAILABLE_IN_GROUP',
      'L4.2',
      'L1.1',
      // And the capability vocabulary: a 403 that named the missing capability
      // would tell an actor exactly what to ask for, and tell a prober what
      // exists.
      ...CAPABILITIES.map((capability) => capability.key),
      // Module keys are the shape P-3 is specifically about.
      'core_scheduling',
      'organization_administration',
    ];
  }

  async function assertClean(response: { body: string; headers: Record<string, unknown> }, label: string): Promise<void> {
    const haystack = `${response.body}\n${JSON.stringify(response.headers)}`;
    const leaked = forbiddenStrings().filter((needle) => haystack.includes(needle));
    expect(leaked, `${label}: the response carries ${leaked.join(', ')}`).toEqual([]);
    return Promise.resolve();
  }

  it('L4.2 — a role without the capability', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.member.id, alpha.groupOne.id),
    });
    expect(response.statusCode).toBe(403);
    await assertClean(response, 'L4.2');
    // And the log DOES carry it, so the diagnostic is not simply missing.
    const denial = harness.logs.find(
      (line) => (line as { authorization?: unknown }).authorization !== undefined,
    ) as { authorization?: { explanation?: string } } | undefined;
    expect(denial?.authorization?.explanation, 'the explanation is missing from the log too').toContain(
      'membership.touch_self',
    );
  });

  it('L4.1 — an explicit deny grant', async () => {
    const grantId = '8e000001-1111-4111-8111-000000000001';
    try {
      await harness.runtime.runner.run(
        administratorContext(alpha.organizationId, 'leak-check-deny'),
        async ({ query }) => {
          await query
            .insertInto('capability_grants')
            .values({
              id: grantId,
              organization_id: alpha.organizationId,
              group_id: alpha.groupOne.id,
              membership_id: alpha.users.scheduler.membershipId,
              capability_key: 'membership.touch_self',
              granted: false,
            })
            .execute();
        },
      );
      const response = await harness.app.inject({
        method: 'POST',
        url: groupPath,
        headers: await headersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      });
      expect(response.statusCode).toBe(403);
      await assertClean(response, 'L4.1');
    } finally {
      await admin.query('delete from capability_grants where id = $1', [grantId]);
    }
  });

  it('L1.2 — a suspended entitlement (P-3: the module shape is not disclosed)', async () => {
    try {
      await harness.runtime.runner.run(
        administratorContext(alpha.organizationId, 'leak-check-entitlement'),
        async ({ query }) => {
          await query
            .updateTable('entitlements')
            .set({ state: 'suspended' })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        },
      );
      const response = await harness.app.inject({
        method: 'POST',
        url: groupPath,
        headers: await headersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      });
      expect(response.statusCode).toBe(404);
      await assertClean(response, 'L1.2');
    } finally {
      await harness.runtime.runner.run(
        administratorContext(alpha.organizationId, 'leak-check-restore'),
        async ({ query }) => {
          await query
            .updateTable('entitlements')
            .set({ state: 'active' })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        },
      );
    }
  });

  it('the 403 and 404 bodies are FIXED — the same for every reason', async () => {
    // Two different 403 reasons must produce the same body, or the body itself
    // is the oracle. Correlation ids are pinned so the comparison measures the
    // envelope rather than the request id.
    const noCapability = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: contextHeaders(
        alpha.users.member.id,
        await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: alpha.groupOne.id,
          userId: alpha.users.member.id,
        }),
        'fixed-body-check',
      ),
    });

    const grantId = '8e000002-1111-4111-8111-000000000002';
    let explicitDenyBody = '';
    try {
      await harness.runtime.runner.run(
        administratorContext(alpha.organizationId, 'leak-check-deny-2'),
        async ({ query }) => {
          await query
            .insertInto('capability_grants')
            .values({
              id: grantId,
              organization_id: alpha.organizationId,
              group_id: alpha.groupOne.id,
              membership_id: alpha.users.scheduler.membershipId,
              capability_key: 'membership.touch_self',
              granted: false,
            })
            .execute();
        },
      );
      const explicitDeny = await harness.app.inject({
        method: 'POST',
        url: groupPath,
        headers: contextHeaders(
          alpha.users.scheduler.id,
          await currentCounters(admin, {
            organizationId: alpha.organizationId,
            groupId: alpha.groupOne.id,
            userId: alpha.users.scheduler.id,
          }),
          'fixed-body-check',
        ),
      });
      explicitDenyBody = explicitDeny.body;
      expect(explicitDeny.statusCode).toBe(403);
    } finally {
      await admin.query('delete from capability_grants where id = $1', [grantId]);
    }

    expect(noCapability.statusCode).toBe(403);
    expect(
      noCapability.body,
      'two different denial reasons produced two different bodies — the body is an oracle',
    ).toBe(explicitDenyBody);
    log('L4.1 and L4.2 produce byte-identical 403 bodies');
  });
});
