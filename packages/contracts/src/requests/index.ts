import { z } from 'zod';

import { uuidSchema } from '../identifiers.js';
import { calendarDateSchema } from '../schedule/calendar-date.js';

/**
 * The request aggregate and vacation lifecycle on the wire (OPUS-M5-000b;
 * SPEC-08 §1, §2, §5, as amended 2026-08-01 by V-27..V-31).
 *
 * ## The six subtypes are a DISCRIMINATED UNION, and that is the whole design
 *
 * CAR-011's finding was one table with nullable subtype columns, in which a
 * `shift-preference` could reach a terminal state with no shift type because the
 * column was nullable for everyone. The wire shape reproduces the fix rather
 * than the defect: `requestRecordSchema` is a discriminated union on `subtype`,
 * so a shift preference **without** `shiftTypeId` does not parse, and a
 * `no-call` **with** one does not parse either. §1.2's prohibited fields are
 * absent from their members, exactly as they are absent from their tables.
 *
 * ## `.strict()` on every object
 *
 * A positive allowlist, per this package's standing rule. An unknown key is
 * rejected rather than carried — which matters more here than almost anywhere
 * else in the package, because these bodies are `SENSITIVE-PII` (doc 06 §3.4)
 * and a carried key is a field nobody classified.
 *
 * ## What is NOT here, and why the omissions are load-bearing
 *
 *  - **No transition request shape.** No `setStatus`, no `{ from, to }`. Every
 *    status change is a per-subtype transition (§2), and a body that carried a
 *    target status would be a way to move a request without consulting the
 *    matrix. Those bodies land with the packets that own the matrices — M5-001
 *    for submit/withdraw/expire, M5-002 for approve/deny, M5-004 for
 *    commit/reverse. *(The sentence that stood here — "this packet ships no
 *    routes at all (doc 42 §5b)" — was M5-000b's and went stale the moment
 *    OPUS-M5-001 added the submit/withdraw/list/deadline schemas below and the
 *    routes that parse them. Corrected rather than deleted, because the shape it
 *    described is still true of the APPROVAL and COMMIT bodies: those have no
 *    HTTP boundary yet.)*
 *  - **No free-text field except `overrideReason`**, which is a scheduler-
 *    authored administrative note bounded at 1000 characters, of the same class
 *    as `changeSummary` on a schedule version. It is not an ingestion path and
 *    never enters an audit payload; the closed-payload rule (ADR-0019) would
 *    reject free text there. There is no comment body here — §4's comments are
 *    M5-002's surface. *(Corrected by date, 2026-08-27: M5-002 ESCALATED §4's
 *    comments to a packet of their own rather than squeezing them in, and
 *    OPUS-M5-00C lands them under FAD-58. The clause "no free-text field except
 *    `overrideReason`" is superseded by exactly ONE addition —
 *    `appendSchedulerCommentSchema`'s `body`, which is the same
 *    scheduler-authored administrative class with the same 1000-character
 *    bound. The REQUESTER side gained no text field and never will: FAD-58.1
 *    rules the requester channel a controlled vocabulary permanently. The
 *    original sentence is kept because it is the reason the shapes below are
 *    shaped the way they are.)*
 *  - **`isLate` and `revisionRequested` ARE carried** (OPUS-M5-001). This entry
 *    previously read "**No `isLate`**" on the M5-000b reasoning that SPEC-08
 *    §1.1 supersedes doc 06 §3.4 for the root and does not carry it — true then,
 *    and false the moment the machinery that decides it landed. Both fields are
 *    on `requestAggregateSchema` below, because both are facts a REQUESTER needs
 *    to see: whether their submission counted as late (§3), and whether taking a
 *    request back has put a published schedule in question (R-10). The original
 *    reasoning is kept rather than erased — it is why the fields were absent
 *    until a packet could decide them.
 *
 * ## The enums are duplicated from `@schedulepoint/domain`, deliberately
 *
 * This package may import zod and nothing else (`.dependency-cruiser.cjs` rule
 * `contracts-imports-only-zod`). Two copies of a closed set are two truths that
 * can drift, so they are not left to agree by inspection — the api test suite
 * asserts these enums equal the domain's constants AND the database's CHECK
 * domains, which is the same discipline the shift-type catalogue already uses.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Closed vocabularies
 * ──────────────────────────────────────────────────────────────────────────── */

/** §1, V-27 / FD-9 — six, of which `vacation-selection` is the sixth. */
export const requestSubtypeSchema = z.enum([
  'availability',
  'time-off',
  'no-call',
  'shift-preference',
  'shift-group-off',
  'vacation-selection',
]);
export type RequestSubtypeWire = z.infer<typeof requestSubtypeSchema>;

/**
 * The union across every subtype — **not** a per-subtype domain and **not** a
 * state machine.
 *
 * D-20's per-subtype domains are a CHECK in migration 0021 and a constant in
 * `@schedulepoint/domain`; this enum is deliberately the wider set, because a
 * response body carries whatever status a row holds and narrowing it here would
 * put a third copy of D-20 in the layer least able to enforce it.
 *
 * `applied` is absent. It meant three different things and was split into
 * `consumed_by_build` (a solver run took this as input — says nothing about the
 * outcome), `reflected_in_version` (a published version honours it) and
 * `unsatisfied` (consumed, not honoured — a normal outcome for a soft
 * preference, and **not** a denial).
 */
export const requestStatusSchema = z.enum([
  'draft',
  'submitted',
  'under_review',
  'accepted_as_input',
  'approved',
  'denied',
  'withdrawn',
  'consumed_by_build',
  'reflected_in_version',
  'unsatisfied',
  'reversed',
  'expired',
  'superseded_by_revision',
]);
export type RequestStatusWire = z.infer<typeof requestStatusSchema>;

/** §1.2 / §6 — an ordered strength, closed so no unweighable value arrives. */
export const requestPreferenceStrengthSchema = z.enum(['low', 'medium', 'high']);
export type RequestPreferenceStrengthWire = z.infer<typeof requestPreferenceStrengthSchema>;

/** §5.3 — **the authoritative** vacation status. The root's is derived from it. */
export const vacationSelectionStatusSchema = z.enum([
  'available',
  'pending',
  'approved',
  'committed',
  'denied',
  'withdrawn',
  'expired',
  'reversed',
]);
export type VacationSelectionStatusWire = z.infer<typeof vacationSelectionStatusSchema>;

/** §5.2 / §5.5 (V-30) — `open` has no grant rows, and that is not an error. */
export const vacationPeriodModeSchema = z.enum(['quota', 'open']);
export type VacationPeriodModeWire = z.infer<typeof vacationPeriodModeSchema>;

export const vacationPeriodStateSchema = z.enum(['draft', 'open', 'closed', 'archived']);
export type VacationPeriodStateWire = z.infer<typeof vacationPeriodStateSchema>;

/** §5.2 — what a grant is a grant OF. */
export const vacationGrantKindSchema = z.enum(['personal-entitlement', 'weekly-capacity']);
export type VacationGrantKindWire = z.infer<typeof vacationGrantKindSchema>;

/** §5.4 (V-29) — the recorded outcome of an approval command. */
export const vacationApprovalOutcomeSchema = z.enum([
  'approved',
  'denied',
  'quota_exhausted',
  'version_conflict',
  'selection_not_pending',
]);
export type VacationApprovalOutcomeWire = z.infer<typeof vacationApprovalOutcomeSchema>;

/**
 * The idempotency-key shape, matching migration 0021's CHECK character for
 * character. A key the database will refuse should not reach it.
 */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/, 'an idempotency key is 1..64 of [A-Za-z0-9_.-]');

/* ────────────────────────────────────────────────────────────────────────────
 * §1.2 — the six subtype records
 *
 * Each member carries its REQUIRED fields and its optional ones, and no member
 * carries a field §1.2 prohibits for it. `.strict()` is what turns that
 * absence into a rejection rather than a silently discarded key.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Required `targetDate`. */
export const availabilityRecordSchema = z
  .object({
    subtype: z.literal('availability'),
    targetDate: calendarDateSchema,
  })
  .strict();
export type AvailabilityRecordWire = z.infer<typeof availabilityRecordSchema>;

/**
 * Required `targetDate` **or** `(rangeStart, rangeEnd)` — exactly one.
 *
 * A union of the two admissible shapes rather than three optional fields with a
 * refinement, so the half-stated range (`rangeStart` with no `rangeEnd`) is
 * unrepresentable rather than caught. D-19 says the same thing as a CHECK, and
 * the range ordering — `rangeEnd >= rangeStart` — is the one part that needs a
 * refinement because it relates two values.
 */
export const timeOffRecordSchema = z.union([
  z
    .object({
      subtype: z.literal('time-off'),
      targetDate: calendarDateSchema,
    })
    .strict(),
  z
    .object({
      subtype: z.literal('time-off'),
      rangeStart: calendarDateSchema,
      rangeEnd: calendarDateSchema,
    })
    .strict()
    .refine((value) => value.rangeEnd >= value.rangeStart, {
      message: 'a time-off range ends on or after it starts',
      path: ['rangeEnd'],
    }),
]);
export type TimeOffRecordWire = z.infer<typeof timeOffRecordSchema>;

/**
 * Required `targetDate`, and **no shift type is nameable** — that is the meaning
 * of the subtype (it excludes every on-call shift type for the date), not a
 * restriction on it.
 */
export const noCallRecordSchema = z
  .object({
    subtype: z.literal('no-call'),
    targetDate: calendarDateSchema,
  })
  .strict();
export type NoCallRecordWire = z.infer<typeof noCallRecordSchema>;

/**
 * Required `targetDate`, **`shiftTypeId`**, `preferenceStrength`.
 *
 * These two required fields are the review's named failure closed on the wire:
 * a body without a shift type does not parse, so the row that could previously
 * reach a terminal state with none cannot be requested in the first place.
 */
export const shiftPreferenceRecordSchema = z
  .object({
    subtype: z.literal('shift-preference'),
    targetDate: calendarDateSchema,
    shiftTypeId: uuidSchema,
    preferenceStrength: requestPreferenceStrengthSchema,
  })
  .strict();
export type ShiftPreferenceRecordWire = z.infer<typeof shiftPreferenceRecordSchema>;

/**
 * Required `targetDate`, **`shiftGroupId`**.
 *
 * §1.2 adds "whose `allow_request` is true", which is a property of the
 * referenced row and therefore not decidable here. Migration 0021 enforces it
 * with a trigger; this schema decides shape, which is all a schema can honestly
 * decide.
 */
export const shiftGroupOffRecordSchema = z
  .object({
    subtype: z.literal('shift-group-off'),
    targetDate: calendarDateSchema,
    shiftGroupId: uuidSchema,
  })
  .strict();
export type ShiftGroupOffRecordWire = z.infer<typeof shiftGroupOffRecordSchema>;

/**
 * Required `vacationPeriodId` and `weekStart` (§1.2, V-27 / FD-9).
 *
 * "which must fall inside the period" is likewise a cross-row condition and is a
 * trigger in migration 0022, not a refinement here.
 */
export const vacationSelectionRecordSchema = z
  .object({
    subtype: z.literal('vacation-selection'),
    vacationPeriodId: uuidSchema,
    weekStart: calendarDateSchema,
  })
  .strict();
export type VacationSelectionRecordWire = z.infer<typeof vacationSelectionRecordSchema>;

/**
 * The six, discriminated by `subtype` — the same discriminator the root carries
 * and the composite foreign key transports.
 *
 * `z.union` rather than `z.discriminatedUnion`, because `timeOffRecordSchema` is
 * itself a union and zod's discriminated union takes object schemas only.
 * The discrimination is unaffected: every member fixes `subtype` to a literal,
 * so exactly one can match.
 */
export const requestRecordSchema = z.union([
  availabilityRecordSchema,
  timeOffRecordSchema,
  noCallRecordSchema,
  shiftPreferenceRecordSchema,
  shiftGroupOffRecordSchema,
  vacationSelectionRecordSchema,
]);
export type RequestRecordWire = z.infer<typeof requestRecordSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * §1.1 — the aggregate root, and the request-and-record pair
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The root as a client sees it. Only fields common to EVERY subtype, which is
 * the whole of CAR-011's remediation in one sentence.
 */
export const requestAggregateSchema = z
  .object({
    id: uuidSchema,
    membershipId: uuidSchema,
    subtype: requestSubtypeSchema,
    status: requestStatusSchema,
    submittedAt: z.string().datetime().nullable(),
    decidedAt: z.string().datetime().nullable(),
    decidedBy: uuidSchema.nullable(),
    withdrawnAt: z.string().datetime().nullable(),
    /** Server-computed at submission (§3). Never client-supplied. */
    expiresAt: z.string().datetime(),
    idempotencyKey: idempotencyKeySchema,
    version: z.number().int().positive(),
    /* ── OPUS-M5-001 (migration 0023) ────────────────────────────────────────
     * The two lifecycle facts the schema foundation withheld until the
     * machinery that reads them existed. Both are on the wire because both are
     * things a requester needs to SEE: whether their submission counted as
     * late, and whether taking a request back has put a published schedule in
     * question. */
    /** §3: accepted after the effective deadline, where group policy permits. */
    isLate: z.boolean(),
    /** R-10: withdrawn after a published version honoured it; a revision was asked for. */
    revisionRequested: z.boolean(),
  })
  .strict();
export type RequestAggregateWire = z.infer<typeof requestAggregateSchema>;

/** A request and its ONE subtype record, which D-18 makes always true. */
export const requestSchema = z
  .object({
    root: requestAggregateSchema,
    record: requestRecordSchema,
  })
  .strict();
export type RequestWire = z.infer<typeof requestSchema>;

/**
 * What a client sends to create a request.
 *
 * `expiresAt` is absent on purpose and its absence is the contract: §3 says the
 * deadline is computed server-side from the group's policy, and "a client-side
 * deadline is not a deadline". A body that could carry one would be a body that
 * could set its own.
 */
export const createRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    record: requestRecordSchema,
  })
  .strict();
export type CreateRequest = z.infer<typeof createRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-001 — the lifecycle wire surface (SPEC-08 §§3–4)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a client sends to SUBMIT.
 *
 * ## One body, one action, one row (I-10, I-13)
 *
 * There is no separate "create draft" body and no `POST …/requests/:id/submit`.
 * A staff member pressing Submit performs ONE action, so it produces ONE request
 * (I-10) — and nothing is persisted before that completed, validated body
 * arrives (I-13: no control labelled Add, New or Create may persist anything
 * before an explicit Save). The `draft` status the row is born at exists inside
 * the server's transaction and is never a state a client has seen or can address.
 *
 * `periodStart` is optional because it is only MEANINGFUL under the group's
 * `days_before_period_start` request-until mode, where the deadline is relative
 * to the schedule period the request is for. It is not a deadline and cannot be
 * used as one: the server computes `expiresAt` from the group's own policy, and
 * a `periodStart` a group's mode does not read is ignored entirely.
 */
export const submitRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    record: requestRecordSchema,
    /** The schedule period the request is for. Read only under `days_before_period_start`. */
    periodStart: calendarDateSchema.optional(),
  })
  .strict();
export type SubmitRequest = z.infer<typeof submitRequestSchema>;

/**
 * What a client sends to WITHDRAW.
 *
 * `expectedVersion` and nothing else. §4's conditional-update rule is stated for
 * decisions — "first decision wins, the second gets an explicit conflict, never
 * a silent overwrite" — and it is not weaker for a withdrawal: two tabs open on
 * the same request must not both succeed.
 *
 * **There is deliberately no `reason`.** Withdrawal is requester-initiated (§4)
 * and a person taking back their own request owes nobody an explanation; an
 * administrator "withdrawing" for somebody is a DENIAL with a mandatory reason,
 * which is a different operation, on a different key, in M5-002. Adding an
 * optional reason here would blur exactly the line §4 draws — and would put new
 * bounded free text on a SENSITIVE-PII aggregate, which is a question this
 * packet deliberately does not open.
 */
export const withdrawRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type WithdrawRequest = z.infer<typeof withdrawRequestSchema>;

/** What a withdrawal returns: the new version, and whether R-10 fired. */
export const withdrawRequestResultSchema = z
  .object({
    requestId: uuidSchema,
    version: z.number().int().positive(),
    /**
     * R-10: a published version already honoured this request, so a
     * `ScheduleRevisionRequested` event was raised. **The published version is
     * unchanged** — this is a request for the scheduler to act, not a report
     * that anything was reverted.
     */
    revisionRequested: z.boolean(),
  })
  .strict();
export type WithdrawRequestResult = z.infer<typeof withdrawRequestResultSchema>;

/** A member's own requests, newest first. */
export const requestListSchema = z.object({ requests: z.array(requestSchema) }).strict();
export type RequestList = z.infer<typeof requestListSchema>;

/**
 * §3's effective deadline, as a client may read it.
 *
 * Both dates are carried, and the pair is the point: `nominal` is what the
 * group's policy names and `effective` is where the roll moved it to. A surface
 * showing only the effective date cannot explain why "requests close on the
 * 15th" is showing the 14th, and "the deadline is Friday" being ambiguous when
 * Friday is a holiday is the exact ambiguity §3's roll policy exists to remove.
 */
export const requestDeadlineSchema = z.union([
  z.object({ kind: z.literal('closed') }).strict(),
  z
    .object({
      kind: z.literal('dated'),
      nominal: calendarDateSchema,
      effective: calendarDateSchema,
      rolled: z.boolean(),
    })
    .strict(),
]);
export type RequestDeadlineWire = z.infer<typeof requestDeadlineSchema>;

/**
 * §3's late-submission refusal, **which states the effective deadline**.
 *
 * > Late submission — Rejected with the effective deadline stated, **or**
 * > accepted into `submitted` with `is_late = true` where group policy permits.
 *
 * The date is on the wire because §3 puts it there, and because a refusal that
 * will not say what the deadline was is a refusal the requester cannot act on.
 * This is deliberately NOT the fixed error envelope, for the same reason
 * `validationProblemBodySchema` is not: the envelope carries no detail, and here
 * the detail IS the remedy.
 *
 * `effective` is null for `WINDOW_CLOSED` — a closed window has no date at all,
 * which is exactly the distinction migration 0010 kept `closed` separate from an
 * absent date to preserve. Reporting some date for it would invent one.
 */
export const requestDeadlineRefusalBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum(['REQUEST_WINDOW_CLOSED', 'REQUEST_SUBMISSION_LATE']),
        message: z.string().min(1),
        correlationId: z.string().min(1),
        effectiveDeadline: calendarDateSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type RequestDeadlineRefusalBody = z.infer<typeof requestDeadlineRefusalBodySchema>;

/**
 * The refusal for an operation §2's matrix does not permit from the row's
 * current status — R-22's "rejected after `consumed_by_build`", and R-23's two
 * named illegal expiries reached from an API rather than from SQL.
 *
 * The CURRENT status is carried, and nothing else about the row. A requester
 * told only "no" cannot tell "somebody already decided this" from "a build has
 * consumed it and it is too late" — two situations with different remedies. The
 * status is a closed vocabulary, not free text, so it discloses nothing beyond
 * what the requester's own list already shows them.
 */
export const requestIllegalOperationBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('REQUEST_OPERATION_ILLEGAL'),
        message: z.string().min(1),
        correlationId: z.string().min(1),
        status: requestStatusSchema,
      })
      .strict(),
  })
  .strict();
export type RequestIllegalOperationBody = z.infer<typeof requestIllegalOperationBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * §5 — the vacation carriers
 * ──────────────────────────────────────────────────────────────────────────── */

/** §5.2 — the round. Monday to Friday. */
export const vacationPeriodSchema = z
  .object({
    id: uuidSchema,
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    mode: vacationPeriodModeSchema,
    state: vacationPeriodStateSchema,
    version: z.number().int().positive(),
  })
  .strict();
export type VacationPeriodWire = z.infer<typeof vacationPeriodSchema>;

/**
 * §5.2 — the allowance.
 *
 * A union over the two kinds rather than one object with two optional fields:
 * `membershipId` and `weekStart` are what each kind MEANS, and the three
 * meaningless combinations are unrepresentable here exactly as they are
 * unrepresentable in the table.
 *
 * `unitsConsumed`, `unitsTotal` and `overrideUnits` are all carried because a
 * client showing a variance indicator needs all three: D-21's bound is
 * `unitsConsumed <= unitsTotal + overrideUnits`, and a surface given only the
 * first two would show an over-quota grant as a violation rather than as the
 * audited override it is.
 */
const vacationGrantCommon = {
  id: uuidSchema,
  vacationPeriodId: uuidSchema,
  unitsTotal: z.number().int().nonnegative(),
  unitsConsumed: z.number().int().nonnegative(),
  overrideUnits: z.number().int().nonnegative(),
  version: z.number().int().positive(),
};

export const vacationGrantSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...vacationGrantCommon,
      kind: z.literal('personal-entitlement'),
      membershipId: uuidSchema,
    })
    .strict(),
  z
    .object({
      ...vacationGrantCommon,
      kind: z.literal('weekly-capacity'),
      weekStart: calendarDateSchema,
    })
    .strict(),
]);
export type VacationGrantWire = z.infer<typeof vacationGrantSchema>;

/**
 * §5.2 — the selection, which is also the sixth subtype record.
 *
 * `requestId` is nullable because §5.3's `available` row means "*no request row
 * yet* — a selection becomes a request at submission". The database pins the
 * correspondence with a CHECK; the wire shape carries the null so a client can
 * render an unsubmitted week without inventing an id.
 */
export const vacationSelectionSchema = z
  .object({
    id: uuidSchema,
    requestId: uuidSchema.nullable(),
    membershipId: uuidSchema,
    vacationPeriodId: uuidSchema,
    weekStart: calendarDateSchema,
    status: vacationSelectionStatusSchema,
    version: z.number().int().positive(),
    grantId: uuidSchema.nullable(),
    isOverride: z.boolean(),
    /** §5.5's mandatory reason when `isOverride`. Bounded, like a change summary. */
    overrideReason: z.string().min(1).max(1000).nullable(),
    committedToVersionId: uuidSchema.nullable(),
  })
  .strict()
  /**
   * §5.5: the override "requires an explicit override capability and a MANDATORY
   * reason". The capability is the server's to check; the reason's presence is
   * decidable here, in both directions — neither an unexplained override nor a
   * reason attached to a non-override parses.
   */
  .refine((value) => value.isOverride === (value.overrideReason !== null), {
    message: 'an override states its reason, and a non-override states none',
    path: ['overrideReason'],
  });
export type VacationSelectionWire = z.infer<typeof vacationSelectionSchema>;

/**
 * §5.4 step 0 (V-29) — the approval idempotency ledger row, D-26's subject.
 *
 * `outcome` is nullable because the row is written BEFORE any effect and the
 * outcome is stamped by the transaction's last statement. A row with none is a
 * command whose transaction did not reach it.
 */
export const vacationApprovalCommandSchema = z
  .object({
    id: uuidSchema,
    selectionId: uuidSchema,
    approvalIdempotencyKey: idempotencyKeySchema,
    receivedAt: z.string().datetime(),
    outcome: vacationApprovalOutcomeSchema.nullable(),
  })
  .strict();
export type VacationApprovalCommandWire = z.infer<typeof vacationApprovalCommandSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-002 — §4's decisions, and §5.4's vacation approval
 *
 * The `approve`/`deny` bodies this file's header said "have no HTTP boundary
 * yet". They have one now, and the header's REASON for the absence is what these
 * shapes satisfy: there is still no `setStatus` and no `{ from, to }`. A decision
 * body names the DECISION and the version it expects, and the server derives the
 * status path from §2's matrix — a body that carried a target status would be a
 * way to move a request without consulting it.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * §4's decision reason — scheduler-authored bounded free text.
 *
 * The same class and the same bound as `overrideReason` above and
 * `changeSummary` on a schedule version. **It is stored on the decision row and
 * goes nowhere else**: not into an audit payload, not into an outbox payload, not
 * into a notification (I-07, ADR-0019, non-bypass rules 8 and 9). The closed
 * payload rule would reject it anyway — a payload string may not contain a space
 * — which is a property the api suite proves in both layers rather than a promise
 * made here.
 *
 * It is not an ingestion path and it is not clinical. `.min(1)` after trimming is
 * migration 0024's `length(btrim(reason)) BETWEEN 1 AND 1000` on the wire, so a
 * reason of pure whitespace is refused before it reaches a constraint.
 */
export const decisionReasonSchema = z
  .string()
  .trim()
  .min(1, 'a decision reason says something')
  .max(1000, 'a decision reason is at most 1000 characters');

/**
 * What a client sends to APPROVE one request.
 *
 * `expectedVersion` and nothing else. §4: "conditional update on
 * `expected_version`; **first decision wins**, the second gets an explicit
 * conflict — never a silent overwrite."
 *
 * **There is deliberately no `reason`**, and the absence is the rule rather than
 * an omission: §4 makes a reason mandatory on a DENIAL and §5.5 on an override,
 * and neither asks for one on an ordinary approval. An optional note here would
 * be new bounded free text on a `SENSITIVE-PII` aggregate that no specification
 * asks for, and migration 0024's CHECK refuses it in that direction too.
 */
export const approveRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type ApproveRequest = z.infer<typeof approveRequestSchema>;

/**
 * What a client sends to DENY one request — the version, and the MANDATORY
 * reason (§4).
 *
 * §4's other sentence is what makes this the administrator's only way to end
 * somebody else's request: "an administrator 'withdrawing' for someone is a
 * **denial with a reason**, recorded as such". `requests.own.withdraw` carries no
 * ownership override precisely so that this is the only door.
 */
export const denyRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: decisionReasonSchema,
  })
  .strict();
export type DenyRequest = z.infer<typeof denyRequestSchema>;

/**
 * What a client sends to REVERSE an approval (§4's reversal row).
 *
 * A reason is mandatory here for the reason it is mandatory on a denial: this
 * takes back something a person was told they had. The prior decision is not
 * named in the body — the server finds it, because a client naming which decision
 * it believes it is reversing would be a client that could name the wrong one.
 */
export const reverseDecisionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: decisionReasonSchema,
  })
  .strict();
export type ReverseDecision = z.infer<typeof reverseDecisionSchema>;

/** One decision, as a client reads it back. §4's history is a list of these. */
export const approvalSchema = z
  .object({
    id: uuidSchema,
    requestId: uuidSchema,
    decision: z.enum(['approved', 'denied', 'reversed']),
    decidedBy: uuidSchema,
    decidedAt: z.string().datetime(),
    /** Present exactly when §4 or §5.5 makes it mandatory. */
    reason: z.string().min(1).max(1000).nullable(),
    isOverride: z.boolean(),
    vacationSelectionId: uuidSchema.nullable(),
    /** A reversal names what it reverses; nothing else does. */
    supersedesApprovalId: uuidSchema.nullable(),
  })
  .strict();
export type ApprovalWire = z.infer<typeof approvalSchema>;

/** What a single decision returns. */
export const decisionResultSchema = z
  .object({
    requestId: uuidSchema,
    decision: z.enum(['approved', 'denied', 'reversed']),
    status: requestStatusSchema,
    version: z.number().int().positive(),
    approvalId: uuidSchema,
  })
  .strict();
export type DecisionResultWire = z.infer<typeof decisionResultSchema>;

/**
 * The refusal for a decision that could not be made.
 *
 * A closed `code`, because a caller must be able to branch. `VERSION_CONFLICT` is
 * §4's loser and means reload-and-retry; `REQUEST_OPERATION_ILLEGAL` means
 * somebody already decided this and there is nothing to retry;
 * `DECISION_REASON_REQUIRED` means the body was incomplete; and
 * `SUBTYPE_NOT_DECIDABLE` means the request is decided somewhere else — a shift
 * preference is never approved at all (§2.1), and a vacation selection goes
 * through §5.4's transaction (§5.3's one writer).
 */
export const decisionRefusalBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          'VERSION_CONFLICT',
          'REQUEST_OPERATION_ILLEGAL',
          'DECISION_REASON_REQUIRED',
          'SUBTYPE_NOT_DECIDABLE',
        ]),
        message: z.string().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type DecisionRefusalBody = z.infer<typeof decisionRefusalBodySchema>;

/* ── the batch ──────────────────────────────────────────────────────────────── */

/**
 * What a client sends to decide MANY requests at once.
 *
 * One `decision` and one `reason` for the whole batch, and a list of
 * `(requestId, expectedVersion)` pairs. Per-item reasons are deliberately not
 * offered: a scheduler denying twenty requests has ONE reason, and twenty boxes
 * get filled with the same sentence or with nothing. The one reason is stored on
 * every one of the twenty decision rows, so each still carries its explanation
 * when read back alone.
 *
 * The bound is 100, matching `DECISION_BATCH_MAX_ITEMS`. A batch decision is ONE
 * user action (I-10), and the bound keeps one action from holding row locks
 * proportional to how many rows somebody selected.
 */
export const batchDecisionSchema = z
  .object({
    decision: z.enum(['approved', 'denied']),
    reason: decisionReasonSchema.nullable().default(null),
    items: z
      .array(
        z
          .object({
            requestId: uuidSchema,
            expectedVersion: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1, 'a batch decides at least one request')
      .max(100, 'a batch decides at most 100 requests'),
  })
  .strict();
export type BatchDecision = z.infer<typeof batchDecisionSchema>;

/**
 * The batch's answer: **one outcome per item, in the order sent**.
 *
 * A partial failure is per-item and never all-or-nothing silent (doc 42 §5d Part
 * C). The union is discriminated on `ok`, so a client cannot read a `version` off
 * a failed item, and `failure` is a closed vocabulary rather than a message.
 */
export const decisionItemOutcomeSchema = z.union([
  z
    .object({
      requestId: uuidSchema,
      ok: z.literal(true),
      decision: z.enum(['approved', 'denied', 'reversed']),
      status: requestStatusSchema,
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      requestId: uuidSchema,
      ok: z.literal(false),
      failure: z.enum([
        'not-found',
        'illegal-operation',
        'version-conflict',
        'reason-required',
        'subtype-not-decidable-here',
      ]),
    })
    .strict(),
]);
export type DecisionItemOutcomeWire = z.infer<typeof decisionItemOutcomeSchema>;

export const batchDecisionResultSchema = z
  .object({ outcomes: z.array(decisionItemOutcomeSchema) })
  .strict();
export type BatchDecisionResult = z.infer<typeof batchDecisionResultSchema>;

/* ── the queue and the detail read ──────────────────────────────────────────── */

/** The scheduler's pending-review queue — requests plus their decision history. */
export const requestQueueSchema = z.object({ requests: z.array(requestSchema) }).strict();
export type RequestQueue = z.infer<typeof requestQueueSchema>;

/* ════════════════════════════════════════════════════════════════════════════
 * OPUS-M5-00C — SPEC-08 §4's FIFTH row: COMMENTS, under FAD-58
 *
 * The header of this file says, of the M5-000b vintage: "**No free-text field
 * except `overrideReason`** … There is no comment body here — §4's comments are
 * M5-002's surface." M5-002 ESCALATED them out rather than squeezing them in,
 * FAD-58 ruled, and this block is that ruling on the wire. The header sentence
 * is left standing because it is the reason the shapes below look the way they
 * do, and because its second clause was corrected by date rather than by
 * deletion: the surface is M5-00C's.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * **FAD-58.1's controlled vocabulary — a `SCHEDULEPOINT-REQUIREMENT`, not an
 * observed fact, extensible only by a recorded decision.**
 *
 * ## Why this is a code list and not a text box
 *
 * Every bounded-free-text precedent this repository holds is SCHEDULER-authored
 * administrative text about a scheduling act — `changeSummary`,
 * `overrideReason`, a decision `reason`. §4's comments are REQUESTER-authored
 * text about the requester's own circumstances, on a `SENSITIVE-PII` aggregate,
 * in a product where **the honest answer to "why that Friday?" is frequently a
 * medical one**. I-07 is not patient-scoped — *"no patient-identifying
 * information **or clinical free text** enters the system"* — and a length bound
 * bounds SIZE, not KIND. So the requester picks a code (I-17) and there is
 * nowhere to type.
 *
 * ## `other` is TERMINAL, and that is the load-bearing part
 *
 * There is **no "other, specify" field**, here or at any other layer, because
 * that field would be the free-text channel under a different name. `other`
 * means "no further statement", and it is a complete answer.
 *
 * ## The ABSENCE of a medical or sick code is the DESIGN
 *
 * A reader arriving here with a bug report — "a doctor cannot say they are ill"
 * — is meeting the ruling, not a gap in it. **A requester whose reason is
 * medical selects `personal`, or `other`, and discloses nothing**; the scheduler
 * learns that the request has a reason and does not learn a diagnosis. That is
 * the entire purpose of FAD-58.1, and adding `medical`, `sick`, `health`,
 * `appointment` or any near-synonym would re-open the clinical channel this list
 * exists to close. **A future packet must not add one**; if the product ever
 * genuinely needs one, it needs a recorded decision that overturns FAD-58 first.
 *
 * ## Two curation notes, recorded rather than left to be re-litigated
 *
 *  * **`bereavement` is kept and NOT folded into `family`.** It is a standard,
 *    non-clinical HR leave category, and folding it would make the vocabulary
 *    less honest rather than narrower — a bereaved requester would have to pick
 *    a code that says something else.
 *  * **`professional-obligation` covers the "I am teaching / on a committee /
 *    at a tribunal" case** that would otherwise be pushed into `other`, which is
 *    where a vocabulary starts losing its usefulness and a text box starts
 *    getting asked for.
 *
 * ## Three copies, held to each other
 *
 * This list, `REQUEST_REASON_CODES` in `@schedulepoint/domain`, and migration
 * 0026's `request_comments_reason_code_domain` CHECK. This package may import
 * zod and nothing else, so the copies cannot be one; the api suite asserts all
 * three are equal as sets, which is the discipline the subtype and status
 * vocabularies already use.
 */
export const requestReasonCodeSchema = z.enum([
  'personal',
  'family',
  'childcare',
  'bereavement',
  'travel',
  'education',
  'religious-observance',
  'professional-obligation',
  'other',
]);
export type RequestReasonCodeWire = z.infer<typeof requestReasonCodeSchema>;

/** FAD-58's two channels. One comment surface (§4); two kinds of statement. */
export const commentChannelSchema = z.enum(['requester', 'scheduler']);
export type CommentChannelWire = z.infer<typeof commentChannelSchema>;

/**
 * **What a REQUESTER sends to attach a reason code to their own request.**
 *
 * One field. `.strict()`, so a body carrying `text`, `note`, `detail`,
 * `otherText` or anything else is refused STRUCTURALLY with
 * `unrecognized_keys` before it reaches a handler — there is no field to remove
 * and no field to null, because none was ever declared.
 * `apps/api/test/requests/request-comments.test.ts` POSTs such a body over HTTP
 * and reads the refusal, so the claim is behavioural rather than a promise made
 * in this docblock.
 *
 * **One code, not an array.** I-16: one turn, at most one accepted selection,
 * through one transaction. A list would be one turn producing several accepted
 * statements, and a client that sent twenty would be holding a transaction open
 * proportional to how many boxes somebody ticked.
 */
export const attachReasonCodeSchema = z
  .object({
    reasonCode: requestReasonCodeSchema,
  })
  .strict();
export type AttachReasonCode = z.infer<typeof attachReasonCodeSchema>;

/**
 * **What a SCHEDULER sends to append a comment to a request in their queue.**
 *
 * Bounded free text of exactly the class `decisionReasonSchema` above is —
 * scheduler-authored, administrative, never clinical, not an ingestion path
 * (non-bypass rule 8) — with the same bound and the same trimming, so a comment
 * of pure whitespace is refused on the wire rather than at a constraint.
 *
 * **It never enters an audit payload, an outbox payload, or a notification**
 * (I-07, ADR-0019, rule 9). The closed-payload rule would reject it anyway: a
 * payload string may not contain a space. And FAD-58.5 enqueues nothing at all
 * on this surface, so there is no notification for it to reach.
 */
export const appendSchedulerCommentSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, 'a comment says something')
      .max(1000, 'a comment is at most 1000 characters'),
  })
  .strict();
export type AppendSchedulerComment = z.infer<typeof appendSchedulerCommentSchema>;

/**
 * **One comment, as a client reads it back.**
 *
 * A discriminated union would be the natural shape, and it is deliberately NOT
 * used: a client rendering a thread iterates one list and reads `channel`, and
 * the two content fields are nullable-and-exclusive exactly as the row is. The
 * exclusivity is enforced where enforcement belongs — migration 0026's two
 * CHECKs and the domain's `commentContentIsWellFormed`, both written in both
 * directions — rather than by a wire schema that a server could satisfy while
 * writing a row the database refuses.
 *
 * `authorMembershipId` is §4's "author recorded", and it is the acting
 * membership by construction: 0026's write policies require the stored author to
 * BE the caller, so this field cannot name somebody who did not write it.
 */
export const requestCommentSchema = z
  .object({
    id: uuidSchema,
    requestId: uuidSchema,
    channel: commentChannelSchema,
    /** Present exactly on the `requester` channel. */
    reasonCode: requestReasonCodeSchema.nullable(),
    /** Present exactly on the `scheduler` channel. */
    body: z.string().min(1).max(1000).nullable(),
    authorMembershipId: uuidSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type RequestCommentWire = z.infer<typeof requestCommentSchema>;

/**
 * A request's comment thread, OLDEST first.
 *
 * The opposite ordering to the decision history beside it, and deliberately: a
 * decision history answers "what is the current decision", a thread answers "how
 * did this conversation go".
 */
export const requestCommentThreadSchema = z
  .object({
    comments: z.array(requestCommentSchema),
  })
  .strict();
export type RequestCommentThread = z.infer<typeof requestCommentThreadSchema>;

/** What appending one comment returns. The row, and nothing about the request. */
export const requestCommentResultSchema = z
  .object({
    comment: requestCommentSchema,
  })
  .strict();
export type RequestCommentResult = z.infer<typeof requestCommentResultSchema>;

/**
 * The refusal for a comment that could not be appended.
 *
 * A closed `code`, because a caller must be able to branch, and each member has
 * a different remedy. `COMMENT_CONTENT_REFUSED` is the domain's exactly-one-of
 * rule — the shape that would have made a requester row carry prose, or a
 * scheduler row carry a code — and it is a `422` because it is a statement about
 * the body. There is deliberately **no version conflict code**: a comment is an
 * append and conflicts with nothing, which is what append-only buys.
 */
export const commentRefusalBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('COMMENT_CONTENT_REFUSED'),
        message: z.string().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type CommentRefusalBody = z.infer<typeof commentRefusalBodySchema>;

/**
 * One request in full, as the queue's detail read returns it: the aggregate, its
 * subtype record, and every decision ever made about it.
 *
 * The history is a LIST because §4's reversal is "a new `approvals` record; the
 * prior decision is never overwritten" — a single `decision` field would be the
 * shape that sentence forbids.
 */
export const requestDetailSchema = z
  .object({
    request: requestSchema,
    approvals: z.array(approvalSchema),
    /**
     * §4's comment thread, OLDEST first (OPUS-M5-00C, FAD-58).
     *
     * **This is where a DECIDER reads comments**, and it is a field on the
     * existing detail read rather than a route of its own, because the ratified
     * reader table says a comment is visible exactly where the REQUEST it is on
     * is visible and no wider — so the key that already decides this read
     * (`requests.read_any`) is the key that decides the thread, and a second
     * route would be a second place for that to drift. FAD-58.4's "deciders see
     * the queue's" is this line.
     *
     * The REQUESTER's half of the same table is `GET …/requests/:requestId/
     * comments`, which is self-scoped and rides `requests.own.read`; it needs
     * its own route because a requester cannot reach this one at all.
     */
    comments: z.array(requestCommentSchema),
  })
  .strict();
export type RequestDetail = z.infer<typeof requestDetailSchema>;

/* ── §5.4's vacation decision ───────────────────────────────────────────────── */

/**
 * What a client sends to APPROVE a vacation selection (§5.4).
 *
 * Four fields, and each one is an amendment's fix:
 *
 *  * `approvalIdempotencyKey` — **D-26** (V-29). Approval had no key at all;
 *    `commitIdempotencyKey` covers COMMIT. Without it a retry consumed a second
 *    quota unit.
 *  * `expectedSelectionVersion` — **V-29**. The version §5.4 checked was the
 *    GRANT's, so the selection update ran unguarded.
 *  * `grantId` / `expectedGrantVersion` — optional, per §5.4's own signature.
 *    Absent in `open` mode, where there are no grants at all (V-30), and
 *    resolvable by the server in quota mode.
 *  * `overrideReason` — §5.5's MANDATORY reason when the approval exceeds the
 *    bound. Supplying it does not authorise anything: the override capability is
 *    evaluated server-side inside the transaction, and without it the approval is
 *    refused (R-06) whatever the body says.
 */
export const approveVacationSelectionSchema = z
  .object({
    approvalIdempotencyKey: idempotencyKeySchema,
    expectedSelectionVersion: z.number().int().positive(),
    grantId: uuidSchema.optional(),
    expectedGrantVersion: z.number().int().positive().optional(),
    overrideReason: decisionReasonSchema.optional(),
  })
  .strict();
export type ApproveVacationSelection = z.infer<typeof approveVacationSelectionSchema>;

/** What a client sends to DENY a vacation selection. A denial consumes nothing. */
export const denyVacationSelectionSchema = z
  .object({
    approvalIdempotencyKey: idempotencyKeySchema,
    expectedSelectionVersion: z.number().int().positive(),
    reason: decisionReasonSchema,
  })
  .strict();
export type DenyVacationSelection = z.infer<typeof denyVacationSelectionSchema>;

/** What a vacation decision returns. `replayed` is D-26 answering (R-17). */
export const vacationDecisionResultSchema = z
  .object({
    selectionId: uuidSchema,
    requestId: uuidSchema,
    outcome: vacationApprovalOutcomeSchema,
    selectionVersion: z.number().int().positive(),
    /** Null in open mode — V-30's recorded fact, not a missing one. */
    grantId: uuidSchema.nullable(),
    isOverride: z.boolean(),
    /** D-26 stopped this at step 0: nothing consumed, nothing emitted. */
    replayed: z.boolean(),
  })
  .strict();
export type VacationDecisionResultWire = z.infer<typeof vacationDecisionResultSchema>;

/**
 * §5.4/§5.5's refusals, as a closed `code`.
 *
 * Each one has a different remedy, which is why they are not one message:
 * `QUOTA_EXHAUSTED` means there is nothing to retry (R-05's loser),
 * `VERSION_CONFLICT` means reload, `SELECTION_NOT_PENDING` means somebody already
 * decided it (R-18/R-19), `OVERRIDE_REQUIRED` means this actor may not exceed the
 * quota (R-06), and `OVERRIDE_REASON_REQUIRED` means they may but did not say why.
 */
export const vacationDecisionRefusalBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          'QUOTA_EXHAUSTED',
          'VERSION_CONFLICT',
          'SELECTION_NOT_PENDING',
          'OVERRIDE_REQUIRED',
          'OVERRIDE_REASON_REQUIRED',
        ]),
        message: z.string().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type VacationDecisionRefusalBody = z.infer<typeof vacationDecisionRefusalBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-003 — §5's SUBMISSION side and the staff surfaces (doc 42 §5f)
 *
 * The member's half of the vacation lifecycle: selecting a week, taking the
 * selection back, and the round as a surface reads it. The decision bodies above
 * are the scheduler's half and neither restates the other.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **R-15's mapping, inverted, as a CLIENT may compute it.**
 *
 * The forward table (`vacation_selections.status` → `requests.status`) lives in
 * three places already and this is the fourth reader rather than a fifth
 * authority: `packages/domain`'s `VACATION_STATUS_TO_REQUEST_STATUS`, the
 * database's `app_vacation_derived_request_status`, and D-27's deferred triggers
 * which enforce it. This is the same table read the other way, duplicated here
 * for the reason this file's header already states about the enums — **this
 * package may import zod and nothing else**, so a client that must DERIVE a
 * displayed status cannot reach the domain's copy.
 *
 * "Two copies of a closed set are two truths that can drift, so they are not
 * left to agree by inspection": `apps/api/test/requests/
 * vacation-status-mapping-agreement.test.ts` asserts this table equals the
 * domain's inverse AND the database's function, over every status, in one place.
 *
 * **Nothing stores a displayed status.** That is R-15's shape, and the reason
 * this is a derivation rather than a field on `vacationSelectionViewSchema`
 * below: a stored copy is a third value that can disagree with two rows D-27
 * already holds together.
 */
export const VACATION_ROOT_STATUS_TO_SELECTION_STATUS: Readonly<
  Partial<Record<RequestStatusWire, VacationSelectionStatusWire>>
> = {
  submitted: 'pending',
  approved: 'approved',
  reflected_in_version: 'committed',
  denied: 'denied',
  withdrawn: 'withdrawn',
  expired: 'expired',
  reversed: 'reversed',
};

/**
 * The selection status a `vacation-selection` root in `status` implies, or
 * `null` when §5.3's mapping produces no such root status.
 *
 * `null` is a finding, not a rendering problem: `draft`, `under_review` and
 * `superseded_by_revision` are in §2's vacation column (D-20 admits them) and are
 * produced by no selection status (D-27 refuses the row) — the declared tension
 * migration 0022's header §2 records. A surface that met one would be looking at
 * a row the database says cannot exist, and showing "unknown" is the honest
 * answer.
 */
export function selectionStatusForRootStatusWire(
  status: RequestStatusWire,
): VacationSelectionStatusWire | null {
  return VACATION_ROOT_STATUS_TO_SELECTION_STATUS[status] ?? null;
}

/**
 * §5.5's advisory variance, as a surface reads it.
 *
 * Doc 09 §2.1: *"Over-quota is advisory, not blocking. The variance indicator
 * warns; approval still succeeds."* `state` is therefore a WARNING vocabulary
 * and never a permission — nothing on either side of the wire consults it to
 * decide anything.
 *
 * `overEntitlement` is measured against `unitsTotal` rather than against `bound`,
 * because an approval that raised the bound to fit itself is precisely the event
 * a variance display exists to make visible.
 */
export const vacationVarianceSchema = z
  .object({
    grantId: uuidSchema,
    kind: vacationGrantKindSchema,
    /** The member a personal entitlement belongs to, or null for a weekly capacity. */
    membershipId: uuidSchema.nullable(),
    /** The week a capacity is for, or null for a personal entitlement. */
    weekStart: calendarDateSchema.nullable(),
    unitsTotal: z.number().int().nonnegative(),
    unitsConsumed: z.number().int().nonnegative(),
    overrideUnits: z.number().int().nonnegative(),
    bound: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    overEntitlement: z.number().int().nonnegative(),
    state: z.enum(['within', 'at-entitlement', 'over-entitlement']),
  })
  .strict();
export type VacationVarianceWire = z.infer<typeof vacationVarianceSchema>;

/**
 * One selection as the round's surface reads it: the selection row, and the ROOT
 * facts R-15's derivation and §3's deadline display need.
 *
 * `rootStatus` is carried and a displayed status is NOT. The client calls
 * `selectionStatusForRootStatusWire` on it, and the server has already asserted
 * that the derivation agrees with `selection.status` before answering — so the
 * two halves of D-27's pair are on the wire together and a disagreement is
 * visible rather than papered over.
 *
 * Every root field is nullable for exactly one reason: §5.3's `available` row has
 * no root at all.
 */
/**
 * The selection as the MEMBER's round read carries it — **without
 * `overrideReason`** (OPUS-M5-003, condition C-3).
 *
 * `vacationSelectionSchema` above is the full row and stays as it is; this is a
 * PROJECTION of it for one surface, and the omission is the point.
 * `overrideReason` is SCHEDULER-authored bounded free text explaining why
 * somebody's allowance was exceeded — the `change_summary` class — and putting
 * it on a member's own round read would widen who can read that class of text
 * without any decision having been taken to widen it. `isOverride` is retained,
 * because the FACT that a week was approved over the allowance is a fact about
 * the member's own week and they are entitled to see it; the REASON is a
 * scheduler's administrative note about it.
 *
 * A future packet may grant the member the reason deliberately, under a recorded
 * decision. Until then the field is absent rather than nulled: an absent field
 * cannot be read, whereas a nulled one is a field somebody will one day fill in
 * "because it is already on the wire".
 *
 * The `.refine` that pairs `isOverride` with `overrideReason` is deliberately
 * NOT carried here — there is no reason field for it to pair with, and a
 * refinement over an absent field would be a rule that can never fire.
 */
export const vacationSelectionSummarySchema = z
  .object({
    id: uuidSchema,
    requestId: uuidSchema.nullable(),
    membershipId: uuidSchema,
    vacationPeriodId: uuidSchema,
    weekStart: calendarDateSchema,
    status: vacationSelectionStatusSchema,
    version: z.number().int().positive(),
    grantId: uuidSchema.nullable(),
    /** §5.5: this week was approved beyond the allowance. The REASON is not here. */
    isOverride: z.boolean(),
    committedToVersionId: uuidSchema.nullable(),
  })
  .strict();
export type VacationSelectionSummaryWire = z.infer<typeof vacationSelectionSummarySchema>;

export const vacationSelectionViewSchema = z
  .object({
    selection: vacationSelectionSummarySchema,
    rootStatus: requestStatusSchema.nullable(),
    rootVersion: z.number().int().positive().nullable(),
    submittedAt: z.string().datetime().nullable(),
    /** §3's server-computed deadline for the root. Never client-supplied. */
    expiresAt: z.string().datetime().nullable(),
    isLate: z.boolean(),
  })
  .strict();
export type VacationSelectionViewWire = z.infer<typeof vacationSelectionViewSchema>;

/**
 * The vacation ROUND, as one read.
 *
 * One request, one surface (I-10): the period, the caller's selections in it, and
 * the variance rows for its grants. A surface that had to fetch three of these
 * separately would be three requests for one action, and the request-budget gate
 * counts exactly that.
 *
 * `variance` is EMPTY in `open` mode and that is not an error — V-30: open mode
 * has no `vacation_grants` rows at all, and a client that treated an empty list
 * as "no allowance left" would be reintroducing the defect V-30 fixed.
 */
export const vacationRoundSchema = z
  .object({
    period: vacationPeriodSchema,
    selections: z.array(vacationSelectionViewSchema),
    variance: z.array(vacationVarianceSchema),
  })
  .strict();
export type VacationRoundWire = z.infer<typeof vacationRoundSchema>;

/** Every round a member may select in, newest first. */
export const vacationRoundListSchema = z
  .object({ periods: z.array(vacationPeriodSchema) })
  .strict();
export type VacationRoundList = z.infer<typeof vacationRoundListSchema>;

/**
 * What a member sends to WITHDRAW their own selection.
 *
 * The SELECTION's version, not the root's (V-29 — the version §5.4 originally
 * checked was the grant's, and that confusion was the defect). §4's conditional
 * rule is not weaker for a withdrawal than for a decision: two tabs open on the
 * same week must not both succeed.
 *
 * **There is deliberately no `reason`**, exactly as `withdrawRequestSchema` has
 * none: withdrawal is requester-initiated and a person taking back their own week
 * owes nobody an explanation, and adding one would put new bounded free text on a
 * `SENSITIVE-PII` aggregate — the question M5-00C owns and this packet does not
 * open.
 */
export const withdrawVacationSelectionSchema = z
  .object({
    expectedSelectionVersion: z.number().int().positive(),
  })
  .strict();
export type WithdrawVacationSelection = z.infer<typeof withdrawVacationSelectionSchema>;

/**
 * What a member's WITHDRAWAL returns — both halves of D-27's pair.
 *
 * The root status is carried BESIDE the selection status rather than instead of
 * it, so a client can check the derivation itself. That is R-15 on the wire: the
 * two rows agree, and the answer says so in a form a caller can verify rather
 * than in one it must trust.
 *
 * **A SUBMISSION does not use this shape.** It answers `requestSchema`, the same
 * body the other five subtypes return from the same route — one submission
 * endpoint, one answer to parse. `unitReleased` is what a withdrawal has to say
 * that a submission does not: withdrawing an APPROVED selection returns the quota
 * unit the approval consumed (§5.5's release write path), and a member whose
 * balance just moved should be told so rather than left to re-read for it.
 */
export const vacationSelectionResultSchema = z
  .object({
    selectionId: uuidSchema,
    requestId: uuidSchema,
    selectionStatus: vacationSelectionStatusSchema,
    rootStatus: requestStatusSchema,
    selectionVersion: z.number().int().positive(),
    /** §5.5: a quota unit was returned to its grant. False from a `pending` withdrawal. */
    unitReleased: z.boolean(),
  })
  .strict();
export type VacationSelectionResultWire = z.infer<typeof vacationSelectionResultSchema>;

/**
 * **FU-23's named ending.** One member's idempotency key already names a request
 * of a DIFFERENT subtype.
 *
 * Before this packet the same situation produced a bare `23505` surfacing as an
 * unexplained `409` — the failure FU-23 records as "a 409 posing as a replay".
 * The remedy is different from every other conflict on this surface: reloading
 * changes nothing and retrying repeats it. The caller must choose another key.
 *
 * The subtype the key already names is carried, and it discloses nothing: D-7's
 * uniqueness is scoped to `membership_id`, so the row it names is the caller's
 * own, and their own list already shows it.
 */
export const idempotencyKeyReusedBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('IDEMPOTENCY_KEY_REUSED'),
        message: z.string().min(1),
        correlationId: z.string().min(1),
        existingSubtype: requestSubtypeSchema,
      })
      .strict(),
  })
  .strict();
export type IdempotencyKeyReusedBody = z.infer<typeof idempotencyKeyReusedBodySchema>;

/**
 * §5.3/§5.5's refusals on the member's side of the round.
 *
 * `SELECTION_NOT_PENDING` is R-18/R-19's, reused deliberately: it means the same
 * thing here as it does on the decision side — the selection is not standing
 * where the command believed, or the version is stale — and a second code with
 * the same remedy would be a vocabulary that grew without meaning.
 * `VACATION_ROUND_NOT_OPEN` is the period's own window, which is not §3's
 * deadline and is refused separately from it.
 */
export const vacationSelectionRefusalBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          'SELECTION_NOT_PENDING',
          'VACATION_ROUND_NOT_OPEN',
          'VACATION_WEEK_ALREADY_SELECTED',
        ]),
        message: z.string().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type VacationSelectionRefusalBody = z.infer<typeof vacationSelectionRefusalBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-004 — §5.6's commit and reversal (doc 42 §5h, FAD-59)
 *
 * The scheduler's two most consequential acts on a round: putting it on the
 * schedule, and taking one week of it back off. Both are `.strict()` like
 * everything here, and neither body carries a status or a date — the round and
 * the selection already say those, and a body that repeated them would be a
 * second authority a client could get wrong.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a client sends to COMMIT a vacation round (§5.6).
 *
 * `idempotencyKey` is FAD-59's, and it is the ONLY thing that makes a retry
 * safe: the same key twice commits once (R-12). Same shape as every other key in
 * this file — migration 0027's `vacation_commit_commands_key_shape` is the
 * database's independent copy.
 *
 * **No `selectionIds`.** A commit is an act on the ROUND: it takes every
 * `approved` selection in the period, because a commit that took a subset would
 * make "was this round committed?" a question with a list for an answer, and
 * FAD-59's ledger row is per COMMAND rather than per selection.
 */
export const commitVacationRoundSchema = z
  .object({
    /** SPEC-05's DRAFT version. A published one is refused by name (I-18). */
    targetVersionId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type CommitVacationRound = z.infer<typeof commitVacationRoundSchema>;

/** What a commit returns. `replayed` is FAD-59's ledger answering (R-12). */
export const commitVacationRoundResultSchema = z
  .object({
    vacationPeriodId: uuidSchema,
    targetVersionId: uuidSchema,
    committedSelectionIds: z.array(uuidSchema),
    /** How many OFF assignment snapshots this call created. Zero on a replay. */
    assignmentsCreated: z.number().int().nonnegative(),
    /** The ledger already held this key: nothing was written (R-12). */
    replayed: z.boolean(),
  })
  .strict();
export type CommitVacationRoundResultWire = z.infer<typeof commitVacationRoundResultSchema>;

/**
 * What a client sends to REVERSE a committed week (§5.6).
 *
 * The reason is MANDATORY — §5.6 says so — and it is bounded administrative text
 * of exactly the class `approvals.reason` and `override_reason` are: never
 * clinical, never an ingestion path (non-bypass rule 8), and it reaches no audit
 * payload, no outbox row and no log (I-07, rule 9). `decisionReasonSchema` is the
 * house bound, reused rather than respelled.
 */
export const reverseVacationCommitSchema = z.object({ reason: decisionReasonSchema }).strict();
export type ReverseVacationCommit = z.infer<typeof reverseVacationCommitSchema>;

/** What a reversal returns. `revisionRequested` is always true — §5.6 raises one. */
export const reverseVacationCommitResultSchema = z
  .object({
    selectionId: uuidSchema,
    requestId: uuidSchema,
    selectionVersion: z.number().int().positive(),
    /** False in open mode: no grant row, nothing to release (V-30). */
    unitReleased: z.boolean(),
    /** §5.6 raises a revision request rather than editing a published version. */
    revisionRequested: z.literal(true),
  })
  .strict();
export type ReverseVacationCommitResultWire = z.infer<typeof reverseVacationCommitResultSchema>;

/**
 * §5.6's refusals, as a closed `code`. Each has its own remedy.
 *
 * `COMMIT_RACE_LOST` is deliberately ABSENT: it is the service's internal signal
 * that two commands raced, and the route converges on the recorded outcome
 * instead of surfacing it (see the domain's `VACATION_COMMIT_FAILURES`). A code
 * a client can never receive would be a vocabulary member with no meaning to
 * them.
 */
export const vacationCommitRefusalBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum([
          'COMMIT_TARGET_NOT_DRAFT',
          'COMMIT_PERIOD_NOT_FOUND',
          'COMMIT_PERIOD_VERSION_MISMATCH',
          'COMMIT_NO_OFF_SHIFT_TYPE',
          'COMMIT_SELECTION_NOT_APPROVED',
          'COMMIT_NOTHING_TO_COMMIT',
          'REVERSAL_SELECTION_NOT_COMMITTED',
          'REVERSAL_OVERRIDE_REQUIRED',
          'REVERSAL_REASON_REQUIRED',
          'REVERSAL_GRANT_CONFLICT',
        ]),
        message: z.string().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type VacationCommitRefusalBody = z.infer<typeof vacationCommitRefusalBodySchema>;
