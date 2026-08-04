import { z } from 'zod';

/**
 * Shift groups, staff groups, valid combinations, pick positions, and the group
 * holiday calendar (OPUS-M2-002; CAP-012, CAP-011, CAR-011).
 *
 * The same rules as `shift-types.ts`: `.strict()` throughout, server-generated
 * ids, no denial reason in any body, and validation problems addressed to the
 * field that caused them so the authoring form's summary can link to it.
 */

const uuid = z.string().uuid();

/* ────────────────────────────────────────────────────────────────────────────
 * Shift groups
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `scoringMode` and `weight` are a discriminated pair, and the union is what
 * makes the meaningless combination unrepresentable on the wire as well as in
 * the table.
 *
 * Research 05 §1 resolved the observed "Hard (0)" / "Linear (1000)" display:
 * **Hard is a non-negotiable constraint and carries no weight at all** — the
 * zero is a display convention for "not weighted", not a value. Modelling it as
 * a nullable number would have preserved the confusion; a discriminated union
 * makes `{ scoringMode: 'hard', weight: 0 }` a parse error.
 */
export const shiftGroupScoringSchema = z.discriminatedUnion('scoringMode', [
  z.object({ scoringMode: z.literal('hard') }).strict(),
  z
    .object({ scoringMode: z.literal('weighted'), weight: z.number().min(0).max(1000000) })
    .strict(),
]);

export type ShiftGroupScoring = z.infer<typeof shiftGroupScoringSchema>;

/**
 * Likewise `allowRequest` and `requestOffLabel`.
 *
 * ADM-08 records "Request Off Text" as the exact phrasing shown to staff when
 * requesting off the whole bundle. A bundle that accepts requests with no
 * phrasing is a control nobody can describe; a bundle that does not accept them
 * but keeps a stale phrasing is a lie waiting to be re-enabled.
 */
export const shiftGroupRequestSchema = z.discriminatedUnion('allowRequest', [
  z.object({ allowRequest: z.literal(false) }).strict(),
  z
    .object({ allowRequest: z.literal(true), requestOffLabel: z.string().min(1).max(160) })
    .strict(),
]);

export type ShiftGroupRequest = z.infer<typeof shiftGroupRequestSchema>;

export const createShiftGroupRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullable().default(null),
    scoring: shiftGroupScoringSchema,
    request: shiftGroupRequestSchema,
    /** The member shift types. May be empty at creation and filled in later. */
    shiftTypeIds: z.array(uuid).max(200).default([]),
  })
  .strict();

export type CreateShiftGroupRequest = z.infer<typeof createShiftGroupRequestSchema>;

export const updateShiftGroupRequestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    scoring: shiftGroupScoringSchema.optional(),
    request: shiftGroupRequestSchema.optional(),
    shiftTypeIds: z.array(uuid).max(200).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict();

export type UpdateShiftGroupRequest = z.infer<typeof updateShiftGroupRequestSchema>;

export const shiftGroupSchema = z
  .object({
    shiftGroupId: uuid,
    name: z.string().min(1),
    description: z.string().nullable(),
    scoringMode: z.enum(['hard', 'weighted']),
    weight: z.number().nullable(),
    allowRequest: z.boolean(),
    requestOffLabel: z.string().nullable(),
    shiftTypeIds: z.array(uuid),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
  })
  .strict();

export type ShiftGroup = z.infer<typeof shiftGroupSchema>;

export const shiftGroupListSchema = z
  .object({ shiftGroups: z.array(shiftGroupSchema), correlationId: z.string().min(1) })
  .strict();

export type ShiftGroupList = z.infer<typeof shiftGroupListSchema>;

export const shiftGroupResultSchema = z
  .object({ shiftGroup: shiftGroupSchema, correlationId: z.string().min(1) })
  .strict();

export type ShiftGroupResult = z.infer<typeof shiftGroupResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Staff groups
 * ──────────────────────────────────────────────────────────────────────────── */

export const createStaffGroupRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullable().default(null),
    /** Memberships in this group. Empty is legitimate — an empty pool is a pool. */
    membershipIds: z.array(uuid).max(500).default([]),
  })
  .strict();

export type CreateStaffGroupRequest = z.infer<typeof createStaffGroupRequestSchema>;

export const staffGroupSchema = z
  .object({
    staffGroupId: uuid,
    name: z.string().min(1),
    description: z.string().nullable(),
    membershipIds: z.array(uuid),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
  })
  .strict();

export type StaffGroup = z.infer<typeof staffGroupSchema>;

export const staffGroupListSchema = z
  .object({ staffGroups: z.array(staffGroupSchema), correlationId: z.string().min(1) })
  .strict();

export type StaffGroupList = z.infer<typeof staffGroupListSchema>;

export const staffGroupResultSchema = z
  .object({ staffGroup: staffGroupSchema, correlationId: z.string().min(1) })
  .strict();

export type StaffGroupResult = z.infer<typeof staffGroupResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Valid combinations
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ADM-09, as resolved in research 05 §1: which numbered draft positions are
 * legal for a given set of shift types.
 *
 * `allowedPickPositions` is a plain integer array rather than a child collection
 * because a pick position is not an entity anywhere in this system — it is an
 * ordinal between 1 and the group's `pickPositionCount`. The shift-type side IS
 * a set of entities, and it is a set of ids for exactly that reason.
 */
export const createValidGroupRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    shiftTypeIds: z.array(uuid).min(1).max(200),
    allowedPickPositions: z.array(z.number().int().min(1).max(1000)).max(1000),
  })
  .strict();

export type CreateValidGroupRequest = z.infer<typeof createValidGroupRequestSchema>;

export const validGroupSchema = z
  .object({
    validGroupId: uuid,
    name: z.string().min(1),
    shiftTypeIds: z.array(uuid),
    allowedPickPositions: z.array(z.number().int()),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
  })
  .strict();

export type ValidGroup = z.infer<typeof validGroupSchema>;

export const validGroupListSchema = z
  .object({
    validGroups: z.array(validGroupSchema),
    /** The ceiling every `allowedPickPositions` member must respect. */
    pickPositionCount: z.number().int().min(0),
    correlationId: z.string().min(1),
  })
  .strict();

export type ValidGroupList = z.infer<typeof validGroupListSchema>;

export const validGroupResultSchema = z
  .object({ validGroup: validGroupSchema, correlationId: z.string().min(1) })
  .strict();

export type ValidGroupResult = z.infer<typeof validGroupResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Pick positions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The one irreversible catalogue action.
 *
 * Research 05 §ADM-07 records the warning the observed product shows: the count
 * "may only be increased… These may not be deleted in the future." The request
 * therefore carries the WHOLE new count rather than a delta — a delta of `-1` is
 * a request that cannot be honoured, and a request that cannot be honoured
 * should not be expressible.
 */
export const setPickPositionCountRequestSchema = z
  .object({ pickPositionCount: z.number().int().min(0).max(1000) })
  .strict();

export type SetPickPositionCountRequest = z.infer<typeof setPickPositionCountRequestSchema>;

export const pickPositionCountSchema = z
  .object({ pickPositionCount: z.number().int().min(0), correlationId: z.string().min(1) })
  .strict();

export type PickPositionCount = z.infer<typeof pickPositionCountSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Group holidays
 * ──────────────────────────────────────────────────────────────────────────── */

/** `YYYY-MM-DD`. A calendar date, not an instant: a holiday has no time zone. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');

export const createGroupHolidayRequestSchema = z
  .object({
    holidayDate: calendarDate,
    name: z.string().min(1).max(120),
    /** False records a holiday the group knows about but works through. */
    observed: z.boolean().default(true),
  })
  .strict();

export type CreateGroupHolidayRequest = z.infer<typeof createGroupHolidayRequestSchema>;

export const groupHolidaySchema = z
  .object({
    groupHolidayId: uuid,
    holidayDate: calendarDate,
    name: z.string().min(1),
    observed: z.boolean(),
    version: z.number().int(),
  })
  .strict();

export type GroupHoliday = z.infer<typeof groupHolidaySchema>;

export const groupHolidayListSchema = z
  .object({ holidays: z.array(groupHolidaySchema), correlationId: z.string().min(1) })
  .strict();

export type GroupHolidayList = z.infer<typeof groupHolidayListSchema>;

export const groupHolidayResultSchema = z
  .object({ holiday: groupHolidaySchema, correlationId: z.string().min(1) })
  .strict();

export type GroupHolidayResult = z.infer<typeof groupHolidayResultSchema>;
