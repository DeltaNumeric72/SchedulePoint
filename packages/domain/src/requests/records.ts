/**
 * SPEC-08 §1.1, §1.2 and §5.2 — the shapes of the aggregate root, its six
 * subtype records, and the vacation carriers.
 *
 * ## Two things these types deliberately do NOT do
 *
 * **They do not encode D-20.** `RequestAggregate.status` is the union across
 * every subtype, so `{ subtype: 'shift-preference', status: 'approved' }` — the
 * row SPEC-08 R-03 requires to be refused — type-checks here. Making it a
 * discriminated union over the six domains was considered and rejected: it would
 * put a SECOND copy of D-20 in a place a reader might trust INSTEAD of the CHECK
 * in migration 0021, and the two would drift the first time a status moved. The
 * predicate to ask is `statusIsInSubtypeDomain`; the enforcement is the database.
 *
 * **They do not encode the subtype↔record correspondence as a union either.**
 * `RequestSubtypeRecord` is a discriminated union over the six record shapes and
 * is useful for narrowing what you HAVE, but D-18 — exactly one subtype row per
 * request, of the matching kind — is a `UNIQUE`, a composite foreign key
 * carrying the discriminator, a CHECK, and a deferred constraint trigger. Not a
 * type.
 *
 * ## Dates are plain `string`
 *
 * `target_date`, `week_start` and the period bounds are ISO calendar dates
 * (`YYYY-MM-DD`) and are typed as `string`, not `Date`. A vacation week starting
 * on a Monday is a fact about a calendar, not about an instant, and putting it in
 * a `Date` is how it acquires a timezone it does not have. `calendarDate` in
 * this package validates the spelling where one has to be validated.
 *
 * Instants — `submittedAt`, `expiresAt`, `receivedAt` — are `Date`, because they
 * are instants.
 */

import type {
  RequestPreferenceStrength,
  RequestStatus,
  RequestSubtype,
  VacationApprovalOutcome,
  VacationGrantKind,
  VacationPeriodMode,
  VacationPeriodState,
  VacationSelectionStatus,
} from './subtypes.js';

/**
 * The aggregate root — SPEC-08 §1.1's field list, and only fields common to
 * EVERY subtype.
 *
 * **No nullable subtype field appears here.** That was the defect CAR-011 named:
 * a `shift-preference` row could reach a terminal state with no shift type
 * because the column was nullable for everyone. Every subtype field lives on its
 * own record below.
 */
export interface RequestAggregate {
  readonly id: string;
  readonly organizationId: string;
  readonly groupId: string;
  /** The requester. Withdrawal is requester-initiated only (§4). */
  readonly membershipId: string;
  readonly subtype: RequestSubtype;
  /**
   * For a `vacation-selection` request this is DERIVED from the selection's own
   * status by §5.3's mapping, written in the same transaction, and asserted by
   * D-27. It is not independently authoritative.
   */
  readonly status: RequestStatus;
  readonly submittedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
  readonly withdrawnAt: Date | null;
  /**
   * Server-computed from the group's request-until policy at submission (§3).
   * A client-side deadline is not a deadline, so this is never a value a client
   * supplies.
   */
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  /** §4's `expected_version`: first decision wins, the second gets a conflict. */
  readonly version: number;
  /* ── OPUS-M5-001 (migration 0023) ──────────────────────────────────────────
   * The two facts the lifecycle records that the schema foundation deliberately
   * left until the machinery that reads them existed. */
  /**
   * §3: this submission arrived after the effective deadline and the group's
   * policy is `accept_as_late`. **Never true implicitly** — a `reject` group
   * refuses the submission rather than marking it.
   */
  readonly isLate: boolean;
  /**
   * R-10 / FAD-55: withdrawn while a PUBLISHED version honoured it, so a
   * `ScheduleRevisionRequested` event was raised and a scheduler must decide.
   * The published version itself is never altered (I-18).
   */
  readonly revisionRequested: boolean;
}

/** §1.2 — required `target_date`. The ON request. */
export interface AvailabilityRecord {
  readonly subtype: 'availability';
  readonly requestId: string;
  readonly targetDate: string;
}

/**
 * §1.2 — required `target_date` **or** `(rangeStart, rangeEnd)`, exactly one.
 *
 * The union is what "exactly one" looks like in a type: there is no member with
 * both, and no member with half a range. D-19 is the same statement as a CHECK.
 */
export type TimeOffRecord = {
  readonly subtype: 'time-off';
  readonly requestId: string;
} & (
  | { readonly targetDate: string; readonly rangeStart?: never; readonly rangeEnd?: never }
  | { readonly targetDate?: never; readonly rangeStart: string; readonly rangeEnd: string }
);

/**
 * §1.2 — required `target_date`.
 *
 * No shift type is nameable, and that is the MEANING of the subtype rather than
 * a restriction on it: a no-call request excludes every on-call shift type for
 * the date (doc 06 §3.4).
 */
export interface NoCallRecord {
  readonly subtype: 'no-call';
  readonly requestId: string;
  readonly targetDate: string;
}

/**
 * §1.2 — required `target_date`, **`shiftTypeId`**, `preferenceStrength`.
 *
 * Both required fields are non-optional here and `NOT NULL` in migration 0021.
 * That is the review's named failure closed: a shift preference could previously
 * reach a terminal state with no shift type.
 */
export interface ShiftPreferenceRecord {
  readonly subtype: 'shift-preference';
  readonly requestId: string;
  readonly targetDate: string;
  readonly shiftTypeId: string;
  readonly preferenceStrength: RequestPreferenceStrength;
}

/**
 * §1.2 — required `target_date`, **`shiftGroupId`** (whose `allow_request` is
 * true).
 *
 * The `allow_request` condition is a property of the referenced row, so neither
 * this type nor a foreign key can carry it; migration 0021 enforces it with a
 * trigger.
 */
export interface ShiftGroupOffRecord {
  readonly subtype: 'shift-group-off';
  readonly requestId: string;
  readonly targetDate: string;
  readonly shiftGroupId: string;
}

/**
 * §1.2 and §5.2 — the sixth subtype record, which is also the carrier of the
 * quota and commitment lifecycle (V-27 / FD-9). Required `vacationPeriodId` and
 * `weekStart`.
 *
 * `requestId` is `null` in `available` and only in `available` — §5.3's
 * "*no request row yet* — a selection becomes a request at submission". The
 * database pins the correspondence with a CHECK, so the two cannot come apart.
 */
export interface VacationSelectionRecord {
  readonly subtype: 'vacation-selection';
  readonly id: string;
  readonly requestId: string | null;
  readonly membershipId: string;
  readonly vacationPeriodId: string;
  /** A Monday inside the period. */
  readonly weekStart: string;
  /** **Authoritative.** `requests.status` is derived from this (§5.3). */
  readonly status: VacationSelectionStatus;
  /** V-29 — the SELECTION's own counter. The grant's is a different one. */
  readonly version: number;
  readonly grantId: string | null;
  readonly isOverride: boolean;
  readonly overrideReason: string | null;
  readonly approvalIdempotencyKey: string | null;
  readonly committedToVersionId: string | null;
  readonly commitIdempotencyKey: string | null;
}

/**
 * The six record shapes, discriminated by `subtype` — the same discriminator the
 * root carries and the composite foreign key transports.
 */
export type RequestSubtypeRecord =
  | AvailabilityRecord
  | TimeOffRecord
  | NoCallRecord
  | ShiftPreferenceRecord
  | ShiftGroupOffRecord
  | VacationSelectionRecord;

/**
 * A subtype record as a CALLER supplies it — the same six shapes, without the
 * `request_id` that does not exist yet (OPUS-M5-001).
 *
 * ## A declared correction to the M5-000b port, and why it is a strengthening
 *
 * `NewRequest.record` was typed `RequestSubtypeRecord`, which requires
 * `requestId`. But `RequestStore.create` inserts the ROOT and then the record,
 * so at the moment a caller builds the argument the id does not exist — and the
 * implementation necessarily ignores whatever was supplied and uses the id the
 * insert returned. A required field the implementation must ignore is a field
 * that invites a caller to believe it means something: the obvious reading is
 * "name the request this record belongs to", and a caller who did that would be
 * silently overruled.
 *
 * So the creation shape drops it. Nothing is weakened — the id is still on every
 * record that has been READ, because a stored record does have one — and the
 * one thing that changes is that a request id can no longer be handed to a
 * request that has none.
 *
 * Distributive by construction: the conditional is written over a naked type
 * parameter, so it maps each member of the union rather than collapsing the
 * union into one object. A plain `Omit<RequestSubtypeRecord, 'requestId'>` would
 * have produced a single shape with only the fields all six share, which is
 * exactly the "nullable columns on one table" defect CAR-011 was filed about,
 * reintroduced in the type system.
 */
export type WithoutRequestId<R> = R extends { readonly requestId: string }
  ? Omit<R, 'requestId'>
  : never;

export type NewRequestSubtypeRecord = WithoutRequestId<RequestSubtypeRecord>;

/** A request and its one subtype record, which is what D-18 makes always true. */
export interface Request {
  readonly root: RequestAggregate;
  readonly record: RequestSubtypeRecord;
}

/** §5.2 — the round. Monday to Friday, one mode, one state. */
export interface VacationPeriod {
  readonly id: string;
  readonly organizationId: string;
  readonly groupId: string;
  /** A Monday. */
  readonly startDate: string;
  /** A Friday. */
  readonly endDate: string;
  readonly mode: VacationPeriodMode;
  readonly state: VacationPeriodState;
  readonly version: number;
}

/**
 * §5.2 — the allowance, renamed from `vacation_quotas` (CAR-011 / CAR-020).
 *
 * `membershipId` and `weekStart` are not independently optional: they are what
 * each `kind` MEANS. A personal entitlement is a per-member allowance across the
 * period; a weekly capacity is a per-week ceiling across the group. The database
 * makes the other two combinations unrepresentable.
 *
 * **D-21 is not a property of this type.** `unitsConsumed >= 0` and
 * `unitsConsumed <= unitsTotal + overrideUnits` are two unconditional CHECKs, and
 * the second is expressed against the sum precisely so the audited override can
 * RAISE the bound (V-28) rather than relax a constraint, which a table CHECK
 * cannot do per-caller.
 */
export type VacationGrant = {
  readonly id: string;
  readonly organizationId: string;
  readonly groupId: string;
  readonly vacationPeriodId: string;
  readonly unitsTotal: number;
  readonly unitsConsumed: number;
  /** V-28. Written only by the audited override path of §5.5. */
  readonly overrideUnits: number;
  readonly version: number;
} & (
  | {
      readonly kind: 'personal-entitlement';
      readonly membershipId: string;
      readonly weekStart?: never;
    }
  | { readonly kind: 'weekly-capacity'; readonly membershipId?: never; readonly weekStart: string }
);

/** Narrowing helper for the two grant kinds, so a caller need not re-derive it. */
export function grantKindOf(grant: VacationGrant): VacationGrantKind {
  return grant.kind;
}

/**
 * §5.4 step 0 (V-29) — the approval idempotency ledger row. D-26's subject.
 *
 * The INSERT is the FIRST effect of `APPROVE-VACATION`, before any other. Zero
 * rows inserted means replay: return the recorded outcome, consume no unit, emit
 * no event, write no approval row. `outcome` is `null` while the command is in
 * flight — a row with none is a command whose transaction did not reach its last
 * statement.
 */
export interface VacationApprovalCommand {
  readonly id: string;
  readonly organizationId: string;
  readonly groupId: string;
  readonly selectionId: string;
  readonly approvalIdempotencyKey: string;
  readonly receivedAt: Date;
  readonly outcome: VacationApprovalOutcome | null;
}
