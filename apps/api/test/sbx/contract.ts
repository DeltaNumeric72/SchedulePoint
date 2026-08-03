/* ────────────────────────────────────────────────────────────────────────────
 * SPEC-16 — the SBX evidence contract, as executable code.
 *
 * SPEC-16 §1: "Every SBX test declares all nine. **A test missing any field is
 * not runnable, and the validator says so.**" That sentence is the whole design
 * of this module. The nine fields are not documentation attached to a scenario —
 * they are the scenario's precondition, checked before it runs, and a scenario
 * missing one never executes.
 *
 * SPEC-16 §7: a scenario whose fixture cannot be provisioned is reported
 * `EVIDENCE_BLOCKED` **with its dependency named** — "not as a pass, and not
 * silently skipped".
 *
 * ## The falsifiability probe
 *
 * Every scenario also carries one, and it is not optional either. NR-13 turned
 * up a live example of why: `outbox-dispatch.test.ts:320` asserted that a CHECK
 * constraint refuses a bad value, by UPDATEing a row a sibling test created —
 * and with that row absent the UPDATE matched nothing, succeeded, and the
 * assertion could not fail for the right reason. A scenario that cannot be made
 * to fail proves nothing, however green it looks. So the harness runs each
 * scenario's probe: a deliberately broken variant that MUST fail. If it passes,
 * the scenario is reported `VACUOUS` and the run fails.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The nine SPEC-16 §1 contract fields. All required; the validator enforces it. */
export interface SbxContract {
  /** Who owns this evidence. SPEC-16 §1. */
  readonly owner: string;
  /** Where the fixture comes from, and how it is reproduced. SPEC-16 §5. */
  readonly fixtureProvenance: string;
  /** How the run is made deterministic. SPEC-16 §4. */
  readonly deterministicSetup: string;
  /** Every external dependency, or an explicit statement that there is none. */
  readonly externalDependency: string;
  /** The faults this scenario injects, or an explicit statement that it injects none. */
  readonly faultControls: string;
  /** The objective oracle. SPEC-16 §3 — never a subjective criterion. */
  readonly objectiveOracle: string;
  /** The durable artifact this scenario produces. */
  readonly retainedArtifact: string;
  /** The environment it needs (MULTI, CONC, LIVE-SIM, ...). */
  readonly environment: string;
  /** SPEC-16 §2: the earliest stage at which this could first fail usefully. */
  readonly earliestExecutionPoint: 'E0' | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6';
}

export const CONTRACT_FIELDS: readonly (keyof SbxContract)[] = [
  'owner',
  'fixtureProvenance',
  'deterministicSetup',
  'externalDependency',
  'faultControls',
  'objectiveOracle',
  'retainedArtifact',
  'environment',
  'earliestExecutionPoint',
];

export type SbxState =
  | 'PASS'
  | 'FAIL'
  | 'EVIDENCE_BLOCKED'
  | 'VACUOUS'
  | 'PROBE_ERROR'
  | 'NOT_RUNNABLE';

/**
 * The ONLY throw that counts as "the probe falsified the scenario".
 *
 * ## Why a typed sentinel, and not "the probe threw"
 *
 * The first version recorded FALSIFIABLE on *any* throw. The independent review
 * broke it in three ways, each of which laundered a bug into a green control: a
 * `TypeError` from a misspelled property, a SQL syntax error, and a probe whose
 * sweep never executed at all. Each threw; each was recorded as proof that the
 * scenario could be made to fail. The control was measuring "did an exception
 * occur", which is not the question.
 *
 * A probe must therefore **observe the scenario's own oracle actually reject**
 * and only then throw this. Anything else — a TypeError, a driver error, a
 * timeout — is a `PROBE_ERROR`, which FAILS the run, because a probe that
 * crashed proved nothing and must not be mistaken for one that worked.
 */
export class ProbeFalsified extends Error {
  readonly falsified = true as const;

  constructor(reason: string) {
    super(`probe falsified the oracle: ${reason}`);
    this.name = 'ProbeFalsified';
  }
}

export interface SbxObservation {
  readonly label: string;
  readonly detail: string;
}

export interface SbxRunContext {
  /** Record a durable observation. These become the scenario's retained artifact. */
  observe(label: string, detail: string): void;
  /** Tables this scenario actually read a row from. Feeds the non-vacuity report. */
  tableExercised(table: string): void;
  /** Policies / controls this scenario exercised, by name. */
  policyExercised(policy: string): void;
}

/**
 * A blocked sub-scenario: something this scenario would test if a named
 * dependency existed. Never a skip, never a pass.
 */
export interface SbxBlocked {
  readonly subScenario: string;
  /** The dependency, by name. SPEC-16 §6 requires it be named rather than absorbed. */
  readonly dependency: string;
}

export interface SbxScenario {
  readonly id: string;
  readonly title: string;
  readonly contract: SbxContract;
  /**
   * Whether a gate depends on this scenario's evidence.
   *
   * `EVIDENCE_BLOCKED` is an acceptable resting state for a scenario nothing is
   * waiting on — SBX-006 is blocked on the authn milestone and no gate claims it.
   * It is NOT acceptable for a scenario a gate requires: a gate whose evidence is
   * blocked is a gate that is not satisfied, and reporting it green is exactly
   * the "absorbed dependency" SPEC-16 §6 forbids. A gate-required scenario that
   * comes back blocked therefore FAILS the run.
   */
  readonly gateRequired?: boolean;
  /**
   * Sub-scenarios that cannot execute, each with its dependency named. A
   * scenario may be entirely blocked (every sub-scenario) or partly.
   */
  readonly blocked?: readonly SbxBlocked[];
  /** The scenario itself. Throwing is a FAIL. */
  run(context: SbxRunContext): Promise<void>;
  /**
   * The falsifiability probe: the same assertions against a deliberately broken
   * world. It MUST throw. If it returns, the scenario is vacuous and the run
   * fails.
   *
   * A scenario that is entirely `blocked` may omit it — there is nothing
   * executable to falsify — and the harness records that reason explicitly
   * rather than treating the absence as satisfied.
   */
  probe?(context: SbxRunContext): Promise<void>;
}

export interface SbxResult {
  readonly id: string;
  readonly title: string;
  readonly state: SbxState;
  readonly gateRequired: boolean;
  readonly contract: SbxContract;
  readonly observations: readonly SbxObservation[];
  readonly tables: readonly string[];
  readonly policies: readonly string[];
  readonly blocked: readonly SbxBlocked[];
  readonly failure?: string;
  readonly probeOutcome: 'FALSIFIABLE' | 'VACUOUS' | 'PROBE_ERROR' | 'NOT_APPLICABLE';
  readonly elapsedMs: number;
}

/** Every contract field that is missing or blank. SPEC-16 §1's validator. */
export function contractProblems(scenario: SbxScenario): readonly string[] {
  const problems: string[] = [];
  const contract = scenario.contract as unknown as Record<string, unknown>;
  for (const field of CONTRACT_FIELDS) {
    const value = contract[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`missing or blank contract field: ${field}`);
    }
  }
  const fullyBlocked =
    scenario.blocked !== undefined && scenario.blocked.length > 0 && scenario.probe === undefined;
  if (scenario.probe === undefined && !fullyBlocked) {
    problems.push(
      'no falsifiability probe: a scenario that cannot be made to fail proves nothing',
    );
  }
  for (const blocked of scenario.blocked ?? []) {
    if (blocked.dependency.trim().length === 0) {
      problems.push(
        `sub-scenario "${blocked.subScenario}" is blocked on an UNNAMED dependency ` +
          '(SPEC-16 §6: named, not absorbed)',
      );
    }
  }
  return problems;
}

function createContext(): SbxRunContext & {
  readonly observations: SbxObservation[];
  readonly tables: Set<string>;
  readonly policies: Set<string>;
} {
  const observations: SbxObservation[] = [];
  const tables = new Set<string>();
  const policies = new Set<string>();
  return {
    observations,
    tables,
    policies,
    observe: (label, detail) => observations.push({ label, detail }),
    tableExercised: (table) => tables.add(table),
    policyExercised: (policy) => policies.add(policy),
  };
}

/**
 * Runs one scenario under its contract.
 *
 * Order matters and is deliberate:
 *  1. validate the contract — a scenario missing a field never runs;
 *  2. if every sub-scenario is blocked, report EVIDENCE_BLOCKED without running;
 *  3. run the scenario;
 *  4. run the falsifiability probe. **Even when the scenario passed** — especially
 *     then, because a vacuous scenario always passes.
 */
export async function runScenario(scenario: SbxScenario): Promise<SbxResult> {
  const started = Date.now();
  const context = createContext();
  const base = {
    id: scenario.id,
    title: scenario.title,
    contract: scenario.contract,
    gateRequired: scenario.gateRequired ?? false,
    blocked: scenario.blocked ?? [],
  };

  const problems = contractProblems(scenario);
  if (problems.length > 0) {
    return {
      ...base,
      state: 'NOT_RUNNABLE',
      observations: [],
      tables: [],
      policies: [],
      failure: problems.join('; '),
      probeOutcome: 'NOT_APPLICABLE',
      elapsedMs: Date.now() - started,
    };
  }

  if (scenario.probe === undefined) {
    // Fully blocked: nothing executable, so nothing to falsify. Reported with
    // its dependencies named, never as a pass.
    return {
      ...base,
      state: 'EVIDENCE_BLOCKED',
      observations: [],
      tables: [],
      policies: [],
      probeOutcome: 'NOT_APPLICABLE',
      elapsedMs: Date.now() - started,
    };
  }

  try {
    await scenario.run(context);
  } catch (error) {
    return {
      ...base,
      state: 'FAIL',
      observations: context.observations,
      tables: [...context.tables].sort(),
      policies: [...context.policies].sort(),
      failure: error instanceof Error ? error.message : String(error),
      probeOutcome: 'NOT_APPLICABLE',
      elapsedMs: Date.now() - started,
    };
  }

  let probeOutcome: SbxResult['probeOutcome'] = 'VACUOUS';
  let probeFailure: string | undefined;
  try {
    await scenario.probe(context);
    // Returned without falsifying anything.
    probeFailure =
      'the falsifiability probe did NOT observe the oracle reject: this scenario cannot be ' +
      'made to fail, so its pass means nothing';
  } catch (error) {
    if (error instanceof ProbeFalsified) {
      probeOutcome = 'FALSIFIABLE';
    } else {
      // A TypeError, a SQL error, a timeout — the probe BROKE rather than
      // falsified. Recording this as FALSIFIABLE is how a laundered bug becomes
      // a green evidence control, so it fails the run instead.
      probeOutcome = 'PROBE_ERROR';
      probeFailure =
        'the falsifiability probe ERRORED instead of falsifying the oracle — it proved ' +
        `nothing: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
  }

  const state: SbxState =
    probeOutcome === 'FALSIFIABLE' ? 'PASS' : probeOutcome === 'PROBE_ERROR' ? 'PROBE_ERROR' : 'VACUOUS';

  return {
    ...base,
    state,
    observations: context.observations,
    tables: [...context.tables].sort(),
    policies: [...context.policies].sort(),
    ...(probeFailure === undefined ? {} : { failure: probeFailure }),
    probeOutcome,
    elapsedMs: Date.now() - started,
  };
}

/**
 * A scenario's state decides the run's exit code.
 *
 * Blocked is never a pass, and blocked on a GATE-REQUIRED scenario is a failure:
 * a gate whose evidence cannot be produced is not a gate that has been met.
 */
export function isRunFailing(results: readonly SbxResult[]): boolean {
  return results.some((result) => {
    if (result.state === 'PASS') return false;
    if (result.state === 'EVIDENCE_BLOCKED') return result.gateRequired;
    return true;
  });
}
