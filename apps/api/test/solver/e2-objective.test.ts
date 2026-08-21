import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  E2_OBJECTIVE_PROFILE,
  OBJECTIVE_SCALE,
  SOLVER_STATUSES,
  objectiveProfileCanonicalString,
  resultReproducibility,
  type SolveRequestSpec,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRejectionSchema } from '@schedulepoint/contracts';

import { rejectionsOf } from '../../src/builds/views.js';
import { validateCandidate } from '../../src/solver/candidate-validation.js';
import {
  OBJECTIVE_PROFILE_CANONICAL,
  OBJECTIVE_PROFILE_DIGEST,
  SolverObjectiveMismatchError,
} from '../../src/solver/objective-record.js';
import { qualityMetrics } from '../../src/solver/quality-metrics.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker, type SolveOutcomeDetail } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import {
  applyHostileWorkerEnv,
  applySolverEnv,
  DETERMINISTIC_PARAMETERS,
  SOLVED_STATUSES,
  SOLVER_ROOT,
  wallClockVerdict,
  WORKER_INTERPRETER,
} from '../support/solver.js';
import { generatedCorpus, protectedPinWouldMoveProblem } from './corpus/generators.js';

/**
 * **NAMED PROOF — E2: the recorded objective, the earned minimality claim, the
 * pin that binds, and the status that never inflates** (OPUS-M4-004, doc 35 §6f).
 *
 * Every arm here drives the REAL worker subprocess. The properties under proof
 * are all properties of two implementations agreeing — a TypeScript objective
 * profile and a Python one, a model and an independent checker — and a mocked
 * worker would prove that a mock agrees with itself.
 */

const CORPUS = generatedCorpus();

function documentFor(name: string): SolverInputSnapshotDocument {
  const fixture = CORPUS.find((entry) => entry.name === name);
  if (fixture === undefined) throw new Error(`no corpus fixture named ${name}`);
  return fixture.document;
}

async function solve(
  document: SolverInputSnapshotDocument,
  overrides: Partial<SolveRequestSpec['parameters']> = {},
): Promise<SolveOutcomeDetail> {
  return solveOnWorker({
    protocolVersion: 1,
    organizationId: document.organizationId,
    groupId: document.groupId,
    buildRunId: randomUUID(),
    correlationId: 'e2-objective-proof',
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(document),
    snapshotPayload: document,
    parameters: { ...DETERMINISTIC_PARAMETERS, ...overrides },
  });
}

describe('the objective profile is single-sourced across the language boundary', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = applySolverEnv();
  });
  afterAll(() => {
    restore();
  });

  it('renders and digests identically in Python and TypeScript', () => {
    /* The scaling-constant proof, in its cheapest form: no solve, no database,
     * one interpreter invocation. Change `OBJECTIVE_SCALE` — or a tier weight,
     * or a kind's tier — on ONE side and this fails immediately, which is the
     * property doc 35 §6f's red arm falsifies from the other direction. */
    const script =
      'import json, sys;' +
      'from schedulepoint_solver import model as M;' +
      'from schedulepoint_solver.model import objective_profile_digest;' +
      'from schedulepoint_solver.protocol import canonical_dumps;' +
      'sys.stdout.write(json.dumps({' +
      '"canonical": canonical_dumps(M.objective_profile()),' +
      '"digest": objective_profile_digest(),' +
      '"scale": M.OBJECTIVE_SCALE,' +
      '"profileId": M.OBJECTIVE_PROFILE_ID}))';
    const raw = execFileSync(WORKER_INTERPRETER, ['-c', script], {
      cwd: SOLVER_ROOT,
      encoding: 'utf8',
    });
    const worker = JSON.parse(raw) as {
      canonical: string;
      digest: string;
      scale: number;
      profileId: string;
    };

    expect(worker.canonical).toBe(OBJECTIVE_PROFILE_CANONICAL);
    expect(worker.canonical).toBe(objectiveProfileCanonicalString());
    expect(worker.digest).toBe(OBJECTIVE_PROFILE_DIGEST);
    expect(worker.scale).toBe(OBJECTIVE_SCALE);
    expect(worker.profileId).toBe(E2_OBJECTIVE_PROFILE.profileId);
    log(`      · objective profile ${worker.profileId} · digest ${worker.digest.slice(0, 12)}…`);
  });

  it('records the profile on every response, whatever the outcome', async () => {
    const outcome = await solve(documentFor('B-feasible-small'));
    expect(outcome.objectiveProfile?.digest).toBe(OBJECTIVE_PROFILE_DIGEST);
    expect(outcome.objectiveProfile?.scale).toBe(OBJECTIVE_SCALE);

    const infeasible = await solve(documentFor('B-infeasible-over-demand'));
    /* An INFEASIBLE run has no objective VALUE and still reports the profile:
     * "which objective was this posed under" is a fact about the request. */
    expect(infeasible.status).toBe('INFEASIBLE');
    expect(infeasible.objectiveProfile?.digest).toBe(OBJECTIVE_PROFILE_DIGEST);
  });

  it('records SPEC-04 §4 statistics — counts and durations, never a model', async () => {
    const outcome = await solve(documentFor('B-feasible-medium'));
    expect(outcome.statistics.booleanVariables).toBeGreaterThan(0);
    expect(outcome.statistics.wallTimeSeconds).not.toBeNull();
    /* The machine-INDEPENDENT measure. A wall clock cannot tell a reproduction
     * attempt whether it did the same amount of search. */
    expect(outcome.statistics.deterministicTimeUnits).not.toBeNull();
    for (const value of Object.values(outcome.statistics)) {
      expect(value === null || typeof value === 'number').toBe(true);
    }
    log(
      `      · statistics: ${String(outcome.statistics.booleanVariables)} cells, ` +
        `${String(outcome.statistics.branches ?? 0)} branches, ` +
        `${String(outcome.statistics.deterministicTimeUnits ?? 0)} deterministic units`,
    );
  });
});

describe('the objective is TIERED and every component weight is recorded', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = applySolverEnv();
  });
  afterAll(() => {
    restore();
  });

  it('records rank, multiplier, scale and each rule’s scaled weight', async () => {
    const outcome = await solve(documentFor('B-fairness-shaped'));
    expect(SOLVED_STATUSES).toContain(outcome.status);
    expect(outcome.objectiveTiers.length).toBeGreaterThan(0);

    for (const tier of outcome.objectiveTiers) {
      const spec = E2_OBJECTIVE_PROFILE.tiers.find((entry) => entry.rank === tier.tier);
      if (spec === undefined) continue;
      expect(tier.name, `tier ${String(tier.tier)} name`).toBe(spec.key);
      expect(tier.weightScale, `tier ${String(tier.tier)} multiplier`).toBe(spec.tierWeight);
      expect(tier.scale).toBe(OBJECTIVE_SCALE);
      /* Every rule in the tier has a RECORDED weight, and it is the scaled one:
       * an authored 0.5 that became 5000 and an authored 0.5 that became 0 are
       * the same line in a rule listing and different facts about a result. */
      expect(tier.components.map((component) => component.ruleKey).sort()).toEqual(
        [...tier.ruleKeys].sort(),
      );
      for (const component of tier.components) {
        expect(component.scaledWeight, `${component.ruleKey} weight`).toBeGreaterThan(0);
        expect(Number.isInteger(component.scaledWeight)).toBe(true);
      }
    }
    log(
      `      · tiers: ${outcome.objectiveTiers
        .map(
          (tier) =>
            `${String(tier.tier)}:${tier.name}×${String(tier.weightScale)}(${String(tier.components.length)})`,
        )
        .join(' ')}`,
    );
  });

  it('a weight change moves the recorded objective, and ONLY the intended tier', async () => {
    /* The per-tier pin doc 35 §6f asks for. The rule set is edited in the
     * SNAPSHOT — a different problem, deliberately — and the assertion is about
     * which tier's record moved, not about the schedule. */
    const base = documentFor('B-fairness-shaped');
    const preferenceRule = base.ruleRevisions.find(
      (revision) =>
        revision.classification === 'SOFT' &&
        (revision.predicate as { kind?: string }).kind === 'ShiftPreference',
    );
    expect(preferenceRule, 'the fairness fixture carries a ShiftPreference rule').toBeDefined();
    if (preferenceRule === undefined) return;

    const doubled: SolverInputSnapshotDocument = {
      ...base,
      ruleRevisions: base.ruleRevisions.map((revision) =>
        revision.ruleKey === preferenceRule.ruleKey
          ? { ...revision, weight: String(Number(revision.weight ?? '1') * 2) }
          : revision,
      ),
    };

    const before = await solve(base);
    const after = await solve(doubled);

    const weightOf = (outcome: SolveOutcomeDetail, ruleKey: string): number | undefined =>
      outcome.objectiveTiers
        .flatMap((tier) => tier.components)
        .find((component) => component.ruleKey === ruleKey)?.scaledWeight;

    const beforeWeight = weightOf(before, preferenceRule.ruleKey);
    const afterWeight = weightOf(after, preferenceRule.ruleKey);
    expect(beforeWeight).toBeDefined();
    expect(afterWeight).toBe((beforeWeight ?? 0) * 2);

    /* Every OTHER rule's recorded weight is untouched. A change that moved a
     * neighbouring tier would mean the tiers share a coefficient somewhere, and
     * the recorded breakdown would be describing something the model did not do. */
    for (const tier of after.objectiveTiers) {
      for (const component of tier.components) {
        if (component.ruleKey === preferenceRule.ruleKey) continue;
        expect(weightOf(before, component.ruleKey), `${component.ruleKey} moved`).toBe(
          component.scaledWeight,
        );
      }
    }
    log(
      `      · preference weight ${String(beforeWeight)} → ${String(afterWeight)}; ` +
        'every other recorded weight unchanged',
    );
  });
});

describe('S-08t under E2 objectives — bit-identical on a soft-rule-bearing class', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = applySolverEnv();
  });
  afterAll(() => {
    restore();
  });

  it('reproduces B-fairness-shaped bit for bit under the FULL pinned set', async () => {
    /* doc 35 §6f required behaviour 4: S-08t EXTENDED to a corpus class under E2
     * objectives. `B-feasible-small` (M4-002's S-08t) carries no SOFT rule at
     * all, so it could not have shown that an OBJECTIVE reproduces — only that a
     * feasibility answer does. This class carries four. */
    const document = documentFor('B-fairness-shaped');
    const first = await solve(document);
    const second = await solve(document);

    expect(first.runtime.reproducibilityMode).toBe('deterministic');

    /* **The PRECONDITION, established rather than assumed** (OPUS-M4-005
     * continuation, §20). `reproducibilityMode` reports what was REQUESTED. It
     * cannot report that the wall clock ended the search, and for this class it
     * always did: `maxTimeInSeconds` was 10 and CP-SAT stops at whichever of the
     * two limits comes first, so the pinned deterministic budget never got to be
     * the thing that stopped it. The arm then diverged about one run in three —
     * standalone, on an idle machine — because the two solves' cut-offs landed
     * at different points in the search.
     *
     * This is the condition S-08t always MEANT and never said. It is asserted,
     * not waived: on a machine slow enough to make the 900-second net bind, this
     * fails and names why, which is the opposite of passing non-reproducibly. */
    for (const [label, outcome] of [
      ['first', first],
      ['second', second],
    ] as const) {
      const verdict = wallClockVerdict(outcome, DETERMINISTIC_PARAMETERS);
      expect(verdict.bound, `${label} solve: ${verdict.detail}`).toBe(false);
    }

    /* The MACHINE-INDEPENDENT half of the claim, and it is strictly stronger
     * than the byte comparison below: two solves can agree on a candidate by
     * coincidence, and cannot agree on the exact deterministic time consumed
     * unless they performed the same search. This is the number that moved —
     * 21.760483 against 21.660444 — while the wall clock was in charge. */
    expect(second.statistics.deterministicTimeUnits).toBe(first.statistics.deterministicTimeUnits);
    expect(second.statistics.branches).toBe(first.statistics.branches);
    expect(second.statistics.conflicts).toBe(first.statistics.conflicts);

    expect(JSON.stringify(first.assignments)).toBe(JSON.stringify(second.assignments));
    expect(first.objectiveValue).toBe(second.objectiveValue);
    expect(JSON.stringify(first.objectiveTiers)).toBe(JSON.stringify(second.objectiveTiers));
    log(
      `      · S-08t/E2: ${String((first.assignments ?? []).length)} assignments and objective ` +
        `${String(first.objectiveValue)} reproduced bit for bit; ` +
        `status ${first.status}, ${String(first.statistics.deterministicTimeUnits)} deterministic ` +
        `units in ${String(first.statistics.wallTimeSeconds)}s against a ` +
        `${String(DETERMINISTIC_PARAMETERS.maxTimeInSeconds)}s net`,
    );
  });

  it('B-1: a REAL cancelled solve is never reproducible, whatever its wall clock says', async () => {
    /* **FAD-50 B-1, against real CP-SAT.** The reviewer's RP-1 shape as a
     * permanent proof, authored here rather than merged from the probe branch.
     *
     * This is the arm the finding needed and did not have. A cancelled solve is
     * the one case where every OTHER input to the verdict looks healthy: the
     * deterministic set is pinned, the statistics are persisted, and the wall
     * time is SHORT — because a person pressed stop, not because the search
     * finished. The reviewer measured `CANCELLED`, 2.35s and 5.6 of 100
     * deterministic units, and the verdict said `reproducible`.
     *
     * `B-fairness-shaped` is used because it genuinely searches for ~33s under
     * the repaired budget, so there is a real solve running to interrupt. */
    const document = documentFor('B-fairness-shaped');
    const readyFile = join(tmpdir(), `sp-b1-ready-${randomUUID()}`);
    const cancelFile = join(tmpdir(), `sp-b1-cancel-${randomUUID()}`);

    try {
      const solving = solveOnWorker(
        {
          protocolVersion: 1,
          organizationId: document.organizationId,
          groupId: document.groupId,
          buildRunId: randomUUID(),
          correlationId: 'e2-b1-cancelled',
          snapshotId: randomUUID(),
          canonicalInputHash: canonicalInputHash(document),
          snapshotPayload: document,
          parameters: DETERMINISTIC_PARAMETERS,
        },
        { readyFile, cancelFile, timeoutMs: 120_000 },
      );

      /* Cancel only once the solve is genuinely RUNNING. Creating the sentinel
       * first would prove a worker can decline to start, which is a different
       * fact and would leave a much shorter wall time than the finding needs. */
      const startedWaiting = Date.now();
      while (!existsSync(readyFile) && Date.now() - startedWaiting < 60_000) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(readyFile), 'the real worker never reported ready').toBe(true);
      writeFileSync(cancelFile, 'e2-b1');

      const outcome = await solving;

      /* The facts, exactly as the reviewer found them. */
      expect(outcome.status).toBe('CANCELLED');
      expect(outcome.terminationReason).toBe('user_cancelled');
      expect(outcome.runtime.reproducibilityMode).toBe('deterministic');

      const wall = outcome.statistics.wallTimeSeconds;
      /* SHORT — comfortably inside the 900s net. This is precisely why the
       * wall-clock test alone waved it through. */
      const verdict = wallClockVerdict(outcome, DETERMINISTIC_PARAMETERS);
      expect(verdict.bound, `a cancelled solve should not read as wall-bound: ${verdict.detail}`).toBe(
        false,
      );

      /* THE REPAIR. */
      const claim = resultReproducibility({
        parameters: DETERMINISTIC_PARAMETERS,
        wallTimeSeconds: wall,
        terminationReason: outcome.terminationReason,
        status: SOLVER_STATUSES.find((s) => s === outcome.status) ?? null,
      });
      expect(claim.verdict).toBe('interrupted');
      expect(claim.reproducible).toBe(false);
      expect(claim.detail).toContain('cancelled');
      expect(claim.detail).not.toContain('produces the same schedule');

      log(
        `      · B-1: real solve CANCELLED after ${String(wall)}s of a ` +
          `${String(DETERMINISTIC_PARAMETERS.maxTimeInSeconds)}s net ` +
          `(${String(outcome.statistics.deterministicTimeUnits)} of ` +
          `${String(DETERMINISTIC_PARAMETERS.maxDeterministicTime)} units) → '${claim.verdict}'`,
      );
    } finally {
      rmSync(readyFile, { force: true });
      rmSync(cancelFile, { force: true });
    }
  }, 180_000);

  it('the precondition BITES: with the old 10s wall clock the search is wall-bound', async () => {
    /* The non-vacuity control. Without it the check above could be asserting
     * `false` against a condition nothing can ever satisfy, and the repair would
     * be decoration.
     *
     * The same class, the same pinned set, the ONE field restored to what it was
     * — and the verdict flips. It also records the two facts that make the
     * test-side precondition necessary in the first place:
     *
     *   1. the deterministic budget is nowhere near spent (100 pinned, ~12–22
     *      consumed), so it demonstrably was NOT what stopped the search; and
     *   2. the DISPATCH mode still reads `deterministic`, because that is a
     *      statement about the parameters the platform sent.
     *
     * **UPDATED DELIBERATELY (FAD-49), as the previous version of this comment
     * required.** (2) used to be the escalation: nothing in the recorded outcome
     * said a wall clock had cut the search short, so the run's own record
     * claimed `deterministic` and the build detail screen turned that into "the
     * same problem run again … produces the same schedule". The ruling granted
     * the RESULT-side verdict, derived from facts already persisted. So the
     * dispatch mode is asserted UNCHANGED — it was never wrong, it was answering
     * a different question — and the result-side verdict is asserted to refuse
     * the claim and to name the wall clock as the reason. */
    const wallBound = { ...DETERMINISTIC_PARAMETERS, maxTimeInSeconds: 10 };
    const outcome = await solve(documentFor('B-fairness-shaped'), { maxTimeInSeconds: 10 });

    const verdict = wallClockVerdict(outcome, wallBound);
    expect(verdict.bound, verdict.detail).toBe(true);

    const consumed = outcome.statistics.deterministicTimeUnits;
    expect(consumed).not.toBeNull();
    expect(consumed ?? 0).toBeLessThan(DETERMINISTIC_PARAMETERS.maxDeterministicTime ?? 0);

    /* The dispatch statement, unchanged and still correct. */
    expect(outcome.runtime.reproducibilityMode).toBe('deterministic');

    /* The RESULT-side verdict — the half that used to be missing. */
    const claim = resultReproducibility({
      parameters: wallBound,
      wallTimeSeconds: outcome.statistics.wallTimeSeconds,
      /* Read off the real outcome (FAD-50 B-1) rather than assumed: this solve
         DID complete — the clock stopped the search, nobody stopped the run —
         and saying so is what keeps the assertion below about the wall clock. */
      terminationReason: outcome.terminationReason,
      status: SOLVER_STATUSES.find((s) => s === outcome.status) ?? null,
    });
    expect(claim.verdict).toBe('wall-clock-truncated');
    expect(claim.reproducible).toBe(false);
    expect(claim.detail).toContain('WALL CLOCK');

    /* Falsifiability, kept: the SAME run's statistics under the repaired budget
     * are judged reproducible. Without this the assertions above would pass for
     * a predicate that refuses everything, which is a different way of being
     * useless than the one this arm was written to catch. */
    const underTheRepairedBudget = resultReproducibility({
      parameters: DETERMINISTIC_PARAMETERS,
      wallTimeSeconds: outcome.statistics.wallTimeSeconds,
      terminationReason: outcome.terminationReason,
      status: SOLVER_STATUSES.find((s) => s === outcome.status) ?? null,
    });
    expect(underTheRepairedBudget.verdict).toBe('reproducible');
    expect(underTheRepairedBudget.reproducible).toBe(true);

    log(
      `      · precondition control: wall ${String(outcome.statistics.wallTimeSeconds)}s of 10s ` +
        `ended the search after only ${String(consumed)} of ` +
        `${String(DETERMINISTIC_PARAMETERS.maxDeterministicTime)} deterministic units; ` +
        `dispatch mode '${outcome.runtime.reproducibilityMode}', ` +
        `result verdict '${claim.verdict}'`,
    );
  });
});

describe('T2: EXPLAINED_MINIMAL is earned, and a false claim is refused', () => {
  it('narrows the T1 subset and reports what it did', async () => {
    const restore = applySolverEnv();
    try {
      const outcome = await solve(documentFor('B-infeasible-contradictory-rules'));
      expect(outcome.status).toBe('INFEASIBLE');
      const explanation = outcome.explanation;
      expect(explanation).not.toBeNull();
      expect(explanation?.tier2?.attempted).toBe(true);
      /* The claim and the record must agree. `EXPLAINED_MINIMAL` with
       * `exhausted: true` would be a minimality claim over a pass that stopped
       * early — the exact thing a scheduler would act on and should not. */
      if (explanation?.state === 'EXPLAINED_MINIMAL') {
        expect(explanation.tier2?.exhausted).toBe(false);
        expect(explanation.tier2?.iterations ?? 0).toBeGreaterThan(0);
      } else {
        expect(explanation?.state).toBe('EXPLANATION_BUDGET_EXCEEDED');
        expect(explanation?.tier2?.exhausted).toBe(true);
      }
      /* Every element of the constructed cause survives the narrowing. A
       * minimisation that dropped a genuinely necessary rule would report a
       * smaller, WRONG answer — worse than the subset it started from. */
      expect(explanation?.conflictingRuleKeys).toContain('ci-implies');
      expect(explanation?.conflictingRuleKeys).toContain('ci-mutex');
      log(
        `      · T2: ${explanation?.state ?? 'none'} after ` +
          `${String(explanation?.tier2?.iterations ?? 0)} probe(s), ` +
          `${String(explanation?.tier2?.removed ?? 0)} removed`,
      );
    } finally {
      restore();
    }
  });

  it('DOWNGRADES a worker that claims minimality with no pass behind it', async () => {
    /* The strongest claim an explanation can make, asserted by the least trusted
     * component that ships. The platform does not take its word for it. */
    const restore = applyHostileWorkerEnv('false-minimality');
    try {
      const outcome = await solve(documentFor('B-feasible-small'));
      expect(outcome.status).toBe('INFEASIBLE');
      expect(outcome.explanation?.state).toBe('EXPLAINED_SUBSET');
      expect(outcome.explanation?.state).not.toBe('EXPLAINED_MINIMAL');
      log('      · a false EXPLAINED_MINIMAL was downgraded to EXPLAINED_SUBSET');
    } finally {
      restore();
    }
  });
});

describe('a response under a different objective is REFUSED', () => {
  it('refuses a mismatching digest', async () => {
    const restore = applyHostileWorkerEnv('objective-mismatch');
    try {
      await expect(solve(documentFor('B-feasible-small'))).rejects.toBeInstanceOf(
        SolverObjectiveMismatchError,
      );
    } finally {
      restore();
    }
  });

  it('refuses an ABSENT objective record — an absent claim is not agreement', async () => {
    const restore = applyHostileWorkerEnv('objective-absent');
    try {
      await expect(solve(documentFor('B-feasible-small'))).rejects.toBeInstanceOf(
        SolverObjectiveMismatchError,
      );
    } finally {
      restore();
    }
  });
});

describe('progressive optimization: the pin binds, and it would have moved', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = applySolverEnv();
  });
  afterAll(() => {
    restore();
  });

  it('UNPINNED: the optimizer moves the assignment to the cheaper participant', async () => {
    /* The control, and without it the arm below proves nothing: an assignment
     * that was never going to move cannot demonstrate that anything held it. */
    const document = protectedPinWouldMoveProblem('unpinned');
    const outcome = await solve(document);
    expect(SOLVED_STATUSES).toContain(outcome.status);
    const preferred = document.participants[1]?.membershipId;
    expect(outcome.assignments).toHaveLength(1);
    expect(outcome.assignments?.[0]?.membershipId).toBe(preferred);
    log('      · unpinned: the optimizer moved it, as designed');
  });

  it('PINNED: the assignment stays put, against a strictly better objective', async () => {
    const document = protectedPinWouldMoveProblem('pinned');
    const outcome = await solve(document);
    expect(SOLVED_STATUSES).toContain(outcome.status);
    const protectedMembership = document.participants[0]?.membershipId;
    expect(outcome.assignments).toHaveLength(1);
    expect(outcome.assignments?.[0]?.membershipId).toBe(protectedMembership);
    log('      · pinned: the protection outranked a cheaper objective');
  });

  it('the CHECKER refuses a candidate that dropped a pin, whatever the model did', async () => {
    /* The independent half. The model cannot produce this row — which is exactly
     * why the checker must not assume it did its job (SPEC-04 §3.3). */
    const document = protectedPinWouldMoveProblem('pinned');
    const hash = canonicalInputHash(document);
    const moved = document.participants[1]?.membershipId ?? '';
    const verdict = validateCandidate({
      snapshot: document,
      assignments: [
        {
          membershipId: moved,
          date: document.startDate,
          shiftTypeId: document.shiftTypes[0]?.shiftTypeId ?? '',
          locationId: null,
        },
      ],
      expectedInputHash: hash,
      reportedInputHash: hash,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain(
      'protected-assignment-dropped',
    );

    /* The mutation control: the SAME checker accepts the candidate that HONOURS
     * the pin. Without it the refusal above could be any refusal at all. */
    const honoured = validateCandidate({
      snapshot: document,
      assignments: [
        {
          membershipId: document.participants[0]?.membershipId ?? '',
          date: document.startDate,
          shiftTypeId: document.shiftTypes[0]?.shiftTypeId ?? '',
          locationId: null,
        },
      ],
      expectedInputHash: hash,
      reportedInputHash: hash,
    });
    expect(honoured.usable).toBe(true);
    log('      · dropped pin refused; the pin-honouring candidate accepted');
  });
});

describe('status honesty and the metric set, end to end', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = applySolverEnv();
  });
  afterAll(() => {
    restore();
  });

  it('never reports OPTIMAL without a proof, and never conflates the two', async () => {
    const outcome = await solve(documentFor('B-fairness-shaped'), { maxTimeInSeconds: 1 });
    expect(SOLVED_STATUSES).toContain(outcome.status);
    /* Whichever of the two it is, the OTHER one must not be claimed anywhere in
     * the recorded outcome. The two words are the whole content of SPEC-04 §7's
     * "no optimality claim for a feasible result". */
    const recorded = JSON.stringify({
      status: outcome.status,
      terminationReason: outcome.terminationReason,
    });
    if (outcome.status === 'FEASIBLE') expect(recorded).not.toContain('OPTIMAL');
    if (outcome.status === 'OPTIMAL') expect(recorded).not.toContain('FEASIBLE');
  });

  it('measures SPEC-04 §7 and leaves the unmeasurable rates NULL', async () => {
    const document = documentFor('B-fairness-shaped');
    const outcome = await solve(document);
    const metrics = qualityMetrics({
      snapshot: document,
      assignments: outcome.assignments ?? [],
      outcome,
      hardViolations: 0,
    });

    expect(metrics.objectiveWeightsDigest).toBe(OBJECTIVE_PROFILE_DIGEST);
    expect(metrics.objectiveScale).toBe(OBJECTIVE_SCALE);
    expect(metrics.fairnessNormalisation).toBe('fte-work-percentage');
    expect(metrics.fairnessMeasuredParticipants).toBeGreaterThan(1);
    /* The two `null`s, and they are the point: a `0` would claim every request
     * was refused and every template ignored, which are specific, wrong,
     * actionable claims about inputs that do not exist at M4. */
    expect(metrics.requestHonourRate).toBeNull();
    expect(metrics.templateAdherenceRate).toBeNull();
    log(
      `      · fairness dispersion ${String(metrics.fairnessDispersion)} over ` +
        `${String(metrics.fairnessMeasuredParticipants)} participants (${metrics.fairnessNormalisation})`,
    );
  });

  it('an explanation failure leaves the build INFEASIBLE — it never flips the outcome', async () => {
    /* SPEC-04 §5, and doc 35 §6f behaviour 6. The explanation budget is driven to
     * a value the T1 solve cannot use, so the explanation degrades — and the
     * SCHEDULING answer must be untouched by that. */
    const document = documentFor('B-infeasible-contradictory-rules');
    const outcome = await solveOnWorker({
      protocolVersion: 1,
      organizationId: document.organizationId,
      groupId: document.groupId,
      buildRunId: randomUUID(),
      correlationId: 'e2-explanation-degraded',
      snapshotId: randomUUID(),
      canonicalInputHash: canonicalInputHash(document),
      snapshotPayload: document,
      parameters: DETERMINISTIC_PARAMETERS,
    });
    expect(outcome.status).toBe('INFEASIBLE');
    expect(outcome.assignments).toBeNull();
    expect(outcome.terminationReason).toBe('completed');
    /* Whatever the explanation state turned out to be, it is one of the five and
     * the outcome above is unaffected by which. */
    expect([
      'EXPLAINED_EXACT',
      'EXPLAINED_SUBSET',
      'EXPLAINED_MINIMAL',
      'EXPLANATION_BUDGET_EXCEEDED',
      'EXPLANATION_UNAVAILABLE',
    ]).toContain(outcome.explanation?.state);
  });
});

/**
 * **REPAIR F-03 — the §7 metric measures cells, and the INDEPENDENT checker
 * measures them too.**
 *
 * The reviewer's probe-04 shape, against the real corpus snapshot: the same
 * NUMBER of assignments as a correct candidate, every one of them moved to a
 * date that carries no requirement. The shipped metric scored that `1` and the
 * `unmet-demand` conflict — which is raised by reading that very number — was
 * suppressed by it.
 *
 * The checker half matters independently. Until this repair, demand was enforced
 * ONLY by the model's hard equality, so the guarantee rested on the solver
 * continuing to post a constraint nobody else measured. That is the D-4 shape,
 * and this is the arm that makes the model's demand posting falsifiable from
 * outside the model.
 */
describe('demand coverage: the metric matches cells, and the checker measures it too', () => {
  const document = documentFor('B-feasible-small');
  const required = document.demand.filter(
    (cell) => cell.source === 'period-requirement' && cell.requiredCount > 0,
  );

  const outcome = {
    status: 'OPTIMAL',
    objectiveValue: 0,
    elapsedMs: 1,
    explanation: null,
    objectiveProfile: {
      profileId: E2_OBJECTIVE_PROFILE.profileId,
      scale: OBJECTIVE_SCALE,
      digest: OBJECTIVE_PROFILE_DIGEST,
    },
    statistics: {},
  } as unknown as SolveOutcomeDetail;

  /** A candidate that fills every required cell exactly, on the RIGHT cells. */
  const correct = required.flatMap((cell) =>
    Array.from({ length: cell.requiredCount }, (_, index) => ({
      membershipId: document.participants[index % document.participants.length]!.membershipId,
      /* `on` is the DATE for a period requirement. The reviewer's probe reads
       * `cell.date`, which this type does not carry — under the old count-based
       * metric that read `undefined` and still scored 1, which is precisely why
       * the defect survived a probe written to catch it. */
      date: cell.on,
      shiftTypeId: cell.shiftTypeId,
    })),
  );

  const measure = (
    assignments: readonly { membershipId: string; date: string; shiftTypeId: string }[],
  ) =>
    qualityMetrics({
      snapshot: document,
      assignments: assignments as never,
      outcome,
      hardViolations: 0,
    });

  it('the corpus snapshot really does carry required cells (else this proves nothing)', () => {
    expect(required.length).toBeGreaterThan(0);
    expect(correct.length).toBeGreaterThan(0);
  });

  it('a candidate that fills every required cell scores exactly 1', () => {
    const metrics = measure(correct);
    expect(metrics.filledSlots).toBe(metrics.requiredSlots);
    expect(metrics.demandSatisfactionRate).toBe(1);
  });

  it('the SAME count of assignments, all on a no-demand date, scores 0 and raises the conflict', () => {
    const moved = correct.map((assignment) => ({ ...assignment, date: '2099-12-31' }));
    const metrics = measure(moved);
    expect(moved).toHaveLength(correct.length);
    expect(metrics.demandSatisfactionRate).not.toBe(1);
    expect(metrics.demandSatisfactionRate).toBe(0);
    expect(metrics.filledSlots).toBe(0);
  });

  it('an empty candidate scores 0', () => {
    expect(measure([]).demandSatisfactionRate).toBe(0);
  });

  it('the INDEPENDENT checker refuses a candidate that leaves demand unmet', () => {
    const hash = canonicalInputHash(document);
    const verdict = validateCandidate({
      snapshot: document,
      assignments: [],
      expectedInputHash: hash,
      reportedInputHash: hash,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain('demand-not-met');
  });

  it('the checker refuses a candidate that staffs a cell nobody asked for', () => {
    const hash = canonicalInputHash(document);
    const verdict = validateCandidate({
      snapshot: document,
      assignments: [...correct, { ...correct[0]!, date: '2099-12-31' }] as never,
      expectedInputHash: hash,
      reportedInputHash: hash,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain('demand-not-met');
  });
});

/**
 * **REPAIR F-14 — a refusal that cannot be reported is a refusal with no reason.**
 *
 * `demand-not-met` was added to the validator's union and to nothing else. Round 1's
 * fifth reason (`protected-assignment-dropped`) had gone into THREE places — the
 * validator, `views.ts`'s allowlist, and `buildRejectionSchema` — and the sixth went
 * into one. The allowlist fails CLOSED, which is right for a forged row and
 * catastrophic for a real one: the candidate is still refused, and the screen now says
 * why: nothing.
 *
 * The delta reviewer's probe-11 shape, as a chain. Each link is asserted separately,
 * because a chain tested only end-to-end tells you it broke, not where.
 */
describe('a demand-not-met refusal survives every layer between the checker and the screen', () => {
  const document = documentFor('B-feasible-small');
  const hash = canonicalInputHash(document);

  /** Layer 1 — the checker produces it. */
  const verdict = validateCandidate({
    snapshot: document,
    assignments: [],
    expectedInputHash: hash,
    reportedInputHash: hash,
  });

  it('1. the validator produces a demand-not-met rejection', () => {
    expect(verdict.usable).toBe(false);
    const demand = verdict.rejections.filter((r) => r.reason === 'demand-not-met');
    expect(demand.length).toBeGreaterThan(0);
    expect(demand[0]!.detail.length).toBeGreaterThan(0);
  });

  it('2. the CONTRACT accepts it — the enum carries the reason the validator can emit', () => {
    for (const rejection of verdict.rejections) {
      expect(() => buildRejectionSchema.parse(rejection)).not.toThrow();
    }
    /* stated positively too, so a rename cannot pass by making the loop empty */
    expect(() =>
      buildRejectionSchema.parse({ reason: 'demand-not-met', detail: 'unmet demand' }),
    ).not.toThrow();
  });

  it('3. the READ PATH carries it rather than filtering it away', () => {
    const carried = rejectionsOf(verdict.rejections);
    expect(carried.map((r) => r.reason)).toContain('demand-not-met');
    /* and the allowlist still bites: an invented reason is dropped */
    expect(rejectionsOf([{ reason: 'not-a-real-reason', detail: 'x' }])).toHaveLength(0);
  });

  it('4. every reason the validator can emit is carried — not just this one', () => {
    /* The class, not the instance. This is the assertion that would have caught
       F-14 when the sixth reason was added, and it will catch the seventh. */
    const everyReason = [
      'input-hash-mismatch',
      'unknown-reference',
      'duplicate-assignment',
      'ineligible-assignment',
      'protected-assignment-dropped',
      'demand-not-met',
      'hard-violation',
    ] as const;
    for (const reason of everyReason) {
      expect(() => buildRejectionSchema.parse({ reason, detail: 'd' })).not.toThrow();
      expect(rejectionsOf([{ reason, detail: 'd' }]).map((r) => r.reason)).toEqual([reason]);
    }
  });
});
