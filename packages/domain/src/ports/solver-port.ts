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
 * both are recorded, and {@link reproducibilityMode} refuses to **dispatch** a
 * run as reproducible when they are not set.
 *
 * **That is a statement about the REQUEST, and it is not the whole promise.**
 * `maxTimeInSeconds` is set alongside `maxDeterministicTime` and the engine
 * stops at whichever arrives first, so a correctly-pinned request can still be
 * ended by the wall clock and produce a result nobody can reproduce.
 * {@link resultReproducibility} is the half that reads what the run actually
 * did. See EV-M4-005 §20a for the measurement and §21 for why both exist.
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
 * **The DISPATCH statement**: `'deterministic'` only when every condition
 * SPEC-04 §4 (amended) names is met *in the request*.
 *
 * Stated as a computed verdict rather than a flag a caller sets, because a flag
 * a caller sets is a claim, and the whole point of the amendment is that the
 * claim was being made without the conditions. Five runs, one seed, eight
 * workers, five different schedules.
 *
 * **What this function does NOT say.** It is computed from the parameters the
 * platform dispatched, before any search has happened, so it cannot know how
 * the search ended. It is correct, it is worth recording, and **it is not a
 * statement that the result can be reproduced** — that is
 * {@link resultReproducibility}, and conflating the two is the defect EV-M4-005
 * §20 diagnosed. This docblock used to claim the function "refuses to call a
 * RUN reproducible", which the measurement falsified.
 */
export function reproducibilityMode(
  parameters: SolverParameters,
): 'deterministic' | 'best-effort' {
  if (!parameters.interleaveSearch) return 'best-effort';
  if (parameters.maxDeterministicTime === null) return 'best-effort';
  return 'deterministic';
}

/* ────────────────────────────────────────────────────────────────────────────
 * The RESULT-side reproducibility verdict (FAD-49; EV-M4-005 §21)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The fraction of `maxTimeInSeconds` at or above which the wall clock is taken
 * to have STOPPED the search rather than merely bounded it.
 *
 * Not `1.0`, because CP-SAT stops at or a little under its deadline: the stops
 * measured against a 10-second budget (EV-M4-005 §20a) were 9.497948, 9.491109,
 * 9.969748 and 10.003466 — 94.9% at the low end. `0.9` sits below every observed
 * stop and far above any run the deterministic budget ended (76.70 units is
 * 32.6s against a 900s budget, or 3.6%).
 *
 * **One threshold, one definition.** The test fixtures consume this constant
 * rather than restating it; a second spelling of a safety predicate is the S-01
 * class of defect, where the two copies drift and the weaker one is the one
 * that ships.
 */
export const WALL_CLOCK_BINDING_FRACTION = 0.9;

/**
 * The fraction of `maxDeterministicTime` at or below which the deterministic
 * budget is taken to be **demonstrably unspent** — so demonstrably that whatever
 * ended the search, it was not that budget (FAD-52).
 *
 * ## The defect this number exists to catch
 *
 * `WALL_CLOCK_BINDING_FRACTION` above answers "did the wall clock STOP the
 * search", and it answers it positively: at or above 90% of the wall budget, it
 * did. What no rule read was the other half FAD-49(1) named — *"deterministic
 * units vs deterministic budget"* — and the gap between the two is a real,
 * measured, intermittent false promise. A pinned run of the B-fairness-shaped
 * class under a 10-second clock completes `FEASIBLE` at wall **8.6–9.1s** having
 * consumed **8.076904 of 100** deterministic units: 92% of the budget unspent,
 * unchanged to six decimals when the budget is raised 36× or unpinned entirely,
 * so the deterministic budget provably did not end it — and 8.7/10 is below 0.9,
 * so the wall-clock rule says nothing and the verdict fell through to
 * `reproducible`. The same run under load crosses 9s and reads
 * `wall-clock-truncated`. A knife edge, load-sensitive in the wrong direction:
 * the honest answer appeared when the machine was busy.
 *
 * ## Why 0.5, and why a coarse number rather than a tight one
 *
 * It has to sit far from BOTH boundaries, because between them it must claim
 * nothing:
 *
 * | run                                    | units of 100 | fraction |
 * | -------------------------------------- | ------------ | -------- |
 * | wall-10 stop, calm (EV-M4-005 §20a)     |    21.760483 |    21.8% |
 * | wall-10 stop, loaded                    |    12.532388 |    12.5% |
 * | wall-10 stop, this defect               |     8.076904 |     8.1% |
 * | OPTIMAL proof, reference machine        |    76.702882 |    76.7% |
 * | OPTIMAL proof, this machine             |    83.130356 |    83.1% |
 *
 * 0.5 is more than twice the largest unspent observation and well under the
 * smallest genuine completion, so neither ordinary variance nor the fact that
 * deterministic units AGGREGATE ACROSS SEARCH WORKERS (a multi-worker run spends
 * its budget in units summed over workers, which moves the numbers around
 * without changing what stopped the search) can push a run across it. A tight
 * threshold would be a precision this measurement does not support.
 *
 * **Between this constant and the budget, NO new claim is made.** A run at 60 of
 * 100 units falls through to the rules that were already here — which is the
 * point: the branch exists to refuse a claim in the region where the evidence is
 * unambiguous, not to manufacture a new one everywhere else.
 */
export const DETERMINISTIC_BUDGET_UNSPENT_FRACTION = 0.5;

/**
 * What ended the run, in the product's own words — one sentence per
 * {@link TerminationReason} (FAD-50 B-1).
 *
 * A table rather than a formatted enum name, because these are read by a
 * scheduler deciding what to do next and the actions differ: a cancelled build
 * is re-run, a deadline is given a bigger budget, a crash is reported. FAD-34's
 * refusal to collapse four terminations into one word is the same argument, and
 * this is that argument applied to the reproducibility line.
 *
 * `completed` is present so the map is total over the closed set, and is
 * unreachable through the interruption branch by construction.
 */
const INTERRUPTION_DETAIL: Readonly<Record<TerminationReason, string>> = {
  completed: 'This build ran to completion.',
  user_cancelled: 'A person cancelled this build, so the search stopped where they stopped it.',
  deadline: 'A deadline ended this build before the search finished.',
  killed: 'The worker running this build was terminated before the search finished.',
  crashed: 'The worker running this build crashed before the search finished.',
  rejected: 'The worker refused this request, so no search ran at all.',
};

/**
 * What a completed run may honestly claim about being re-runnable.
 *
 * Deliberately NOT a termination reason and NOT a solver status: FAD-34's
 * vocabulary is untouched by this. A wall-clock-truncated `FEASIBLE` result is
 * still `FEASIBLE`, still `completed`, and still a perfectly usable schedule —
 * the only thing it cannot do is promise that running it again gives the same
 * one.
 */
export type ResultReproducibility =
  /** The deterministic budget, or a completed proof, ended the search. */
  | 'reproducible'
  /** Pinned deterministic, but the WALL CLOCK ended the search. Not re-runnable. */
  | 'wall-clock-truncated'
  /**
   * Pinned deterministic, ran to completion with a feasible result it did not
   * prove optimal, and **left its deterministic budget demonstrably unspent**
   * (FAD-52). So something other than that budget stopped the search.
   *
   * Deliberately does NOT name the wall clock. `wall-clock-truncated` is the
   * verdict for the case where the clock is positively established as the stop;
   * this is the case where it is not, and the set of other stops — a solution
   * limit, a gap limit, a search callback, a clock that stopped it early — is
   * OPEN. Naming one of them would be a second confident wrong claim in place of
   * the first, which is the whole class FAD-49/50 exist to delete.
   *
   * Distinct from `interrupted`: nothing ended this run from outside, it
   * completed. Distinct from `unrecorded`: the facts are present and they say
   * the budget went unspent.
   */
  | 'stopped-early'
  /**
   * Something ENDED this search before it finished on its own — a person
   * cancelled it, a deadline fired, the worker was killed or crashed, or the
   * request was refused before any search ran.
   *
   * Distinct from `unrecorded` and never to be conflated with it: here the
   * facts are PRESENT and they say the run was interrupted. There it is the
   * facts themselves that are missing. One is a finding; the other is a gap.
   */
  | 'interrupted'
  /** The request never claimed reproducibility. Unchanged behaviour. */
  | 'best-effort'
  /** The facts needed to decide were not recorded. Never a claim either way. */
  | 'unrecorded';

export interface ResultReproducibilityVerdict {
  readonly verdict: ResultReproducibility;
  /** The single question a surface should branch on. `true` for exactly one verdict. */
  readonly reproducible: boolean;
  /** Why, in the product's own terms. Never empty; names the reason for a refusal. */
  readonly detail: string;
}

/**
 * **Does this RESULT support a reproducibility claim?** Derived, never stored.
 *
 * SPEC-04 §4 as amended requires the reproducibility basis to be the
 * deterministic budget, **never a wall clock**. `reproducibilityMode` checks
 * that the request pinned one. This checks the fact the request cannot know:
 * that the wall clock did not get there first.
 *
 * Derived rather than persisted, from facts already on the row — the run's
 * `solver_parameters`, its recorded termination, and the result's recorded
 * `wallTimeSeconds` — because a stored verdict would freeze each build under
 * whatever the predicate said the day it ran, exactly as `conflictsOf` is
 * derived on read for the same reason. No schema change, no worker change
 * (FAD-49(1), FAD-50 B-1).
 *
 * **It fails CLOSED.** An absent wall time is `'unrecorded'`, not `'reproducible'`:
 * a run that crashed, was killed, or predates the statistics being recorded has
 * not earned the claim, and silence is not evidence.
 *
 * ## The termination fact, and the defect that put it here (FAD-50 B-1)
 *
 * The first version of this function decided from the parameters and the wall
 * time alone. A **CANCELLED** deterministic run has a SHORT wall time — a
 * person pressed stop — and its statistics are persisted like any other, so it
 * sailed through both guards and was rendered `reproducible`, carrying the exact
 * promise sentence FAD-49 exists to delete. The reviewer reproduced it against
 * real CP-SAT (`CANCELLED`, 2.35s of wall, 5.6 of 100 deterministic units) and
 * through the shipped route.
 *
 * The lesson is that "the wall clock did not stop it" was never the same claim
 * as "it finished". **Only a `completed` termination may reach `reproducible`;**
 * everything else is {@link ResultReproducibility 'interrupted'} and names what
 * ended it. `deadline` and `killed` would usually also be caught by the wall
 * clock or by an absent wall time, and are checked here anyway — the belt and
 * braces are deliberate, because each of those inputs has now been observed to
 * be reachable without the other.
 *
 * ## The deterministic units, and the defect that put THEM here (FAD-52)
 *
 * FAD-49(1) described the derivation as *"wall time vs wall budget, deterministic
 * units vs deterministic budget"*. Only the first pair was implemented: nothing
 * read `deterministicTimeUnits` at all. The second pair is not decoration — it
 * is the half that catches a run the wall clock did not stop **and** the
 * deterministic budget did not stop either, which is a run nobody can promise to
 * reproduce and which this function was calling `reproducible`. Measured 15+
 * times on the B-fairness-shaped class by two independent reviewers: `FEASIBLE`,
 * `completed`, wall 8.6–9.1s of a 10s limit (so under the 0.9 wall rule),
 * **8.076904 of 100 deterministic units**, unchanged to six decimals with the
 * budget raised 36× or unpinned entirely. Knife-edge and load-sensitive in the
 * wrong direction: under load the wall crosses 0.9× and the honest answer
 * appears, so a single green run proved nothing.
 *
 * The new verdict is {@link ResultReproducibility 'stopped-early'} and it CLAIMS
 * LESS than the wall-clock one: it states what is known — feasible, not proved
 * optimal, budget unspent, therefore not stopped by that budget — and refuses to
 * name the cause, because the set of other stops is open.
 */
export function resultReproducibility(input: {
  readonly parameters: SolverParameters;
  /** From the recorded solver statistics. `null` when the run recorded none. */
  readonly wallTimeSeconds: number | null;
  /**
   * What ENDED the run (`build_runs.termination_reason`). `null` when the run
   * recorded none — which is a gap, not a completion, and is treated as one.
   *
   * Required rather than optional: B-1 was a caller that did not have to think
   * about this fact, and a defaulted parameter would rebuild that hole.
   */
  readonly terminationReason: TerminationReason | null;
  /**
   * The recorded solver status (`build_runs.solver_status`), for the second
   * belt: `isTerminalOutcomeHonest` already refuses a `CANCELLED` reported as
   * `completed`, and a verdict that trusted one field alone would depend on that
   * refusal never being bypassed.
   */
  readonly status: SolverStatus | null;
  /**
   * How much search this run actually did, in deterministic units, from the
   * recorded solver statistics. `null` when the run recorded none.
   *
   * **Required rather than optional, for the FAD-50 B-1 reason** (FAD-52): B-1
   * was a caller that never had to think about a fact it needed, and a defaulted
   * parameter rebuilds that hole in the shape the type checker cannot see. Every
   * call site names this, or it does not compile.
   */
  readonly deterministicTimeUnits: number | null;
}): ResultReproducibilityVerdict {
  const { parameters, wallTimeSeconds, terminationReason, status, deterministicTimeUnits } = input;

  if (reproducibilityMode(parameters) === 'best-effort') {
    return {
      verdict: 'best-effort',
      reproducible: false,
      detail:
        'This build was not posed under the deterministic parameter set, so no ' +
        'reproduction claim was ever made for it.',
    };
  }

  /* Before anything about budgets: did this run FINISH? A search somebody
   * stopped reproduces nothing, however comfortably it sat inside its clock. */
  if (terminationReason === null) {
    return {
      verdict: 'unrecorded',
      reproducible: false,
      detail:
        'The deterministic parameter set was in force, but this build recorded no ' +
        'termination reason, so whether it ran to completion cannot be established.',
    };
  }

  const interruptedStatus = status === 'CANCELLED' || status === 'TIMEOUT' || status === 'FAILED';
  if (terminationReason !== 'completed') {
    return {
      verdict: 'interrupted',
      reproducible: false,
      detail: `${INTERRUPTION_DETAIL[terminationReason]} Reproduction describes a search that ran to its own end; this one did not.`,
    };
  }
  if (interruptedStatus) {
    /* The two recorded facts DISAGREE. `isTerminalOutcomeHonest` refuses this
     * combination on the way in, so reaching it means something upstream was
     * bypassed — and the safe reading of a contradiction is the one that claims
     * less. Said plainly rather than resolved silently in either direction. */
    return {
      verdict: 'interrupted',
      reproducible: false,
      detail:
        `This build recorded a '${status}' status against a 'completed' termination. ` +
        'Those two cannot both be true, so no reproduction claim is made for it.',
    };
  }

  if (wallTimeSeconds === null) {
    return {
      verdict: 'unrecorded',
      reproducible: false,
      detail:
        'The deterministic parameter set was in force, but this build recorded no ' +
        'search time, so whether the wall clock ended the search cannot be established.',
    };
  }

  const threshold = parameters.maxTimeInSeconds * WALL_CLOCK_BINDING_FRACTION;
  if (wallTimeSeconds >= threshold) {
    return {
      verdict: 'wall-clock-truncated',
      reproducible: false,
      detail:
        `The search ran for ${String(wallTimeSeconds)}s against a ` +
        `${String(parameters.maxTimeInSeconds)}s wall-clock limit, so the WALL CLOCK ` +
        'ended it rather than the deterministic budget. How much search fits in that ' +
        'time depends on the machine, so the same problem run again may produce a ' +
        'different schedule of the same quality.',
    };
  }

  /* ── FAD-52: the search finished, the clock did not stop it, and the
   * deterministic budget is still nearly full. Something else stopped it.
   *
   * Scoped to `FEASIBLE` EXACTLY, and both halves of that matter:
   *
   *   * not `OPTIMAL` — a proof of optimality IS the search finishing on its own
   *     terms, and it costs whatever it costs: 76.702882 of 100 units on the
   *     machine of record, 83.130356 on the one this branch was added on, with a
   *     byte-identical candidate from both. The unspent remainder there is the
   *     budget being generous, not a mystery stop.
   *   * not `INFEASIBLE` — the G1 counterexample, and it is not hypothetical:
   *     the `B-infeasible-over-demand` corpus class completes `INFEASIBLE` at
   *     **0.0 deterministic units** in 0.001075s, measured on the real worker.
   *     An infeasibility proof legitimately consumes almost nothing, and a rule
   *     that read "few units means something stopped it" would refuse the
   *     reproducibility of every infeasible answer the platform ever gives.
   *
   * The check sits AFTER the wall-clock rule on purpose (FAD-52(2)): where the
   * clock IS positively established as the stop, the product should say so —
   * that is the more actionable sentence, and it is unchanged. This branch is
   * only for the region where it is not. */
  if (status === 'FEASIBLE') {
    if (deterministicTimeUnits === null) {
      /* The same hole-shape as FAD-50's B-1, closed the same way: the fact this
       * branch needs is ABSENT, and an absent fact is never evidence for the
       * claim. A run whose deterministic time was not recorded cannot show that
       * its budget was spent, so it does not get to say the budget ended it. */
      return {
        verdict: 'unrecorded',
        reproducible: false,
        detail:
          'The deterministic parameter set was in force and this build finished with a ' +
          'schedule it did not prove optimal, but it recorded no deterministic time, so ' +
          'whether the deterministic budget ended the search cannot be established.',
      };
    }
    const deterministicBudget = parameters.maxDeterministicTime;
    /* Non-null by construction — `reproducibilityMode` returned `'deterministic'`
     * above, which requires it — and re-read rather than asserted, because an
     * assertion here would be a claim the type system cannot check. */
    if (
      deterministicBudget !== null &&
      deterministicTimeUnits <= deterministicBudget * DETERMINISTIC_BUDGET_UNSPENT_FRACTION
    ) {
      return {
        verdict: 'stopped-early',
        reproducible: false,
        detail:
          `The search ended with a usable schedule it did not prove optimal, after ` +
          `consuming only ${String(deterministicTimeUnits)} of the ` +
          `${String(deterministicBudget)} deterministic units it was given. Something ` +
          'other than the deterministic budget stopped it, and the recorded facts do ' +
          'not establish what, so the same problem run again may produce a different ' +
          'schedule of the same quality.',
      };
    }
  }

  return {
    verdict: 'reproducible',
    reproducible: true,
    detail:
      `The deterministic budget or a completed proof ended the search after ` +
      `${String(wallTimeSeconds)}s, well inside the ` +
      `${String(parameters.maxTimeInSeconds)}s wall-clock limit, so the same problem ` +
      'run again on the same worker build produces the same schedule.',
  };
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
