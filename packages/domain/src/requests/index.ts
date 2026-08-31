/**
 * The request aggregate, its six constrained subtypes, and the vacation
 * carriers — SPEC-08 (ADR-0016), as amended 2026-08-01 by V-27..V-31.
 *
 * Types, closed vocabularies, and port signatures. **No transaction, no
 * transition verb, no matrix.** Doc 42 §5b lands the schema and its enforcement
 * BEFORE any lifecycle transaction exists, so the packets that write those
 * transactions build on constraints that are already enforced and already
 * tested rather than on constraints shaped by the first writer's convenience.
 *
 * The enforcement itself is in `apps/api/migrations/0021_request_aggregate_and_subtypes.sql`
 * and `apps/api/migrations/0022_vacation_lifecycle_carriers.sql`. Nothing in this
 * directory enforces anything, and the modules say so where a reader might hope
 * otherwise — D-18, D-19, D-20, D-21 and D-27 are constraints and triggers, and
 * a type that appeared to restate one would be a weaker second copy in a place
 * that invites trust.
 *
 * **Neither port is in the `ports` registry**, deliberately. That registry is
 * enumerable so a port with no implementation is visible; `RequestStore` and
 * `VacationStore` have none yet, and registering them would make the registry
 * assert something untrue. They join it with their implementation, in M5-001.
 */

export {
  EXPIRY_SOURCE_STATUSES,
  REQUEST_PREFERENCE_STRENGTHS,
  REQUEST_STATUSES,
  REQUEST_STATUSES_BY_SUBTYPE,
  REQUEST_SUBTYPES,
  VACATION_APPROVAL_OUTCOMES,
  VACATION_GRANT_KINDS,
  VACATION_PERIOD_MODES,
  VACATION_PERIOD_STATES,
  VACATION_SELECTION_STATUSES,
  VACATION_STATUS_TO_REQUEST_STATUS,
  derivedRequestStatus,
  statusIsInSubtypeDomain,
  type ExpirySourceStatus,
  type RequestPreferenceStrength,
  type RequestStatus,
  type RequestSubtype,
  type VacationApprovalOutcome,
  type VacationGrantKind,
  type VacationPeriodMode,
  type VacationPeriodState,
  type VacationSelectionStatus,
} from './subtypes.js';

export {
  grantKindOf,
  type AvailabilityRecord,
  type NoCallRecord,
  type Request,
  type RequestAggregate,
  type NewRequestSubtypeRecord,
  type RequestSubtypeRecord,
  type WithoutRequestId,
  type ShiftGroupOffRecord,
  type ShiftPreferenceRecord,
  type TimeOffRecord,
  type VacationApprovalCommand,
  type VacationGrant,
  type VacationPeriod,
  type VacationSelectionRecord,
} from './records.js';

export type {
  Approval,
  NewApproval,
  NewRequest,
  NewRequestComment,
  NewVacationSelection,
  RequestComment,
  RequestStore,
  VacationSelectionView,
  VacationStore,
} from './port.js';

/* ── OPUS-M5-001 — the lifecycle half (doc 42 §5c) ──────────────────────────
 *
 * The three modules below are what this directory's header said was NOT here at
 * M5-000b: "No transaction, no transition verb, no matrix." The matrices, the §3
 * deadline policy and the operation cross-product land with the packet that owns
 * them, against a schema whose invariants were already enforced and tested.
 *
 * They remain pure. `packages/domain` imports NOTHING, so there is still no
 * clock, no database handle and no configuration in any of them — a transition
 * matrix that could read something would be one whose answer depended on when
 * you asked, and a deadline calculator with a clock inside it is one you cannot
 * test at a boundary. */

export {
  ACCEPTED_AS_INPUT_SUBTYPES,
  BUILD_CONSUMED_SUBTYPES,
  INITIAL_REQUEST_STATUS_BY_SUBTYPE,
  REQUEST_TRANSITIONS,
  REVIEWED_SUBTYPES,
  initialRequestStatus,
  isLegalInitialStatus,
  legalTransitionsFrom,
  transitionIsLegal,
  type RequestTransition,
} from './transitions.js';

export {
  DEADLINE_ROLLS,
  LATE_SUBMISSION_POLICIES,
  classifySubmission,
  deadlineBindsInStatus,
  deadlineRollExhausted,
  effectiveDeadline,
  isNonWorkingDay,
  rollDeadline,
  type DeadlineRoll,
  type EffectiveDeadline,
  type GroupDeadlinePolicy,
  type LateSubmissionPolicy,
  type RequestUntilPolicy,
  type SubmissionTiming,
} from './deadlines.js';

export {
  DECIDABLE_FROM_STATUSES,
  DECIDABLE_SUBTYPES,
  REQUEST_OPERATIONS,
  REQUEST_REFUSAL_REASONS,
  decisionStatusPath,
  operationIsLegal,
  operationStatusPath,
  operationVerdict,
  withdrawalRequiresRevision,
  type OperationVerdict,
  type RequestOperation,
  type RequestRefusalReason,
} from './lifecycle.js';

/* ── OPUS-M5-002 — §4's decisions and §5.4/§5.5's vacation transaction ───────
 *
 * The two modules below are what `./lifecycle.ts` and `./port.ts` recorded as
 * M5-002's: "approve · deny · batch · the §5.4 `APPROVE-VACATION` transaction".
 * They are pure for the same reason everything else in this directory is —
 * `packages/domain` imports NOTHING — so `./vacation-approval.ts` carries D-21's
 * bound as a predicate and the two-step as a constant, while the transaction
 * that walks them lives in `apps/api`. */

export {
  DECISION_BATCH_MAX_ITEMS,
  DECISION_ITEM_FAILURES,
  DECISION_REASON_MAX_LENGTH,
  REQUEST_DECISIONS,
  decisionReasonIsWellFormed,
  decisionRequiresReason,
  type DecisionAuditFacts,
  type DecisionItemFailure,
  type DecisionItemOutcome,
  type RequestDecision,
} from './decisions.js';

export {
  VACATION_APPROVAL_FAILURES,
  VACATION_APPROVAL_ROOT_PATH,
  VACATION_DENIAL_ROOT_PATH,
  approvalConsumesQuota,
  countersAfterReversal,
  grantBound,
  grantHasHeadroom,
  grantVariance,
  overrideUnitsNeeded,
  reversalKeepsFloor,
  type GrantCounters,
  type GrantVariance,
  type VacationApprovalFailure,
} from './vacation-approval.js';

/* ── OPUS-M5-003 — §5's SUBMISSION side (doc 42 §5f) ─────────────────────────
 *
 * §5.3's own lifecycle, the mapping read in both directions (R-15), and the
 * order a selection list is presented in. The approval side above and this one
 * share one table and one set of statuses; neither restates the other. */

export {
  VACATION_SELECTION_OPERATIONS,
  VACATION_SELECTION_REFUSAL_REASONS,
  VACATION_SELECTION_TRANSITIONS,
  compareSelectionsForDisplay,
  orderSelectionsForDisplay,
  selectionEdgeRootPath,
  selectionOperationIsLegal,
  selectionOperationVerdict,
  selectionStatusForRootStatus,
  selectionTransitionIsLegal,
  vacationStatusPairAgrees,
  vacationWeekDates,
  type SelectionOrderKey,
  type VacationSelectionOperation,
  type VacationSelectionRefusalReason,
  type VacationSelectionVerdict,
} from './vacation-selection.js';

/* ── OPUS-M5-00C — §4's fifth row, comments (doc 42 §5g, FAD-58) ─────────────
 *
 * The vocabulary and the exactly-one-of rule that keeps the two channels apart.
 * Pure like everything else here — migration 0026's CHECKs are the independent
 * second copy, and `apps/api/src/requests/comments.ts` is the transaction. */

export {
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_CHANNELS,
  COMMENT_REFUSAL_REASONS,
  REQUEST_REASON_CODES,
  commentBodyIsWellFormed,
  commentContentIsWellFormed,
  isRequestReasonCode,
  type CommentAuditFacts,
  type CommentChannel,
  type CommentContent,
  type CommentContentVerdict,
  type CommentRefusalReason,
  type RequestReasonCode,
} from './comments.js';

/* ── OPUS-M5-004 — §6's solver projection (doc 42 §5h, FAD-60) ───────────────
 *
 * The membership rule the solver's problem is built from, and FAD-60's weight
 * table. Pure like everything else here: the assembly that reads the rows lives
 * in `apps/api/src/solver/canonical-input.ts`, and the rule about WHICH rows
 * exist lives here so it can be checked against §6 without a database. */

export {
  PROJECTED_STATUSES,
  PROJECTION_EXCLUDED_STATUSES,
  PROJECTION_RULE,
  REQUEST_PROJECTION_KINDS,
  SOFT_PREFERENCE_WEIGHTS,
  entersProjection,
  projectionDisposition,
  softPreferenceWeight,
  type HardOffProjectionRow,
  type HardOnProjectionRow,
  type RequestProjection,
  type RequestProjectionKind,
  type ShiftGroupOffProjectionRow,
  type SoftPreferenceProjectionRow,
} from './solver-projection.js';

/* ── OPUS-M5-004 — §5.6's commit and reversal (doc 42 §5h, FAD-59) ───────────
 *
 * The two closed failure vocabularies and the draft-only rule, pure. The
 * transaction is `apps/api/src/requests/vacation-commit.ts`; FAD-59's ledger is
 * migration 0027. */

export {
  COMMITTABLE_VERSION_STATES,
  REVERSAL_REASON_MAX_LENGTH,
  VACATION_COMMIT_FAILURES,
  VACATION_REVERSAL_FAILURES,
  reversalReasonIsWellFormed,
  versionAcceptsCommit,
  type VacationCommitFailure,
  type VacationReversalFailure,
} from './vacation-commit.js';
