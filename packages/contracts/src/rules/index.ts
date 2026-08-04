import { z } from 'zod';

/**
 * The wire shapes for the typed scheduling-rule model (OPUS-M3-002, CAP-015,
 * CAP-045, CAR-006; SPEC-04 §3).
 *
 * ## Rules this package works under, restated where they bite
 *
 *  - **`.strict()` on every object.** An unknown key is rejected, not carried.
 *    A rule write that silently accepted an extra field would be exactly the
 *    free-form/JSON escape hatch the closed AST exists to forbid (SPEC-04 §3.1,
 *    non-bypass rule 8). There is **no** "custom expression" or raw-predicate
 *    node — a `predicate` whose `kind` is not one of the closed set is rejected
 *    by the discriminated union below, not carried as opaque JSON.
 *  - **Enums are duplicated here rather than imported.** `@schedulepoint/contracts`
 *    imports zod and nothing else (the layering rule). The node kinds, weekdays,
 *    strengths, metrics and restrictions are duplicated **and asserted** against
 *    `@schedulepoint/domain` by `apps/api/test/rules/contract-parity.test.ts` (the
 *    cross-package seam where both are dependencies), so drift is a failing test
 *    rather than a save-time rejection.
 *  - **No response body carries a denial reason.** A denial is the fixed 403/404
 *    envelope; these schemas describe success and field-addressed validation only.
 */

const ruleKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'a rule key is lowercase letters, digits and underscores, starting with a letter',
  )
  .max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');
const shiftType = z.string().min(1).max(64);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

export const RULE_WEEKDAY_VALUES = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
  'holiday',
] as const;
export const PREFERENCE_STRENGTH_VALUES = [
  'strong_prefer',
  'prefer',
  'avoid',
  'strong_avoid',
] as const;
export const FAIRNESS_METRIC_VALUES = [
  'credits',
  'assignments',
  'weekend_load',
  'call_load',
] as const;
export const FAIRNESS_NORMALISATION_VALUES = ['none', 'per_fte', 'per_eligible_day'] as const;
export const LOCUM_RESTRICTION_VALUES = ['no_locum', 'locum_only', 'locum_last_resort'] as const;
export const RULE_CLASSIFICATION_VALUES = ['HARD', 'SOFT'] as const;

const weekday = z.enum(RULE_WEEKDAY_VALUES);

const patternSegmentSchema = z.object({ offsetDays: z.number().int(), shiftType }).strict();

/** The closed predicate node set. A discriminated union — an unknown `kind` cannot parse. */
export const ruleNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RequiredCount'), count: positiveInt }).strict(),
  z.object({ kind: z.literal('MinCoverage'), min: positiveInt }).strict(),
  z.object({ kind: z.literal('MaxCoverage'), max: positiveInt }).strict(),
  z
    .object({
      kind: z.literal('RequiresQualification'),
      qualification: z.string().min(1).max(64),
      validAt: z.literal('shift_date'),
    })
    .strict(),
  z
    .object({ kind: z.literal('MemberOfStaffGroup'), staffGroup: z.string().min(1).max(64) })
    .strict(),
  z
    .object({ kind: z.literal('ValidGroupRestriction'), validGroup: z.string().min(1).max(64) })
    .strict(),
  z
    .object({
      kind: z.literal('PickPositionRestriction'),
      allowedPickPositions: z.array(nonNegativeInt).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('MaxAssignmentsInWindow'),
      max: positiveInt,
      windowDays: positiveInt,
    })
    .strict(),
  z
    .object({ kind: z.literal('WeekdayFteLimit'), weekday, fteFraction: z.number().min(0).max(1) })
    .strict(),
  z
    .object({
      kind: z.literal('WorkPercentageTarget'),
      targetPercentage: z.number().gt(0).max(100),
    })
    .strict(),
  z.object({ kind: z.literal('MaxConsecutive'), maxDays: positiveInt }).strict(),
  z.object({ kind: z.literal('MinimumRestBetween'), minHours: positiveInt }).strict(),
  z.object({ kind: z.literal('CallSpacing'), minDaysBetweenCalls: positiveInt }).strict(),
  z
    .object({ kind: z.literal('NoAdjacent'), shiftTypeA: shiftType, shiftTypeB: shiftType })
    .strict(),
  z.object({ kind: z.literal('ForbiddenSequence'), sequence: z.array(shiftType).min(2) }).strict(),
  z
    .object({
      kind: z.literal('PatternRule'),
      trigger: shiftType,
      daysOfWeek: z.array(weekday).min(1),
      segments: z.array(patternSegmentSchema).min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal('AlternatingWeek'), onShiftType: shiftType, cycleWeeks: positiveInt })
    .strict(),
  z
    .object({
      kind: z.literal('TemplateAdherence'),
      template: z.string().min(1).max(64),
      cycleWeeks: positiveInt,
    })
    .strict(),
  z.object({ kind: z.literal('LinkedShifts'), shiftTypes: z.array(shiftType).min(2) }).strict(),
  z
    .object({
      kind: z.literal('ImpliesAssignment'),
      ifShiftType: shiftType,
      thenShiftType: shiftType,
    })
    .strict(),
  z
    .object({ kind: z.literal('MutuallyExclusive'), shiftTypes: z.array(shiftType).min(2) })
    .strict(),
  z.object({ kind: z.literal('RequestHonoured'), requestType: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('ShiftPreference'),
      shiftType,
      strength: z.enum(PREFERENCE_STRENGTH_VALUES),
    })
    .strict(),
  z.object({ kind: z.literal('AvoidDate'), date: isoDate }).strict(),
  z
    .object({
      kind: z.literal('FairnessBalance'),
      metric: z.enum(FAIRNESS_METRIC_VALUES),
      normalisation: z.enum(FAIRNESS_NORMALISATION_VALUES),
    })
    .strict(),
  z
    .object({ kind: z.literal('CreditDistribution'), metric: z.enum(FAIRNESS_METRIC_VALUES) })
    .strict(),
  z.object({ kind: z.literal('StaffOverLocumPriority'), windowDays: positiveInt }).strict(),
  z
    .object({ kind: z.literal('LocumRestriction'), restriction: z.enum(LOCUM_RESTRICTION_VALUES) })
    .strict(),
  z
    .object({ kind: z.literal('FixedAssignment'), assignmentIdentity: z.string().min(1).max(64) })
    .strict(),
  z.object({ kind: z.literal('ProtectedRange'), from: isoDate, to: isoDate }).strict(),
]);
export type RuleNodeWire = z.infer<typeof ruleNodeSchema>;

export const ruleScopeSchema = z
  .object({
    dateRange: z.object({ from: isoDate, to: isoDate }).strict().optional(),
    shiftTypes: z.array(shiftType).optional(),
    staffGroups: z.array(z.string().min(1).max(64)).optional(),
    memberships: z.array(z.string().min(1).max(64)).optional(),
  })
  .strict();
export type RuleScopeWire = z.infer<typeof ruleScopeSchema>;

/**
 * The create/edit body. The hard/soft weight discipline is a refinement, mirrored
 * by the domain validation and the database CHECK: HARD must omit weight, SOFT
 * must carry a positive one.
 */
export const ruleWriteSchema = z
  .object({
    ruleKey,
    name: z.string().min(1).max(120),
    classification: z.enum(RULE_CLASSIFICATION_VALUES),
    weight: z.number().positive().optional(),
    scope: ruleScopeSchema,
    predicate: ruleNodeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.classification === 'HARD' && value.weight !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weight'],
        message: 'a hard rule must not carry a weight',
      });
    }
    if (value.classification === 'SOFT' && value.weight === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weight'],
        message: 'a soft rule must carry a weight',
      });
    }
  });
export type RuleWriteRequest = z.infer<typeof ruleWriteSchema>;

/** A rule set: an ordered list of rule keys the build references (doc 06 `rule_sets`). */
export const ruleSetWriteSchema = z
  .object({
    name: z.string().min(1).max(120),
    ruleKeys: z.array(ruleKey).min(1),
  })
  .strict();
export type RuleSetWriteRequest = z.infer<typeof ruleSetWriteSchema>;

/** A field-addressed validation problem, so the authoring form can link its summary. */
export const ruleProblemSchema = z.object({ path: z.string(), message: z.string() }).strict();
export const ruleValidationBodySchema = z.object({ problems: z.array(ruleProblemSchema) }).strict();
export type RuleProblemWire = z.infer<typeof ruleProblemSchema>;
export type RuleValidationBody = z.infer<typeof ruleValidationBodySchema>;

/** A rule set as returned to the authoring surface. */
export const ruleSetViewSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    ruleKeys: z.array(ruleKey),
    state: z.enum(['active', 'archived']),
  })
  .strict();
export type RuleSetView = z.infer<typeof ruleSetViewSchema>;

/** The persisted view of a rule returned to the authoring surface. */
export const ruleViewSchema = z
  .object({
    ruleKey,
    name: z.string(),
    ruleSchemaVersion: z.number().int().positive(),
    classification: z.enum(RULE_CLASSIFICATION_VALUES),
    weight: z.number().positive().nullable(),
    scope: ruleScopeSchema,
    predicate: ruleNodeSchema,
    state: z.enum(['active', 'disabled', 'archived']),
  })
  .strict();
export type RuleView = z.infer<typeof ruleViewSchema>;

export const ruleListSchema = z
  .object({ rules: z.array(ruleViewSchema), correlationId: z.string().min(1) })
  .strict();
export type RuleList = z.infer<typeof ruleListSchema>;

export const ruleResultSchema = z
  .object({ rule: ruleViewSchema, correlationId: z.string().min(1) })
  .strict();
export type RuleResult = z.infer<typeof ruleResultSchema>;

export const ruleSetListSchema = z
  .object({ ruleSets: z.array(ruleSetViewSchema), correlationId: z.string().min(1) })
  .strict();
export type RuleSetList = z.infer<typeof ruleSetListSchema>;

export const ruleSetResultSchema = z
  .object({ ruleSet: ruleSetViewSchema, correlationId: z.string().min(1) })
  .strict();
export type RuleSetResult = z.infer<typeof ruleSetResultSchema>;

/** The lifecycle move a state change requests. Archived is terminal. */
export const ruleStateRequestSchema = z
  .object({ state: z.enum(['active', 'disabled', 'archived']) })
  .strict();
export type RuleStateRequest = z.infer<typeof ruleStateRequestSchema>;
