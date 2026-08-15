import { EVALUATED_HARD_RULE_KINDS } from '@schedulepoint/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateCandidate } from '../../../src/solver/candidate-validation.js';
import { log } from '../../support/harness.js';
import { SOLVED_STATUSES, applySolverEnv } from '../../support/solver.js';
import { e1Corpus, runFixture, summaryLine, type CorpusRun } from './corpus.js';
import type { CorpusFixture } from './generators.js';
import { readRaceCapture } from './race-fixture.js';

/**
 * **NAMED PROOF — the solver and the independent checker agree, on every corpus
 * fixture** (OPUS-M4-002; doc 35 §6d "Green tests / red-mutation controls",
 * SPEC-04 §3.3, §5, §8).
 *
 * > solver AND checker agreeing on every corpus fixture (agreement asserted, not
 * > assumed)
 *
 * ## Why agreement has to be asserted rather than reasoned about
 *
 * The two implementations share **no evaluation code** — Python over the
 * request, building CP-SAT variables and linear statements; TypeScript over the
 * snapshot and the returned rows, making a pass over finished assignments. That
 * independence is the whole safety argument for the pipeline, and it is worth
 * exactly nothing unless the two are put in front of the same problems and
 * compared. A wrong schedule is the most dangerous artifact this system can
 * produce precisely because it is indistinguishable, by inspection, from a right
 * one.
 *
 * So every fixture is posed to the **real worker subprocess** and every returned
 * candidate is re-checked. There is no mock anywhere in this file.
 *
 * ## What each class asserts
 *
 * | Class | Assertion |
 * |---|---|
 * | feasible / multisite / rule-heavy / pinned / qualifications / FTE / fairness | a solved status, a candidate, and **zero independently measured hard violations** |
 * | `locum-shaped` | the worker REFUSES, naming the kind and its owner (FAD-27) — never a silent solve |
 * | `infeasible-*` | `INFEASIBLE`, with the CONSTRUCTED cause matched by T0 or T1, or an explicitly degraded state |
 * | `race-retired-holding` | the validator REJECTS a candidate staffing the raced membership |
 *
 * The expectations are read from each fixture's own `expectation` field, which
 * is part of the committed manifest — recorded before the run rather than
 * fitted to it.
 */

let runs: CorpusRun[] = [];
let fixtures: readonly CorpusFixture[] = [];
let restoreEnv: () => void;

beforeAll(async () => {
  restoreEnv = applySolverEnv();
  fixtures = await e1Corpus();
  runs = [];
  for (const fixture of fixtures) {
    /* Serially, and deliberately: one solve occupies one subprocess (SPEC-04
     * §2), and fifteen concurrent CP-SAT processes would measure this machine's
     * scheduler rather than the corpus. */
    runs.push(await runFixture(fixture));
  }
}, 600_000);

afterAll(() => {
  restoreEnv?.();
});

const runFor = (name: string): CorpusRun => {
  const found = runs.find((run) => run.fixture.name === name);
  if (found === undefined) throw new Error(`no run recorded for ${name}`);
  return found;
};

describe('the E1 corpus, solver against independent checker', () => {
  it('records the per-class run summary', () => {
    expect(runs.length).toBeGreaterThan(0);
    log('      ┌─ E1 CORPUS RUN SUMMARY ─────────────────────────────────────');
    for (const run of runs) log(`      │ ${summaryLine(run)}`);
    log('      └─────────────────────────────────────────────────────────────');
  });

  it('agrees on every fixture — the constructed expectation, fixture by fixture', () => {
    for (const run of runs) {
      const { fixture, outcome, verdict } = run;
      const where = `${fixture.name} (${fixture.corpusClass})`;

      if (fixture.expectation.outcome === 'solved') {
        expect(SOLVED_STATUSES, `${where}: not solved`).toContain(outcome.status);
        expect(outcome.terminationReason, where).toBe('completed');
        expect(verdict, `${where}: a solved run returned no candidate to check`).not.toBeNull();
        /* THE agreement assertion. The solver said this schedule satisfies every
         * HARD rule; the checker measured it from the other side and must find
         * nothing. */
        expect(verdict?.hardViolations, `${where}: independently measured violations`).toBe(0);
        expect(verdict?.rejections.map((r) => r.reason), where).toEqual([]);
        expect(verdict?.usable, where).toBe(true);
        continue;
      }

      if (fixture.expectation.outcome === 'worker-refused') {
        /* FAD-27's fail-closed path. A build that SOLVED this would have
         * silently ignored an active HARD rule, which SPEC-04 §3.3 admits no
         * path to — so the refusal here is the correct answer and a candidate
         * would be the defect. */
        expect(outcome.status, `${where}: the worker did not refuse`).toBe(
          fixture.expectation.status,
        );
        expect(outcome.terminationReason, where).toBe(fixture.expectation.terminationReason);
        expect(outcome.assignments, `${where}: a refused model returned a candidate`).toBeNull();
        /* WHICH block fired. Without the code the refusal is indistinguishable
         * from any other rejection — a malformed request, a bad identifier —
         * and the fail-closed claim would rest on the status alone. */
        expect(outcome.refusalCode, `${where}: the wrong refusal block fired`).toBe(
          fixture.expectation.code,
        );
        continue;
      }

      expect(outcome.status, `${where}: not identified as infeasible`).toBe('INFEASIBLE');
      expect(outcome.assignments, `${where}: an infeasible solve returned a candidate`).toBeNull();
      expect(outcome.explanation, `${where}: INFEASIBLE with no explanation at all`).not.toBeNull();

      const explanation = outcome.explanation;
      const codes = (explanation?.structural ?? []).map((finding) => finding.code);
      for (const expected of fixture.expectation.structuralCodes ?? []) {
        expect(codes, `${where}: T0 did not name the constructed cause`).toContain(expected);
      }
      for (const expected of fixture.expectation.conflictingRuleKeys ?? []) {
        expect(
          explanation?.conflictingRuleKeys,
          `${where}: T1 did not name the constructed cause`,
        ).toContain(expected);
      }
      /* An explanation is never allowed to be silently absent. Either a state
       * that CARRIES a cause, or one of the two states that says honestly that
       * it does not — a degraded state is acceptable (SPEC-04 §5); a missing one
       * is not. */
      expect(
        [
          'EXPLAINED_EXACT',
          'EXPLAINED_SUBSET',
          'EXPLANATION_BUDGET_EXCEEDED',
          'EXPLANATION_UNAVAILABLE',
        ],
        where,
      ).toContain(explanation?.state);
    }
  });

  it('NEVER claims EXPLAINED_MINIMAL — CP-SAT returns sufficient, not minimal', () => {
    /* Measured in EV-M4-002 probe 02 and stated in SPEC-04 §5. A subset that
     * called itself minimal would be a stronger claim than anything the library
     * makes, arriving in the shape of a better answer. */
    for (const run of runs) {
      expect(run.outcome.explanation?.state ?? 'EXPLANATION_UNAVAILABLE').not.toBe(
        'EXPLAINED_MINIMAL',
      );
    }
  });

  it('rule-heavy: every M4-evaluable HARD kind is present, and all of them hold at once', () => {
    const run = runFor('B-ruleheavy');
    const kinds = new Set(
      run.fixture.document.ruleRevisions
        .filter((revision) => revision.classification === 'HARD')
        .map((revision) => (revision.predicate as { kind: string }).kind),
    );
    /* The packet's clause, as an assertion rather than as a claim about the
     * fixture: EVERY kind the independent checker evaluates appears at least
     * once. A kind that only ever appeared in an infeasible fixture would never
     * have its SATISFIED direction exercised end to end. */
    for (const kind of EVALUATED_HARD_RULE_KINDS) {
      expect(kinds, `rule-heavy is missing ${kind}`).toContain(kind);
    }
    expect(SOLVED_STATUSES).toContain(run.outcome.status);
    expect(run.verdict?.hardViolations).toBe(0);
    log(
      `      · rule-heavy: ${String(kinds.size)} HARD kinds, ` +
        `${String((run.outcome.assignments ?? []).length)} assignments, 0 hard violations`,
    );
  });

  it('multisite: location is NOT a coverage dimension (RK-RULING-01)', () => {
    const run = runFor('B-multisite');
    expect(run.fixture.document.locations.length).toBeGreaterThan(1);
    /* The model may not invent a location. R-B6: a shift without one is legal,
     * and a per-location coverage dimension would be a demand-model SCHEMA
     * change — recorded as a future owner question, never smuggled in as a
     * modelling choice. */
    for (const assignment of run.outcome.assignments ?? []) {
      expect(assignment.locationId).toBeNull();
    }
    /* And coverage was met per date × shift type, counted here independently of
     * both the model and the checker. */
    const filled = new Map<string, number>();
    for (const assignment of run.outcome.assignments ?? []) {
      const key = `${assignment.date}|${assignment.shiftTypeId}`;
      filled.set(key, (filled.get(key) ?? 0) + 1);
    }
    for (const cell of run.fixture.document.demand) {
      expect(filled.get(`${cell.on}|${cell.shiftTypeId}`) ?? 0).toBe(cell.requiredCount);
    }
  });

  it('progressive/pinned: every pinned input survives into the candidate', () => {
    const run = runFor('B-progressive-pinned');
    const placed = new Set(
      (run.outcome.assignments ?? []).map((a) => `${a.membershipId}|${a.date}|${a.shiftTypeId}`),
    );
    for (const fixed of run.fixture.document.fixedAssignments) {
      expect(
        placed,
        'a pinned input was dropped — a "protected" assignment that quietly stops being protected',
      ).toContain(`${fixed.membershipId}|${fixed.date}|${fixed.shiftTypeId}`);
    }
  });

  it('fairness-shaped: the E1 objective tiers are RECORDED, and SOFT never became HARD', () => {
    const run = runFor('B-fairness-shaped');
    expect(SOLVED_STATUSES).toContain(run.outcome.status);
    expect(run.outcome.objectiveTiers.length).toBeGreaterThan(0);
    const named = run.outcome.objectiveTiers.flatMap((tier) => tier.ruleKeys);
    for (const revision of run.fixture.document.ruleRevisions) {
      if (revision.classification !== 'SOFT') continue;
      /* Every SOFT rule is either in a tier or NAMED as unmapped. The one thing
       * it may never be is absent — an omission that costs quality is
       * acceptable, an omission nobody can see is not. */
      const unmapped = run.outcome.objectiveTiers.flatMap((tier) => tier.unmappedRuleKeys);
      expect([...named, ...unmapped]).toContain(revision.ruleKey);
    }
    /* SOFT stayed SOFT: the checker measures HARD rules only, and a fairness
     * term that had become a constraint would show up as a violation here. */
    expect(run.verdict?.hardViolations).toBe(0);
    log(
      `      · fairness tiers: ${run.outcome.objectiveTiers
        .map((tier) => `${String(tier.tier)}:${tier.name}(${String(tier.termCount)})`)
        .join(' ')}`,
    );
  });

  it('race-retired-holding: the validator REJECTS staffing the raced membership', () => {
    /* The same rejection the harness proves against the LIVE snapshot, asserted
     * here against the COMMITTED capture — so the corpus carries the property
     * without needing the race to run. */
    const capture = readRaceCapture();
    const verdict = validateCandidate({
      snapshot: capture.document,
      assignments: [
        {
          membershipId: capture.racedMembershipId,
          date: capture.document.startDate,
          shiftTypeId: capture.racedShiftTypeId,
          locationId: null,
        },
      ],
      expectedInputHash: 'corpus',
      reportedInputHash: 'corpus',
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain(
      'ineligible-assignment',
    );

    /* MUTATION CONTROL. Without it, a validator that rejected everything would
     * pass the case above. The CONTROL shift type in the same captured snapshot
     * was granted with no race at all, and staffing it must be accepted. */
    const control = validateCandidate({
      snapshot: capture.document,
      assignments: [
        {
          membershipId: capture.racedMembershipId,
          date: capture.document.startDate,
          shiftTypeId: capture.controlShiftTypeId,
          locationId: null,
        },
      ],
      expectedInputHash: 'corpus',
      reportedInputHash: 'corpus',
    });
    expect(
      control.rejections.map((rejection) => rejection.reason),
      'the control pair was rejected too — the refusal above proves nothing',
    ).not.toContain('ineligible-assignment');
    log('      · raced staffing refused; the un-raced control staffing accepted');
  });
});
