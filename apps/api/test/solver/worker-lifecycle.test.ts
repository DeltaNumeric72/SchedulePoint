import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SolveRequestSpec } from '@schedulepoint/domain';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import { DETERMINISTIC_PARAMETERS, applySolverEnv } from '../support/solver.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — cancellation, timeout, forced termination, and honest
 * outcomes** (OPUS-M4-001; SPEC-04 §2, EV-M0-SPC H-4/H-5/H-6, FAD-10).
 *
 * SPEC-04 §2 layers cancellation because the first two mechanisms can fail, and
 * says plainly which one is the guarantee:
 *
 * > **Mechanism 3 is what makes cancellation a guarantee rather than a hope.**
 *
 * Every case here runs a **real subprocess** and asserts on what actually
 * happened to it — a pid read from the worker's own ready file, a signal, a
 * measured wall clock. A mocked child would prove that a mock can be killed.
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | a mid-solve cancellation is reported `CANCELLED`/`user_cancelled` | the H-6 lie: a scheduler cancels, is told it timed out, and raises the budget |
 * | 2 | a wedged solve is TERMINATED by the parent, measurably | mechanism 3 is a paragraph and a wedged solve holds a slot forever |
 * | 3 | a terminated solve is reported `FAILED`/`killed`, never as a completion | "the process went away, call it done" — the worst possible answer |
 * | 4 | termination leaves **no orphan** | a killed build keeps burning a core, invisibly |
 * | 5 | the parent's deadline is derived from the solver's, not tighter | healthy solves get killed and reported as wedged |
 *
 * ## Mutation control (FAD-15)
 *
 * Case 1 has a paired control: the SAME dwelling solve, left uncancelled, must
 * return a candidate. Without it, "cancellation works" would pass against a
 * worker that could never produce an answer at all.
 */

let restoreEnv: () => void;
const scratch = mkdtempSync(join(tmpdir(), 'sp-solver-lifecycle-'));

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function request(overrides: Partial<SolveRequestSpec> = {}): SolveRequestSpec {
  const payload = syntheticProblem();
  return {
    protocolVersion: 1,
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    buildRunId: randomUUID(),
    correlationId: `lifecycle-${randomUUID().slice(0, 8)}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(payload),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
    ...overrides,
  };
}

/** Wait for the worker to write its pid, i.e. for the solve to have STARTED. */
async function waitForReady(readyFile: string, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = readFileSync(readyFile, 'utf8').trim();
      if (text !== '') return Number.parseInt(text, 10);
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new Error('the worker never signalled that it had started');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** `true` when a pid still names a live process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the solver worker lifecycle', () => {
  it('reports a mid-solve cancellation as CANCELLED, honestly (H-6)', async () => {
    const readyFile = join(scratch, `ready-${randomUUID()}`);
    const cancelFile = join(scratch, `cancel-${randomUUID()}`);

    const solve = solveOnWorker(request(), {
      readyFile,
      cancelFile,
      stubBehaviour: 'dwell',
      stubDwellMs: 20_000,
      timeoutMs: 30_000,
    });

    const pid = await waitForReady(readyFile);
    /* The cancellation is requested only once the solve is genuinely running.
     * Creating the sentinel before the child starts would let the worker observe
     * it during startup, and the case would prove that a worker can decline to
     * begin rather than that a running solve can be stopped. */
    writeFileSync(cancelFile, 'cancel');

    const started = Date.now();
    const outcome = await solve;
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe('CANCELLED');
    expect(outcome.terminationReason).toBe('user_cancelled');
    /* Not a timeout, and not a failure. Those are different facts and a
     * scheduler acts on them differently — which is the entire finding. */
    expect(outcome.status).not.toBe('TIMEOUT');
    expect(outcome.status).not.toBe('FAILED');
    /* Far inside the 20 s dwell, so the solve genuinely stopped early rather
     * than running out and being relabelled. */
    expect(elapsed).toBeLessThan(10_000);
    expect(isAlive(pid)).toBe(false);
    log(`      · cancelled ${String(elapsed)}ms into a 20000ms dwell; pid ${String(pid)} reaped`);
  });

  it('MUTATION CONTROL: the same dwelling solve, uncancelled, returns a candidate', async () => {
    /* Without this, "cancellation works" would pass against a worker that could
     * never answer at all — the cancelled arm and the broken arm are
     * indistinguishable from the cancelled side alone. */
    const outcome = await solveOnWorker(request(), {
      stubBehaviour: 'dwell',
      stubDwellMs: 150,
      timeoutMs: 30_000,
    });
    expect(outcome.status).toBe('FEASIBLE');
    expect(outcome.terminationReason).toBe('completed');
    log('      · MUTATION CONTROL: the uncancelled dwell answers, so the cancel arm is real');
  });

  it('TERMINATES a wedged solve and reports FAILED/killed — never a completion', async () => {
    const readyFile = join(scratch, `ready-${randomUUID()}`);

    const solve = solveOnWorker(request(), {
      readyFile,
      /* `wedged` ignores its own deadline AND the cancellation flag. Layers 1
       * and 2 do not return, which is exactly the case SPEC-04 §2 introduces
       * mechanism 3 for. */
      stubBehaviour: 'wedged',
      timeoutMs: 1_500,
      graceMs: 500,
    });

    const pid = await waitForReady(readyFile);
    expect(isAlive(pid)).toBe(true);

    const started = Date.now();
    const outcome = await solve;
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe('FAILED');
    expect(outcome.terminationReason).toBe('killed');
    /* `killed` is attributed by the PARENT and is never self-reported: a
     * terminated worker writes nothing at all. */
    expect(outcome.assignments).toBeNull();
    log(`      · wedged solve terminated after ${String(elapsed)}ms (timeout 1500ms + grace 500ms)`);

    /* No orphan. The child is not detached, so it dies with the signal rather
     * than surviving into the next test — and a solve that kept burning a core
     * invisibly is exactly what "cancellation is a guarantee" must exclude. */
    for (let attempt = 0; attempt < 100 && isAlive(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(isAlive(pid), `pid ${String(pid)} survived termination`).toBe(false);
    log(`      · no orphan: pid ${String(pid)} is gone`);
  });

  it('honours the solver-native deadline and reports TIMEOUT, not a candidate', async () => {
    /* Layer 1. The dwell is longer than the solver's own budget, so the worker's
     * deadline fires INSIDE the worker and the parent's timer never runs — which
     * is what a healthy timeout looks like and is why the parent's deadline is
     * derived from the solver's rather than set tighter. */
    const outcome = await solveOnWorker(
      request({ parameters: { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 1 } }),
      { stubBehaviour: 'dwell', stubDwellMs: 20_000, graceMs: 3_000 },
    );

    expect(outcome.status).toBe('TIMEOUT');
    expect(outcome.terminationReason).toBe('deadline');
    expect(outcome.assignments).toBeNull();
    /* Distinct from the wedged case above: this worker RETURNED, so the parent
     * had nothing to kill and says so. */
    expect(outcome.status).not.toBe('FAILED');
    log(`      · solver-native deadline honoured in ${String(outcome.elapsedMs)}ms`);
  });

  it('measures the parent timeout against the solver budget, not against zero', async () => {
    /* A parent deadline tighter than the solver's would kill healthy solves and
     * report them as wedged — a self-inflicted outage that reads as instability.
     * The default is `maxTimeInSeconds * 1000 + grace`, so a solve that answers
     * inside its budget is never touched by layer 3. */
    const started = Date.now();
    const outcome = await solveOnWorker(
      request({ parameters: { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 30 } }),
      { stubBehaviour: 'dwell', stubDwellMs: 200 },
    );
    const elapsed = Date.now() - started;

    expect(outcome.status).toBe('FEASIBLE');
    expect(elapsed).toBeLessThan(10_000);
    log(`      · answered in ${String(elapsed)}ms under a 30s budget; layer 3 never fired`);
  });
});
