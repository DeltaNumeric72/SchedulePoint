import {
  reproducibilityMode,
  resultReproducibility,
  WALL_CLOCK_BINDING_FRACTION,
  type SolverParameters,
} from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

/**
 * **NAMED PROOF — the RESULT-side reproducibility verdict** (FAD-49; EV-M4-005
 * §20/§21).
 *
 * ## The defect, in one sentence
 *
 * `reproducibilityMode` is computed from the REQUEST, `_configure` in the worker
 * sets `max_time_in_seconds` **and** `max_deterministic_time`, and CP-SAT stops
 * at whichever arrives first — so a build posed under the full pinned set could
 * be ended by its wall clock and still persist a record saying `deterministic`.
 * EV-M4-005 §20a measured it: 21.760483 deterministic units against 21.660444
 * between two solves in one process while the clock was binding, 76.702882 in
 * every run once it was not.
 *
 * ## Why the numbers below are the measured ones
 *
 * Every figure in this file is from that measurement rather than invented, so a
 * change to the predicate is checked against what the engine actually did rather
 * than against a rounder number somebody preferred.
 *
 * ## What this file does NOT test
 *
 * Whether the verdict reaches a screen. That is the wiring, and it is proven
 * over real persisted rows in `apps/api/test/builds/e2-quality-and-credits.test.ts`
 * and on the rendered page in `apps/web/e2e/builds.spec.ts` (AC-31b).
 */

/** The repaired fixture set: a 900s net over a 100-unit deterministic budget. */
const DETERMINISTIC: SolverParameters = {
  randomSeed: 20270301,
  numSearchWorkers: 1,
  maxTimeInSeconds: 900,
  maxDeterministicTime: 100,
  interleaveSearch: true,
};

/** The set as it shipped, with the 10s clock that raced the budget. */
const RACED: SolverParameters = { ...DETERMINISTIC, maxTimeInSeconds: 10 };

/**
 * A run that FINISHED — the baseline every pre-FAD-50 arm below implicitly
 * assumed, now stated.
 *
 * Written as an explicit spread rather than a defaulted parameter: B-1 was a
 * caller that never had to think about the termination, and a helper that
 * quietly supplied `completed` would rebuild exactly that hole inside the test
 * that exists to close it. Every arm that cares passes its own.
 */
const COMPLETED = { terminationReason: 'completed', status: 'OPTIMAL' } as const;

describe('the verdict separates the DISPATCH statement from the RESULT', () => {
  it('a search the deterministic budget ended IS reproducible', () => {
    /* The measured pass: 32.618628s of wall against a 900s net, OPTIMAL proven,
     * 76.702882 deterministic units — the run that reproduced bit for bit on a
     * calm machine and on one running 1.7× slower. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 32.618628,
      ...COMPLETED,
    });
    expect(verdict.verdict).toBe('reproducible');
    expect(verdict.reproducible).toBe(true);
    expect(verdict.detail.length).toBeGreaterThan(0);
  });

  it('a search the WALL CLOCK ended is NOT reproducible, and says which limit did it', () => {
    /* The measured failure, and the whole point: the REQUEST is identical in
     * every respect the dispatch statement can see. */
    expect(reproducibilityMode(RACED)).toBe('deterministic');

    const verdict = resultReproducibility({ parameters: RACED, wallTimeSeconds: 9.497948, ...COMPLETED });
    expect(verdict.verdict).toBe('wall-clock-truncated');
    expect(verdict.reproducible).toBe(false);
    /* The reason is NAMED. A refusal with no reason sends a scheduler to look
     * at the wrong thing, which is the failure mode this whole finding is. */
    expect(verdict.detail).toContain('WALL CLOCK');
    expect(verdict.detail).toContain('9.497948');
    expect(verdict.detail).toContain('10');
  });

  it('the SAME wall time is judged differently under the two budgets — the budget is read, not assumed', () => {
    /* Without this, the predicate could be hard-coding "9.5 seconds is bad"
     * rather than comparing against the budget the run was given. */
    const underRaced = resultReproducibility({ parameters: RACED, wallTimeSeconds: 9.497948, ...COMPLETED });
    const underRepaired = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 9.497948,
      ...COMPLETED,
    });
    expect(underRaced.verdict).toBe('wall-clock-truncated');
    expect(underRepaired.verdict).toBe('reproducible');
  });

  it('a best-effort REQUEST is unchanged — it never claimed reproduction', () => {
    /* FAD-49(5)(c). A best-effort run is not a failure and must not be reported
     * as one: nobody promised anything, so nothing was broken. */
    for (const parameters of [
      { ...DETERMINISTIC, interleaveSearch: false },
      { ...DETERMINISTIC, maxDeterministicTime: null },
    ] satisfies SolverParameters[]) {
      expect(reproducibilityMode(parameters)).toBe('best-effort');
      const verdict = resultReproducibility({
        parameters,
        wallTimeSeconds: 0.001,
        ...COMPLETED,
      });
      expect(verdict.verdict).toBe('best-effort');
      expect(verdict.reproducible).toBe(false);
      /* Even a run that finished nowhere near its clock. The reason it cannot be
       * reproduced is the parallel search, not the budget, and saying
       * "wall-clock-truncated" here would be a specific wrong claim. */
    }
  });

  it('FAILS CLOSED: an unrecorded search time is never a reproduction claim', () => {
    /* A crashed or killed run records no statistics, and neither does a row
     * written before they were recorded at all. Silence is not evidence. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: null,
      ...COMPLETED,
    });
    expect(verdict.verdict).toBe('unrecorded');
    expect(verdict.reproducible).toBe(false);
    expect(verdict.detail).toContain('cannot be established');
  });

  it('exactly one verdict sets `reproducible`', () => {
    /* The surfaces branch on this boolean. If two verdicts set it the screen
     * would say "Not reproducible" and mean the opposite somewhere. */
    const cases = [
      resultReproducibility({ parameters: DETERMINISTIC, wallTimeSeconds: 1, ...COMPLETED }),
      resultReproducibility({ parameters: RACED, wallTimeSeconds: 9.9, ...COMPLETED }),
      resultReproducibility({ parameters: DETERMINISTIC, wallTimeSeconds: null, ...COMPLETED }),
      resultReproducibility({
        parameters: { ...DETERMINISTIC, interleaveSearch: false },
        wallTimeSeconds: 1,
        ...COMPLETED,
      }),
    ];
    expect(cases.filter((verdict) => verdict.reproducible)).toHaveLength(1);
    expect(cases.find((verdict) => verdict.reproducible)?.verdict).toBe('reproducible');
    /* and every one of them explains itself */
    for (const verdict of cases) expect(verdict.detail.length).toBeGreaterThan(20);
  });
});

/**
 * **FAD-50 B-1 — a run that was INTERRUPTED never claims reproduction.**
 *
 * The blocking finding, as a permanent proof. The reviewer reproduced it against
 * real CP-SAT: a deterministic build cancelled by a person recorded `CANCELLED`,
 * 2.35s of wall against a 900s net and 5.6 of 100 deterministic units — short,
 * comfortable, and utterly unreproducible — and the verdict said `reproducible`
 * and handed the screen the promise sentence.
 *
 * The hole was conceptual, not arithmetic: **"the wall clock did not stop it" is
 * not the same claim as "it finished"**, and the first version of the predicate
 * had no input that could tell the difference.
 */
describe('B-1: only a run that FINISHED can be reproducible', () => {
  /** The reviewer's measured numbers, so this arm is anchored to the real one. */
  const CANCELLED_WALL = 2.35;

  it('the reviewer’s exact case: deterministic, short wall, CANCELLED → never reproducible', () => {
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: CANCELLED_WALL,
      terminationReason: 'user_cancelled',
      status: 'CANCELLED',
    });
    expect(verdict.verdict).toBe('interrupted');
    expect(verdict.reproducible).toBe(false);
    /* The two sentences that made the finding blocking must BOTH be gone. */
    expect(verdict.detail).not.toContain('produces the same schedule');
    expect(verdict.detail).not.toContain('completed proof');
    /* and the reason is named, because "not reproducible" without it sends a
     * scheduler to look at the budget when a person pressed stop. */
    expect(verdict.detail).toContain('cancelled');
  });

  it('the SAME facts with a completed termination ARE reproducible — the control', () => {
    /* Without this, the arm above would pass against a predicate that refused
     * every short run, and the repair would be a different bug. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: CANCELLED_WALL,
      terminationReason: 'completed',
      status: 'OPTIMAL',
    });
    expect(verdict.verdict).toBe('reproducible');
    expect(verdict.reproducible).toBe(true);
  });

  it('EVERY non-completed termination is interrupted, and each says something different', () => {
    /* Belt and braces, deliberately. `deadline` and `killed` would usually also
     * be caught by the wall clock or by an absent wall time — usually is not a
     * guarantee, and B-1 is what "the other input will catch it" costs. */
    const reasons = ['user_cancelled', 'deadline', 'killed', 'crashed', 'rejected'] as const;
    const details = new Set<string>();
    for (const terminationReason of reasons) {
      const verdict = resultReproducibility({
        parameters: DETERMINISTIC,
        wallTimeSeconds: 1,
        terminationReason,
        status: 'FEASIBLE',
      });
      expect(verdict.verdict, terminationReason).toBe('interrupted');
      expect(verdict.reproducible, terminationReason).toBe(false);
      expect(verdict.detail, terminationReason).not.toContain('produces the same schedule');
      details.add(verdict.detail);
    }
    /* Five reasons, five sentences. FAD-34's refusal to collapse four
     * terminations into one word, applied to this line. */
    expect(details.size).toBe(reasons.length);
  });

  it('a CANCELLED status against a completed termination is refused rather than resolved', () => {
    /* The two recorded facts contradict each other. `isTerminalOutcomeHonest`
     * refuses the combination upstream, so arriving here means something was
     * bypassed — and the safe reading of a contradiction claims less. */
    for (const status of ['CANCELLED', 'TIMEOUT', 'FAILED'] as const) {
      const verdict = resultReproducibility({
        parameters: DETERMINISTIC,
        wallTimeSeconds: 1,
        terminationReason: 'completed',
        status,
      });
      expect(verdict.verdict, status).toBe('interrupted');
      expect(verdict.reproducible, status).toBe(false);
      expect(verdict.detail, status).toContain('cannot both be true');
    }
  });

  it('an INFEASIBLE answer that completed is still reproducible — the status is not a filter', () => {
    /* "It finished" is the question, not "it found a schedule". An infeasibility
     * answer reproduces exactly as a feasible one does, and refusing it here
     * would be a new wrong claim in the opposite direction. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 3,
      terminationReason: 'completed',
      status: 'INFEASIBLE',
    });
    expect(verdict.verdict).toBe('reproducible');
  });

  it('an unrecorded termination is `unrecorded`, NEVER `interrupted`', () => {
    /* FAD-50 is explicit that the two must not be conflated. Here the facts are
     * ABSENT; in `interrupted` they are present and say the run was stopped. One
     * is a gap, the other is a finding, and a scheduler acts differently on each. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 3,
      terminationReason: null,
      status: 'FEASIBLE',
    });
    expect(verdict.verdict).toBe('unrecorded');
    expect(verdict.reproducible).toBe(false);
  });

  it('the termination is checked BEFORE the budget — a cancelled run is not called truncated', () => {
    /* Order matters for the words. A run cancelled at 9.5s of a 10s clock is
     * genuinely both, and reporting "the wall clock ended it" would send the
     * scheduler to raise a budget that was never the problem. */
    const verdict = resultReproducibility({
      parameters: RACED,
      wallTimeSeconds: 9.497948,
      terminationReason: 'user_cancelled',
      status: 'CANCELLED',
    });
    expect(verdict.verdict).toBe('interrupted');
    expect(verdict.detail).toContain('cancelled');
  });

  it('best-effort still wins over everything — no claim was made to withdraw', () => {
    const verdict = resultReproducibility({
      parameters: { ...DETERMINISTIC, interleaveSearch: false },
      wallTimeSeconds: 1,
      terminationReason: 'user_cancelled',
      status: 'CANCELLED',
    });
    expect(verdict.verdict).toBe('best-effort');
  });
});

describe('the SENTENCE handed to the screen is honest on its own', () => {
  /* `detail` is not decoration. The build detail page renders it verbatim
   * (`BuildDetailPage.tsx`), because the reason quotes that run's own measured
   * search time and a reason invented on the client would be a second source
   * for a fact the server already has. So the wording is part of the contract
   * and is asserted here rather than left to a screenshot. */

  /** The promise the old wording made about every deterministic-mode build. */
  const THE_PROMISE = 'produces the same schedule';

  it('a run that cannot be reproduced never contains the promise', () => {
    const refusals = [
      resultReproducibility({ parameters: RACED, wallTimeSeconds: 9.497948, ...COMPLETED }),
      resultReproducibility({ parameters: DETERMINISTIC, wallTimeSeconds: null, ...COMPLETED }),
      resultReproducibility({
        parameters: { ...DETERMINISTIC, interleaveSearch: false },
        wallTimeSeconds: 1,
        ...COMPLETED,
      }),
    ];
    for (const verdict of refusals) {
      expect(verdict.reproducible).toBe(false);
      expect(verdict.detail, verdict.verdict).not.toContain(THE_PROMISE);
    }
  });

  it('a run that CAN be reproduced does make the promise — the refusal is not blanket silence', () => {
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 32.618628,
      ...COMPLETED,
    });
    expect(verdict.reproducible).toBe(true);
    expect(verdict.detail).toContain(THE_PROMISE);
  });

  it('the three refusals give three DIFFERENT reasons — never one generic sentence', () => {
    /* A scheduler acts differently on "the clock ran out" (raise the budget),
     * "best effort" (change the configuration) and "not recorded" (nothing to
     * act on). Collapsing them into one apologetic sentence would lose the only
     * part that is actionable. */
    const details = [
      resultReproducibility({ parameters: RACED, wallTimeSeconds: 9.5, ...COMPLETED }).detail,
      resultReproducibility({ parameters: DETERMINISTIC, wallTimeSeconds: null, ...COMPLETED }).detail,
      resultReproducibility({
        parameters: { ...DETERMINISTIC, maxDeterministicTime: null },
        wallTimeSeconds: 1,
        ...COMPLETED,
      }).detail,
    ];
    expect(new Set(details).size).toBe(3);
  });
});

describe('the binding threshold is the measured one, and it bites on both sides', () => {
  /* CP-SAT stops AT OR A LITTLE UNDER its deadline — 9.491109 was the lowest of
   * four observed stops against a 10s budget, or 94.9%. The threshold sits at
   * 90%, below every observed stop and far above any run the deterministic
   * budget ended (32.6s against 900s is 3.6%). These two arms are the boundary
   * itself, so a change to the constant cannot pass unnoticed. */
  const budget = RACED.maxTimeInSeconds;
  const threshold = budget * WALL_CLOCK_BINDING_FRACTION;

  it('AT the threshold the wall clock is taken to have bound the search', () => {
    expect(
      resultReproducibility({ parameters: RACED, wallTimeSeconds: threshold, ...COMPLETED }).verdict,
    ).toBe('wall-clock-truncated');
  });

  it('just BELOW it, it is not', () => {
    expect(
      resultReproducibility({ parameters: RACED, wallTimeSeconds: threshold - 0.000001, ...COMPLETED })
        .verdict,
    ).toBe('reproducible');
  });

  it('every stop measured against the 10s budget is caught', () => {
    /* EV-M4-005 §20a's four, verbatim: two on a calm machine and two under ten
     * deliberate CPU hogs. All four must read as wall-clock-truncated — this is
     * the arm that would have caught a threshold set too high. */
    for (const wall of [9.497948, 9.491109, 9.969748, 10.003466]) {
      expect(
        resultReproducibility({ parameters: RACED, wallTimeSeconds: wall, ...COMPLETED }).verdict,
        `wall ${String(wall)}s against ${String(budget)}s`,
      ).toBe('wall-clock-truncated');
    }
  });
});
