import { randomUUID } from 'node:crypto';

import {
  MAX_SOLVER_RESPONSE_BYTES,
  isTerminalOutcomeHonest,
  solverResponseVerdict,
  type SolveRequestSpec,
  type SolverStatus,
  type TerminationReason,
} from '@schedulepoint/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import {
  DETERMINISTIC_PARAMETERS,
  SOLVED_STATUSES,
  applyHostileWorkerEnv,
  applySolverEnv,
} from '../support/solver.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — a worker response is believed only when it is believable**
 * (OPUS-M4-001; SPEC-04 §1.2, §2, doc 35 §6a "malformed/oversized worker
 * response rejected").
 *
 * The worker is the least trusted component the platform itself ships: it
 * parses a payload, runs a native library, and writes bytes back. Two halves are
 * proven here, and they are different kinds of proof:
 *
 *  - **the decision**, `solverResponseVerdict`, exercised directly and
 *    exhaustively. It is pure and total, so every refusal class can be reached
 *    without a subprocess — which is what lets a reviewer hand-build the
 *    pathological input rather than contrive a worker that produces it;
 *  - **the wiring**, exercised through a real hostile subprocess, so the
 *    decision is provably the one the client actually consults.
 *
 * The most consequential arm is `dishonest-outcome`. A worker reporting
 * `CANCELLED` with termination reason `deadline` is not malformed — it is a
 * plausible lie, and it is the EV-M0-SPC H-6 finding stated as data. Every other
 * refusal here protects the process; that one protects the scheduler's judgement.
 */

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function request(): SolveRequestSpec {
  const payload = syntheticProblem();
  return {
    protocolVersion: 1,
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    buildRunId: randomUUID(),
    correlationId: `refusal-${randomUUID().slice(0, 8)}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(payload),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
  };
}

const EXPECTED_HASH = 'a'.repeat(64);

function verdictOf(parsed: unknown, overrides: { bytes?: number; authenticated?: boolean } = {}) {
  return solverResponseVerdict({
    parsed,
    bytes: overrides.bytes ?? 256,
    expectedInputHash: EXPECTED_HASH,
    authenticated: overrides.authenticated ?? true,
  });
}

function goodResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    status: 'FEASIBLE',
    terminationReason: 'completed',
    canonicalInputHash: EXPECTED_HASH,
    ...overrides,
  };
}

describe('the response decision, exercised directly', () => {
  it('ACCEPTS a well-formed, authenticated, honest response', () => {
    expect(verdictOf(goodResponse())).toEqual({
      outcome: 'accepted',
      status: 'FEASIBLE',
      terminationReason: 'completed',
    });
  });

  it('refuses an oversized response before it looks at anything else', () => {
    const verdict = verdictOf(goodResponse(), { bytes: MAX_SOLVER_RESPONSE_BYTES + 1 });
    expect(verdict).toMatchObject({ outcome: 'refused', refusal: { reason: 'oversized' } });
  });

  it('refuses anything that is not a JSON object', () => {
    for (const value of [null, undefined, 42, 'text', [1, 2, 3], true]) {
      expect(verdictOf(value), `accepted ${String(value)}`).toMatchObject({
        refusal: { reason: 'malformed' },
      });
    }
  });

  it('refuses a protocol version outside the window, rather than guessing (S-10t)', () => {
    for (const version of [0, 2, 99, '1', null]) {
      expect(verdictOf(goodResponse({ protocolVersion: version }))).toMatchObject({
        refusal: { reason: 'unsupported-protocol-version' },
      });
    }
  });

  it('refuses an unauthenticated response — but AFTER the version window', () => {
    /* Order matters operationally: a response from an incompatible protocol may
     * legitimately not carry a MAC this build knows how to verify, and reporting
     * "unauthenticated" for it would send an operator hunting a security
     * incident that is a deploy-ordering mistake. */
    expect(verdictOf(goodResponse(), { authenticated: false })).toMatchObject({
      refusal: { reason: 'unauthenticated' },
    });
    expect(
      verdictOf(goodResponse({ protocolVersion: 99 }), { authenticated: false }),
    ).toMatchObject({ refusal: { reason: 'unsupported-protocol-version' } });
  });

  it('refuses a status or termination reason outside the closed sets', () => {
    expect(verdictOf(goodResponse({ status: 'PROBABLY_FINE' }))).toMatchObject({
      refusal: { reason: 'unknown-status' },
    });
    expect(verdictOf(goodResponse({ terminationReason: 'gave_up' }))).toMatchObject({
      refusal: { reason: 'unknown-termination-reason' },
    });
  });

  it('refuses a response naming a different canonical input hash', () => {
    expect(verdictOf(goodResponse({ canonicalInputHash: 'f'.repeat(64) }))).toMatchObject({
      refusal: { reason: 'input-hash-mismatch' },
    });
  });

  it('refuses a DISHONEST outcome — the H-6 lie, as data', () => {
    const lies: readonly [SolverStatus, TerminationReason][] = [
      ['CANCELLED', 'deadline'],
      ['CANCELLED', 'completed'],
      ['TIMEOUT', 'user_cancelled'],
      ['TIMEOUT', 'completed'],
      ['OPTIMAL', 'deadline'],
      ['OPTIMAL', 'user_cancelled'],
      ['INFEASIBLE', 'killed'],
      ['FAILED', 'completed'],
      ['FEASIBLE', 'killed'],
      ['UNKNOWN', 'user_cancelled'],
    ];
    for (const [status, terminationReason] of lies) {
      expect(isTerminalOutcomeHonest(status, terminationReason), `${status}/${terminationReason}`).toBe(
        false,
      );
      expect(verdictOf(goodResponse({ status, terminationReason }))).toMatchObject({
        refusal: { reason: 'dishonest-outcome' },
      });
    }
    log(`      · ${String(lies.length)} impossible status/reason pairs, all refused`);
  });

  it('MUTATION CONTROL: the truthful pairs are ACCEPTED', () => {
    /* Without this, the honesty rule could be `() => false` and every case above
     * would still pass — while every real solve was refused. */
    const truths: readonly [SolverStatus, TerminationReason][] = [
      ['OPTIMAL', 'completed'],
      ['INFEASIBLE', 'completed'],
      ['MODEL_INVALID', 'completed'],
      ['FEASIBLE', 'completed'],
      ['FEASIBLE', 'deadline'],
      ['FEASIBLE', 'user_cancelled'],
      ['UNKNOWN', 'completed'],
      ['UNKNOWN', 'deadline'],
      ['CANCELLED', 'user_cancelled'],
      ['TIMEOUT', 'deadline'],
      ['FAILED', 'killed'],
      ['FAILED', 'crashed'],
      ['FAILED', 'rejected'],
    ];
    for (const [status, terminationReason] of truths) {
      expect(isTerminalOutcomeHonest(status, terminationReason), `${status}/${terminationReason}`).toBe(
        true,
      );
      expect(verdictOf(goodResponse({ status, terminationReason }))).toMatchObject({
        outcome: 'accepted',
      });
    }
    log(`      · MUTATION CONTROL: ${String(truths.length)} truthful pairs accepted`);
  });
});

describe('the same decision, through a real hostile worker subprocess', () => {
  it('refuses a response that is not JSON', async () => {
    restore = applyHostileWorkerEnv('malformed');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'malformed' },
    });
  });

  it('refuses valid JSON that is not an object', async () => {
    restore = applyHostileWorkerEnv('not-an-object');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'malformed' },
    });
  });

  it('STOPS READING an oversized response rather than draining it', async () => {
    /* A parent that read to EOF would let an untrusted child exhaust the API's
     * memory. The refusal has to happen while the stream is still open. */
    restore = applyHostileWorkerEnv('oversized');
    const started = Date.now();
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'oversized' },
    });
    log(`      · oversized response refused in ${String(Date.now() - started)}ms`);
  });

  it('refuses a protocol version outside the window', async () => {
    restore = applyHostileWorkerEnv('bad-protocol');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'unsupported-protocol-version' },
    });
  });

  it('refuses an unknown status', async () => {
    restore = applyHostileWorkerEnv('unknown-status');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'unknown-status' },
    });
  });

  it('refuses a DISHONEST worker', async () => {
    restore = applyHostileWorkerEnv('dishonest');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'dishonest-outcome', status: 'CANCELLED', terminationReason: 'deadline' },
    });
    log('      · a worker claiming CANCELLED-by-deadline is refused, not recorded');
  });

  it('refuses a response naming a hash that was never dispatched', async () => {
    restore = applyHostileWorkerEnv('hash-mismatch');
    await expect(solveOnWorker(request())).rejects.toMatchObject({
      refusal: { reason: 'input-hash-mismatch' },
    });
  });

  it('reports a worker that exits silently as FAILED/crashed — not killed, not empty', async () => {
    /* Two properties, and the second is a correction.
     *
     * The dangerous answer would be "a valid schedule with no assignments": a
     * worker that writes nothing has produced no answer, and the parent says so.
     *
     * And the REASON must be true. This worker exited on its own; nothing killed
     * it. `killed` is reserved for the case where THIS PROCESS sent a signal
     * (`worker-lifecycle.test.ts` covers that one and still asserts `killed`).
     * SPEC-04 §2 gives both words and they are different operational events —
     * "investigate the worker" versus "investigate why we killed it". Reporting
     * `killed` here was the parent claiming an action it never took. */
    restore = applyHostileWorkerEnv('silent');
    const outcome = await solveOnWorker(request());
    expect(outcome.status).toBe('FAILED');
    expect(outcome.terminationReason).toBe('crashed');
    expect(outcome.assignments).toBeNull();
    log('      · a silent worker is FAILED/crashed with no candidate — never an empty schedule');
  });

  it('MUTATION CONTROL: the REAL worker on the same path is accepted', async () => {
    /* Every case above would pass against a client that refused everything. */
    restore = applySolverEnv();
    const outcome = await solveOnWorker(request());
    /* Re-anchored at OPUS-M4-002 (disclosed). The property is *the honest
     * worker is BELIEVED* — the inverse of every refusal above — and the real
     * model closes this fixture with a proof, so the solved set is what the
     * control has always meant. */
    expect(SOLVED_STATUSES).toContain(outcome.status);
    log('      · MUTATION CONTROL: the honest worker is still believed');
  });
});
