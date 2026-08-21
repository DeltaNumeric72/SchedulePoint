import { describe, expect, it } from 'vitest';

import { runResultReproducibility } from '../../src/builds/service.js';

/**
 * **NAMED PROOF — the row-to-verdict wiring** (FAD-49; EV-M4-005 §21).
 *
 * `resultReproducibility` in the domain decides the question; this decides which
 * COLUMNS the question is asked about, and that is a separate way to be wrong.
 * A derivation that read the configuration's current budget rather than the one
 * the run was dispatched with would pass every domain test and still report a
 * historical build under today's settings.
 *
 * Pure, over explicit row shapes, and deliberately so: the DB-backed half —
 * that these columns are really written and really read back — is in
 * `e2-quality-and-credits.test.ts`, which also pins what happens on the row
 * shape that carries no parameters at all.
 *
 * The shapes below are the two `runResultReproducibility` actually receives:
 * `build_runs.solver_parameters` (jsonb, written at claim time by
 * `runQueuedBuild`) and the `wallTimeSeconds` lifted out of
 * `build_run_results.quality_metrics.solverStatistics`.
 */

/** A run dispatched under the repaired deterministic set: a 900s net over 100 units. */
const deterministicRun = {
  reproducibility_mode: 'deterministic',
  /* FAD-50 B-1: the run FINISHED. Stated on the fixture rather than defaulted,
     because the whole finding was a path that never had to say so. */
  termination_reason: 'completed',
  solver_status: 'OPTIMAL',
  solver_parameters: {
    randomSeed: 20270301,
    numSearchWorkers: 1,
    maxTimeInSeconds: 900,
    maxDeterministicTime: 100,
    interleaveSearch: true,
  },
};

/** The same run as it was dispatched BEFORE the repair — a 10s clock racing the budget. */
const racedRun = {
  ...deterministicRun,
  solver_parameters: { ...deterministicRun.solver_parameters, maxTimeInSeconds: 10 },
};

/** The B-1 row: the same deterministic dispatch, ended by a person. */
const cancelledRun = {
  ...deterministicRun,
  termination_reason: 'user_cancelled',
  solver_status: 'CANCELLED',
};

describe('the verdict is derived from the RUN’s own recorded parameters', () => {
  it('a search that ended inside the budget is reproducible', () => {
    const verdict = runResultReproducibility(deterministicRun, 32.618628);
    expect(verdict?.verdict).toBe('reproducible');
    expect(verdict?.reproducible).toBe(true);
  });

  it('a search the wall clock ended is refused, and the reason names the clock', () => {
    const verdict = runResultReproducibility(racedRun, 9.497948);
    expect(verdict?.verdict).toBe('wall-clock-truncated');
    expect(verdict?.reproducible).toBe(false);
    expect(verdict?.detail).toContain('WALL CLOCK');
  });

  it('the BUDGET comes from the row, not from a constant — the same wall time, two answers', () => {
    /* The assertion that catches a derivation reading the wrong column. 9.497948
     * seconds is a truncated search under a 10s clock and a comfortable finish
     * under a 900s one, and only the row can say which this run had. */
    expect(runResultReproducibility(racedRun, 9.497948)?.verdict).toBe('wall-clock-truncated');
    expect(runResultReproducibility(deterministicRun, 9.497948)?.verdict).toBe('reproducible');
  });

  it('B-1: a CANCELLED run is read off the row as interrupted, never reproducible', () => {
    /* FAD-50 B-1 at the WIRING layer. The domain predicate is proven separately;
     * this is the question that layer answers — are `termination_reason` and
     * `solver_status` actually read off the row, or does the derivation still
     * decide from the budget alone? Same row as `deterministicRun` in every
     * other respect, and the verdict has to move. */
    const verdict = runResultReproducibility(cancelledRun, 2.35);
    expect(verdict?.verdict).toBe('interrupted');
    expect(verdict?.reproducible).toBe(false);
    expect(verdict?.detail).toContain('cancelled');
    expect(verdict?.detail).not.toContain('produces the same schedule');

    /* and the control: the identical row that completed still earns the claim */
    expect(runResultReproducibility(deterministicRun, 2.35)?.verdict).toBe('reproducible');
  });

  it('an unrecognised termination reads as ABSENT, not as completed', () => {
    /* The parse, not a cast. A value outside the closed vocabulary must not walk
     * past the `!== 'completed'` test by being an unknown string. */
    const verdict = runResultReproducibility(
      { ...deterministicRun, termination_reason: 'finished-ish' },
      1,
    );
    expect(verdict?.verdict).toBe('unrecorded');
    expect(verdict?.reproducible).toBe(false);
  });

  it('a best-effort run is reported as best-effort, never as truncated', () => {
    const bestEffort = {
      ...deterministicRun,
      reproducibility_mode: 'best-effort',
      solver_parameters: {
        ...deterministicRun.solver_parameters,
        numSearchWorkers: 8,
        maxDeterministicTime: null,
        interleaveSearch: false,
      },
    };
    const verdict = runResultReproducibility(bestEffort, 899);
    expect(verdict?.verdict).toBe('best-effort');
    expect(verdict?.reproducible).toBe(false);
  });
});

describe('it fails CLOSED on anything it cannot read', () => {
  it('reports nothing at all before a run has a runtime record', () => {
    /* Not a refusal — an absence. The detail surface hides the line entirely,
     * because "this build cannot be reproduced" would be a finding about a
     * build that has not run. */
    expect(runResultReproducibility({ ...deterministicRun, reproducibility_mode: null }, 1)).toBeNull();
  });

  it('a missing, empty or malformed parameter bag is `unrecorded`, never a claim', () => {
    /* Every one of these is a row the verdict must not read optimistically. The
     * `false` case is the one that matters most: a bag with the right KEYS and
     * the wrong TYPES is what a schema drift looks like, and guessing a default
     * for it would manufacture a reproduction claim out of a parse failure. */
    const shapes: unknown[] = [
      null,
      {},
      { maxTimeInSeconds: 900 }, // no interleaveSearch
      { interleaveSearch: true }, // no budget
      { maxTimeInSeconds: '900', interleaveSearch: true }, // budget as a string
      { maxTimeInSeconds: Number.NaN, interleaveSearch: true },
      { maxTimeInSeconds: 900, interleaveSearch: 'true' },
    ];
    for (const solver_parameters of shapes) {
      const verdict = runResultReproducibility(
        { ...deterministicRun, solver_parameters },
        1,
      );
      expect(verdict?.verdict, JSON.stringify(solver_parameters)).toBe('unrecorded');
      expect(verdict?.reproducible).toBe(false);
    }
  });
});
