/**
 * `@schedulepoint/domain` — the layering root.
 *
 * The boundary, enforced by `.dependency-cruiser.cjs` rule
 * `domain-imports-nothing` and proved by `scripts/red-cases/import-boundary/`:
 *
 *   packages/domain  ->  (nothing)
 *   packages/contracts -> zod only
 *   apps/api         ->  domain, contracts, infrastructure
 *   apps/web         ->  contracts
 *
 * Domain has **zero** runtime dependencies: no Fastify, no Kysely, no `pg`, no
 * React, no node builtin, nothing from `apps/**`. Everything it needs from the
 * outside world arrives as a port — an interface declared here, implemented in
 * `apps/api`.
 *
 * OPUS-M1-001 adds the tenancy kernel's domain half: the SPEC-01 §2 context
 * tuple, the **pure** §2.3 validation sequence and §3 target binding, and the
 * §4.2 unit-of-work contract with its read-back comparison. Every one of those
 * is a pure function or an interface, which is what lets the SPEC-01 §7.1
 * harness enumerate the branches without a database and the §7.2 harness
 * exercise the same code the HTTP surface uses.
 */

export {
  ContextReadbackMismatchError,
  NestedTenantChangeError,
  TENANT_SETTING_NAMES,
  isTenantChange,
  readBackMismatches,
  tenantSettingValues,
  type SettingMismatch,
  type TenantContext,
  type TenantSettingName,
  type UnitOfWork,
  type UnitOfWorkRunner,
} from './ports/unit-of-work.js';

export type { AlertSeverity, AlertSink, OperationalAlert } from './ports/alerts.js';
export type {
  EnqueuedJob,
  FrozenJobContext,
  JobOutcome,
  JobQueue,
} from './ports/job-queue.js';
export type { Principal, PrincipalResolution, PrincipalResolver } from './ports/principal.js';

export {
  authorizationVersionOf,
  contextVersionsMatch,
  type ActionScope,
  type ContextVersion,
  type DeclaredContext,
  type RequestContext,
} from './context/request-context.js';

export {
  bindTarget,
  membershipIsActive,
  verifyDeclaredContext,
  type ContextFailure,
  type ContextFailureCode,
  type ContextSnapshot,
  type ContextStep,
  type ContextVerification,
  type GroupSnapshot,
  type MembershipKind,
  type MembershipSnapshot,
  type MembershipStatus,
  type OrganizationSnapshot,
  type PrincipalSnapshot,
  type TargetBinding,
  type TargetDescriptor,
} from './context/verification.js';

/**
 * OPUS-M1-002 adds the authorization kernel: SPEC-06's capability catalogue, its
 * `PolicyInput`, and the pure truth-table evaluator. Same rule as everything
 * above it — no I/O, no clock, no database.
 */
export * from './authz/index.js';

export { ports, type PortName } from './ports/index.js';

/* ── OPUS-M1-003: the audit chain and outbox ports (SPEC-11, ADR-0019) ────────
 *
 * Interfaces and pure functions only, as everything in this package must be.
 * The chain itself lives in the database (migration 0003) because a chain the
 * application computes is a chain the application can quietly recompute.
 */
export {
  AUDIT_EVENT_NAMES,
  AUDIT_SUBJECT_TYPES,
  isAuditEventName,
  isAuditSubjectType,
  type AuditEventName,
  type AuditSubjectType,
} from './audit/event-names.js';

export {
  AUDIT_PAYLOAD_MAX_KEYS,
  AUDIT_PAYLOAD_MAX_STRING_LENGTH,
  AuditPayloadNotClosedError,
  assertClosedAuditPayload,
  auditPayloadViolations,
  isClosedAuditPayload,
  type AuditPayload,
  type AuditPayloadValue,
  type AuditPayloadViolation,
  type AuditPayloadViolationCode,
} from './audit/payload.js';

export type {
  AuditEventDraft,
  AuditRecorder,
  CheckpointSignature,
  CheckpointSigner,
  OutboxPublication,
  OutboxPublisher,
  PublishedOutboxEvent,
  RecordedAuditEvent,
} from './audit/port.js';

/* ── OPUS-M2-003: effective dating (CAP-013, CAP-058) ─────────────────────────
 *
 * The single implementation of "which row is in force at instant T", and the
 * single window predicate underneath it. Pure functions over plain data, as
 * everything in this package must be — which is what lets the boundary battery
 * enumerate instant-of-change, gap, future-dated and first/last cases without a
 * database, against exactly the code the SQL loader and every writer's
 * precondition check run.
 *
 * It exists because of `docs/evidence/EV-M1-AUTHZ` finding S-01. */
export {
  AmbiguousInForceError,
  ELIGIBLE_HOLDING_STATUSES,
  containsInstant,
  filterInForce,
  isEligibleAt,
  nextWindowStart,
  parseInstant,
  requireInForce,
  selectInForce,
  type EffectiveDated,
  type EligibleHoldingStatus,
  type HoldingLike,
  type InForceSelection,
  type NoRowReason,
} from './profiles/in-force.js';
