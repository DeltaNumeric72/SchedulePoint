/**
 * The SPEC-06 authorization kernel — pure, and importable without a database.
 *
 * > **I-19 — Every protected operation … is decided by the same pure
 * > authorization function evaluated against current state at the moment of the
 * > operation.**
 *
 * Nothing in this directory performs I/O, reads a clock, or knows what a
 * transaction is. `apps/api/src/authz/` assembles the snapshot inside the unit of
 * work and calls `authorize`; `packages/domain/test/authz/` calls it a quarter of
 * a million times without a server.
 */

export {
  CAPABILITIES,
  MODULE_DEPENDENCIES,
  MODULE_KEYS,
  capabilityDefinition,
  capabilityKeys,
  duplicateCapabilityKeys,
  isKnownCapability,
  moduleClosure,
  moduleDependencyCycles,
  overlappingCapabilityKeys,
  type CapabilityDefinition,
  type CapabilityScope,
  type ModuleKey,
} from './catalogue.js';

export {
  allow,
  deny,
  denialDisclosure,
  passedCapabilityLayer,
  type Allow,
  type Decision,
  type Deny,
  type DenyReason,
  type Disclosure,
  type PolicyStep,
} from './decision.js';

export type {
  ActionInput,
  AvailabilityInput,
  EntitlementInput,
  EntitlementState,
  EvaluationContext,
  GrantInput,
  GroupInput,
  ImpersonationInput,
  Instant,
  MembershipInput,
  MembershipInputStatus,
  OrganizationInput,
  PolicyInput,
  ProxyInput,
  ProxyScope,
  RoleInput,
  TargetInput,
} from './policy-input.js';

export { authorize, authorizeWithoutObjectPolicy, withinWindow } from './evaluate.js';

export {
  ENTITLEMENT_STATES,
  GRANT_SLOTS,
  GROUP_ROLE_SLOTS,
  IMPERSONATION_SLOTS,
  MEMBERSHIP_WINDOWS,
  NOW as CROSS_PRODUCT_NOW,
  OWNERSHIP_SLOTS,
  PROXY_SLOTS,
  ORGANIZATION_ROLE_SLOTS,
  SYSTEM_GROUP_ROLES,
  SYSTEM_ORGANIZATION_ROLES,
  SYSTEM_ROLE_CAPABILITIES,
  describeCase,
  expectedOutcome,
  generateCases,
  policyInputFor,
  type CrossProductCase,
  type ExpectedOutcome,
  type GenerationOptions,
} from './cross-product.js';
