import { createHash } from 'node:crypto';

import {
  CAPABILITIES,
  MODULE_KEYS,
  SYSTEM_GROUP_ROLES,
  SYSTEM_ORGANIZATION_ROLES,
  SYSTEM_ROLE_CAPABILITIES,
  type ModuleKey,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * Provisioning an organization's authorization state.
 *
 * ## The bootstrap problem, stated plainly
 *
 * Every administrative write in `0002_authorization.sql` is gated on the acting
 * membership holding a capability. An organization that has just been created
 * has no memberships, therefore no acting membership, therefore nobody who could
 * hold anything — so the very first writes cannot be capability-gated without
 * making organization creation impossible.
 *
 * The migration's answer is one narrow door: `app_require_capability` returns
 * without checking **only** when the caller is in an organization-scoped context
 * **and** the organization has no memberships at all. It closes the instant the
 * first membership row exists, and `memberships` has no DELETE grant for any
 * runtime role, so it can never reopen.
 *
 * **This module is the only thing that walks through that door**, and the order
 * below is load-bearing:
 *
 *   1. roles, role capabilities, entitlements, module availability — the
 *      organization still has zero memberships, so the door is open;
 *   2. the first organization membership — the trigger runs BEFORE the row
 *      exists, so the door is still open for exactly this statement;
 *   3. **the door is now shut.** Every later membership, grant, role or
 *      entitlement change must be made by an acting membership that holds the
 *      capability, including every one this same function makes.
 *
 * Step 3 is not a limitation to work around. It is the property the whole
 * migration exists to establish, and `apps/api/test/authz/provisioning.test.ts`
 * asserts that a second organization membership created without an acting
 * administrator is refused.
 */

export interface ProvisionedRole {
  readonly id: string;
  readonly scope: 'group' | 'organization';
  readonly key: string;
}

/**
 * Deterministic ids, derived from the **whole** organization id and a
 * discriminator.
 *
 * ## Why deterministic at all
 *
 * A random UUID per role would make the fixture's expected state depend on
 * insertion order, and a test that has to read back an id it just wrote cannot
 * assert anything about a row it did not write.
 *
 * ## Why the first version was wrong
 *
 * It took the organization id's **first eight hex characters** and appended a
 * 32-bit FNV hash of the role key. An independent review pointed out the
 * consequence: two organizations whose ids share eight leading hex characters
 * produce **identical role primary keys**, and `roles.id` is a primary key, so
 * the second organization's provisioning fails with a 23505 — a unique check
 * that **bypasses RLS** and therefore reports a collision against a row the
 * caller cannot see. Thirty-two bits of tenant distinctness is a birthday
 * collision at a few tens of thousands of organizations, and the failure mode is
 * "this tenant cannot be created" with a cross-tenant existence oracle attached.
 *
 * SHA-256 over the full organization id plus the discriminator, formatted as a
 * v4-shaped UUID. It is an identifier, not a secret — nothing anywhere treats a
 * role id as unguessable — but it is now collision-free for any realistic number
 * of tenants rather than for a few thousand.
 */
function derivedUuid(organizationId: string, discriminator: string): string {
  const digest = createHash('sha256').update(`${organizationId}\u0000${discriminator}`).digest('hex');
  // Stamp the version (4) and variant (8..b) nibbles so the value is a
  // well-formed UUID, which `uuid` columns and the contracts' `z.string().uuid()`
  // both require. 122 bits of the digest survive.
  const variant = '89ab'[Number.parseInt(digest[16] ?? '0', 16) % 4] ?? '8';
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function roleId(organizationId: string, scope: string, key: string): string {
  return derivedUuid(organizationId, `role:${scope}:${key}`);
}

function derivedId(organizationId: string, marker: string, discriminator: string): string {
  return derivedUuid(organizationId, `${marker}:${discriminator}`);
}

export interface ProvisionAuthorizationOptions {
  readonly organizationId: string;
  /**
   * Modules entitled at provisioning, and their state.
   *
   * Defaults to the three modules an organization cannot function without:
   * `core_scheduling`, and the two SPEC-06 §1.1 names as governing organization
   * administration — `organization_administration` and `entitlements`. Nothing
   * else. That is deliberately the *minimum*: PO-DEC-04's commercial packaging is
   * a pending decision, so provisioning `picklist` or `marketplace` by default
   * would be implementing a packaging choice nobody has made.
   *
   * The two administration modules are not commercial packages — they are the
   * surface through which an organization is administered at all — and omitting
   * them would produce a tenant nobody can configure.
   */
  readonly entitledModules?: readonly {
    readonly moduleKey: ModuleKey;
    readonly state?: 'trial' | 'active' | 'suspended' | 'revoked';
  }[];
  /** Groups in which the entitled modules are made available (SPEC-06 L2.1). */
  readonly groupIds?: readonly string[];
}

/**
 * Writes the system roles, their capability sets, the entitlements and the
 * per-group availability for a freshly created organization.
 *
 * Must run in an ORGANIZATION-scoped unit of work, before the organization's
 * first membership exists.
 */
export async function provisionAuthorization(
  query: Kysely<Database>,
  options: ProvisionAuthorizationOptions,
): Promise<readonly ProvisionedRole[]> {
  const { organizationId } = options;
  const entitled = options.entitledModules ?? [
    { moduleKey: 'core_scheduling' as const },
    { moduleKey: 'organization_administration' as const },
    { moduleKey: 'entitlements' as const },
  ];
  const groupIds = options.groupIds ?? [];

  /* ── roles ─────────────────────────────────────────────────────────────── */
  const roles: ProvisionedRole[] = [
    ...SYSTEM_GROUP_ROLES.map((key) => ({
      id: roleId(organizationId, 'group', key),
      scope: 'group' as const,
      key,
    })),
    ...SYSTEM_ORGANIZATION_ROLES.map((key) => ({
      id: roleId(organizationId, 'organization', key),
      scope: 'organization' as const,
      key,
    })),
  ];

  await query
    .insertInto('roles')
    .values(
      roles.map((role) => ({
        id: role.id,
        organization_id: organizationId,
        scope: role.scope,
        key: role.key,
        name: role.key,
        is_system_role: true,
      })),
    )
    .execute();

  /* ── role capabilities ─────────────────────────────────────────────────── */
  //
  // Every pair is validated against the catalogue before it is written. A typo
  // in `SYSTEM_ROLE_CAPABILITIES` would otherwise become a row that grants
  // nothing and denies nothing, and the only symptom would be a capability that
  // mysteriously never works.
  const known = new Set(CAPABILITIES.map((capability) => capability.key));
  const pairs: { roleId: string; scope: string; capabilityKey: string }[] = [];
  for (const role of roles) {
    for (const capabilityKey of SYSTEM_ROLE_CAPABILITIES[role.key] ?? []) {
      const definition = CAPABILITIES.find((c) => c.key === capabilityKey);
      if (!known.has(capabilityKey) || definition === undefined) {
        throw new Error(
          `role ${role.key} claims the unknown capability ${capabilityKey} — the catalogue and ` +
            'SYSTEM_ROLE_CAPABILITIES have diverged',
        );
      }
      if (definition.scope !== role.scope) {
        // P-10 at the point of writing, not only at the point of reading.
        throw new Error(
          `role ${role.key} is ${role.scope}-scoped but ${capabilityKey} is ${definition.scope}-scoped (P-10)`,
        );
      }
      pairs.push({ roleId: role.id, scope: role.scope, capabilityKey });
    }
  }

  if (pairs.length > 0) {
    await query
      .insertInto('role_capabilities')
      .values(
        pairs.map((pair) => ({
          id: derivedId(organizationId, 'c1', `${pair.roleId}:${pair.capabilityKey}`),
          organization_id: organizationId,
          role_id: pair.roleId,
          capability_key: pair.capabilityKey,
        })),
      )
      .execute();
  }

  /* ── entitlements ──────────────────────────────────────────────────────── */
  for (const module of entitled) {
    if (!(MODULE_KEYS as readonly string[]).includes(module.moduleKey)) {
      throw new Error(`unknown module ${module.moduleKey}`);
    }
    await query
      .insertInto('entitlements')
      .values({
        id: derivedId(organizationId, 'e2', `entitlement:${module.moduleKey}`),
        organization_id: organizationId,
        module_key: module.moduleKey,
        state: module.state ?? 'active',
      })
      .execute();
  }

  /* ── group module availability ─────────────────────────────────────────── */
  for (const groupId of groupIds) {
    for (const module of entitled) {
      await query
        .insertInto('group_module_availability')
        .values({
          id: derivedId(organizationId, 'a3', `${groupId}:${module.moduleKey}`),
          organization_id: organizationId,
          group_id: groupId,
          module_key: module.moduleKey,
          available: true,
        })
        .execute();
    }
  }

  return roles;
}
