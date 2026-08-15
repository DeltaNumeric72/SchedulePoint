import { randomUUID } from 'node:crypto';

import type {
  SolveRequestSpec,
  SolverCandidateAssignment,
  SolverInputSnapshotDocument,
} from '@schedulepoint/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCandidate } from '../../src/solver/candidate-validation.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import { DETERMINISTIC_PARAMETERS, applySolverEnv } from '../support/solver.js';
import { restAcrossGapDayProblem } from './corpus/generators.js';

/**
 * **NAMED PROOF — `MinimumRestBetween` reaches ACROSS a demand-free gap day**
 * (FAD-42 R-1; the reviewer's P8).
 *
 * ## The defect this pins, and why the corpus missed it
 *
 * `cpsat_adapter._hard` paired each date with `window_dates[index : index + 2]`
 * — this date and the NEXT one. Every rest pair further apart than one day was
 * therefore never posted to the model at all. The checker
 * (`hard-rule-check.ts`) compares chronologically ADJACENT assignments at any
 * distance, so the two implementations disagreed for every `minHours` a gap day
 * could span.
 *
 * The consequence was not a silent wrong answer — §3.3's redundancy held, and
 * that is worth saying plainly — but it was still a defect that mattered: the
 * checker refused every such candidate, so a **legal** rest rule could never
 * produce a usable build, and the engine reported *worker output rejected*
 * where the honest answer was INFEASIBLE. An operator reads the first as "the
 * solver is broken" and the second as "your rules cannot be satisfied".
 *
 * The corpus did not catch it because every corpus rest rule sat inside one day
 * (`B-ruleheavy`'s was `minHours: 8`). A window bug is invisible to fixtures
 * that never leave the window — which is why `B-ruleheavy` now carries a rest
 * rule that does leave it.
 *
 * ## The fixture, and why the number is decisive
 *
 * `restAcrossGapDayProblem` puts demand on date 1 and date 3 and NONE on date 2,
 * with a single participant. The only demand-satisfying schedule is a `DAY` on
 * date 1 (ends 16:00) and a `DAY` on date 3 (starts 08:00): **40.00 hours**.
 * One knob, two sides of it, and no other schedule to hide behind.
 *
 * ## Both directions, and what "agree" means in each
 *
 * | `minHours` | Model | Checker |
 * |---|---|---|
 * | 30 | solves it — the rest is legal | zero breaches on the model's own candidate |
 * | 41 | **INFEASIBLE** — no candidate exists | the only demand-satisfying schedule DOES breach, and the checker names the rule |
 *
 * The second row is the one the repair moved. Asserting only that the model now
 * says INFEASIBLE would leave open whether it is refusing for the right reason,
 * so the same schedule the model declined to produce is handed to the checker
 * directly: the model's silence and the checker's breach are two statements
 * about one fact, made independently.
 */

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

function specFor(document: SolverInputSnapshotDocument): SolveRequestSpec {
  return {
    protocolVersion: 1,
    organizationId: document.organizationId,
    groupId: document.groupId,
    buildRunId: randomUUID(),
    correlationId: 'rest-across-gap-day',
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(document),
    snapshotPayload: document,
    parameters: DETERMINISTIC_PARAMETERS,
  };
}

function check(
  document: SolverInputSnapshotDocument,
  assignments: readonly SolverCandidateAssignment[],
): { usable: boolean; breaches: string[] } {
  const hash = canonicalInputHash(document);
  const verdict = validateCandidate({
    snapshot: document,
    assignments,
    expectedInputHash: hash,
    reportedInputHash: hash,
  });
  return {
    usable: verdict.usable,
    breaches: verdict.findings
      .filter((finding) => finding.finding === 'breach')
      .map((finding) => `${finding.nodeKind}: ${finding.explanation}`),
  };
}

describe('MinimumRestBetween across a demand-free gap day (FAD-42 R-1)', () => {
  it('minHours=30 — 40 hours of rest is LEGAL: the model builds it and the checker agrees', async () => {
    const document = restAcrossGapDayProblem(30);
    const outcome = await solveOnWorker(specFor(document));

    expect(outcome.status, 'a legal rest rule must produce a build').toBe('OPTIMAL');
    expect(outcome.assignments, 'the model produced no candidate').not.toBeNull();
    const assignments = outcome.assignments ?? [];
    expect(assignments, 'both demanded dates are staffed').toHaveLength(2);

    const verdict = check(document, assignments);
    expect(verdict.breaches, 'the checker must find nothing to complain about').toEqual([]);
    expect(verdict.usable).toBe(true);
    log(
      `minHours=30: model ${outcome.status} with ${String(assignments.length)} row(s); ` +
        'independent checker usable=true, 0 breaches — the two AGREE',
    );
  });

  it('minHours=41 — the SAME 40 hours is ILLEGAL: the model refuses, and the checker says why', async () => {
    const document = restAcrossGapDayProblem(41);
    const outcome = await solveOnWorker(specFor(document));

    /* ── the model's half ─────────────────────────────────────────────────────
     *
     * Before the repair this came back OPTIMAL with two rows, because the
     * date-1 <-> date-3 pair was never posted. The honest answer is that the
     * demand cannot be met without breaking the rule.
     */
    expect(
      outcome.assignments,
      'the model produced a candidate for a problem whose only schedule breaches a HARD rule — ' +
        'the rest pairing is not reaching across the gap day',
    ).toBeNull();
    expect(outcome.status, 'and it must say so as INFEASIBLE, not as a rejected output').toBe(
      'INFEASIBLE',
    );

    /* ── the checker's half, on the schedule the model declined to produce ────
     *
     * Constructed here rather than taken from the model, because the model
     * (correctly) returns nothing. This is the only assignment pair that
     * satisfies the demand, so if it breaches then no usable build exists — and
     * that is exactly what the model just said.
     */
    const shiftTypeId = document.shiftTypes[0]?.shiftTypeId ?? '';
    const membershipId = document.participants[0]?.membershipId ?? '';
    const dates = [...new Set(document.demand.map((entry) => entry.on))].sort();
    const onlySchedule: SolverCandidateAssignment[] = dates.map((date) => ({
      membershipId,
      date,
      shiftTypeId,
      locationId: null,
    }));

    const verdict = check(document, onlySchedule);
    expect(
      verdict.breaches.join(' '),
      'the checker must name the rule it is refusing on',
    ).toContain('MinimumRestBetween');
    expect(verdict.usable, 'and refuse the candidate outright').toBe(false);
    log(
      `minHours=41: model ${outcome.status} with no candidate; the only demand-satisfying ` +
        `schedule breaches — ${verdict.breaches.join(' | ')} — the two AGREE`,
    );
  });
});
