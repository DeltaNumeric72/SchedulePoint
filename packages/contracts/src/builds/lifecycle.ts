import { z } from 'zod';

import { calendarDateSchema } from '../schedule/calendar-date.js';
import { uuidSchema } from '../identifiers.js';
import { solverStatusSchema, terminationReasonSchema } from '../solver/outcome.js';

/**
 * The build lifecycle's wire shapes (OPUS-M4-003; report 21 §4, SPEC-04 §2/§6/§7).
 *
 * ## The sixteen states are an enum, not a string
 *
 * Report 21 §4 governs the set, and it is written out here so that a client
 * cannot receive a seventeenth. The two dimensions the solver contract keeps
 * separate — `status` and `terminationReason` — stay separate here too and are
 * carried BESIDE the lifecycle state rather than folded into it. Three fields
 * instead of one is deliberate: `failed` alone cannot say whether a deadline, a
 * kill, a crash, or a refused result produced it, and the first caller who needs
 * one word will pick the nearest and lose the distinction permanently.
 *
 * ## `infeasible` is not `failed`
 *
 * The first is a statement about the problem; the second about the system. They
 * are different members of this enum and no client-side mapping collapses them.
 *
 * ## What is deliberately NOT here
 *
 * No free-text reason field anywhere. A cancellation carries an actor and a
 * timestamp; a readiness failure carries a CODE and identifiers. I-07 is not
 * relaxed because the surface is internal.
 */

export const buildRunStateSchema = z.enum([
  'draft_configuration',
  'validating',
  'readiness_check',
  'queued',
  'running',
  'completed',
  'completed_with_unmet_preferences',
  'infeasible',
  'failed',
  'cancelled',
  'reviewed',
  'progressively_extended',
  'approved',
  'applied_to_draft_schedule',
  'superseded',
  'archived',
]);
export type BuildRunStateWire = z.infer<typeof buildRunStateSchema>;

/** SPEC-04 §5's bounded tiers, including both honest degraded states. */
export const explanationStateSchema = z.enum([
  'EXPLAINED_EXACT',
  'EXPLAINED_SUBSET',
  'EXPLAINED_MINIMAL',
  'EXPLANATION_BUDGET_EXCEEDED',
  'EXPLANATION_UNAVAILABLE',
]);
export type ExplanationStateWire = z.infer<typeof explanationStateSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Configurations
 * ──────────────────────────────────────────────────────────────────────────── */

export const buildConfigurationSchema = z
  .object({
    id: uuidSchema,
    periodId: uuidSchema,
    name: z.string().min(1).max(120),
    randomSeed: z.number().int(),
    numSearchWorkers: z.number().int().positive(),
    maxTimeSeconds: z.number().positive(),
    /** `null` means "not pinned", which is honestly not reproducible (H-6). */
    maxDeterministicTime: z.number().positive().nullable(),
    interleaveSearch: z.boolean(),
    dispatchTimeoutMs: z.number().int().positive(),
    heartbeatTimeoutMs: z.number().int().positive(),
    retryLimit: z.number().int().min(0).max(10),
    /** Computed from the parameters, never declared (SPEC-04 §4). */
    reproducibilityMode: z.enum(['deterministic', 'best-effort']),
  })
  .strict();
export type BuildConfiguration = z.infer<typeof buildConfigurationSchema>;

export const createBuildConfigurationRequestSchema = z
  .object({
    periodId: uuidSchema,
    name: z.string().trim().min(1).max(120),
    randomSeed: z.number().int().min(0).max(2_147_483_647).optional(),
    numSearchWorkers: z.number().int().positive().max(64).optional(),
    maxTimeSeconds: z.number().positive().max(3600).optional(),
    maxDeterministicTime: z.number().positive().max(3600).nullable().optional(),
    interleaveSearch: z.boolean().optional(),
    dispatchTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    heartbeatTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    retryLimit: z.number().int().min(0).max(10).optional(),
  })
  .strict();
export type CreateBuildConfigurationRequest = z.infer<typeof createBuildConfigurationRequestSchema>;

export const buildConfigurationListSchema = z
  .object({
    configurations: z.array(buildConfigurationSchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type BuildConfigurationList = z.infer<typeof buildConfigurationListSchema>;

export const buildConfigurationResultSchema = z
  .object({ configuration: buildConfigurationSchema, correlationId: z.string().min(1) })
  .strict();
export type BuildConfigurationResult = z.infer<typeof buildConfigurationResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Findings — validation, readiness (T0), and the independent checker's
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One itemised refusal from `validating` or `readiness_check`.
 *
 * `code` is from a closed vocabulary and `detail` is system-authored. Report 21
 * requires both edges back to `draft_configuration` to be "itemised" and
 * "explained"; an unexplained bounce is what makes a scheduler retry the same
 * configuration until they give up.
 */
export const buildFindingSchema = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    /** The tier this finding came from. `T0` is SPEC-04 §5's structural pass. */
    tier: z.enum(['configuration', 'assembly', 'T0']),
    date: calendarDateSchema.nullable(),
    shiftTypeId: uuidSchema.nullable(),
    detail: z.string().min(1).max(2000),
  })
  .strict();
export type BuildFinding = z.infer<typeof buildFindingSchema>;

/** One independently measured HARD finding. Both kinds block (FAD-27). */
export const buildViolationSchema = z
  .object({
    finding: z.enum(['breach', 'not-evaluable']),
    ruleKey: z.string().min(1).max(200),
    nodeKind: z.string().min(1).max(100),
    field: z.string().min(1).max(200),
    explanation: z.string().min(1).max(2000),
  })
  .strict();
export type BuildViolation = z.infer<typeof buildViolationSchema>;

/** Why the independent checker refused a candidate (`candidate-validation.ts`). */
export const buildRejectionSchema = z
  .object({
    reason: z.enum([
      'input-hash-mismatch',
      'unknown-reference',
      'duplicate-assignment',
      'ineligible-assignment',
      /** OPUS-M4-004: a PINNED fixed input the candidate did not reproduce. */
      'protected-assignment-dropped',
      /**
       * OPUS-M4-004 repair F-14: demand the candidate left unmet, or a cell
       * nobody asked for that it staffed anyway.
       *
       * A reason the validator can produce and this enum cannot carry is a
       * refusal with no reason: the read path drops it, the client renders an
       * empty list, and a scheduler sees a candidate refused for nothing.
       */
      'demand-not-met',
      'hard-violation',
    ]),
    detail: z.string().min(1).max(2000),
  })
  .strict();
export type BuildRejection = z.infer<typeof buildRejectionSchema>;

/**
 * PO-DEC-13's four conflict classes, on the wire.
 *
 * Four, closed, in the decision's own severity order. `blocksApproval` and
 * `banded` travel WITH each conflict rather than being re-derived by the client:
 * a surface that had to look up whether a class blocks approval is a surface
 * that can look it up wrongly, and `fairness-outlier` — the one class with no
 * band at all, because no band is set until the M6 benchmark — is exactly the one a client would
 * be most tempted to render as a failure.
 */
export const conflictClassSchema = z.enum([
  'hard-breach',
  'unmet-demand',
  'eligibility-failure',
  'fairness-outlier',
]);
export type ConflictClassWire = z.infer<typeof conflictClassSchema>;

export const buildConflictSchema = z
  .object({
    conflictClass: conflictClassSchema,
    /** 1 is most severe. The list arrives sorted by it. */
    severityRank: z.number().int().positive(),
    blocksApproval: z.boolean(),
    /** `false` where no threshold is defined — a measurement, not a verdict. */
    banded: z.boolean(),
    /** Which producer raised it. Identifiers only; never user text. */
    source: z.enum(['violation', 'rejection', 'structural', 'demand', 'fairness']),
    code: z.string().min(1).max(200),
    subject: z.string().max(200).nullable(),
    detail: z.string().min(1).max(2000),
  })
  .strict();
export type BuildConflict = z.infer<typeof buildConflictSchema>;

/** One rule's recorded contribution: the SCALED weight it carried (doc 08 §3.4). */
export const objectiveComponentSchema = z
  .object({
    ruleKey: z.string().min(1).max(200),
    scaledWeight: z.number(),
  })
  .strict();
export type ObjectiveComponent = z.infer<typeof objectiveComponentSchema>;

export const objectiveTierSchema = z
  .object({
    /** The RANK. 1 carries the largest multiplier. */
    tier: z.number().int(),
    name: z.string().min(1).max(120),
    /** The tier's multiplier. Separate from the rank since OPUS-M4-004. */
    weightScale: z.number(),
    /** The global integer scaling factor in force (doc 08 §3.4). */
    scale: z.number().int().positive(),
    ruleKeys: z.array(z.string().min(1).max(200)),
    components: z.array(objectiveComponentSchema),
    unmappedRuleKeys: z.array(z.string().min(1).max(200)),
    termCount: z.number().int().nonnegative(),
  })
  .strict();
export type ObjectiveTier = z.infer<typeof objectiveTierSchema>;

/**
 * SPEC-04 §7's measurable metrics.
 *
 * Every band except `hardViolations = 0` is **undefined** until the benchmark
 * corpus is run, and saying so is the honest position — so nothing here carries
 * a threshold, a rating, or a colour. They are counts and ratios.
 */
export const buildQualityMetricsSchema = z
  .object({
    demandSatisfactionRate: z.number().min(0).max(1).nullable(),
    requiredSlots: z.number().int().nonnegative(),
    filledSlots: z.number().int().nonnegative(),
    hardViolations: z.number().int().nonnegative(),
    softPenaltyTotal: z.number().nullable(),
    solveWallClockMs: z.number().int().nonnegative(),
    /* OPUS-M4-004 — the rest of SPEC-04 §7's table. The two `null`s below are
     * load-bearing: requests are M5 and `TemplateAdherence` is fail-closed at M4
     * (FAD-27), so a `0` would claim every request was refused and every
     * template ignored. `null` says "not measured", which is what is true. */
    requestHonourRate: z.number().min(0).max(1).nullable(),
    templateAdherenceRate: z.number().min(0).max(1).nullable(),
    /** §7's `fairness_dispersion` — the coefficient of variation. Band-less. */
    fairnessDispersion: z.number().nullable(),
    /** The recorded basis. A dispersion whose basis is unstated is unreadable. */
    fairnessNormalisation: z.string().min(1).max(64),
    fairnessMeasuredParticipants: z.number().int().nonnegative(),
    /** Participants with no in-force FTE. Reported, never assumed full-time. */
    fairnessUnmeasuredParticipants: z.number().int().nonnegative(),
    explanationLatencyMs: z.number().int().nonnegative().nullable(),
    /** Two results are comparable iff same snapshot AND same digest. */
    objectiveWeightsDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    objectiveScale: z.number().int().nonnegative(),
    objectiveProfileId: z.string().max(64),
    /** SPEC-04 §4's search statistics. Counts and durations; never a model. */
    solverStatistics: z.record(z.string(), z.number().nullable()),
  })
  .strict();
export type BuildQualityMetrics = z.infer<typeof buildQualityMetricsSchema>;

/** What the T2 minimisation loop did, and what stopped it (SPEC-04 §5). */
export const explanationTier2Schema = z
  .object({
    attempted: z.boolean(),
    iterations: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    budgetSeconds: z.number().nonnegative(),
    maxIterations: z.number().int().nonnegative(),
    /** `true` when a cap bit before the pass completed — why the state degraded. */
    exhausted: z.boolean(),
  })
  .strict();
export type ExplanationTier2 = z.infer<typeof explanationTier2Schema>;

export const buildExplanationSchema = z
  .object({
    state: explanationStateSchema.nullable(),
    /** T0 structural findings — always attempted, exact when they fire. */
    structural: z.array(buildFindingSchema),
    /** T1/T2's conflicting subset. Minimal ONLY when the state says so. */
    conflictingRuleKeys: z.array(z.string().min(1).max(200)),
    tier2: explanationTier2Schema.nullable(),
    solveCount: z.number().int().nonnegative().nullable(),
    elapsedSeconds: z.number().nonnegative().nullable(),
  })
  .strict();
export type BuildExplanation = z.infer<typeof buildExplanationSchema>;

export const buildResultSchema = z
  .object({
    solverStatus: solverStatusSchema,
    terminationReason: terminationReasonSchema,
    /** The independent checker's verdict — never the worker's opinion. */
    usable: z.boolean(),
    candidateReturned: z.boolean(),
    assignmentCount: z.number().int().nonnegative(),
    objectiveValue: z.number().nullable(),
    elapsedMs: z.number().int().nonnegative(),
    quality: buildQualityMetricsSchema,
    objectiveTiers: z.array(objectiveTierSchema),
    explanation: buildExplanationSchema,
    rejections: z.array(buildRejectionSchema),
  })
  .strict();
export type BuildResult = z.infer<typeof buildResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Runs
 * ──────────────────────────────────────────────────────────────────────────── */

export const buildRunEventSchema = z
  .object({
    kind: z.enum(['transition', 'result_refused', 'heartbeat_reaped', 'claim', 'cancel_requested']),
    fromState: buildRunStateSchema.nullable(),
    toState: buildRunStateSchema.nullable(),
    claimEpoch: z.number().int().nonnegative(),
    currentClaimEpoch: z.number().int().nonnegative().nullable(),
    reason: z.string().max(64).nullable(),
    occurredAt: z.string().min(1),
  })
  .strict();
export type BuildRunEvent = z.infer<typeof buildRunEventSchema>;

export const buildRunSummarySchema = z
  .object({
    id: uuidSchema,
    periodId: uuidSchema,
    configurationId: uuidSchema,
    configurationName: z.string().min(1).max(120),
    candidateLabel: z.string().min(1).max(120),
    sourceVersionId: uuidSchema,
    state: buildRunStateSchema,
    solverStatus: solverStatusSchema.nullable(),
    terminationReason: terminationReasonSchema.nullable(),
    canonicalInputHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    claimEpoch: z.number().int().nonnegative(),
    heartbeatAt: z.string().min(1).nullable(),
    retryOfBuildRunId: uuidSchema.nullable(),
    retryAttempt: z.number().int().nonnegative(),
    retryLimit: z.number().int().nonnegative(),
    parentBuildIds: z.array(uuidSchema),
    appliedToVersionId: uuidSchema.nullable(),
    supersededByBuildRunId: uuidSchema.nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BuildRunSummary = z.infer<typeof buildRunSummarySchema>;

export const buildRunDetailSchema = z
  .object({
    run: buildRunSummarySchema,
    validationFindings: z.array(buildFindingSchema),
    readinessFindings: z.array(buildFindingSchema),
    result: buildResultSchema.nullable(),
    violations: z.array(buildViolationSchema),
    /**
     * PO-DEC-13's taxonomy over everything this build produced, sorted by
     * severity. A projection over `violations`, `result.rejections`,
     * `result.explanation.structural` and the measured quality — one classified
     * list, so a scheduler reads one ordering instead of reconciling four.
     */
    conflicts: z.array(buildConflictSchema),
    events: z.array(buildRunEventSchema),
    /**
     * The source draft's material-input digest AS IT IS NOW. The selection CAS
     * compares against it (FAD-26(2)'s review-digest precedent): a build posed
     * against a draft that has since been edited must not silently overwrite
     * the edit.
     */
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    reproducibility: z.enum(['deterministic', 'best-effort']).nullable(),
    correlationId: z.string().min(1),
  })
  .strict();
export type BuildRunDetail = z.infer<typeof buildRunDetailSchema>;

export const buildRunListSchema = z
  .object({ runs: z.array(buildRunSummarySchema), correlationId: z.string().min(1) })
  .strict();
export type BuildRunList = z.infer<typeof buildRunListSchema>;

export const buildRunResultSchema = z
  .object({ run: buildRunSummarySchema, correlationId: z.string().min(1) })
  .strict();
export type BuildRunResult = z.infer<typeof buildRunResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Comparison — D-4c's read-only projection
 * ──────────────────────────────────────────────────────────────────────────── */

export const candidateComparisonRowSchema = z
  .object({
    membershipId: uuidSchema,
    date: calendarDateSchema,
    shiftTypeId: uuidSchema,
    /** Which of the compared runs place this assignment. Ids, in request order. */
    inRunIds: z.array(uuidSchema),
  })
  .strict();
export type CandidateComparisonRow = z.infer<typeof candidateComparisonRowSchema>;

/**
 * **Comparability, as a first-class answer** (OPUS-M4-004; doc 35 §6f required
 * behaviour 1).
 *
 * > two results are comparable iff same snapshot + same weights, and the
 * > comparison service enforces exactly that.
 *
 * A refusal is a 200 carrying `comparable: false` and a reason rather than an
 * error, deliberately: the scheduler asked a legitimate question and the honest
 * answer is "these two cannot be put in one column, and here is why". An error
 * would read as a fault and invite a retry that cannot succeed.
 */
export const comparabilitySchema = z.discriminatedUnion('comparable', [
  z.object({ comparable: z.literal(true) }).strict(),
  z
    .object({
      comparable: z.literal(false),
      reason: z.enum(['cross-snapshot', 'weights-differ']),
    })
    .strict(),
]);
export type Comparability = z.infer<typeof comparabilitySchema>;

export const candidateComparisonSchema = z
  .object({
    runs: z.array(buildRunSummarySchema),
    quality: z.array(z.object({ runId: uuidSchema, quality: buildQualityMetricsSchema }).strict()),
    comparability: comparabilitySchema,
    /**
     * Only the rows that DIFFER; a full agreement projection is the empty list.
     * **Empty whenever `comparability.comparable` is false** — a difference list
     * across two different problems is a list of coincidences.
     */
    differences: z.array(candidateComparisonRowSchema),
    sharedAssignmentCount: z.number().int().nonnegative(),
    correlationId: z.string().min(1),
  })
  .strict();
export type CandidateComparison = z.infer<typeof candidateComparisonSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Requests
 * ──────────────────────────────────────────────────────────────────────────── */

/** The D-17 one-domain key shape, identical to `publication_records`. */
export const buildIdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);

export const createBuildRunRequestSchema = z
  .object({
    configurationId: uuidSchema,
    sourceVersionId: uuidSchema,
    candidateLabel: z.string().trim().min(1).max(120),
    idempotencyKey: buildIdempotencyKeySchema,
    /**
     * report 21 §5 / doc 08 §5. A progressive stage names the build it extends
     * and the assignment IDENTITIES it protects — recorded rather than inferred,
     * and expressed against the stable identity so protection survives a clone.
     */
    parentBuildIds: z.array(uuidSchema).max(50).optional(),
    protectedAssignmentIdentities: z.array(uuidSchema).max(5000).optional(),
    /** Set only by a retry. Bounded by the configuration's `retryLimit`. */
    retryOfBuildRunId: uuidSchema.optional(),
  })
  .strict();
export type CreateBuildRunRequest = z.infer<typeof createBuildRunRequestSchema>;

/**
 * Every state-changing request carries the state the caller believes the run is
 * in. Without it a stale tab's "Approve" lands on a build that has since been
 * superseded, and the transition guard's refusal reads as a bug rather than as
 * the answer to "did this move while you were looking at it?".
 */
export const buildTransitionRequestSchema = z
  .object({ expectedState: buildRunStateSchema })
  .strict();
export type BuildTransitionRequest = z.infer<typeof buildTransitionRequestSchema>;

export const applyBuildRequestSchema = z
  .object({
    expectedState: buildRunStateSchema,
    /** FAD-26(2)'s second compare-and-set: did the source draft move? */
    expectedSourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ApplyBuildRequest = z.infer<typeof applyBuildRequestSchema>;

export const applyBuildResultSchema = z
  .object({
    run: buildRunSummarySchema,
    /** The NEW draft. Never a published version, never the source (I-18). */
    draftVersionId: uuidSchema,
    assignmentsWritten: z.number().int().nonnegative(),
    /** R-8: how many written rows carried a real pick position through. */
    pickPositionsCarried: z.number().int().nonnegative(),
    correlationId: z.string().min(1),
  })
  .strict();
export type ApplyBuildResult = z.infer<typeof applyBuildResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Typed refusal bodies
 *
 * `errorEnvelopeSchema` is `.strict()`, so a body carrying an extra field never
 * parses as an envelope and would reach the client as `UNEXPECTED_RESPONSE`.
 * Each refusal that carries state therefore gets its own shape, parsed on the
 * way out and matched on the way in by BODY rather than by code.
 * ──────────────────────────────────────────────────────────────────────────── */

export const buildStateMovedBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('BUILD_STATE_MOVED'),
        message: z.string().min(1),
        currentState: buildRunStateSchema,
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type BuildStateMovedBody = z.infer<typeof buildStateMovedBodySchema>;

export const buildStaleSourceBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('STALE_BUILD_SOURCE'),
        message: z.string().min(1),
        currentSourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type BuildStaleSourceBody = z.infer<typeof buildStaleSourceBodySchema>;
