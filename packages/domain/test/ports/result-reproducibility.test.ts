import {
  DETERMINISTIC_BUDGET_UNSPENT_FRACTION,
  reproducibilityMode,
  resultReproducibility,
  SOLVER_STATUSES,
  WALL_CLOCK_BINDING_FRACTION,
  type ResultReproducibility,
  type SolverParameters,
  type SolverStatus,
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
const COMPLETED = {
  terminationReason: 'completed',
  status: 'OPTIMAL',
  /* FAD-52 added a third fact the predicate reads. It is carried HERE, on the
   * shared "this run finished" shape, for exactly the reason the comment above
   * gives about the other two: an arm that did not have to state it would be
   * the B-1 hole again, one field along. `83.130356` is the measured cost of
   * the OPTIMAL proof on the machine this was added on — a run that finished
   * because it was DONE, which is what `COMPLETED` means. */
  deterministicTimeUnits: 83.130356,
} as const;

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
      /* The reviewer's third measured number, now that the predicate reads it. */
      deterministicTimeUnits: 5.6,
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
      deterministicTimeUnits: 5.6,
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
        deterministicTimeUnits: 1,
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
        deterministicTimeUnits: 1,
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
      /* MEASURED, and it is the FAD-52 G1 counterexample:
       * `B-infeasible-over-demand` completes at 0.0 deterministic units. A proof of
       * infeasibility costs almost nothing and reproduces perfectly, so the
       * units-aware branch must never fire on it. */
      deterministicTimeUnits: 0.0,
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
      deterministicTimeUnits: 3,
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
      deterministicTimeUnits: 21.760483,
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
      deterministicTimeUnits: 1,
      terminationReason: 'user_cancelled',
      status: 'CANCELLED',
    });
    expect(verdict.verdict).toBe('best-effort');
  });
});

/**
 * **FAD-52 — a run that finished with its deterministic budget UNSPENT never
 * claims reproduction.**
 *
 * ## The defect, measured
 *
 * FAD-49(1) described the derivation as *"wall time vs wall budget, deterministic
 * units vs deterministic budget"*. The shipped predicate never read the second
 * pair at all, and the gap between the two is reachable, intermittent and
 * measured 15+ times by two independent reviewers: a pinned run of the
 * B-fairness-shaped class under a 10s wall clock completes `FEASIBLE` at
 * **8.6–9.1s** having consumed **8.076904 of 100** deterministic units — 92% of
 * the budget untouched, unchanged to six decimals when the budget is raised 36×
 * or unpinned entirely, so the deterministic budget provably did not end it. And
 * 8.7 of 10 is BELOW the 0.9 wall-clock rule, so nothing refused, and the
 * verdict was `reproducible` with the promise sentence attached.
 *
 * It is a knife edge, and it is load-sensitive **in the wrong direction**: put
 * the machine under load, the wall crosses 9s, the old rule fires and the answer
 * looks honest. A single green run proves nothing here, which is why the
 * boundary arms below are arithmetic rather than measured.
 *
 * ## What the new verdict claims, and what it refuses to claim
 *
 * `stopped-early` states only what is established — feasible, not proved
 * optimal, budget unspent, therefore not stopped by that budget — and says
 * "may produce a different schedule". It does NOT name the wall clock: the set
 * of other stops is open, and swapping one confident wrong claim for another is
 * not a repair.
 */
describe('FAD-52: a completed FEASIBLE run with its budget unspent claims nothing', () => {
  /** The defect, exactly as measured: 8.076904 of 100 units, 8.725341s of 10s. */
  const MEASURED_UNITS = 8.076904;
  const MEASURED_WALL = 8.725341;

  it('THE DEFECT: the measured run reads `stopped-early`, never `reproducible`', () => {
    /* Every input here is a real recorded value from the reproduction. Under the
     * shipped predicate this returned `reproducible` and the sentence
     * "…produces the same schedule". */
    const verdict = resultReproducibility({
      parameters: RACED,
      wallTimeSeconds: MEASURED_WALL,
      deterministicTimeUnits: MEASURED_UNITS,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    });
    expect(verdict.verdict).toBe('stopped-early');
    expect(verdict.reproducible).toBe(false);
    /* the promise is gone */
    expect(verdict.detail).not.toContain('produces the same schedule');
    /* the numbers that make the finding are IN the sentence, so a reader can
     * check the claim rather than take it */
    expect(verdict.detail).toContain('8.076904');
    expect(verdict.detail).toContain('100');
    expect(verdict.detail).toContain('deterministic units');
    /* and it is conditional — "may", never "will" */
    expect(verdict.detail).toContain('may produce a different schedule');
  });

  it('it does NOT name the wall clock, because the wall clock is not established', () => {
    /* The discipline that separates this verdict from `wall-clock-truncated`.
     * At 8.7s of 10s the clock had not arrived; the stop could equally be a
     * solution limit, a gap limit or a callback. Naming one would be the same
     * class of confident wrong claim FAD-49 and FAD-50 were both written to
     * delete, relocated rather than removed. */
    const verdict = resultReproducibility({
      parameters: RACED,
      wallTimeSeconds: MEASURED_WALL,
      deterministicTimeUnits: MEASURED_UNITS,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    });
    expect(verdict.detail).not.toContain('WALL CLOCK');
    expect(verdict.detail).not.toContain('wall clock');
    expect(verdict.detail).not.toContain('wall-clock');
  });

  it('the wall budget is irrelevant to it — the SAME run under the 900s net still refuses', () => {
    /* The measurement that makes this a product defect rather than a fixture
     * one: raising the wall budget 90× (and the deterministic budget 36×, and
     * unpinning it) moved `deterministicTimeUnits` not at all. The wall clock
     * was never the whole story, so a verdict that only reads the wall clock
     * cannot become correct by being given a better wall budget. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: MEASURED_WALL,
      deterministicTimeUnits: MEASURED_UNITS,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    });
    expect(verdict.verdict).toBe('stopped-early');
    expect(verdict.reproducible).toBe(false);
  });

  it('G1: an INFEASIBLE proof at 0.0 units is NOT stopped-early — it is reproducible', () => {
    /* The counterexample that bounds the rule, and it is measured rather than
     * imagined: `B-infeasible-over-demand` completes INFEASIBLE at 0.0
     * deterministic units in 0.001075s of wall, on the real worker, under this
     * exact pinned set. "Few units" is not the finding — "few units AND a feasible answer
     * it could not prove optimal" is. A rule scoped to the first would refuse
     * the reproducibility of every infeasibility answer the platform gives,
     * which is a new wrong claim in the opposite direction. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 0.001075,
      deterministicTimeUnits: 0.0,
      terminationReason: 'completed',
      status: 'INFEASIBLE',
    });
    expect(verdict.verdict).toBe('reproducible');
    expect(verdict.reproducible).toBe(true);
  });

  it('an OPTIMAL proof is reproducible however much budget it left — unchanged', () => {
    /* 83.130356 of 100 here, 76.702882 on the reference machine, byte-identical
     * candidate on both. The remainder is the budget being generous, not a
     * mystery stop: the proof IS the search ending on its own terms. */
    for (const units of [83.130356, 76.702882, 0.05]) {
      const verdict = resultReproducibility({
        parameters: DETERMINISTIC,
        wallTimeSeconds: 32.618628,
        deterministicTimeUnits: units,
        terminationReason: 'completed',
        status: 'OPTIMAL',
      });
      expect(verdict.verdict, `OPTIMAL at ${String(units)} units`).toBe('reproducible');
    }
  });

  it('FAILS CLOSED: unrecorded units on this path are `unrecorded`, never `reproducible`', () => {
    /* FAD-50 B-1's hole-shape, one field along: the fact the branch needs is
     * ABSENT, and an absent fact is not evidence for the claim. A run that
     * cannot show its budget was spent does not get to say the budget ended it. */
    const verdict = resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 3,
      deterministicTimeUnits: null,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    });
    expect(verdict.verdict).toBe('unrecorded');
    expect(verdict.reproducible).toBe(false);
    expect(verdict.detail).toContain('cannot be established');
    expect(verdict.detail).not.toContain('produces the same schedule');
  });

  it('the WALL-CLOCK case is untouched: an established clock stop still names the clock', () => {
    /* FAD-52(2). Where the clock IS positively established, that is the more
     * actionable sentence and it is the one the product keeps giving. The
     * ordering — wall rule first, units rule second — is what preserves it, and
     * this run satisfies BOTH predicates (9.497948 of 10s, 21.760483 of 100). */
    const verdict = resultReproducibility({
      parameters: RACED,
      wallTimeSeconds: 9.497948,
      deterministicTimeUnits: 21.760483,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    });
    expect(verdict.verdict).toBe('wall-clock-truncated');
    expect(verdict.detail).toContain('WALL CLOCK');
  });

  it('`stopped-early` never sets `reproducible` — still exactly one verdict does', () => {
    const cases = [
      resultReproducibility({
        parameters: RACED,
        wallTimeSeconds: MEASURED_WALL,
        deterministicTimeUnits: MEASURED_UNITS,
        terminationReason: 'completed',
        status: 'FEASIBLE',
      }),
      resultReproducibility({ parameters: DETERMINISTIC, wallTimeSeconds: 1, ...COMPLETED }),
      resultReproducibility({ parameters: RACED, wallTimeSeconds: 9.9, ...COMPLETED }),
      resultReproducibility({
        parameters: DETERMINISTIC,
        wallTimeSeconds: 3,
        deterministicTimeUnits: null,
        terminationReason: 'completed',
        status: 'FEASIBLE',
      }),
    ];
    expect(cases.filter((verdict) => verdict.reproducible)).toHaveLength(1);
    expect(cases.find((verdict) => verdict.reproducible)?.verdict).toBe('reproducible');
    /* four distinct verdicts, four distinct sentences */
    expect(new Set(cases.map((verdict) => verdict.verdict)).size).toBe(4);
    expect(new Set(cases.map((verdict) => verdict.detail)).size).toBe(4);
  });
});

/**
 * **REV-A-006 / GH-008 M-2 — an ABSENT solver status is never evidence for the
 * claim either.**
 *
 * The finding, verbatim (REV-A `docs/evidence/EV-REVIEW-A/REPORT.md`):
 *
 * > `solver_status` NULL → `reproducible` with the promise. Also an
 * > **unrecognised** status (`'UNKNOWN'`): `runResultReproducibility` parses it
 * > to `null` deliberately ("an unrecognised termination reads as ABSENT… the
 * > fail-closed direction") and that fail-closed *parse* then feeds a
 * > fail-**open** branch. The derivation applies "an absent fact is never
 * > evidence for the claim" to three of its four nullable facts (units, wall
 * > time, termination) and not to the fourth.
 *
 * The reviewer's truth table (`transcripts/04-repro-truth-table.txt`) shows both
 * rows, marked `<< GH-008 M-2`, arriving at `reproducible` **with the promise
 * sentence**. The parse above it is the one the api layer already does right —
 * a status outside `SOLVER_STATUSES` becomes `null` rather than being cast — so
 * the whole fail-closed intention was being handed to a branch that read silence
 * as consent.
 *
 * Nothing about a RECORDED status moves: the eight members of the closed set are
 * pinned by the arms elsewhere in this file and by the truth table, and the
 * reviewer's `solver_status UNKNOWN` row is deliberately NOT part of this
 * finding — `UNKNOWN` is a status the platform recorded, not a status it failed
 * to record, and the two are different facts.
 */
describe('REV-A-006: an absent solver status fails CLOSED, like the other three facts', () => {
  /** The reviewer's first M-2 row: comfortable wall, spent budget, no status. */
  const withoutStatus = {
    parameters: DETERMINISTIC,
    wallTimeSeconds: 1,
    deterministicTimeUnits: 76.702882,
    terminationReason: 'completed',
    status: null,
  } as const;

  it('THE FINDING: a completed run that recorded NO status claims nothing', () => {
    const verdict = resultReproducibility(withoutStatus);
    expect(verdict.verdict).toBe('unrecorded');
    expect(verdict.reproducible).toBe(false);
    expect(verdict.detail).toContain('cannot be established');
    /* the half that made it a finding rather than a wording nit */
    expect(verdict.detail).not.toContain('produces the same schedule');
  });

  it('the reviewer’s second row — no status AND no units — is `unrecorded` too', () => {
    const verdict = resultReproducibility({ ...withoutStatus, deterministicTimeUnits: null });
    expect(verdict.verdict).toBe('unrecorded');
    expect(verdict.reproducible).toBe(false);
  });

  it('an UNRECOGNISED status is absent, because the api layer parses it to null', () => {
    /* The wider half of REV-A-006, at the layer that decides. The parse lives in
     * `runResultReproducibility` (`apps/api/src/builds/service.ts`), where a
     * value outside the closed set becomes `null` rather than being cast — and
     * this is the branch that value then reaches. Proven end-to-end from a raw
     * row in `apps/api/test/builds/result-reproducibility-wiring.test.ts`. */
    const recordedText: string = 'DEFINITELY-NOT-A-STATUS';
    const parsed: SolverStatus | null = SOLVER_STATUSES.find((s) => s === recordedText) ?? null;
    expect(parsed).toBeNull();
    expect(resultReproducibility({ ...withoutStatus, status: parsed }).verdict).toBe('unrecorded');
  });

  it('the CONTROL: the identical run with its status recorded still earns the claim', () => {
    /* Without this the arms above would pass against a predicate that refused
     * every run, which is a different way of being wrong. One field moves. */
    const verdict = resultReproducibility({ ...withoutStatus, status: 'OPTIMAL' });
    expect(verdict.verdict).toBe('reproducible');
    expect(verdict.reproducible).toBe(true);
  });

  it('every RECORDED status is unchanged — the eight-member closed set, swept', () => {
    /* The fix is scoped to ABSENCE. A status the platform actually recorded
     * decides exactly what it decided before, and this arm is what would catch a
     * "fail closed" that quietly widened into "refuse anything unfamiliar". */
    const expected: Readonly<Record<SolverStatus, string>> = {
      OPTIMAL: 'reproducible',
      FEASIBLE: 'reproducible',
      INFEASIBLE: 'reproducible',
      MODEL_INVALID: 'reproducible',
      UNKNOWN: 'reproducible',
      /* the three that contradict a `completed` termination */
      CANCELLED: 'interrupted',
      TIMEOUT: 'interrupted',
      FAILED: 'interrupted',
    };
    for (const status of SOLVER_STATUSES) {
      expect(resultReproducibility({ ...withoutStatus, status }).verdict, status).toBe(
        expected[status],
      );
    }
  });

  it('a fact that is PRESENT still wins: no status but an interrupted run is `interrupted`', () => {
    /* FAD-50's distinction, preserved. `unrecorded` is a gap; `interrupted` is a
     * finding; a run whose termination says a person stopped it has the finding
     * whether or not a status was recorded beside it. */
    const verdict = resultReproducibility({
      ...withoutStatus,
      terminationReason: 'user_cancelled',
    });
    expect(verdict.verdict).toBe('interrupted');
    expect(verdict.detail).toContain('cancelled');
  });

  it('all FOUR nullable facts now fail closed — the symmetry the finding named', () => {
    /* The finding's own sentence as an executable sweep: units, wall time,
     * termination and status. Each absence, alone, on an otherwise
     * claim-earning run. */
    const feasible = { ...withoutStatus, status: 'FEASIBLE', deterministicTimeUnits: 99 } as const;
    const absences = [
      { fact: 'deterministic units', input: { ...feasible, deterministicTimeUnits: null } },
      { fact: 'wall time', input: { ...feasible, wallTimeSeconds: null } },
      { fact: 'termination reason', input: { ...feasible, terminationReason: null } },
      { fact: 'solver status', input: { ...feasible, status: null } },
    ];
    for (const { fact, input } of absences) {
      const verdict = resultReproducibility(input);
      expect(verdict.verdict, fact).toBe('unrecorded');
      expect(verdict.reproducible, fact).toBe(false);
      expect(verdict.detail, fact).not.toContain('produces the same schedule');
    }
    /* and the control, so the sweep cannot pass by refusing everything */
    expect(resultReproducibility(feasible).verdict).toBe('reproducible');
  });
});

describe('FAD-52: the unspent threshold claims less between itself and the budget', () => {
  /* The constant is COARSE on purpose, and the arms below are the boundary
   * itself so a change to it cannot pass unnoticed — the same discipline as the
   * wall-clock threshold's two arms. Measured separation: the largest unspent
   * observation is 21.8% and the smallest genuine completion is 76.7%, so 50%
   * is more than twice the first and well under the second. */
  const budget = DETERMINISTIC.maxDeterministicTime ?? 0;
  const boundary = budget * DETERMINISTIC_BUDGET_UNSPENT_FRACTION;

  const feasibleAt = (units: number): string =>
    resultReproducibility({
      parameters: DETERMINISTIC,
      wallTimeSeconds: 20,
      deterministicTimeUnits: units,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    }).verdict;

  it('AT the boundary the budget is taken to be unspent', () => {
    expect(feasibleAt(boundary)).toBe('stopped-early');
  });

  it('just ABOVE it, NO new claim is made — the derivation falls through', () => {
    /* This is the "claims less" half, and it is deliberate rather than an
     * oversight. Between the constant and the budget the evidence is ambiguous:
     * a run at 60 of 100 units may have been stopped by something else or may
     * simply have finished, and inventing a refusal there would be the same
     * failure — a confident claim past the evidence — pointing the other way. */
    expect(feasibleAt(boundary + 0.000001)).toBe('reproducible');
  });

  it('every measured unspent run is caught, and every measured completion is not', () => {
    /* EV-M4-005 §20a's three wall-bound unit counts plus this defect's own,
     * against the two measured OPTIMAL costs. The gap between the groups is
     * what the constant sits in. */
    for (const units of [8.076904, 12.532388, 12.444773, 21.660444, 21.760483]) {
      expect(feasibleAt(units), `${String(units)} of ${String(budget)} units`).toBe('stopped-early');
    }
    for (const units of [76.702882, 83.130356]) {
      expect(feasibleAt(units), `${String(units)} of ${String(budget)} units`).toBe('reproducible');
    }
  });
});

/**
 * **REV-A-005 / GH-008 M-1 — the reproducible sentence says only what the truth
 * table established.**
 *
 * The finding, verbatim (REV-A `docs/evidence/EV-REVIEW-A/REPORT.md`):
 *
 * > Driving `resultReproducibility` over its whole input space
 * > (`transcripts/04-repro-truth-table.txt`, 26 cases): FEASIBLE + `completed` +
 * > **50.000001 of 100** units → `reproducible`, **with the promise sentence**.
 * > Registered and honestly sized as GH-008 M-1. **Added:** at wall
 * > `8.999999 s` of a 10 s limit the same branch renders "…after 8.999999s,
 * > **well inside** the 10s wall-clock limit" — false at 90.0% of the limit.
 *
 * ## What moved and what did not
 *
 * The VERDICT is untouched. FAD-52 ruled deliberately that between
 * `DETERMINISTIC_BUDGET_UNSPENT_FRACTION` and the budget **no new claim is
 * made** — a refusal invented in that band would be the same confident-past-the-
 * evidence error pointing the other way — and the boundary arms above pin it.
 *
 * What moved is the SENTENCE, which was asserting two things the derivation had
 * not established: that the deterministic budget *or a completed proof* ended the
 * search (in the mid-band neither is established — the run simply fell through
 * every refusal), and that the wall time sat "well inside" its limit (false at
 * 8.999999 of 10, which is 90.0% of it and one millionth of a second from the
 * verdict flipping). It now states exactly the two facts the rules above it
 * checked: the clock did not reach the point at which it is taken to have ended
 * the search, and nothing recorded shows the search stopping before it was done.
 */
describe('REV-A-005: the reproducible sentence claims no more than the rules checked', () => {
  it('THE FINDING: at 8.999999s of a 10s limit the sentence never says “well inside”', () => {
    /* The reviewer's exact case, and 8.999999 is not a round number chosen for
     * effect: the wall rule fires at 9.0, so this is the single largest wall
     * time that still reaches this branch. Any intensifier that is false here is
     * false, full stop — the branch renders the same words for every run in it. */
    const verdict = resultReproducibility({
      parameters: RACED,
      wallTimeSeconds: 8.999999,
      deterministicTimeUnits: 75,
      terminationReason: 'completed',
      status: 'FEASIBLE',
    });
    expect(verdict.verdict).toBe('reproducible');
    expect(verdict.detail).not.toContain('well inside');
    /* the numbers a reader needs to check it are still there */
    expect(verdict.detail).toContain('8.999999');
    expect(verdict.detail).toContain('10');
  });

  it('THE MID-BAND: it never names an ender the derivation did not establish', () => {
    /* The reviewer's `units 50.000001 of 100` row. Nothing in the rules above
     * decided that the deterministic budget ended this search or that a proof
     * did — the run fell through every refusal, which is a weaker fact and is
     * the only one the sentence may state. */
    for (const units of [50.000001, 75, 99.9]) {
      const detail = resultReproducibility({
        parameters: DETERMINISTIC,
        wallTimeSeconds: 1,
        deterministicTimeUnits: units,
        terminationReason: 'completed',
        status: 'FEASIBLE',
      }).detail;
      expect(detail, `${String(units)} units`).not.toContain(
        'The deterministic budget or a completed proof ended the search',
      );
      expect(detail, `${String(units)} units`).not.toContain('well inside');
    }
  });

  it('the promise is NOT withdrawn — the verdict and its claim are unchanged', () => {
    /* The control that keeps this a wording repair rather than a silent verdict
     * change. FAD-52 ruled the mid-band falls through verbatim; if a future edit
     * turned "the sentence overclaims" into "so refuse the claim", that would be
     * implementing a non-default branch of a settled decision, and this fails. */
    for (const units of [DETERMINISTIC_BUDGET_UNSPENT_FRACTION * 100 + 0.000001, 75, 99.9]) {
      const verdict = resultReproducibility({
        parameters: DETERMINISTIC,
        wallTimeSeconds: 1,
        deterministicTimeUnits: units,
        terminationReason: 'completed',
        status: 'FEASIBLE',
      });
      expect(verdict.verdict, `${String(units)} units`).toBe('reproducible');
      expect(verdict.reproducible, `${String(units)} units`).toBe(true);
      expect(verdict.detail, `${String(units)} units`).toContain('produces the same schedule');
    }
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

/**
 * **GH-008 — the SENTENCE SWEEP, enumerated over the verdict set.**
 *
 * The registered follow-up asks for "an enumerated sweep of every user-facing
 * reproducibility sentence asserted in tests", and the reason is a specific
 * failure mode rather than tidiness: the arms above assert sentences through
 * ad-hoc lists — three refusals here, one promise there — so a verdict whose
 * wording changed, or a verdict ADDED to
 * {@link ResultReproducibility the union}, could quietly end up with no sentence
 * assertion at all and every test would still pass. `stopped-early` was added by
 * FAD-52 and reached the screen; nothing structural made that happen.
 *
 * The table below is typed `Record<ResultReproducibility, …>`, so **a new verdict
 * does not compile until it has an entry here** — the same discipline
 * `INTERRUPTION_DETAIL` uses in the source to stay total over
 * `TerminationReason`. Each entry states the input that reaches its verdict, the
 * fragments the sentence owes, and the words it may not say.
 *
 * The forbidden list is where REV-A-005 becomes permanent: an intensifier is a
 * claim about a MEASUREMENT the sentence renders for every run in its branch, so
 * "well inside" was false at the top of the reproducible band. None of the six
 * sentences may carry one.
 */
describe('GH-008: every verdict’s sentence is asserted, by enumeration over the set', () => {
  /** Words that assert comfort the derivation never measured (REV-A-005). */
  const UNEARNED_INTENSIFIERS = ['well inside', 'comfortably', 'far below', 'plenty of'];

  const SENTENCE_SWEEP: Readonly<
    Record<
      ResultReproducibility,
      {
        readonly input: Parameters<typeof resultReproducibility>[0];
        readonly reproducible: boolean;
        readonly says: readonly string[];
        readonly neverSays: readonly string[];
      }
    >
  > = {
    reproducible: {
      input: { parameters: DETERMINISTIC, wallTimeSeconds: 32.618628, ...COMPLETED },
      reproducible: true,
      /* the promise, the run's own measured time, and its own limit */
      says: ['produces the same schedule', '32.618628', '900'],
      neverSays: ['may produce a different schedule', 'cannot be established'],
    },
    'wall-clock-truncated': {
      input: { parameters: RACED, wallTimeSeconds: 9.497948, ...COMPLETED },
      reproducible: false,
      /* names the cause, because this is the case where it is established */
      says: ['WALL CLOCK', '9.497948', '10', 'may produce a different schedule'],
      neverSays: ['produces the same schedule'],
    },
    'stopped-early': {
      input: {
        parameters: RACED,
        wallTimeSeconds: 8.725341,
        deterministicTimeUnits: 8.076904,
        terminationReason: 'completed',
        status: 'FEASIBLE',
      },
      reproducible: false,
      /* FAD-52: the units it did spend and the budget it had, and NO cause */
      says: ['8.076904', 'deterministic units', 'may produce a different schedule'],
      neverSays: ['produces the same schedule', 'WALL CLOCK', 'deadline'],
    },
    interrupted: {
      input: {
        parameters: DETERMINISTIC,
        wallTimeSeconds: 2.35,
        deterministicTimeUnits: 5.6,
        terminationReason: 'user_cancelled',
        status: 'CANCELLED',
      },
      reproducible: false,
      /* FAD-50 B-1: which stop it was, in the product's own words */
      says: ['cancelled', 'ran to its own end'],
      neverSays: ['produces the same schedule', 'cannot be established'],
    },
    'best-effort': {
      input: {
        parameters: { ...DETERMINISTIC, interleaveSearch: false },
        wallTimeSeconds: 1,
        ...COMPLETED,
      },
      reproducible: false,
      /* nobody promised anything, so nothing is reported as broken */
      says: ['no reproduction claim was ever made'],
      neverSays: ['produces the same schedule', 'WALL CLOCK'],
    },
    unrecorded: {
      input: { parameters: DETERMINISTIC, wallTimeSeconds: null, ...COMPLETED },
      reproducible: false,
      /* a gap, said as a gap — never as a finding */
      says: ['cannot be established'],
      neverSays: ['produces the same schedule', 'may produce a different schedule'],
    },
  };

  it('reaches all six verdicts — the table is not describing an unreachable set', () => {
    const reached = Object.entries(SENTENCE_SWEEP).map(
      ([verdict, arm]) => [verdict, resultReproducibility(arm.input).verdict] as const,
    );
    for (const [declared, actual] of reached) expect(actual, declared).toBe(declared);
    expect(new Set(reached.map(([, actual]) => actual)).size).toBe(6);
  });

  it('every sentence says what it owes and refuses what it must', () => {
    for (const [verdict, arm] of Object.entries(SENTENCE_SWEEP)) {
      const { detail, reproducible } = resultReproducibility(arm.input);
      expect(reproducible, verdict).toBe(arm.reproducible);
      expect(detail.length, verdict).toBeGreaterThan(20);
      for (const fragment of arm.says) expect(detail, `${verdict} must say`).toContain(fragment);
      for (const fragment of arm.neverSays) {
        expect(detail, `${verdict} must not say`).not.toContain(fragment);
      }
    }
  });

  it('no sentence carries an unearned intensifier — REV-A-005 made permanent', () => {
    for (const [verdict, arm] of Object.entries(SENTENCE_SWEEP)) {
      const { detail } = resultReproducibility(arm.input);
      for (const word of UNEARNED_INTENSIFIERS) {
        expect(detail.toLowerCase(), `${verdict}: "${word}"`).not.toContain(word);
      }
    }
  });

  it('six verdicts, six DIFFERENT sentences — none collapses into another', () => {
    const details = Object.values(SENTENCE_SWEEP).map((arm) => resultReproducibility(arm.input).detail);
    expect(new Set(details).size).toBe(6);
    /* and exactly one of the six makes the promise */
    expect(details.filter((detail) => detail.includes('produces the same schedule'))).toHaveLength(1);
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
