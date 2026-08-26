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
 *    commit/reverse. **This packet ships no routes at all** (doc 42 §5b), so
 *    nothing parses these schemas on an HTTP boundary yet.
 *  - **No free-text field except `overrideReason`**, which is a scheduler-
 *    authored administrative note bounded at 1000 characters, of the same class
 *    as `changeSummary` on a schedule version. It is not an ingestion path and
 *    never enters an audit payload; the closed-payload rule (ADR-0019) would
 *    reject free text there. There is no comment body here — §4's comments are
 *    M5-002's surface.
 *  - **No `isLate`.** SPEC-08 §1.1 supersedes doc 06 §3.4 for the root and does
 *    not carry it; §3's late-submission policy is M5-001's, and the field lands
 *    with the machinery that decides it.
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
