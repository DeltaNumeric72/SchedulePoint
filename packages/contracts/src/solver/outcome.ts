import { z } from 'zod';

import { uuidSchema } from '../identifiers.js';

/**
 * The solve outcome and the reproducibility record, as wire contracts
 * (OPUS-M4-001; SPEC-04 §2 and §4).
 *
 * ## The two dimensions never collapse
 *
 * SPEC-04 §2: "**`FEASIBLE` and `UNKNOWN` are never collapsed into 'done'** — a
 * timed-out run must not be reported as a completed one." The status and the
 * termination reason are therefore separate enums on the wire, not one flattened
 * "state" that a client would have to reverse-engineer. A flattened field is how
 * "cancelled" quietly becomes "failed" three layers later: somebody needs one
 * word, picks the nearest, and the distinction is gone from that point on.
 *
 * Whether a *pair* of them is truthful is decided in the domain
 * (`isTerminalOutcomeHonest`), not here. Zod can say the words are in the
 * vocabulary; it cannot say that `CANCELLED` with reason `deadline` is a lie,
 * and encoding that rule twice would make one of the two the one that drifts.
 */

export const solverStatusSchema = z.enum([
  'OPTIMAL',
  'FEASIBLE',
  'INFEASIBLE',
  'MODEL_INVALID',
  'UNKNOWN',
  'CANCELLED',
  'TIMEOUT',
  'FAILED',
]);
export type SolverStatusWire = z.infer<typeof solverStatusSchema>;

export const terminationReasonSchema = z.enum([
  'completed',
  'deadline',
  'user_cancelled',
  /** Never self-reported: a terminated worker writes nothing. The parent attributes it. */
  'killed',
  'crashed',
  'rejected',
]);
export type TerminationReasonWire = z.infer<typeof terminationReasonSchema>;

/**
 * The parameters a build was run with.
 *
 * Every field SPEC-04 §4 (amended, FAD-10) requires pinned for a reproducibility
 * claim, and they are all present even on a run that makes no such claim —
 * because "we did not pin the deterministic time limit" is exactly the fact
 * somebody investigating an unreproducible result needs to see.
 */
export const solverParametersSchema = z
  .object({
    randomSeed: z.number().int(),
    numSearchWorkers: z.number().int().positive(),
    maxTimeInSeconds: z.number().positive(),
    /** `null` means "not pinned", which is not reproducible (H-6). */
    maxDeterministicTime: z.number().positive().nullable(),
    /** CP-SAT's deterministic portfolio. `false` is not reproducible (H-6). */
    interleaveSearch: z.boolean(),
  })
  .strict();
export type SolverParametersWire = z.infer<typeof solverParametersSchema>;

/**
 * SPEC-04 §4's per-build record.
 *
 * `reproducibilityMode` is a **computed** verdict over the parameters, never a
 * flag a caller sets. The amendment exists because the claim was being made
 * without the conditions: five runs, one seed, eight workers, five different
 * schedules.
 *
 * `imageDigest` may read `venv:…` or `unknown`. Those are recorded absences and
 * are deliberately representable: a fabricated digest would make a build look
 * reproducible against an image that never existed, which is worse than a gap
 * because it is actionable and wrong.
 */
export const solverRuntimeRecordSchema = z
  .object({
    imageDigest: z.string().min(1),
    solverVersion: z.string().min(1),
    compilerVersion: z.string().min(1),
    platformArch: z.string().min(1),
    languageRuntime: z.string().min(1),
    reproducibilityMode: z.enum(['deterministic', 'best-effort']),
  })
  .strict();
export type SolverRuntimeRecordWire = z.infer<typeof solverRuntimeRecordSchema>;

export const solverCandidateAssignmentSchema = z
  .object({
    membershipId: uuidSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shiftTypeId: uuidSchema,
    locationId: uuidSchema.nullable(),
  })
  .strict();

/**
 * What a build reports.
 *
 * `assignments` is nullable and that nullability is load-bearing: a `CANCELLED`,
 * `TIMEOUT`, `INFEASIBLE` or `FAILED` run has no candidate, and an empty array
 * would say "a schedule with no assignments" — which is a *valid-looking answer*
 * and the single most dangerous thing this pipeline could return.
 */
export const solverOutcomeSchema = z
  .object({
    snapshotId: uuidSchema,
    canonicalInputHash: z.string().regex(/^[0-9a-f]{64}$/),
    status: solverStatusSchema,
    terminationReason: terminationReasonSchema,
    assignments: z.array(solverCandidateAssignmentSchema).nullable(),
    runtime: solverRuntimeRecordSchema,
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

export type SolverOutcomeWire = z.infer<typeof solverOutcomeSchema>;
