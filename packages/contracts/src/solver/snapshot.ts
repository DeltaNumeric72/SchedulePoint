import { z } from 'zod';

import { uuidSchema } from '../identifiers.js';

/**
 * The canonical solver input snapshot, as a wire contract (OPUS-M4-001;
 * SPEC-04 §3.4, doc 35 §6a).
 *
 * ## Why the shape is defined here as well as in the domain
 *
 * `packages/domain/src/ports/solver-snapshot.ts` defines the snapshot as a
 * TypeScript type — which is erased at runtime and therefore proves nothing
 * about a document that has been through PostgreSQL's `jsonb` and back, or
 * through a Python worker, or through an HTTP body. This is the runtime
 * definition, and it is what lets a test assert that the *persisted* payload is
 * still exactly the document that was assembled rather than something that
 * merely type-checks.
 *
 * The two are held together by `apps/api/test/solver/snapshot-contract.test.ts`,
 * which parses a real assembled document against this schema. A schema nothing
 * parses is a second definition waiting to drift; a schema a proof parses is the
 * one that catches the drift.
 *
 * ## `.strict()` everywhere, and why that matters more here than usual
 *
 * An unknown key in a snapshot is not a harmless extra: the canonical input hash
 * covers the whole document, so a field that arrived by accident changes the
 * hash and makes an otherwise identical build look like a different problem —
 * and a field that arrived *deliberately* would be an input the solver consumes
 * and nothing reviewed. Rejecting unknown keys is the wire half of "the
 * constituent list is closed".
 */

/** A revisioned constituent: what the build consumed, and at which revision. */
export const snapshotConstituentSchema = z
  .object({
    kind: z.enum([
      'rule',
      'shiftType',
      'location',
      'qualification',
      'shiftTypeQualification',
      'weekdayDemand',
      'requirement',
      'qualificationHolding',
      'timezoneBasis',
      'period',
      'version',
      /* v2 (OPUS-M4-002, FAD-38). Appended, mirroring
       * `SNAPSHOT_CONSTITUENT_KINDS`; `constituent-kind-parity` in
       * `apps/api/test/solver/snapshot-contract.test.ts` asserts the two lists
       * are the same list. */
      'staffGroup',
      'validGroup',
    ]),
    /** The STABLE identifier where one exists, the surrogate id otherwise. */
    key: z.string().min(1),
    /**
     * Text, not a number. The counters are not all integers — the catalogue
     * tables carry `integer` and the schedule spine carries `xid8` rendered as
     * decimal — and coercing a 64-bit counter through a float64 is a silent
     * precision loss at exactly the value a citation depends on.
     */
    revision: z.string().min(1),
  })
  .strict();

export type SnapshotConstituentWire = z.infer<typeof snapshotConstituentSchema>;

/** `YYYY-MM-DD`. Shape only; whether it is a REAL date is the domain's calendar. */
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const snapshotTimezoneSchema = z
  .object({
    basis: z.string().min(1).max(64),
    tzdbVersion: z.string().min(1).max(32),
    /** A fallback is visible in the record, never disguised as a snapshot. */
    source: z.enum(['version-snapshot', 'group-current']),
  })
  .strict();

export const snapshotLocationSchema = z
  .object({
    locationId: uuidSchema,
    name: z.string().min(1),
    status: z.enum(['active', 'archived']),
    /** Display metadata only — the GROUP timezone governs (R-B3, FAD-31). */
    timezone: z.string().nullable(),
  })
  .strict();

export const snapshotShiftTypeSchema = z
  .object({
    shiftTypeId: uuidSchema,
    code: z.string().min(1),
    startTime: z.string(),
    endTime: z.string(),
    crossesMidnight: z.boolean(),
    isManualOnly: z.boolean(),
    /** `shift_types.is_on_call` — what makes CallSpacing decidable (v2, FAD-39). */
    isOnCall: z.boolean(),
    /** `numeric` as text, so `1.0` and `1.00` are not silently made equal. */
    creditWeight: z.string(),
    status: z.enum(['active', 'retired']),
    requiredQualificationIds: z.array(uuidSchema),
  })
  .strict();

export const snapshotDemandCellSchema = z
  .object({
    source: z.enum(['weekday-default', 'period-requirement']),
    shiftTypeId: uuidSchema,
    /** A weekday token for a default, a calendar date for a requirement. */
    on: z.string().min(1),
    requiredCount: z.number().int().nonnegative(),
  })
  .strict();

export const snapshotWeekdayTargetSchema = z
  .object({
    day: z.string().min(1),
    fteFraction: z.number(),
    maxAssignments: z.number().int().nullable(),
  })
  .strict();

export const snapshotWorkProfileSchema = z
  .object({
    workProfileId: uuidSchema,
    effectiveFrom: z.string().min(1),
    effectiveTo: z.string().nullable(),
    workPercentage: z.number(),
    maxAssignmentsPerWeek: z.number().int().nullable(),
    maxAssignmentsPerPeriod: z.number().int().nullable(),
    maxConsecutiveDays: z.number().int().nullable(),
    weekdayTargets: z.array(snapshotWeekdayTargetSchema),
  })
  .strict();

/**
 * A credential holding, narrowed to what a build needs.
 *
 * `evidence_ref` is deliberately absent. It is the free-text field a certificate
 * reference would live in, it is `SENSITIVE-PII`, and no solver decision depends
 * on it — so it does not enter the snapshot, is not persisted in it, and never
 * crosses to the worker (I-07, non-bypass rule 9). The absence is enforced by
 * `.strict()`: a future assembly that started carrying it would fail this parse.
 */
export const snapshotHoldingSchema = z
  .object({
    qualificationId: uuidSchema,
    validFrom: z.string().min(1),
    validUntil: z.string().nullable(),
    status: z.string().min(1),
  })
  .strict();

export const snapshotEligibilitySchema = z
  .object({
    shiftTypeId: uuidSchema,
    /** True only when the verdict holds on EVERY date in the period. */
    eligible: z.boolean(),
    /** `qualificationId:outcome`, sorted, so a refusal can be explained. */
    outcomes: z.array(z.string()),
  })
  .strict();

export const snapshotParticipantSchema = z
  .object({
    membershipId: uuidSchema,
    membershipKind: z.enum(['organization', 'group']),
    staffingKind: z.enum(['staff', 'locum']),
    status: z.enum(['invited', 'active', 'suspended', 'ended']),
    validFrom: z.string().min(1),
    validTo: z.string().nullable(),
    workProfile: snapshotWorkProfileSchema.nullable(),
    holdings: z.array(snapshotHoldingSchema),
    eligibility: z.array(snapshotEligibilitySchema),
  })
  .strict();

export const snapshotFixedAssignmentSchema = z
  .object({
    assignmentIdentityId: uuidSchema,
    membershipId: uuidSchema,
    date: calendarDate,
    shiftTypeId: uuidSchema,
    locationId: uuidSchema.nullable(),
    isPinned: z.boolean(),
    origin: z.enum(['manual', 'clone', 'solver', 'picklist']),
    creditedMembershipId: uuidSchema.nullable(),
    creditWeight: z.string().nullable(),
  })
  .strict();

export const snapshotRuleRevisionSchema = z
  .object({
    ruleKey: z.string().min(1),
    revision: z.string().min(1),
    ruleSchemaVersion: z.number().int().positive(),
    classification: z.enum(['HARD', 'SOFT']),
    category: z.enum(['general', 'pattern', 'staff']),
    weight: z.string().nullable(),
    status: z.enum(['active', 'disabled', 'archived']),
    /** The stored AST, passed through unchanged so a revision is reconstructable. */
    scope: z.unknown(),
    predicate: z.unknown(),
  })
  .strict();

/* ── snapshot v2 vocabularies (OPUS-M4-002, FAD-38) ──────────────────────────
 *
 * The runtime half of the three additions. `.strict()` for the same reason every
 * other object here is: an unknown key changes the canonical hash, so a field
 * that arrived by accident makes an identical build look like a different
 * problem. Each schema carries the STABLE identifier the ruling names and no
 * display name — `staff_groups.name` is mutable and a rename must not move a
 * rule's historical meaning. */

export const snapshotStaffGroupSchema = z
  .object({
    /** `staff_groups.id` — RK-RULING-02's identifier domain. Never the name. */
    staffGroupId: uuidSchema,
    memberMembershipIds: z.array(uuidSchema),
  })
  .strict();

export const snapshotValidGroupSchema = z
  .object({
    /** `valid_groups.id` — RK-RULING-03's identifier domain. */
    validGroupId: uuidSchema,
    /** Ascending, distinct — migration 0005's trigger owns the shape. */
    allowedPickPositions: z.array(z.number().int().nonnegative()),
    shiftTypeIds: z.array(uuidSchema),
  })
  .strict();

/**
 * The qualification vocabulary — the id↔key↔status triple.
 *
 * `requires_expiry` and `evidence_ref` are absent and the absence is enforced by
 * `.strict()`: the first is a write-time control (0012/0017) no evaluation
 * consults, and the second is the `SENSITIVE-PII` free-text field that must
 * never cross this boundary (I-07, non-bypass rule 9).
 */
export const snapshotQualificationSchema = z
  .object({
    qualificationId: uuidSchema,
    /** `qualifications.key` — the domain the AST's `qualification` field names. */
    key: z.string().min(1),
    status: z.string().min(1),
  })
  .strict();

/** **The whole document.** What the hash covers and what the worker receives. */
export const solverInputSnapshotSchema = z
  .object({
    snapshotSchemaVersion: z.number().int().positive(),
    compilerVersion: z.number().int().nonnegative(),
    ruleSchemaVersion: z.number().int().positive(),

    organizationId: uuidSchema,
    groupId: uuidSchema,
    periodId: uuidSchema,
    versionId: uuidSchema,
    periodName: z.string().min(1),
    periodStatus: z.enum(['planning', 'published', 'closed']),

    startDate: calendarDate,
    endDate: calendarDate,
    dayCount: z.number().int().nonnegative(),
    timezone: snapshotTimezoneSchema,

    locations: z.array(snapshotLocationSchema),
    shiftTypes: z.array(snapshotShiftTypeSchema),
    demand: z.array(snapshotDemandCellSchema),
    participants: z.array(snapshotParticipantSchema),
    fixedAssignments: z.array(snapshotFixedAssignmentSchema),
    ruleRevisions: z.array(snapshotRuleRevisionSchema),

    /* v2 (FAD-38) — appended, required, never optional. An optional field would
     * make "this group has no staff groups" and "the assembly forgot to carry
     * them" the same document, and those two answers disagree about every
     * staff-group-scoped rule. `snapshotSchemaVersion` 2 is what lets them be
     * required: a v1 document is refused by version rather than misread. */
    staffGroups: z.array(snapshotStaffGroupSchema),
    validGroups: z.array(snapshotValidGroupSchema),
    qualifications: z.array(snapshotQualificationSchema),

    constituents: z.array(snapshotConstituentSchema),
  })
  .strict();

export type SolverInputSnapshotWire = z.infer<typeof solverInputSnapshotSchema>;
