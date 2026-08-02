/**
 * The role keys, from [08-roles-and-permissions.md](../../../../../docs/fable/08-roles-and-permissions.md) §3.
 *
 * Role lives on the **membership**, not on the account — the research corpus's
 * key finding, and the reason a person can hold different roles in different
 * groups. The two namespaces are **disjoint** (SPEC-06 P-10): a key is declared
 * group-scoped or organization-scoped, never both.
 *
 * These are the identifiers only. The capability envelope behind each of them is
 * SPEC-06's truth table, which lands with the evaluator in OPUS-M1-002; nothing
 * in this milestone maps a role to a capability set beyond the explicit
 * per-route `provisional.allowRoles` list.
 *
 * `Genius` is deliberately absent: it merges into `scheduler` unless a real,
 * testable capability difference is ever specified, and an untestable
 * distinction is not shipped (PO-DEC-02, doc 08 §3).
 */

/** Roles held by a GROUP membership. */
export const GROUP_ROLES = ['member', 'viewer', 'telecom', 'scheduler', 'group_admin'] as const;
export type GroupRole = (typeof GROUP_ROLES)[number];

/** Roles held by an ORGANIZATION membership. */
export const ORGANIZATION_ROLES = ['org_admin'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export function isGroupRole(value: string): value is GroupRole {
  return (GROUP_ROLES as readonly string[]).includes(value);
}

export function isOrganizationRole(value: string): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly string[]).includes(value);
}

/**
 * P-10, asserted rather than assumed: the two namespaces must not overlap.
 *
 * A key declared in both would make P-8 and P-9 unenforceable — the evaluator
 * could not tell which scope a grant belonged to.
 */
export function overlappingRoleKeys(): readonly string[] {
  return GROUP_ROLES.filter((key) => (ORGANIZATION_ROLES as readonly string[]).includes(key));
}
