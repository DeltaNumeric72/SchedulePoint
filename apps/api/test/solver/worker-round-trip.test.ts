import { randomUUID } from 'node:crypto';

import { reproducibilityMode, type SolveRequestSpec } from '@schedulepoint/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import {
  BEST_EFFORT_PARAMETERS,
  DETERMINISTIC_PARAMETERS,
  SOLVED_STATUSES,
  applyHostileWorkerEnv,
  applySolverEnv,
} from '../support/solver.js';
import { NON_ASCII_CASES } from './non-ascii-corpus.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — the API → worker → API round trip** (OPUS-M4-001; doc 35 §6a,
 * SPEC-04 §§1–2, §4).
 *
 * This is the packet's first test row: *"Round trip on a synthetic problem (stub
 * solver)"*. Everything here spawns the **real Python worker as a real
 * subprocess** over the real protocol. Nothing is mocked, and that is the whole
 * point — the properties under proof are that a second-language process starts,
 * authenticates in both directions, receives a problem and no credential,
 * returns a believable answer, and exits.
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | a signed request produces a verified, believable response | the boundary is untested until M4-002 puts a solver behind it |
 * | 2 | the response is bound to the CANONICAL INPUT HASH dispatched | a stale or substituted result is indistinguishable from a fresh one |
 * | 3 | the runtime record names the interpreter, the image and the solver | SPEC-04 §4 reproducibility is a paragraph, not a record |
 * | 4 | `reproducibilityMode` is COMPUTED from the parameters | the claim the FAD-10 measurement disproved gets made anyway |
 * | 5 | the worker receives NO database credential in its environment | the boundary SPEC-04 §1.1 designs is bypassed through the environment while the protocol stays clean |
 * | 6 | the same problem produces the same candidate | the round trip cannot be compared across runs at all |
 *
 * ## Mutation control (FAD-15)
 *
 * The last case removes the response MAC verification's binding by dispatching
 * with one key and answering with another, and asserts the round trip then
 * FAILS. Without it, cases 1–4 would pass just as happily against a boundary
 * that verified nothing.
 */

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

function request(
  overrides: Partial<SolveRequestSpec> = {},
): SolveRequestSpec {
  const payload = syntheticProblem();
  return {
    protocolVersion: 1,
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    buildRunId: randomUUID(),
    correlationId: `round-trip-${randomUUID().slice(0, 8)}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(payload),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
    ...overrides,
  };
}

describe('the solver round trip, against the real worker subprocess', () => {
  it('dispatches a synthetic problem and receives a believable candidate', async () => {
    const spec = request();
    const outcome = await solveOnWorker(spec);

    log(`      · status ${outcome.status} / ${outcome.terminationReason} in ${String(outcome.elapsedMs)}ms`);
    log(`      · runtime ${outcome.runtime.languageRuntime} · ${outcome.runtime.solverVersion}`);
    log(`      · image   ${outcome.runtime.imageDigest}`);

    /* RE-ANCHORED at OPUS-M4-002 (disclosed; see the INDEX's re-anchoring
     * table). This assertion read `toBe('FEASIBLE')` and its note said "FEASIBLE,
     * not OPTIMAL. The stub is a greedy fill with no proof". Both halves were
     * true OF THE STUB. The subject of the test is *a synthetic problem goes out
     * and a believable candidate comes back*, and the real CP-SAT model closes
     * this fixture and PROVES optimality — so `OPTIMAL` here is SPEC-04 §7
     * honoured, not an optimality claim smuggled in.
     *
     * The two statuses stay distinct everywhere they mean something different:
     * `response-refusals.test.ts` still refuses the impossible pairs by exact
     * status, and nothing admits `OPTIMAL` where `FEASIBLE` is the property. */
    expect(SOLVED_STATUSES).toContain(outcome.status);
    expect(outcome.terminationReason).toBe('completed');
    expect(outcome.assignments).not.toBeNull();
    expect((outcome.assignments ?? []).length).toBeGreaterThan(0);
  });

  it('binds the response to the canonical input hash that was dispatched', async () => {
    const spec = request();
    const outcome = await solveOnWorker(spec);
    expect(outcome.canonicalInputHash).toBe(spec.canonicalInputHash);
    expect(outcome.canonicalInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the runtime facts SPEC-04 §4 requires, and no fabricated digest', async () => {
    const outcome = await solveOnWorker(request());

    expect(outcome.runtime.languageRuntime).toMatch(/^cpython-3\./);
    expect(outcome.runtime.platformArch).toMatch(/^[a-z]+-/);
    expect(outcome.runtime.compilerVersion).not.toBe('unknown');

    /* **The interpreter-wiring proof** (OPUS-M4-002). `runtime.py` reads the
     * OR-Tools distribution from package METADATA and records `stub-only` when
     * it is absent, so this one field distinguishes *the resolved interpreter
     * reached the child* from *some Python reached the child*. It is the
     * assertion that would have named step-08's cause 1 immediately: with the
     * helper's hard-coded `python3` default winning over the operator's
     * `SP_SOLVER_WORKER_COMMAND`, the child had no OR-Tools and could not have
     * produced this string at all. */
    expect(outcome.runtime.solverVersion).toContain('ortools-');
    log(`      · interpreter carried OR-Tools: ${outcome.runtime.solverVersion}`);

    /* The FAD-7 substitution, stated in the record rather than hidden: with no
     * image to run in, the worker reports the interpreter it actually used.
     * A fabricated digest would make a build look reproducible against an image
     * that never existed. */
    expect(outcome.runtime.imageDigest.startsWith('venv:')).toBe(true);
    log(`      · FAD-7 substitution visible in the record: ${outcome.runtime.imageDigest}`);
  });

  it('COMPUTES the reproducibility mode from the parameters, both ways', async () => {
    const deterministic = await solveOnWorker(request());
    expect(deterministic.runtime.reproducibilityMode).toBe('deterministic');

    const bestEffort = await solveOnWorker(request({ parameters: BEST_EFFORT_PARAMETERS }));
    expect(bestEffort.runtime.reproducibilityMode).toBe('best-effort');

    /* The same verdict, from the domain, over the same parameters — so the
     * property is "the conditions decide" and not "the worker agreed with us". */
    expect(reproducibilityMode(DETERMINISTIC_PARAMETERS)).toBe('deterministic');
    expect(reproducibilityMode(BEST_EFFORT_PARAMETERS)).toBe('best-effort');
    log('      · seed + worker count alone is NOT deterministic (EV-M0-SPC H-6)');
  });

  it('gives the worker NO database credential in its environment (S-15t)', async () => {
    /* The harness process holds five role passwords and a superuser password. If
     * the client passed `process.env` through, the worker would inherit every one
     * of them — the reach SPEC-04 §1.1 designs away, arriving through the back
     * door while the protocol stayed clean.
     *
     * The `env-probe` fixture reports what it saw THROUGH THE STATUS, with three
     * distinct answers so the proof cannot pass vacuously:
     *
     *   MODEL_INVALID  a `SP_PG_*` credential reached the child          — FAIL
     *   FEASIBLE       none did, AND the probe demonstrably reads its env — PASS
     *   UNKNOWN        the probe saw nothing at all                       — VACUOUS
     *
     * The middle answer is the one that matters. A probe that could not read its
     * environment would report "no credential" for the most boring possible
     * reason, so it must first prove it can see something — the image digest,
     * which the client's allowlist deliberately does let through. */
    expect(process.env['SP_PG_PASSWORD_APP_RUNTIME']).toBeDefined();
    expect(process.env['SP_PG_SUPERUSER_PASSWORD']).toBeDefined();

    const previousDigest = process.env['SP_SOLVER_IMAGE_DIGEST'];
    process.env['SP_SOLVER_IMAGE_DIGEST'] = 'sha256:fixture-local-not-a-real-digest';
    const restoreProbe = applyHostileWorkerEnv('env-probe');
    try {
      const outcome = await solveOnWorker(request());
      expect(
        outcome.status,
        outcome.status === 'MODEL_INVALID'
          ? 'a SP_PG_* database credential reached the solver worker'
          : 'the environment probe saw nothing at all — this proof would be vacuous',
      ).toBe('FEASIBLE');
      log('      · worker environment: no SP_PG_* variable, probe non-vacuous');
    } finally {
      restoreProbe();
      if (previousDigest === undefined) delete process.env['SP_SOLVER_IMAGE_DIGEST'];
      else process.env['SP_SOLVER_IMAGE_DIGEST'] = previousDigest;
    }
  });

  it('produces the same candidate for the same problem, twice', async () => {
    const payload = syntheticProblem({ participants: 4, days: 3, requiredCount: 2 });
    const spec = request({
      snapshotPayload: payload,
      canonicalInputHash: canonicalInputHash(payload),
      organizationId: payload.organizationId,
      groupId: payload.groupId,
    });

    const first = await solveOnWorker(spec);
    const second = await solveOnWorker(spec);

    expect(JSON.stringify(second.assignments)).toBe(JSON.stringify(first.assignments));
    log(`      · ${String((first.assignments ?? []).length)} assignments, identical across two runs`);
  });

  it.each(NON_ASCII_CASES)(
    'completes the round trip with non-ASCII operator text: $label',
    async ({ label, text }) => {
      /* **The B-1 regression guard, through the PRODUCTION path** — the same
       * `solveOnWorker` a build calls, not a hand-built probe. The reviewer's
       * reproduction was exactly this: a period named "Février 2029" produced
       * SOLVER_RESPONSE_REJECTED every time, because the MAC covered a
       * re-derivation of the message instead of the bytes on the wire.
       *
       * Nothing in the snapshot restricts period names, location names or
       * shift-type codes to ASCII, and nothing should — a period is called what
       * its group calls it. */
      const payload = syntheticProblem({ periodName: text, shiftTypeCode: text });
      const outcome = await solveOnWorker(
        request({
          snapshotPayload: payload,
          canonicalInputHash: canonicalInputHash(payload),
          organizationId: payload.organizationId,
          groupId: payload.groupId,
        }),
      );

      /* Re-anchored with the case above: the property is *the round trip
       * completed*, and which of the two solved statuses the model reaches is
       * not what this fixture is about. */
      expect(SOLVED_STATUSES, `${label} was rejected`).toContain(outcome.status);
      expect(outcome.assignments).not.toBeNull();
      log(`      · ${label}: round trip completed`);
    },
  );

  it('MUTATION CONTROL: a response that does not authenticate is REFUSED', async () => {
    /* Every case above would pass just as happily against a client that
     * verified nothing and believed whatever arrived. The control puts a worker
     * behind the same code path whose response carries a MAC that does not
     * verify, and asserts the round trip refuses rather than returning a
     * perfectly plausible candidate.
     *
     * The forged response is otherwise IDENTICAL to a good one — same protocol
     * version, same status, same hash, same principal, same key id, same echoed
     * nonce. Only the tag is wrong. If the round trip accepted it, nothing else
     * in this file would have noticed. */
    const restoreHostile = applyHostileWorkerEnv('forged-mac');
    try {
      await expect(solveOnWorker(request())).rejects.toMatchObject({
        code: 'SOLVER_RESPONSE_REJECTED',
      });
      log('      · MUTATION CONTROL fired: a forged MAC is refused, not tolerated');
    } finally {
      restoreHostile();
    }
  });
});
