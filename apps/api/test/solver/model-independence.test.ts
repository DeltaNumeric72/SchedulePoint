import { randomUUID } from 'node:crypto';

import type { SolveRequestSpec } from '@schedulepoint/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCandidate } from '../../src/solver/candidate-validation.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import { DETERMINISTIC_PARAMETERS, applySolverEnv } from '../support/solver.js';
import { generatedCorpus } from './corpus/generators.js';

/**
 * **NAMED PROOF — the checker is INDEPENDENT of the model, and catches it**
 * (OPUS-M4-002; doc 35 §6d "Solver-vs-checker independence mutation", the
 * `solver-model-constraint-dropped` red case).
 *
 * ## The property, and why it needs its own file
 *
 * `corpus-agreement.test.ts` asserts that the two implementations AGREE. That is
 * necessary and it is not sufficient: two implementations that share a defect
 * agree perfectly. What has to be shown is that the checker would **disagree**
 * if the model were wrong — and the only honest way to show it is to make the
 * model wrong and look.
 *
 * The red case does exactly that: it drops the whole **linkage constraint
 * family** (`LinkedShifts` / `ImpliesAssignment` / `MutuallyExclusive`) from
 * `cpsat_adapter.py` and runs this file.
 *
 * ## Why the contradictory fixture, and why the catch is CERTAIN
 *
 * `B-infeasible-contradictory-rules` demands one `AUX` and one `EVE` on every
 * date, under two HARD rules that cannot both hold: `AUX` implies `EVE` on the
 * same date, and `AUX` excludes `EVE` on the same date. With the model intact
 * the problem is unsatisfiable and no candidate exists.
 *
 * Drop the family and the problem becomes solvable — but **every** solution to
 * it breaches at least one of the two rules, by construction: any candidate must
 * place `AUX` somewhere, and that membership either also has `EVE` on that date
 * (breaching the exclusion) or does not (breaching the implication). There is no
 * third option and no lucky draw. So the checker's catch does not depend on
 * which solution CP-SAT happens to find, which is what makes this a proof rather
 * than an observation.
 *
 * ## What the two directions look like
 *
 * | Tree | This file |
 * |---|---|
 * | clean | `INFEASIBLE`, no candidate — and the case says so |
 * | family dropped | a candidate arrives; the checker measures its breaches and REPORTS them; the case then FAILS on the candidate's very existence |
 *
 * The failure in the red direction is deliberately the *second* assertion, not
 * the first. The transcript therefore shows the checker doing its job — the
 * violated rule keys and their counts — immediately above the line that says the
 * model should never have produced the row. A case that failed on the first
 * assertion would prove the model changed and say nothing about the checker.
 */

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

const CONTRADICTORY = generatedCorpus().find(
  (fixture) => fixture.corpusClass === 'infeasible-contradictory-rules',
);
if (CONTRADICTORY === undefined) throw new Error('the contradictory corpus fixture is missing');

describe('the independent checker would catch a model that lost a constraint', () => {
  it('the linkage family is IN the model — and if it were not, the checker would catch it', async () => {
    const document = CONTRADICTORY.document;
    const spec: SolveRequestSpec = {
      protocolVersion: 1,
      organizationId: document.organizationId,
      groupId: document.groupId,
      buildRunId: randomUUID(),
      correlationId: 'model-independence',
      snapshotId: randomUUID(),
      canonicalInputHash: canonicalInputHash(document),
      snapshotPayload: document,
      parameters: DETERMINISTIC_PARAMETERS,
    };

    const outcome = await solveOnWorker(spec);

    if (outcome.assignments !== null) {
      /* THE RED DIRECTION. A candidate exists for a problem that has none, so
       * the model has lost a constraint. Measure the candidate with the
       * INDEPENDENT checker first and report what it found — that is the whole
       * subject of this file — and only then fail on the fact that the row
       * exists at all. */
      const verdict = validateCandidate({
        snapshot: document,
        assignments: outcome.assignments,
        expectedInputHash: spec.canonicalInputHash,
        reportedInputHash: outcome.canonicalInputHash,
      });
      const breaches = verdict.findings.filter((finding) => finding.finding === 'breach');
      const byRule = new Map<string, number>();
      for (const breach of breaches) byRule.set(breach.ruleKey, (byRule.get(breach.ruleKey) ?? 0) + 1);

      log(
        '      · THE CHECKER CAUGHT IT: ' +
          `${String(verdict.hardViolations)} hard violation(s) across ` +
          `${String((outcome.assignments ?? []).length)} assignment(s) — ` +
          [...byRule].map(([key, count]) => `${key}×${String(count)}`).join(', '),
      );
      expect(
        verdict.usable,
        'the model produced a candidate AND the checker accepted it — the redundancy is gone',
      ).toBe(false);
      expect(verdict.hardViolations).toBeGreaterThan(0);
    }

    /* THE GREEN DIRECTION, and the assertion the red case fails on. */
    expect(
      outcome.assignments,
      'the model produced a candidate for a problem two HARD rules make unsatisfiable',
    ).toBeNull();
    expect(outcome.status).toBe('INFEASIBLE');
    log('      · linkage family present: the contradictory fixture has no solution, as constructed');
  }, 120_000);
});
