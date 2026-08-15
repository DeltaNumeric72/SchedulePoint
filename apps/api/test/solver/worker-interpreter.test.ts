import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { log } from '../support/harness.js';
import {
  DISCOVERED_INTERPRETER_PATHS,
  SOLVER_ROOT,
  WORKER_INTERPRETER,
  applySolverEnv,
  resolveWorkerInterpreter,
} from '../support/solver.js';

/**
 * **NAMED PROOF — which interpreter runs the worker** (OPUS-M4-002, the fix for
 * EV-M4-002 step-08 cause 1).
 *
 * ## The defect, stated exactly
 *
 * `applySolverEnv` defaulted `SP_SOLVER_WORKER_COMMAND` to the literal
 * `'python3'` and wrote it in a `beforeEach`. That is not a default — it is an
 * **override**, and it silently beat the operator's own environment. Seventeen
 * solver proofs then failed with `FAILED`/`crashed` on a machine whose
 * `python3` has no OR-Tools, while the identical snapshot solved to `OPTIMAL`
 * under the venv interpreter invoked by hand.
 *
 * The parent's attribution was never the problem. A child that dies importing
 * `ortools` **has** crashed, and `crashed` is what SPEC-04 §2 requires the
 * parent to say — the last case here holds that behaviour in place so the fix
 * cannot quietly turn a genuine absence into a green run.
 *
 * ## What is proven
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | an explicit `SP_SOLVER_WORKER_COMMAND` WINS | the harness overrides the deployment again, and the symptom is a crashed worker |
 * | 2 | a `SP_SOLVER_VENV` root resolves to its `bin/python` | the common local case needs a full interpreter path |
 * | 3 | a `SP_SOLVER_VENV` that does not resolve THROWS | a typo presents as a crashed solve half an hour later |
 * | 4 | discovery is repository-relative only | a user-specific path gets committed and works on exactly one machine |
 * | 5 | the last rung is the generic `python3` | the committed default stops working from a plain checkout |
 * | 6 | `applySolverEnv` publishes the RESOLVED interpreter | the resolution exists but nothing consults it |
 *
 * Everything here is pure over injected sources — no filesystem, no spawn — so
 * the ORDER is what is under test rather than this machine's layout.
 */

const NOTHING_EXISTS = (): boolean => false;
const EVERYTHING_EXISTS = (): boolean => true;

describe('the worker interpreter resolution order', () => {
  it('1. an explicit SP_SOLVER_WORKER_COMMAND outranks every other rung', () => {
    expect(
      resolveWorkerInterpreter({
        workerCommand: '/deployment/bin/python',
        venvRoot: '/some/venv',
        exists: EVERYTHING_EXISTS,
      }),
    ).toBe('/deployment/bin/python');
  });

  it('1b. an EMPTY command is not a command — it falls through', () => {
    /* `process.env.X = ''` is the shape a shell produces for an unset-but-
     * exported variable, and treating it as a path would hand `spawn` an empty
     * string. The whole resolution would then report `crashed` for a variable
     * nobody meant to set. */
    expect(resolveWorkerInterpreter({ workerCommand: '', exists: NOTHING_EXISTS })).toBe('python3');
  });

  it('2. a SP_SOLVER_VENV ROOT resolves to its bin/python', () => {
    expect(
      resolveWorkerInterpreter({
        venvRoot: '/fixture/venvs/solver',
        exists: (path) => path === '/fixture/venvs/solver/bin/python',
      }),
    ).toBe('/fixture/venvs/solver/bin/python');
  });

  it('3. a SP_SOLVER_VENV that does not resolve THROWS rather than falling back', () => {
    /* The falling-back version is the defect this proof exists for, one rung
     * down: a configuration error that presents as a crashed worker. */
    expect(() =>
      resolveWorkerInterpreter({ venvRoot: '/fixture/typo', exists: NOTHING_EXISTS }),
    ).toThrow(/no bin\/python/);
  });

  it('4. discovery is repository-relative, and names no home directory', () => {
    expect(DISCOVERED_INTERPRETER_PATHS.length).toBeGreaterThan(0);
    const worktreeRoot = resolve(SOLVER_ROOT, '..');
    for (const candidate of DISCOVERED_INTERPRETER_PATHS) {
      /* The committed default may not depend on one machine's layout. A path
       * anchored to a home directory would work for its author and for nobody
       * else, and would keep working long enough to be believed.
       *
       * Anchored to the WORKTREE, and separately proven not to be anchored to
       * `$HOME`: on this machine the worktree happens to live under the home
       * directory, so a `startsWith('/Users/')` check would be true for a
       * correct path and would prove nothing. */
      expect(candidate.startsWith(worktreeRoot)).toBe(true);
      expect(candidate.startsWith(`${homedir()}/.`)).toBe(false);
      expect(candidate).toMatch(/\.venv\/bin\/python$/);
    }
    /* And discovery really is consulted: with everything present, rung 3 wins
     * over rung 4. Without this the array could be dead. */
    expect(resolveWorkerInterpreter({ exists: EVERYTHING_EXISTS })).toBe(
      DISCOVERED_INTERPRETER_PATHS[0],
    );
  });

  it('5. the last rung is the generic interpreter, not a path', () => {
    expect(resolveWorkerInterpreter({ exists: NOTHING_EXISTS })).toBe('python3');
  });

  it('6. applySolverEnv publishes the RESOLVED interpreter, not a literal', () => {
    const restore = applySolverEnv();
    try {
      expect(process.env['SP_SOLVER_WORKER_COMMAND']).toBe(WORKER_INTERPRETER);
      log(`      · worker interpreter for this run: ${WORKER_INTERPRETER}`);
    } finally {
      restore();
    }
  });

  it('6b. an explicit command argument still wins over the resolved default', () => {
    const restore = applySolverEnv({ command: '/fixture/explicit/python' });
    try {
      expect(process.env['SP_SOLVER_WORKER_COMMAND']).toBe('/fixture/explicit/python');
    } finally {
      restore();
    }
  });
});
