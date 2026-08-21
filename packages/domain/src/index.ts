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

/* ── OPUS-M4-000C: the provider/unit-of-work boundary (SPEC-12 U-07, doc 34 §4-H)
 *
 * The DECISION only. The observation that answers "is a transaction open in this
 * async context?" is an `AsyncLocalStorage` in `apps/api/src/db/provider-boundary.ts`,
 * because it is infrastructure and this package imports nothing. */
export {
  ProviderBoundaryNotInstalledError,
  ProviderInsideUnitOfWorkError,
  assertProviderOutsideUnitOfWork,
  providerBoundaryVerdict,
  type ActiveUnitOfWorkMark,
  type ProviderBoundaryProbe,
  type ProviderBoundaryVerdict,
} from './ports/provider-boundary.js';

/* ── OPUS-M4-001: the solver port and the canonical input snapshot ────────────
 *
 * SPEC-04 §§1–2 and §3.4, doc 35 §6a. Interfaces and PURE decisions only — the
 * subprocess, the protocol bytes, the MAC and the kill are all in
 * `apps/api/src/solver/`, because SPEC-04 §1 requires that **no domain module
 * imports the solver or knows it is Python**.
 *
 * Two files, two questions: `solver-port.ts` is "what may I ask, and may I
 * believe the answer?"; `solver-snapshot.ts` is "what is the problem, and is it
 * posable at all?".
 *
 * The barrel addition follows the 000A/000B/000C precedent for `ports/**` — the
 * package exposes exactly one entry point, so a new port is unreachable without
 * it. Additive: no existing export is changed, removed or reordered. */
export {
  DishonestSolverOutcomeError,
  MAX_SOLVER_RESPONSE_BYTES,
  SOLVER_PROTOCOL_VERSION,
  SOLVER_SNAPSHOT_SCHEMA_VERSION,
  SOLVER_STATUSES,
  SUPPORTED_SOLVER_PROTOCOL_VERSIONS,
  SolverResponseRejectedError,
  TERMINATION_REASONS,
  WALL_CLOCK_BINDING_FRACTION,
  isTerminalOutcomeHonest,
  reproducibilityMode,
  resultReproducibility,
  solverResponseVerdict,
  type ResultReproducibility,
  type ResultReproducibilityVerdict,
  type SolveOutcome,
  type SolveRequestSpec,
  type SolverCandidateAssignment,
  type SolverParameters,
  type SolverPort,
  type SolverResponseRefusal,
  type SolverResponseVerdict,
  type SolverRuntimeRecord,
  type SolverStatus,
  type TerminationReason,
} from './ports/solver-port.js';

export {
  SNAPSHOT_CONSTITUENT_KINDS,
  SNAPSHOT_REFUSAL_REASONS,
  SnapshotRefusedError,
  snapshotRefusals,
  type SnapshotConstituent,
  type SnapshotConstituentKind,
  type SnapshotDemandCell,
  type SnapshotEligibility,
  type SnapshotFixedAssignment,
  type SnapshotHolding,
  type SnapshotLocation,
  type SnapshotParticipant,
  /* v2 (OPUS-M4-002, FAD-38) — the three vocabularies RK-RULING-02/03 and
   * CP-SAT modelling of `RequiresQualification` need. Additive. */
  type SnapshotQualification,
  type SnapshotRefusal,
  type SnapshotRefusalReason,
  type SnapshotRevisionExpectation,
  type SnapshotRuleRevision,
  type SnapshotShiftType,
  type SnapshotStaffGroup,
  type SnapshotTimezone,
  type SnapshotValidGroup,
  type SnapshotWeekdayTarget,
  type SnapshotWorkProfile,
  type SolverInputSnapshotDocument,
} from './ports/solver-snapshot.js';

export type { AlertSeverity, AlertSink, OperationalAlert } from './ports/alerts.js';
export type { EnqueuedJob, FrozenJobContext, JobOutcome, JobQueue } from './ports/job-queue.js';
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

/* ── OPUS-M4-000A: the shared eligibility verdict (doc 34 §4-B) ───────────────
 *
 * One pure function answering "may this membership work this shift type at
 * this instant", with the five distinct non-satisfied outcomes the packet
 * requires (expired / future / revoked / retired / missing). Manual
 * scheduling, publication validation, and — from M4-001 — solver input and
 * independent output validation all converge on it. Frozen to M4-000B/C,
 * which consume it read-only (doc 35 §2).
 */
export * from './eligibility/index.js';

/* ── OPUS-M3-002: the typed scheduling-rule AST, validation, serialization, and
 * compiler (CAP-015, CAP-045, CAR-006; SPEC-04 §3) ───────────────────────────
 *
 * The closed node set, the pure field-addressed validation, the deterministic
 * canonical serialization, and the AST→canonical-solver-input compiler with the
 * structural hard/soft invariant. Dependency-free, as everything here must be.
 * There is no solver — building and solving the model is M4 (non-bypass rule 7).
 */
export * from './rules/index.js';

/* ── OPUS-M2-002: the shift-type catalogue's pure rules (CAP-011, CAP-012) ────
 *
 * The closed display-token sets, the derived midnight crossing, the pick-position
 * canonical form and monotonicity rule, and the field-addressed validation the
 * authoring form's `role="alert"` summary is built from. Every rule here is also
 * enforced by migration 0005; the tests assert the two agree rather than assuming
 * it, because a constant and a CHECK that drift produce a save which fails for no
 * visible reason.
 */
export * from './catalogue/index.js';

/* ── OPUS-M4-000B: calendar dates and zone semantics (doc 34 §4-F) ────────────
 *
 * Two new pure modules, exported here because `@schedulepoint/domain` declares
 * a single `"."` entry point and a deep import would not resolve. **Additive
 * only** — no line above this block is touched — which is the same discipline
 * doc 35 §2 puts on the contracts barrel and `apps/api/src/db/schema.ts`. The
 * crossing into this file is reported in the packet's return report rather than
 * made silently (FAD-30).
 *
 *   calendar  real calendar-date validation, replacing the shape-only regex
 *             that accepted 2027-02-29 and 2027-13-01 (doc 34 §4-F)
 *   time      the DST gap ruling (R-B4, forward), the DST fold ruling (R-B5,
 *             start-earliest / end-latest), overnight derivation, and the
 *             UTC+14 / UTC−12 extremes
 */
export * from './calendar/index.js';
export * from './time/index.js';
