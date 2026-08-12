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

/**
 * OPUS-M4-000C — the AST bounds, mirrored on the wire (doc 34 §4-D).
 *
 * The domain's `AST_BOUNDS` is the definition; these are the same numbers at the
 * HTTP boundary, duplicated for the same reason every other constant in this
 * file is (`@schedulepoint/contracts` imports zod and nothing else) and asserted
 * equal by `apps/api/test/rules/contract-parity.test.ts`, so drift is a failing
 * test rather than a save-time rejection.
 *
 * Two layers rather than one because they answer different callers: the wire
 * bound turns an oversized payload into a `400` before it is parsed into a
 * domain object at all, and the domain bound is what a background job, a
 * migration or any future non-HTTP writer meets.
 */
export const AST_BOUND_VALUES = {
  maxNodeDepth: 3,
  maxSequenceLength: 32,
  maxShiftTypesInNode: 64,
  maxPatternSegments: 64,
  maxDaysOfWeek: 8,
  maxPickPositions: 64,
  maxCount: 10_000,
  maxWindowDays: 366,
  maxDays: 366,
  maxRestHours: 8_760,
  maxCycleWeeks: 260,
  maxSegmentOffsetDays: 366,
  maxScopeShiftTypes: 200,
  maxScopeStaffGroups: 200,
  maxScopeMemberships: 1_000,
  maxIdentifierLength: 64,
  maxFindingsPerRule: 100,
} as const;

const B = AST_BOUND_VALUES;

const ruleKey = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'a rule key is lowercase letters, digits and underscores, starting with a letter',
  )
  .max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');
const shiftType = z.string().min(1).max(B.maxIdentifierLength);
const nonNegativeInt = z.number().int().nonnegative();
/**
 * A positive whole number that is also within a declared capacity bound.
 *
 * Every numeric parameter in the node set now goes through this rather than a
 * bare `positiveInt`: an unbounded positive integer is exactly the shape the
 * OPUS-M4-000C bounds exist to close, and leaving one un-bounded "because it is
 * obviously small" is how the list of exceptions starts.
 */
const boundedInt = (max: number) => z.number().int().positive().max(max);

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

const patternSegmentSchema = z
  .object({
    offsetDays: z.number().int().min(-B.maxSegmentOffsetDays).max(B.maxSegmentOffsetDays),
    shiftType,
  })
  .strict();

/** The closed predicate node set. A discriminated union — an unknown `kind` cannot parse. */
export const ruleNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RequiredCount'), count: boundedInt(B.maxCount) }).strict(),
  z.object({ kind: z.literal('MinCoverage'), min: boundedInt(B.maxCount) }).strict(),
  z.object({ kind: z.literal('MaxCoverage'), max: boundedInt(B.maxCount) }).strict(),
  z
    .object({
      kind: z.literal('RequiresQualification'),
      qualification: z.string().min(1).max(B.maxIdentifierLength),
      validAt: z.literal('shift_date'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('MemberOfStaffGroup'),
      staffGroup: z.string().min(1).max(B.maxIdentifierLength),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ValidGroupRestriction'),
      validGroup: z.string().min(1).max(B.maxIdentifierLength),
    })
    .strict(),
  z
    .object({
      kind: z.literal('PickPositionRestriction'),
      allowedPickPositions: z.array(nonNegativeInt.max(B.maxCount)).min(1).max(B.maxPickPositions),
    })
    .strict(),
  z
    .object({
      kind: z.literal('MaxAssignmentsInWindow'),
      max: boundedInt(B.maxCount),
      windowDays: boundedInt(B.maxWindowDays),
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
  z.object({ kind: z.literal('MaxConsecutive'), maxDays: boundedInt(B.maxDays) }).strict(),
  z.object({ kind: z.literal('MinimumRestBetween'), minHours: boundedInt(B.maxRestHours) }).strict(),
  z
    .object({ kind: z.literal('CallSpacing'), minDaysBetweenCalls: boundedInt(B.maxDays) })
    .strict(),
  z
    .object({ kind: z.literal('NoAdjacent'), shiftTypeA: shiftType, shiftTypeB: shiftType })
    .strict(),
  z
    .object({
      kind: z.literal('ForbiddenSequence'),
      sequence: z.array(shiftType).min(2).max(B.maxSequenceLength),
    })
    .strict(),
  z
    .object({
      kind: z.literal('PatternRule'),
      trigger: shiftType,
      daysOfWeek: z.array(weekday).min(1).max(B.maxDaysOfWeek),
      segments: z.array(patternSegmentSchema).min(1).max(B.maxPatternSegments),
    })
    .strict(),
  z
    .object({
      kind: z.literal('AlternatingWeek'),
      onShiftType: shiftType,
      cycleWeeks: boundedInt(B.maxCycleWeeks),
    })
    .strict(),
  z
    .object({
      kind: z.literal('TemplateAdherence'),
      template: z.string().min(1).max(B.maxIdentifierLength),
      cycleWeeks: boundedInt(B.maxCycleWeeks),
    })
    .strict(),
  z
    .object({
      kind: z.literal('LinkedShifts'),
      shiftTypes: z.array(shiftType).min(2).max(B.maxShiftTypesInNode),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ImpliesAssignment'),
      ifShiftType: shiftType,
      thenShiftType: shiftType,
    })
    .strict(),
  z
    .object({
      kind: z.literal('MutuallyExclusive'),
      shiftTypes: z.array(shiftType).min(2).max(B.maxShiftTypesInNode),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RequestHonoured'),
      requestType: z.string().min(1).max(B.maxIdentifierLength),
    })
    .strict(),
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
  z
    .object({ kind: z.literal('StaffOverLocumPriority'), windowDays: boundedInt(B.maxWindowDays) })
    .strict(),
  z
    .object({ kind: z.literal('LocumRestriction'), restriction: z.enum(LOCUM_RESTRICTION_VALUES) })
    .strict(),
  z
    .object({
      kind: z.literal('FixedAssignment'),
      assignmentIdentity: z.string().min(1).max(B.maxIdentifierLength),
    })
    .strict(),
  z.object({ kind: z.literal('ProtectedRange'), from: isoDate, to: isoDate }).strict(),
]);
export type RuleNodeWire = z.infer<typeof ruleNodeSchema>;

export const ruleScopeSchema = z
  .object({
    dateRange: z.object({ from: isoDate, to: isoDate }).strict().optional(),
    // Scope CARDINALITY (doc 34 §4-D): a scope is the multiplier on every
    // evaluation the rule will ever cost.
    shiftTypes: z.array(shiftType).max(B.maxScopeShiftTypes).optional(),
    staffGroups: z
      .array(z.string().min(1).max(B.maxIdentifierLength))
      .max(B.maxScopeStaffGroups)
      .optional(),
    memberships: z
      .array(z.string().min(1).max(B.maxIdentifierLength))
      .max(B.maxScopeMemberships)
      .optional(),
  })
  .strict();
export type RuleScopeWire = z.infer<typeof ruleScopeSchema>;

/**
 * The create/edit body. The hard/soft weight discipline is a refinement, mirrored
 * by the domain validation and the database CHECK: HARD must omit weight, SOFT
 * must carry a positive one.
 */
/**
 * The compare-and-set token (OPUS-M4-000C, doc 34 §4-D).
 *
 * Database-owned and monotonic: `app_maintain_catalogue_version` (migration
 * 0008) increments it on every UPDATE including a no-op one, and it is absent
 * from every UPDATE grant, so the application can neither forge nor rewind it.
 * The same integer is the rule's REVISION NUMBER in `rule_revisions`, which is
 * why there is one counter rather than two answers to the same question.
 */
export const ruleVersionSchema = z.number().int().positive();

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

/**
 * An AMENDMENT to an existing rule: the write body plus the version the author
 * was looking at.
 *
 * `expectedVersion` is REQUIRED, and required for the same reason FAD-22(2) made
 * `expectedPriorCurrentVersionId` required on publication: an optional
 * compare-and-set is indistinguishable from a caller that never thought about
 * concurrency, and "a stale edit is rejected, never merged blindly" (doc 07
 * §3.1) cannot hold when the check can simply be omitted.
 *
 * A `create` carries no version — there is nothing yet to be stale against.
 */
export const ruleAmendSchema = z
  .object({
    ruleKey,
    name: z.string().min(1).max(120),
    classification: z.enum(RULE_CLASSIFICATION_VALUES),
    weight: z.number().positive().optional(),
    scope: ruleScopeSchema,
    predicate: ruleNodeSchema,
    expectedVersion: ruleVersionSchema,
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
export type RuleAmendRequest = z.infer<typeof ruleAmendSchema>;

/** A rule set: an ordered list of rule keys the build references (doc 06 `rule_sets`). */
export const ruleSetWriteSchema = z
  .object({
    name: z.string().min(1).max(120),
    ruleKeys: z.array(ruleKey).min(1),
  })
  .strict();
export type RuleSetWriteRequest = z.infer<typeof ruleSetWriteSchema>;

/** A rule-set amendment. Same discipline, same reason. */
export const ruleSetAmendSchema = z
  .object({
    name: z.string().min(1).max(120),
    ruleKeys: z.array(ruleKey).min(1),
    expectedVersion: ruleVersionSchema,
  })
  .strict();
export type RuleSetAmendRequest = z.infer<typeof ruleSetAmendSchema>;

/**
 * `409 STALE_RULE` — the rule (or rule set) moved between the load and the save.
 *
 * The same shape as the publication surface's `STALE_REVIEW` (FAD-26): the code,
 * the CURRENT version so the editor can re-fetch, and an explicit message. It is
 * never a merge and never a silent overwrite.
 */
export const staleRuleBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('STALE_RULE'),
        message: z.string().min(1),
        currentVersion: ruleVersionSchema,
      })
      .strict(),
    correlationId: z.string().min(1),
  })
  .strict();
export type StaleRuleBody = z.infer<typeof staleRuleBodySchema>;

/** One historical revision of a rule (OPUS-M4-000C). Append-only history. */
export const ruleRevisionViewSchema = z
  .object({
    ruleKey,
    revision: ruleVersionSchema,
    ruleSchemaVersion: z.number().int().positive(),
    name: z.string(),
    classification: z.enum(RULE_CLASSIFICATION_VALUES),
    weight: z.number().positive().nullable(),
    state: z.enum(['active', 'disabled', 'archived']),
    recordedAt: z.string().min(1),
  })
  .strict();
export type RuleRevisionView = z.infer<typeof ruleRevisionViewSchema>;

export const ruleRevisionListSchema = z
  .object({ revisions: z.array(ruleRevisionViewSchema), correlationId: z.string().min(1) })
  .strict();
export type RuleRevisionList = z.infer<typeof ruleRevisionListSchema>;

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
    version: ruleVersionSchema,
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
    /**
     * The CAS token the editor loads and presents back on save, and the rule's
     * current revision number. One integer, two jobs, one source of truth.
     */
    version: ruleVersionSchema,
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

/**
 * The lifecycle move a state change requests. Archived is terminal.
 *
 * `expectedVersion` is REQUIRED here for the same reason it is on an amendment,
 * and with more at stake: archiving is terminal, so archiving a rule somebody
 * has just rewritten — without either of them being told — is the most
 * consequential last-write-wins on this surface.
 */
export const ruleStateRequestSchema = z
  .object({
    state: z.enum(['active', 'disabled', 'archived']),
    expectedVersion: ruleVersionSchema,
  })
  .strict();
export type RuleStateRequest = z.infer<typeof ruleStateRequestSchema>;
