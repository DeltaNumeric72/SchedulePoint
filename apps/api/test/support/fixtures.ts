import type { TenantContext } from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import {
  buildMultiFixture,
  seedMultiAuditAndOutbox,
  seedMultiTenants,
  type MultiFixture,
} from './multi.js';

/**
 * The **immutable shared baseline** (FAD-15 Layer 1).
 *
 * One MULTI fixture, seeded once in `globalSetup`, and **read-only for every
 * test in the suite**. `baseline-guard.ts` re-digests it after every test file
 * and fails the run naming the file that changed a row.
 *
 * ## Why read-only, and why enforced rather than agreed
 *
 * NR-13. Before FAD-15, 551 tests shared this fixture and wrote to it: eleven of
 * twenty-four api files modified rows the seed had created — `memberships`,
 * `organizations` and `users` by seven files each — and six tests across five
 * files were measurably order-dependent as a result
 * (`docs/evidence/EV-M2-NR13/`). A convention that eleven files already violate
 * is not a convention, so this one is a control.
 *
 * **A test that needs to write calls `ownedMulti()`** (`owned-multi.ts`) and gets
 * its own fixture of exactly this shape with fresh identifiers, isolated from
 * every other file by RLS rather than by agreement.
 *
 * The shape itself lives in `multi.ts`, which is the single fixture owner: this
 * baseline and every owned fixture are the same builder called with different
 * identifiers.
 */
export const FIXTURE: MultiFixture = buildMultiFixture('baseline', 'core');

/** A UUID that belongs to nothing. Used for forged-id and non-existent-id probes. */
export const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

export function organizationContext(
  organizationId: string,
  correlationId = 'fixture-organization-seed',
): TenantContext {
  return { organizationId, groupId: null, membershipId: null, correlationId };
}

/**
 * An organization-scoped context acting as that organization's administrator.
 *
 * Since OPUS-M1-002 a privilege-bearing membership change — role, status, kind,
 * group, validity window — is refused by
 * `memberships_guard_administration_on_privilege_change` unless the acting
 * membership holds `organization.membership.administer`. A test that wants to
 * revoke a role therefore has to do it the way production does, and this is that
 * context. Using `membershipId: null` is now a **refusal**, which is the point of
 * the change.
 *
 * `fixture` defaults to the shared baseline for the read-only callers; a file
 * working in its own tenant passes its own.
 */
export function administratorContext(
  organizationId: string,
  correlationId = 'fixture-administration',
  fixture: MultiFixture = FIXTURE,
): TenantContext {
  let membershipId = fixture.alpha.users.organizationAdmin.membershipId;
  if (organizationId === fixture.beta.organizationId) {
    membershipId = fixture.beta.users.organizationAdmin.membershipId;
  } else if (fixture.gamma !== undefined && organizationId === fixture.gamma.organizationId) {
    membershipId = fixture.gamma.users.organizationAdmin.membershipId;
  }
  return { organizationId, groupId: null, membershipId, correlationId };
}

export function groupContext(
  organizationId: string,
  groupId: string,
  membershipId: string | null = null,
  correlationId = 'fixture-group-seed',
): TenantContext {
  return { organizationId, groupId, membershipId, correlationId };
}

/**
 * The baseline's four legitimate (organization, group) partitions.
 *
 * Still ground truth for "the baseline is intact", and deliberately **no longer**
 * ground truth for "which partitions may exist": owned fixtures create their own,
 * and a census that flagged those would be measuring the test rather than the
 * system. The census reads the live sets from `groups` and `organizations`
 * instead (`harness.ts`).
 */
export const BASELINE_PARTITIONS: ReadonlySet<string> = new Set(FIXTURE.partitions);

export const BASELINE_ORGANIZATIONS: ReadonlySet<string> = new Set(FIXTURE.organizationIds);

/** Seeds the shared baseline. Called once, by `globalSetup`. */
export async function seedFixture(runner: PgUnitOfWorkRunner): Promise<void> {
  await seedMultiTenants(runner, FIXTURE);
}

/** Seeds the shared baseline's audit, outbox and checkpoint rows. */
export async function seedAuditAndOutbox(
  runtime: PgUnitOfWorkRunner,
  worker: PgUnitOfWorkRunner,
): Promise<void> {
  await seedMultiAuditAndOutbox(runtime, worker, FIXTURE);
}
