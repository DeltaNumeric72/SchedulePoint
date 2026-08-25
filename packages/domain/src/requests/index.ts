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
  type RequestSubtypeRecord,
  type ShiftGroupOffRecord,
  type ShiftPreferenceRecord,
  type TimeOffRecord,
  type VacationApprovalCommand,
  type VacationGrant,
  type VacationPeriod,
  type VacationSelectionRecord,
} from './records.js';

export type {
  NewRequest,
  NewVacationSelection,
  RequestStore,
  VacationStore,
} from './port.js';
