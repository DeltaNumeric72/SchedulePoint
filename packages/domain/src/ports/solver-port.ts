/**
 * The solver port — **SPEC-04 §§1–2**, doc 35 §6a (OPUS-M4-001).
 *
 * The *interface* and every decision that can be made without I/O live here; the
 * *implementation* — a subprocess, a protocol, a MAC, a kill — lives in
 * `apps/api/src/solver/`, and `.dependency-cruiser.cjs`'s `domain-imports-nothing`
 * rule makes it impossible for that direction to reverse. SPEC-04 §1 is explicit
 * about why that matters: **"no domain module imports the solver or knows it is
 * Python"**. Nothing in this file names Python, OR-Tools, CP-SAT, a process, a
 * socket, or a file.
 *
 * ## The vocabulary is the point
 *
 * SPEC-04 §2's verified-status mapping says CP-SAT's `OPTIMAL`, `FEASIBLE`,
 * `INFEASIBLE`, `MODEL_INVALID` and `UNKNOWN` "map to distinct build outcomes"
 * and that **`FEASIBLE` and `UNKNOWN` are never collapsed into 'done'**. The
 * spike found the harder half of that (EV-M0-SPC H-6, and the H-4/H-5
 * cancellation measurements): a *cancelled* solve and a *timed-out* solve and a
 * *killed* solve are three different facts, and the tempting simplification —
 * "the process went away, call it failed" — destroys the one thing a scheduler
 * needs to decide what to do next.
 *
 * So {@link SOLVER_STATUSES} and {@link TERMINATION_REASONS} are closed sets,
 * they are disjoint dimensions, and {@link isTerminalOutcomeHonest} refuses the
 * combinations that would be a lie. A `CANCELLED` outcome reported with reason
 * `deadline` is not a rounding error; it is the system telling a scheduler their
 * cancel button did nothing when it worked.
 *
 * ## Why the response decision is pure and total
 *
 * The worker is the least trusted component in the platform that the platform
 * itself ships: it parses a payload, runs a native library, and writes bytes
 * back. {@link solverResponseVerdict} is the whole "may I believe this?"
 * decision, expressed over a parsed value and a byte length, with no I/O — so
 * every refusal class can be enumerated in a test without a subprocess, and the
 * client cannot accidentally have a *different* opinion from the one that was
 * tested. The same split as `provider-boundary.ts`: the decision here, the
 * observation injected.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Protocol versioning (SPEC-04 §1.2)
 * ──────────────────────────────────────────────────────────────────────────── */

/** The protocol version this build speaks. */
export const SOLVER_PROTOCOL_VERSION = 1;

/**
 * The bounded window the platform accepts.
 *
 * SPEC-04 §1.2: the worker "accepts a bounded window of versions and **rejects
 * anything outside it rather than guessing**". The window is stated on both
 * sides — the worker enforces its own copy — so a rolling deploy is safe in both
 * directions and a protocol change is a deliberate, reviewed event rather than a
 * field that quietly started meaning something else.
 */
export const SUPPORTED_SOLVER_PROTOCOL_VERSIONS: readonly number[] = [1];

/**
 * The version of the canonical-input document shape (doc 35 §6a).
 *
 * **`2` since OPUS-M4-002 (FAD-38).** v2 APPENDS three vocabularies — staff
 * groups with their members, valid groups with their shift types, and the
 * qualification id↔key↔status triple — that RK-RULING-02/03 and CP-SAT modelling
 * of `RequiresQualification` require and that v1 could not reach. Nothing was
 * removed or reshaped.
 *
 * The bump is what makes the new fields safe to require rather than optional: a
 * v1 document is **refused by version** on both sides rather than read as a v2
 * document that happens to be missing three vocabularies. `SPEC-04 §1.2`'s rule
 * — reject outside the window, never guess — applied to the document as well as
 * to the envelope.
 */
export const SOLVER_SNAPSHOT_SCHEMA_VERSION = 2;

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Outcome vocabulary (SPEC-04 §2)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The solver-neutral statuses. A one-to-one image of SPEC-04 §2's verified
 * mapping plus the two the platform owns, and nothing is collapsed.
 *
 * `CANCELLED` and `TIMEOUT` are separate from `UNKNOWN` deliberately. CP-SAT
 * reports `UNKNOWN` for "I stopped without deciding", which is true of a
 * deadline, of a cancel, and of a wedged solve that was killed — three
 * situations with three different next actions (widen the budget / do nothing /
 * investigate). Reporting one word for all three is how a product acquires a
 * reputation for "sometimes it just doesn't work".
 */
export const SOLVER_STATUSES = [
  'OPTIMAL',
  'FEASIBLE',
  'INFEASIBLE',
  'MODEL_INVALID',
  'UNKNOWN',
  'CANCELLED',
  'TIMEOUT',
  'FAILED',
] as const;
export type SolverStatus = (typeof SOLVER_STATUSES)[number];

/**
 * SPEC-04 §2's `termination_reason ∈ {deadline, user_cancelled, killed, crashed}`,
 * plus `completed` for the ordinary case and `rejected` for a request the worker
 * refused before solving anything.
 *
 * **`killed` is never self-reported.** A terminated process writes nothing; the
 * parent attributes it. Recorded here so the vocabulary is complete in one
 * place, exactly as the spike's protocol module records it.
 */
export const TERMINATION_REASONS = [
  'completed',
  'deadline',
  'user_cancelled',
  'killed',
  'crashed',
  'rejected',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * The combinations that would be a lie, enumerated.
 *
 * EV-M0-SPC H-6 is the finding this encodes: a cancelled solve reported as a
 * timeout (or as a plain failure) is worse than an error, because it is
 * *plausible*. A scheduler who cancelled and was told "the solve timed out"
 * concludes the problem is too hard and raises the budget, which is the exact
 * opposite of what happened.
 *
 * @returns `true` when the pair is a truthful description of what occurred.
 */
export function isTerminalOutcomeHonest(
  status: SolverStatus,
  reason: TerminationReason,
): boolean {
  switch (status) {
    /* A decided solve completed. It cannot also have been cancelled, deadlined,
     * killed, crashed or rejected — every one of those means it did NOT decide. */
    case 'OPTIMAL':
    case 'INFEASIBLE':
    case 'MODEL_INVALID':
      return reason === 'completed';
    /* FEASIBLE is the interesting one: an incumbent may be in hand because the
     * search finished its portfolio, because the deadline arrived, or because the
     * user cancelled. All three are truthful; `killed` and `crashed` are not,
     * because a killed or crashed worker returns nothing at all. */
    case 'FEASIBLE':
      return reason === 'completed' || reason === 'deadline' || reason === 'user_cancelled';
    /* Stopped without deciding, by its own portfolio exhausting the budget. */
    case 'UNKNOWN':
      return reason === 'completed' || reason === 'deadline';
    case 'CANCELLED':
      return reason === 'user_cancelled';
    case 'TIMEOUT':
      return reason === 'deadline';
    /* The parent's attributions: a worker that died, was terminated, or refused. */
    case 'FAILED':
      return reason === 'killed' || reason === 'crashed' || reason === 'rejected';
    default:
      return false;
  }
}

/** Raised when a worker reports a status/reason pair that cannot both be true. */
export class DishonestSolverOutcomeError extends Error {
  readonly code = 'SOLVER_OUTCOME_DISHONEST';

  constructor(
    readonly status: string,
    readonly terminationReason: string,
  ) {
    super(
      `SOLVER_OUTCOME_DISHONEST: a solve cannot be ${status} and terminate for reason ` +
        `${terminationReason}. SPEC-04 §2: cancelled, timed-out and killed solves are ` +
        'three distinct outcomes and are never conflated (EV-M0-SPC H-6).',
    );
    this.name = 'DishonestSolverOutcomeError';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The port
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What the caller hands the port.
 *
 * `snapshotPayload` is the canonical input document — the *whole* problem. The
 * worker receives it and nothing else: **no database handle, no credential, no
 * connection string** (SPEC-04 §1.1, S-15t). That is not a convention the
 * implementation may relax; it is why a compromised worker cannot reach tenant
 * data at all.
 *
 * The context ids are **labels for attribution, not authorization** (SPEC-04
 * §1.1). Authorization happened before dispatch; the worker echoes them and
 * never branches on them.
 */
export interface SolveRequestSpec {
  readonly protocolVersion: number;
  readonly organizationId: string;
  readonly groupId: string;
  readonly buildRunId: string;
  readonly correlationId: string;
  /** The persisted snapshot's identity and hash — what makes a solve re-runnable. */
  readonly snapshotId: string;
  readonly canonicalInputHash: string;
  readonly snapshotPayload: unknown;
  readonly parameters: SolverParameters;
}

/**
 * The reproducibility record SPEC-04 §4 requires, as parameters.
 *
 * The AMENDED §4 (FAD-10, from EV-M0-SPC H-6/H-7) is what these fields encode:
 * seed plus worker count is **not** sufficient, so a build that claims
 * reproducibility must pin `interleaveSearch` (the deterministic portfolio) and
 * use a **deterministic** time limit rather than a wall clock. Both are here,
 * both are recorded, and {@link reproducibilityMode} refuses to call a run
 * reproducible when they are not set.
 */
export interface SolverParameters {
  readonly randomSeed: number;
  readonly numSearchWorkers: number;
  /** Wall-clock seconds. The ordinary budget; never a reproducibility basis. */
  readonly maxTimeInSeconds: number;
  /** Deterministic time units. `null` means "not pinned", which is not reproducible. */
  readonly maxDeterministicTime: number | null;
  /** CP-SAT's deterministic portfolio. `false` is not reproducible (H-6). */
  readonly interleaveSearch: boolean;
}

/**
 * `'deterministic'` only when every condition SPEC-04 §4 (amended) names is met.
 *
 * Stated as a computed verdict rather than a flag a caller sets, because a flag
 * a caller sets is a claim, and the whole point of the amendment is that the
 * claim was being made without the conditions. Five runs, one seed, eight
 * workers, five different schedules.
 */
export function reproducibilityMode(
  parameters: SolverParameters,
): 'deterministic' | 'best-effort' {
  if (!parameters.interleaveSearch) return 'best-effort';
  if (parameters.maxDeterministicTime === null) return 'best-effort';
  return 'deterministic';
}

/** One assignment the solver proposes. Solver-neutral; no engine type appears. */
export interface SolverCandidateAssignment {
  readonly membershipId: string;
  readonly date: string;
  readonly shiftTypeId: string;
  readonly locationId: string | null;
}

/** The runtime facts SPEC-04 §4 requires recorded for every build. */
export interface SolverRuntimeRecord {
  /** The image the solve ran in, by content digest, or a recorded absence. */
  readonly imageDigest: string;
  readonly solverVersion: string;
  readonly compilerVersion: string;
  readonly platformArch: string;
  readonly languageRuntime: string;
  readonly reproducibilityMode: 'deterministic' | 'best-effort';
}

/** What the port returns. Never `undefined`, never a thrown "probably fine". */
export interface SolveOutcome {
  readonly status: SolverStatus;
  readonly terminationReason: TerminationReason;
  readonly canonicalInputHash: string;
  readonly assignments: readonly SolverCandidateAssignment[] | null;
  readonly runtime: SolverRuntimeRecord;
  /** Parent-observed wall clock, milliseconds. For the operator, not for logic. */
  readonly elapsedMs: number;
}

/**
 * **The port.** One method, because there is one thing to ask.
 *
 * A cancellation is requested through the handle the implementation returns from
 * its own control channel; the port itself does not expose a `cancel()` that
 * could be called on a different solve by mistake.
 */
export interface SolverPort {
  solve(request: SolveRequestSpec): Promise<SolveOutcome>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Believing the worker — the pure decision
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The largest response the platform will read, in bytes.
 *
 * A bound rather than "whatever arrives", because the worker is a separate
 * process that could, through a defect or a compromise, produce an unbounded
 * stream — and a parent that reads until EOF has handed an untrusted child the
 * ability to exhaust the API's memory. One megabyte is far above any stub or
 * corpus-scale candidate set and far below anything that threatens the process.
 * The number is here, in the tested decision, and not spelled a second time in
 * the client.
 */
export const MAX_SOLVER_RESPONSE_BYTES = 1_048_576;

/** Why a worker response was refused. Each arm is a separate operational event. */
export type SolverResponseRefusal =
  | { readonly reason: 'oversized'; readonly bytes: number; readonly limit: number }
  | { readonly reason: 'malformed' }
  | { readonly reason: 'unsupported-protocol-version'; readonly version: unknown }
  | { readonly reason: 'unknown-status'; readonly status: unknown }
  | { readonly reason: 'unknown-termination-reason'; readonly terminationReason: unknown }
  | {
      readonly reason: 'dishonest-outcome';
      readonly status: SolverStatus;
      readonly terminationReason: TerminationReason;
    }
  | {
      readonly reason: 'input-hash-mismatch';
      readonly expected: string;
      readonly actual: unknown;
    }
  | { readonly reason: 'unauthenticated' };

export type SolverResponseVerdict =
  | { readonly outcome: 'accepted'; readonly status: SolverStatus; readonly terminationReason: TerminationReason }
  | { readonly outcome: 'refused'; readonly refusal: SolverResponseRefusal };

/**
 * The whole "may I believe this response?" decision.
 *
 * Pure and total over a parsed value, a byte length and the two things the
 * caller already knows (the hash it sent, and whether the response's own
 * authentication verified). Ordered so the cheapest and most structural checks
 * refuse first, and so a forged payload never reaches the honesty check with a
 * status it invented.
 *
 * The authentication result is a PARAMETER rather than something computed here:
 * a MAC needs a secret and a constant-time comparison, both of which are
 * infrastructure. The decision that an unauthenticated response is refused is
 * not infrastructure, and it lives here where a test can enumerate it.
 */
export function solverResponseVerdict(input: {
  readonly parsed: unknown;
  readonly bytes: number;
  readonly expectedInputHash: string;
  readonly authenticated: boolean;
  readonly limit?: number;
}): SolverResponseVerdict {
  const limit = input.limit ?? MAX_SOLVER_RESPONSE_BYTES;
  if (input.bytes > limit) {
    return { outcome: 'refused', refusal: { reason: 'oversized', bytes: input.bytes, limit } };
  }
  if (typeof input.parsed !== 'object' || input.parsed === null || Array.isArray(input.parsed)) {
    return { outcome: 'refused', refusal: { reason: 'malformed' } };
  }
  const body = input.parsed as Record<string, unknown>;

  const version = body['protocolVersion'];
  if (typeof version !== 'number' || !SUPPORTED_SOLVER_PROTOCOL_VERSIONS.includes(version)) {
    return {
      outcome: 'refused',
      refusal: { reason: 'unsupported-protocol-version', version },
    };
  }

  /* Authentication is checked AFTER the version window on purpose: a response
   * from an incompatible protocol may legitimately not carry a MAC this build
   * knows how to verify, and reporting "unauthenticated" for it would send an
   * operator hunting a security incident that is a deploy-ordering mistake. */
  if (!input.authenticated) {
    return { outcome: 'refused', refusal: { reason: 'unauthenticated' } };
  }

  const status = body['status'];
  if (typeof status !== 'string' || !(SOLVER_STATUSES as readonly string[]).includes(status)) {
    return { outcome: 'refused', refusal: { reason: 'unknown-status', status } };
  }
  const terminationReason = body['terminationReason'];
  if (
    typeof terminationReason !== 'string' ||
    !(TERMINATION_REASONS as readonly string[]).includes(terminationReason)
  ) {
    return {
      outcome: 'refused',
      refusal: { reason: 'unknown-termination-reason', terminationReason },
    };
  }

  const hash = body['canonicalInputHash'];
  if (hash !== input.expectedInputHash) {
    return {
      outcome: 'refused',
      refusal: { reason: 'input-hash-mismatch', expected: input.expectedInputHash, actual: hash },
    };
  }

  const typedStatus = status as SolverStatus;
  const typedReason = terminationReason as TerminationReason;
  if (!isTerminalOutcomeHonest(typedStatus, typedReason)) {
    return {
      outcome: 'refused',
      refusal: { reason: 'dishonest-outcome', status: typedStatus, terminationReason: typedReason },
    };
  }

  return { outcome: 'accepted', status: typedStatus, terminationReason: typedReason };
}

/** Raised when the worker's response is not believable. Names no payload (I-07). */
export class SolverResponseRejectedError extends Error {
  readonly code = 'SOLVER_RESPONSE_REJECTED';

  constructor(readonly refusal: SolverResponseRefusal) {
    super(`SOLVER_RESPONSE_REJECTED: ${describeRefusal(refusal)}`);
    this.name = 'SolverResponseRejectedError';
  }
}

/**
 * A short, payload-free description of a refusal.
 *
 * Deliberately prints structure and never content: a byte count, a limit, a
 * status word, a hash. Non-bypass rule 9 and I-07 apply to the solver boundary
 * exactly as they apply to notification delivery — the problem document is the
 * whole schedule, and an error message that quoted it would put a group's entire
 * staffing input into a log line.
 */
function describeRefusal(refusal: SolverResponseRefusal): string {
  switch (refusal.reason) {
    case 'oversized':
      return `worker response was ${String(refusal.bytes)} bytes, over the ${String(refusal.limit)}-byte limit`;
    case 'malformed':
      return 'worker response was not a JSON object';
    case 'unsupported-protocol-version':
      return `worker response protocol version is outside the supported window ${JSON.stringify(SUPPORTED_SOLVER_PROTOCOL_VERSIONS)}`;
    case 'unknown-status':
      return 'worker response carried a status outside the closed set';
    case 'unknown-termination-reason':
      return 'worker response carried a termination reason outside the closed set';
    case 'dishonest-outcome':
      return `worker reported ${refusal.status} with termination reason ${refusal.terminationReason}, which cannot both be true (SPEC-04 §2)`;
    case 'input-hash-mismatch':
      return 'worker response named a different canonical input hash than the one dispatched';
    case 'unauthenticated':
      return 'worker response did not authenticate';
    default:
      return 'worker response was refused';
  }
}
