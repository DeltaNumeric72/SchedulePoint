import { randomUUID } from 'node:crypto';

import type { SolveRequestSpec, SolverInputSnapshotDocument } from '@schedulepoint/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateCandidate } from '../../src/solver/candidate-validation.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import { DETERMINISTIC_PARAMETERS, applySolverEnv } from '../support/solver.js';
import { emptyStaffGroupScopeProblem } from './corpus/generators.js';

/**
 * **RULED PIN — a KNOWN but EMPTY `scope.staffGroups` satisfies VACUOUSLY; an
 * UNKNOWN id still blocks** (FAD-42(3), the reviewer's P4).
 *
 * ## Why this needed a ruling rather than a bug fix
 *
 * At base, ANY rule carrying `scope.staffGroups` was `not-evaluable` and
 * therefore blocked publication — but **not as a semantic decision**. The whole
 * kind was not evaluable because the vocabulary to resolve a staff-group id had
 * not reached the checker yet, so the block was an accident of coverage. When
 * RK-RULING-02 pinned the domain and the scope filter began to resolve, a known
 * group with no members started filtering every assignment away, and the rule
 * began passing.
 *
 * That is a change in observable behaviour arriving as a side effect, which is
 * exactly the shape that deserves a recorded decision rather than a shrug.
 * FAD-42(3) made it: **an empty scope makes no statement.** The rule binds the
 * members of the named group; a group with no members leaves nothing to bind,
 * and a rule that binds nothing is satisfied — the same reading RK-RULING-04
 * already applies elsewhere.
 *
 * The unknown id is the opposite case and keeps its refusal: a scope that cannot
 * be resolved narrows to an *unknown* subset, and a rule evaluated over an
 * unknown subset is a rule evaluated over the wrong one. Failing closed there is
 * FAD-27, not caution.
 *
 * ## Why both implementations are pinned, not just the checker
 *
 * The two halves reach this from opposite directions and could drift apart
 * without either being obviously wrong: `model.py` raises
 * `rule_identifier_unresolved` while building, and `hard-rule-check.ts` returns
 * a `not-evaluable` finding while checking. A pin on one says nothing about the
 * other, and "the model and the checker agree" is the property this milestone
 * exists to defend.
 *
 * ## The fixture, and why it cannot pass by accident
 *
 * `emptyStaffGroupScopeProblem` demands one `DAY` on each of two dates with one
 * participant, under a HARD `AvoidDate` rule on the FIRST date. If that rule
 * applied to the participant the problem would be **infeasible** — the demand on
 * date 1 could not be met. So "the model produced a full two-row schedule" is
 * only possible if the rule really did bind nobody. A vacuous pass that was
 * secretly a silent skip would look identical on a fixture the rule could not
 * have changed; here it cannot.
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
    correlationId: 'empty-staff-group-scope',
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(document),
    snapshotPayload: document,
    parameters: DETERMINISTIC_PARAMETERS,
  };
}

describe('scope.staffGroups that resolves to nobody (FAD-42(3))', () => {
  it('KNOWN but EMPTY — the MODEL builds it: the rule bound nobody', async () => {
    const document = emptyStaffGroupScopeProblem('known-empty');
    const outcome = await solveOnWorker(specFor(document));

    expect(
      outcome.status,
      'the AvoidDate rule bound nobody, so the demand on both dates is satisfiable',
    ).toBe('OPTIMAL');
    const assignments = outcome.assignments ?? [];
    expect(
      assignments,
      'both dates staffed — including the date the rule would have forbidden',
    ).toHaveLength(2);
    log(
      `known-empty: model ${outcome.status} with ${String(assignments.length)} row(s) — ` +
        'the empty scope made no statement',
    );
  });

  it('KNOWN but EMPTY — the CHECKER agrees: no breach, and NOT a not-evaluable refusal', async () => {
    const document = emptyStaffGroupScopeProblem('known-empty');
    const outcome = await solveOnWorker(specFor(document));
    const hash = canonicalInputHash(document);

    const verdict = validateCandidate({
      snapshot: document,
      assignments: outcome.assignments ?? [],
      expectedInputHash: hash,
      reportedInputHash: hash,
    });

    const breaches = verdict.findings.filter((finding) => finding.finding === 'breach');
    const refusals = verdict.findings.filter((finding) => finding.finding === 'not-evaluable');
    expect(breaches, 'a vacuously satisfied rule is not a breach').toEqual([]);
    expect(
      refusals.map((finding) => finding.explanation),
      'and it is NOT a refusal either — a known group that is empty resolves fine',
    ).toEqual([]);
    expect(verdict.usable, 'so the candidate is usable').toBe(true);
    log('known-empty: checker usable=true, 0 breaches, 0 not-evaluable — the two AGREE');
  });

  it('UNKNOWN id — the MODEL refuses to build at all', async () => {
    const document = emptyStaffGroupScopeProblem('unknown');
    const outcome = await solveOnWorker(specFor(document));

    expect(outcome.assignments, 'an unresolvable scope must never produce a schedule').toBeNull();
    expect(outcome.status, 'the worker declines the request').toBe('FAILED');
    log(`unknown id: model ${outcome.status}, no candidate — fail-closed (FAD-27)`);
  });

  it('UNKNOWN id — the CHECKER refuses too, and names the id', () => {
    const document = emptyStaffGroupScopeProblem('unknown');
    const hash = canonicalInputHash(document);

    /* The model produced nothing, so the checker is asked about the schedule the
     * `known-empty` arm proves is otherwise legal. The point is that an
     * unresolvable scope is refused on its own terms — not because the rows are
     * wrong, but because the rule cannot be evaluated over an unknown subset. */
    const shiftTypeId = document.shiftTypes[0]?.shiftTypeId ?? '';
    const membershipId = document.participants[0]?.membershipId ?? '';
    const dates = [...new Set(document.demand.map((entry) => entry.on))].sort();

    const verdict = validateCandidate({
      snapshot: document,
      assignments: dates.map((date) => ({ membershipId, date, shiftTypeId, locationId: null })),
      expectedInputHash: hash,
      reportedInputHash: hash,
    });

    const refusals = verdict.findings
      .filter((finding) => finding.finding === 'not-evaluable')
      .map((finding) => finding.explanation);
    expect(refusals.join(' '), 'the refusal must name the scope that would not resolve').toContain(
      'scope.staffGroups names',
    );
    expect(verdict.usable, 'and the candidate must not be usable').toBe(false);
    log(`unknown id: checker usable=false — ${refusals.join(' | ')}`);
  });
});
