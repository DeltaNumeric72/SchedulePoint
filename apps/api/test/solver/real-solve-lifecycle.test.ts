import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SolveRequestSpec } from '@schedulepoint/domain';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import { DETERMINISTIC_PARAMETERS, applySolverEnv, wallClockVerdict } from '../support/solver.js';
import { generatedCorpus, hardOptimisationProblem } from './corpus/generators.js';

/**
 * **NAMED PROOF — S-05t/S-06t/S-07t/S-08t/S-09t against the REAL solve**
 * (OPUS-M4-002; SPEC-04 §2, §4, §9).
 *
 * ## Why these are re-proven rather than inherited
 *
 * `worker-lifecycle.test.ts` proved the same five properties at M4-001 against
 * the **stub**, whose `dwell` and `wedged` behaviours were switches. Those
 * proofs are not retired — doc 35 §6d says "re-anchored, not retired" — and they
 * still run, because the stub paths are still reachable and a control channel
 * that only works for one implementation is not a control channel.
 *
 * But a stub that dwells because it was told to says nothing about CP-SAT, which
 * spends its time inside a native library and cannot be asked to stop by any of
 * the ordinary means (EV-M0-SPC H-4 measured 28 s and a MISREPORTED outcome for
 * the signal path; FAD-10 made the prohibition architectural). So each property
 * is proven again here, against a genuine search:
 *
 * | Row | Property | Against |
 * |---|---|---|
 * | S-05t | a terminal status arrives inside the limit + grace — layer 3 never fires | a real optimisation the deadline cuts short |
 * | S-06t | mid-solve cancellation returns `CANCELLED`/`user_cancelled` within grace | the watcher thread's `StopSearch`, inside a running CP-SAT search |
 * | S-07t | a solve that will not stop is TERMINATED, and reported `FAILED`/`killed` | the same real search, with the parent's clock far tighter than the solver's |
 * | S-08t | same everything → **bit-identical** result | `B-feasible-small`, under the FULL pinned deterministic set |
 * | S-09t | different worker count → **no reproduction claim** | the computed mode, not a declared flag |
 *
 * ## The one thing S-07t cannot borrow from the stub
 *
 * The stub's `wedged` mode ignores its own deadline AND the cancellation flag,
 * which is a fault injection. A real CP-SAT solve cannot be made to do that, and
 * inventing a switch to make it would be building the fault we claim to defend
 * against. So the real-solve arm poses a search that genuinely will not finish
 * inside the parent's window and gives the parent a clock far tighter than the
 * solver's own — layer 1 has not fired, layer 2 is not connected, and mechanism
 * 3 is the only thing that can end it. That is the same guarantee, established
 * without a fault to inject.
 */

let restoreEnv: () => void;
const scratch = mkdtempSync(join(tmpdir(), 'sp-real-solve-'));

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const HARD = hardOptimisationProblem();
const SMALL =
  generatedCorpus().find((fixture) => fixture.corpusClass === 'feasible-small')?.document ??
  HARD;

function request(
  payload = HARD,
  overrides: Partial<SolveRequestSpec> = {},
): SolveRequestSpec {
  return {
    protocolVersion: 1,
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    buildRunId: randomUUID(),
    correlationId: `real-solve-${randomUUID().slice(0, 8)}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(payload),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
    ...overrides,
  };
}

/** Wait for the worker to write its pid — i.e. for the solve to have STARTED. */
async function waitForReady(readyFile: string, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(readyFile)) {
      const text = readFileSync(readyFile, 'utf8').trim();
      if (text !== '') return Number.parseInt(text, 10);
    }
    if (Date.now() > deadline) throw new Error('the worker never reported that it had started');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Is that pid still alive? `kill(pid, 0)` — the check, without the signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the REAL solve, under the three stopping mechanisms', () => {
  it('S-05t: the solver-native deadline is honoured — a terminal status inside limit + grace', async () => {
    /* Layer 1. The parent's clock defaults to `maxTimeInSeconds * 1000 + grace`,
     * so if the solver's own deadline fails to return, layer 3 fires and the
     * outcome is `FAILED`/`killed` — which is what this asserts is NOT what
     * happened. */
    const started = Date.now();
    const outcome = await solveOnWorker(
      request(HARD, { parameters: { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 3 } }),
    );
    const elapsed = Date.now() - started;

    expect(outcome.status, 'the parent had to kill it — layer 1 did not return').not.toBe('FAILED');
    expect(outcome.terminationReason).not.toBe('killed');
    /* And the reason is honest about WHICH of the two happened. A solve that ran
     * out of clock terminated on the deadline; one that finished did not. Both
     * are admitted here because which one occurs depends on how fast the machine
     * is, and a test that demanded one would be asserting the hardware. What is
     * NOT admitted is a third answer, or a completion claimed over a truncation
     * — the distinction this arm made the adapter start drawing. */
    expect(['completed', 'deadline']).toContain(outcome.terminationReason);
    if (outcome.status === 'OPTIMAL') {
      /* An optimality PROOF is a completion whenever the clock expires. */
      expect(outcome.terminationReason).toBe('completed');
    }
    /* Inside limit + grace, with room for the worker's own start-up and for the
     * model build, which is real work on a problem this size. */
    expect(elapsed).toBeLessThan(3_000 + 2_000 + 25_000);
    expect(outcome.runtime.solverVersion).toContain('ortools-');
    log(
      `      · S-05t: real solve returned ${outcome.status}/${outcome.terminationReason} in ` +
        `${String(elapsed)}ms under a 3s budget`,
    );
  }, 120_000);

  it('S-06t: a mid-solve cancellation stops a RUNNING CP-SAT search, within grace', async () => {
    const cancelFile = join(scratch, `cancel-${randomUUID()}`);
    const readyFile = join(scratch, `ready-${randomUUID()}`);

    const solve = solveOnWorker(
      request(HARD, { parameters: { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 120 } }),
      { cancelFile, readyFile, timeoutMs: 120_000 },
    );

    const pid = await waitForReady(readyFile);
    /* The solve has STARTED. The extra wait puts the cancellation inside the
     * search rather than inside model construction, which is what "mid-solve"
     * has to mean for this to be about `StopSearch` at all. */
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const requested = Date.now();
    writeFileSync(cancelFile, 'stop');
    const outcome = await solve;
    const elapsed = Date.now() - requested;

    /* H-6, honoured. A cancelled solve reported as a timeout sends a scheduler
     * to raise a budget that was never the problem. */
    expect(outcome.status).toBe('CANCELLED');
    expect(outcome.terminationReason).toBe('user_cancelled');
    expect(outcome.assignments).toBeNull();
    /* Within grace: the watcher polls every 5 ms and `StopSearch` returns from
     * inside the native search. The spike measured 17 ms; this bound is far
     * looser and still nowhere near the 120 s the solver was given. */
    expect(elapsed).toBeLessThan(15_000);
    expect(isAlive(pid), 'the cancelled worker is still running').toBe(false);
    log(`      · S-06t: real search cancelled ${String(elapsed)}ms after the flag; pid ${String(pid)} reaped`);
  }, 180_000);

  it('S-06t control: the SAME solve, uncancelled, answers — so the cancel arm is real', async () => {
    /* Without this, "cancellation works" would pass against a solve that could
     * never return at all: the cancelled arm and the broken arm look identical
     * from the cancelled side. */
    const outcome = await solveOnWorker(
      request(HARD, { parameters: { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 5 } }),
    );
    expect(outcome.status).not.toBe('CANCELLED');
    expect(outcome.status).not.toBe('FAILED');
    log(`      · S-06t control: the uncancelled real solve answered ${outcome.status}`);
  }, 120_000);

  it('S-07t: a real solve the parent must end is KILLED, and reported killed', async () => {
    const readyFile = join(scratch, `ready-${randomUUID()}`);
    const started = Date.now();

    const outcome = await solveOnWorker(
      /* 300 s of solver budget, and no cancel channel at all. Layer 1 will not
       * fire inside this test's lifetime and layer 2 is not connected, so
       * mechanism 3 is the ONLY thing that can end this — which is the whole
       * claim SPEC-04 §2 makes for it. */
      request(HARD, { parameters: { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 300 } }),
      { readyFile, timeoutMs: 6_000, graceMs: 1_000 },
    );
    const elapsed = Date.now() - started;
    const pid = Number.parseInt(readFileSync(readyFile, 'utf8').trim(), 10);

    /* FAD-34's vocabulary, and the distinction that matters: `killed` means THIS
     * PROCESS terminated it. A worker that died on its own has `crashed`, and a
     * worker that returned has neither. Reporting a kill as a completion — "the
     * process went away, call it done" — is the worst answer this pipeline could
     * give, because the empty schedule that follows looks like an answer. */
    expect(outcome.status).toBe('FAILED');
    expect(outcome.terminationReason).toBe('killed');
    expect(outcome.assignments).toBeNull();
    expect(elapsed).toBeLessThan(6_000 + 1_000 + 20_000);
    /* No orphan. A killed build that keeps burning a core invisibly is the
     * failure mode `detached: false` and the explicit SIGKILL exist for. */
    expect(isAlive(pid), 'the killed solve left an orphan process').toBe(false);
    /* And the runtime record is honest about knowing nothing: a terminated
     * worker wrote no response, so nothing may be claimed on its behalf. */
    expect(outcome.runtime.languageRuntime).toBe('unknown');
    expect(outcome.explanation).toBeNull();
    log(`      · S-07t: real solve killed after ${String(elapsed)}ms; pid ${String(pid)} reaped, nothing claimed`);
  }, 180_000);
});

describe('reproducibility, against the real solve', () => {
  it('S-08t: BIT-IDENTICAL under the full SPEC-04 §4 pinned set', async () => {
    /* The amended §4 (FAD-10, from EV-M0-SPC H-6/H-7): a fixed seed and a fixed
     * worker count are NOT sufficient — five runs at one seed and eight workers
     * produced five different schedules at the same objective. Reproduction
     * requires ALL of: seed, worker count, `interleave_search`, a DETERMINISTIC
     * time limit rather than a wall clock, and the full remaining parameter set.
     *
     * `DETERMINISTIC_PARAMETERS` is that set, and this asserts what it buys:
     * byte-for-byte equality of the candidate, twice, over the same pinned
     * snapshot. Not "the same objective" and not "the same count" — the same
     * bytes, which is the only version of the claim that cannot be satisfied by
     * a coincidence. */
    const payload = SMALL;
    const spec = request(payload);

    const first = await solveOnWorker(spec);
    const second = await solveOnWorker(spec);

    expect(first.runtime.reproducibilityMode).toBe('deterministic');

    /* The precondition the pinned set does not itself establish (OPUS-M4-005
     * continuation, §20): CP-SAT stops at whichever of `max_time_in_seconds` and
     * `max_deterministic_time` comes first, so a wall-clock stop makes the run
     * machine-dependent whatever the request pinned. `SMALL` proves optimality
     * in well under a second and was never at risk — which is exactly why this
     * has to be asserted rather than inferred from the arm passing. */
    for (const [label, outcome] of [
      ['first', first],
      ['second', second],
    ] as const) {
      const verdict = wallClockVerdict(outcome, DETERMINISTIC_PARAMETERS);
      /* FAD-52: `reproducible`, not `bound`. The precondition means "this run IS
         a reproducibility basis", and `bound` only ever answered the narrower
         "did the WALL CLOCK stop it" — which since FAD-52 is one of two ways to
         fail this, not the question itself. A run that came back FEASIBLE with
         its deterministic budget unspent reads `stopped-early` with `bound`
         false, and would have satisfied the old spelling while reproducing
         nothing. `bound` is unchanged and still means only the clock. */
      expect(verdict.reproducible, `${label} solve: ${verdict.detail}`).toBe(true);
    }
    expect(second.statistics.deterministicTimeUnits).toBe(first.statistics.deterministicTimeUnits);

    expect(JSON.stringify(second.assignments)).toBe(JSON.stringify(first.assignments));
    expect(second.status).toBe(first.status);
    expect(second.objectiveValue).toBe(first.objectiveValue);
    expect((first.assignments ?? []).length).toBeGreaterThan(0);
    log(
      `      · S-08t: ${String((first.assignments ?? []).length)} assignments reproduced bit for ` +
        `bit under seed ${String(DETERMINISTIC_PARAMETERS.randomSeed)}, ` +
        `workers ${String(DETERMINISTIC_PARAMETERS.numSearchWorkers)}, ` +
        `interleave ${String(DETERMINISTIC_PARAMETERS.interleaveSearch)}, ` +
        `detTime ${String(DETERMINISTIC_PARAMETERS.maxDeterministicTime)}`,
    );
  }, 120_000);

  it('S-08t: every condition is REQUIRED — the pinned set is not decoration', () => {
    /* Without this, `DETERMINISTIC_PARAMETERS` could pin anything at all and
     * S-08t above would still pass. The mode is COMPUTED from the conditions, so
     * dropping either one has to move it. */
    expect(DETERMINISTIC_PARAMETERS.interleaveSearch).toBe(true);
    expect(DETERMINISTIC_PARAMETERS.maxDeterministicTime).not.toBeNull();
    expect(DETERMINISTIC_PARAMETERS.numSearchWorkers).toBe(1);
    expect(typeof DETERMINISTIC_PARAMETERS.randomSeed).toBe('number');

    /* The FIFTH condition, and the one whose absence cost this milestone two
     * seeds: pinning a deterministic budget buys nothing while a wall clock is
     * allowed to stop the search first. `maxTimeInSeconds` must be a safety net
     * an order of magnitude clear of what the deterministic budget can spend —
     * 100 units measures ≈43 wall-seconds on the M4 reference machine — not a
     * second budget racing it. This is the condition, stated. */
    expect(DETERMINISTIC_PARAMETERS.maxTimeInSeconds).toBeGreaterThanOrEqual(
      (DETERMINISTIC_PARAMETERS.maxDeterministicTime ?? 0) * 5,
    );
  });

  it('S-09t: with the conditions absent the product makes NO reproduction claim', async () => {
    /* The row SPEC-04 §9 words as "different worker count → no reproduction
     * claim", and the assertion is about the CLAIM rather than about the result.
     * A best-effort run may happen to reproduce; what must never happen is the
     * product saying it will. `reproducibilityMode` is computed by the platform
     * from the parameters it dispatched and is never taken from the worker — a
     * worker asserting `deterministic` over a wall-clock deadline would be making
     * exactly the claim the measurement disproved. */
    const outcome = await solveOnWorker(
      request(SMALL, {
        parameters: {
          ...DETERMINISTIC_PARAMETERS,
          numSearchWorkers: 8,
          maxDeterministicTime: null,
          interleaveSearch: false,
        },
      }),
    );
    expect(outcome.runtime.reproducibilityMode).toBe('best-effort');
    /* And it is still an honest, usable answer — a refusal to claim
     * reproduction is not a refusal to solve. */
    expect(['OPTIMAL', 'FEASIBLE']).toContain(outcome.status);
    log('      · S-09t: 8 workers, wall clock, no interleave → best-effort, no claim made');
  }, 120_000);
});
