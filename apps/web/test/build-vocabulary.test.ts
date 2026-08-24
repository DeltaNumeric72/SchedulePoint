import { resultReproducibilityVerdictSchema } from '@schedulepoint/contracts';
import { describe, expect, it } from 'vitest';

import {
  CONFLICT_CLASS_EXPLANATIONS,
  CONFLICT_CLASS_LABELS,
  EXPLANATION_DETAIL,
  EXPLANATION_LABELS,
  REPRODUCIBILITY_DETAIL,
  REPRODUCIBILITY_LABELS,
  RESULT_REPRODUCIBILITY_LABELS,
  STATE_EXPLANATIONS,
  STATE_LABELS,
  TERMINATION_LABELS,
} from '../src/builds/BuildsLayout.js';

/**
 * **NAMED PROOF — the build vocabulary says exactly what happened**
 * (OPUS-M4-004; SPEC-04 §2 and §7, PO-DEC-13).
 *
 * Every string a scheduler reads about a build comes from one of the tables
 * below, and this file is what stops a word appearing in one of them that the
 * system has not earned. It is a pure test over exported constants — no browser,
 * no render — because the claim under proof is about the WORDS, and the e2e run
 * proves separately that these are the words that reach the screen.
 */

const ALL_STRINGS = [
  ...Object.values(STATE_LABELS),
  ...Object.values(STATE_EXPLANATIONS),
  ...Object.values(TERMINATION_LABELS),
  ...Object.values(CONFLICT_CLASS_LABELS),
  ...Object.values(CONFLICT_CLASS_EXPLANATIONS),
  ...Object.values(EXPLANATION_LABELS),
  ...Object.values(EXPLANATION_DETAIL),
  ...Object.values(REPRODUCIBILITY_LABELS),
  ...Object.values(REPRODUCIBILITY_DETAIL),
  ...Object.values(RESULT_REPRODUCIBILITY_LABELS),
];

/**
 * **FAD-49 — the RESULT labels never promise what only the server can know.**
 *
 * These strings label a run that has FINISHED, and the client cannot see
 * how its search ended. The reason travels with the build (`detail` on the
 * wire, asserted in `packages/domain/test/ports/result-reproducibility.test.ts`),
 * so the client's job here is only to name the verdict — and, for the four
 * that refuse, to refuse visibly. A label that hedged would let the honest
 * server sentence sit under a heading that undoes it.
 */
describe('the RESULT reproducibility labels say which way the verdict went', () => {
  it('names all six verdicts and no others', () => {
    expect(Object.keys(RESULT_REPRODUCIBILITY_LABELS).sort()).toEqual([
      'best-effort',
      'interrupted',
      'reproducible',
      /* FAD-52. Present here or the page falls back to rendering the raw enum
         name, which is the "no raw enum leaks to a reader" rule broken by
         omission rather than by commission. */
      'stopped-early',
      'unrecorded',
      'wall-clock-truncated',
    ]);
  });

  it('GH-008: the table is total over the WIRE vocabulary, member for member', () => {
    /* The arm above pins the six by name, which is what a reader wants; this
       pins them against the thing the page actually parses through, which is
       what stops the two drifting. `RESULT_REPRODUCIBILITY_LABELS` is now typed
       `Record<ResultReproducibilityVerdictWire, string>`, so a seventh verdict
       added to the contract fails `tsc` here before it can reach a screen as a
       raw enum name — and this assertion is the runtime half of the same claim,
       for the direction the type cannot see: a label for a verdict the contract
       does NOT have. */
    expect(Object.keys(RESULT_REPRODUCIBILITY_LABELS).sort()).toEqual(
      [...resultReproducibilityVerdictSchema.options].sort(),
    );
  });

  it('every refusing verdict reads as a refusal at a glance', () => {
    for (const verdict of [
      'wall-clock-truncated',
      'best-effort',
      'interrupted',
      'stopped-early',
    ] as const) {
      expect(RESULT_REPRODUCIBILITY_LABELS[verdict]).toMatch(/^Not reproducible/);
    }
    /* `unrecorded` is NOT "Not reproducible": the run may well be reproducible
       and we cannot tell. Saying otherwise would be inventing a finding. */
    expect(RESULT_REPRODUCIBILITY_LABELS['unrecorded']).toBe(
      'Reproducibility not established',
    );
    expect(RESULT_REPRODUCIBILITY_LABELS['reproducible']).toBe('Reproducible');
  });

  it('the wall-clock verdict names the wall clock, so the label alone is actionable', () => {
    expect(RESULT_REPRODUCIBILITY_LABELS['wall-clock-truncated']).toContain('wall clock');
  });

  it('the stopped-early verdict names NO cause — FAD-52', () => {
    /* The one label whose value is in what it does not say. `stopped-early` is
       exactly the case where the wall clock is NOT established as the stop, and
       the set of other stops (solution limits, gap limits, callbacks) is open.
       A label that borrowed the wall-clock wording would turn "we do not know
       what stopped it" into a specific wrong answer, which is the class FAD-49
       and FAD-50 were both written to delete. */
    const label = RESULT_REPRODUCIBILITY_LABELS['stopped-early'] ?? '';
    expect(label).toMatch(/^Not reproducible/);
    expect(label).not.toContain('wall clock');
    expect(label).not.toContain('deadline');
  });
});

describe('no surface claims optimality it has not been given', () => {
  it('never uses the word "optimal" anywhere in the build vocabulary', () => {
    /* SPEC-04 §7: **no optimality claim for a feasible result.** `OPTIMAL` is a
     * PROOF the solver either produced or did not, and it is carried as the
     * `solverStatus` field beside the state — which is where a scheduler can see
     * whether the proof exists. The moment "optimal" appears in a state label,
     * an explanation, or a termination phrase, it applies to every result that
     * reaches that branch, including the merely feasible ones.
     *
     * `completed` is the trap this closes: "Completed — all preferences met" is
     * a true statement about the SOFT terms and says nothing about optimality,
     * and the shortest edit that makes it read better also makes it a lie. */
    for (const text of ALL_STRINGS) {
      expect(text.toLowerCase(), `optimality claimed in: ${text}`).not.toContain('optimal');
    }
  });

  it('never RANKS one candidate against another', () => {
    /* The comparison surface is a read-only projection (D-4c) and every quality
     * band except `hard_violations = 0` is undefined until the benchmark corpus
     * is run. A word that ranks candidates would be an invented threshold
     * wearing an adjective.
     *
     * `best effort` is deliberately not caught: it is the SPEC-04 §4
     * reproducibility mode's own name and says nothing about a candidate's
     * quality. The pattern is written against the ranking PHRASES rather than
     * against the word, so the exclusion is a property of the language and not a
     * carve-out somebody has to remember. */
    for (const text of ALL_STRINGS) {
      expect(text.toLowerCase(), `a ranking word in: ${text}`).not.toMatch(
        /\b(best|better|worse|worst)\b(?! effort)/,
      );
    }
  });

  it('keeps `infeasible` a statement about the PROBLEM and `failed` about the SYSTEM', () => {
    /* report 21 §4's distinction, which the interface has to make or it does not
     * exist: a user told "the build failed" for an infeasible problem goes
     * looking for a system fault that is not there. */
    expect(STATE_EXPLANATIONS.infeasible).toContain('statement about the problem');
    expect(STATE_EXPLANATIONS.failed).toContain('statement about the system');
    expect(STATE_EXPLANATIONS.infeasible).not.toContain('statement about the system');
  });
});

describe("PO-DEC-13's four classes and SPEC-04 §5's five states are complete and distinct", () => {
  it('names exactly four conflict classes, each with wording of its own', () => {
    const keys = Object.keys(CONFLICT_CLASS_LABELS).sort();
    expect(keys).toEqual([
      'eligibility-failure',
      'fairness-outlier',
      'hard-breach',
      'unmet-demand',
    ]);
    expect(Object.keys(CONFLICT_CLASS_EXPLANATIONS).sort()).toEqual(keys);
    expect(new Set(Object.values(CONFLICT_CLASS_LABELS)).size).toBe(4);
  });

  it('says of the fairness class that it carries no threshold', () => {
    /* SPEC-04 §7 leaves every band undefined until the corpus is run and
     * no band exists until the M6 benchmark. The one class with nothing behind it must SAY so on
     * the screen, or it renders as a failure. */
    const text = CONFLICT_CLASS_EXPLANATIONS['fairness-outlier'].toLowerCase();
    expect(text).toContain('no threshold');
    expect(text).toContain('not because anything is wrong');
  });

  it('names all five explanation states, including both degraded ones', () => {
    const keys = Object.keys(EXPLANATION_LABELS).sort();
    expect(keys).toEqual([
      'EXPLAINED_EXACT',
      'EXPLAINED_MINIMAL',
      'EXPLAINED_SUBSET',
      'EXPLANATION_BUDGET_EXCEEDED',
      'EXPLANATION_UNAVAILABLE',
    ]);
    expect(Object.keys(EXPLANATION_DETAIL).sort()).toEqual(keys);
    expect(new Set(Object.values(EXPLANATION_LABELS)).size).toBe(5);
  });

  it('distinguishes a SUBSET from a MINIMAL set in words, not only in a code', () => {
    /* The distinction a scheduler acts on: a subset may contain rules that are
     * not part of the conflict at all, and relaxing one of those achieves
     * nothing. */
    expect(EXPLANATION_DETAIL.EXPLAINED_SUBSET.toLowerCase()).toContain('not necessarily');
    expect(EXPLANATION_DETAIL.EXPLAINED_MINIMAL.toLowerCase()).toContain('necessary');
  });

  it('states plainly, in each degraded state, that the answer is partial or absent', () => {
    /* SPEC-04 §5: "A scheduler is better served by 'we could not isolate the
     * cause in 60 seconds, here is what we do know' than by a system that
     * appears to hang or invents a confident-sounding but wrong answer." */
    expect(EXPLANATION_DETAIL.EXPLANATION_BUDGET_EXCEEDED.toLowerCase()).toContain('partial');
    expect(EXPLANATION_DETAIL.EXPLANATION_UNAVAILABLE.toLowerCase()).toContain(
      'says nothing about why',
    );
    /* And neither of them may present as a scheduling verdict: an explanation
     * failure is not an extra reason the period is infeasible. */
    expect(EXPLANATION_DETAIL.EXPLANATION_UNAVAILABLE.toLowerCase()).not.toContain(
      'no schedule exists',
    );
  });
});

describe('deterministic mode is described by its conditions, never as a promise', () => {
  it('names both modes and says what the best-effort one does not give', () => {
    expect(Object.keys(REPRODUCIBILITY_LABELS).sort()).toEqual(['best-effort', 'deterministic']);
    expect(REPRODUCIBILITY_LABELS['best-effort']?.toLowerCase()).toContain('not reproducible');
    /* EV-M0-SPC H-6, in the copy: a fixed seed alone is NOT enough, and a user
     * who believes it is will report an engine that "changed its mind". */
    expect(REPRODUCIBILITY_DETAIL['best-effort']?.toLowerCase()).toContain('seed alone is not');
  });
});
