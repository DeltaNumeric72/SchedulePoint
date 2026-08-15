import { describe, expect, it } from 'vitest';

import { validateBuildOutcome } from '../../src/solver/build-input.js';
import { validateCandidate } from '../../src/solver/candidate-validation.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import type { SolveOutcomeDetail } from '../../src/solver/solver-client.js';
import { log } from '../support/harness.js';
import { generatedCorpus } from './corpus/generators.js';

/**
 * **NAMED PROOF — deliberately incorrect worker output is REJECTED**
 * (OPUS-M4-002; doc 35 §6d included scope (4), SPEC-04 §3.3).
 *
 * > refusal of incorrect worker output (wrong hash echo, hard-violating
 * > candidate, unknown assignment references)
 *
 * ## Why the outputs are hand-built
 *
 * Every candidate here is one **no honest worker would produce**. The model
 * cannot place a membership it was not given, cannot date a row outside the
 * horizon, cannot duplicate a cell (the variables are booleans keyed by the
 * cell), and cannot breach a HARD rule it posted as a constraint. That is the
 * point: the checker's job is to be right about a worker that has stopped being
 * right, and a test that could only build inputs the worker actually produces
 * would be testing the worker.
 *
 * `validateCandidate` is pure over its arguments precisely so this file needs no
 * subprocess and no cluster — a reviewer can add a pathological candidate here
 * and see the refusal in milliseconds.
 *
 * ## The mutation control
 *
 * Every case below would pass against a validator that rejected everything. The
 * last case takes the same snapshot and a candidate that is genuinely correct
 * and asserts it is ACCEPTED.
 */

const corpus = generatedCorpus();

/** The rule-heavy snapshot: the most rules, so the most ways to be wrong. */
const ruleHeavy = corpus.find((fixture) => fixture.corpusClass === 'rule-heavy')?.document;
if (ruleHeavy === undefined) throw new Error('the rule-heavy corpus fixture is missing');

const HASH = canonicalInputHash(ruleHeavy);
const DATES = (() => {
  const out: string[] = [];
  let cursor = Date.parse(`${ruleHeavy.startDate}T00:00:00Z`);
  const end = Date.parse(`${ruleHeavy.endDate}T00:00:00Z`);
  while (cursor <= end) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return out;
})();

const member = (index: number): string => ruleHeavy.participants[index]?.membershipId ?? '';
const shiftType = (code: string): string =>
  ruleHeavy.shiftTypes.find((entry) => entry.code === code)?.shiftTypeId ?? '';

function verdictFor(
  assignments: readonly { membershipId: string; date: string; shiftTypeId: string }[],
  reportedHash = HASH,
) {
  return validateCandidate({
    snapshot: ruleHeavy as NonNullable<typeof ruleHeavy>,
    assignments: assignments.map((assignment) => ({ ...assignment, locationId: null })),
    expectedInputHash: HASH,
    reportedInputHash: reportedHash,
  });
}

/**
 * A genuinely correct candidate — over the SMALLEST fixture, not the rule-heavy
 * one.
 *
 * The first attempt hand-rolled a candidate for the rule-heavy snapshot and it
 * was refused, correctly: satisfying twenty-two interacting HARD rules by hand
 * is the solver's job, and a "control" that quietly breached one would have been
 * a control asserting the wrong thing. Constructing the honest case on
 * `B-feasible-small` — three participants, two days, one shift type, demand one,
 * no rules — makes correctness inspectable rather than argued.
 *
 * The rule-heavy snapshot's honest direction is not lost: `corpus-agreement`
 * poses it to the REAL worker and asserts the returned candidate measures zero
 * violations through this same validator.
 */
const small = corpus.find((fixture) => fixture.corpusClass === 'feasible-small')?.document;
if (small === undefined) throw new Error('the feasible-small corpus fixture is missing');

describe('deliberately incorrect worker output is refused', () => {
  it('1. WRONG PROBLEM: a response echoing a different canonical input hash', () => {
    /* A result for a different problem is not a result for this one — and it is
     * the one wrong answer that would otherwise look completely normal, because
     * every row in it references things that genuinely exist. */
    const verdict = verdictFor([], 'f'.repeat(64));
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain(
      'input-hash-mismatch',
    );
  });

  it('2. UNKNOWN REFERENCE: a membership, a shift type, or a date the snapshot never carried', () => {
    const cases: readonly [string, { membershipId: string; date: string; shiftTypeId: string }][] =
      [
        [
          'a membership that is not a participant',
          {
            membershipId: '00000000-0000-4000-8000-000000000001',
            date: DATES[0] ?? '',
            shiftTypeId: shiftType('DAY'),
          },
        ],
        [
          'a shift type this group does not define',
          {
            membershipId: member(0),
            date: DATES[0] ?? '',
            shiftTypeId: '00000000-0000-4000-8000-000000000002',
          },
        ],
        [
          'a date outside the period range',
          { membershipId: member(0), date: '2028-01-01', shiftTypeId: shiftType('DAY') },
        ],
      ];
    for (const [label, assignment] of cases) {
      const verdict = verdictFor([assignment]);
      expect(verdict.usable, label).toBe(false);
      expect(verdict.rejections.map((rejection) => rejection.reason), label).toContain(
        'unknown-reference',
      );
    }
    log(`      · ${String(cases.length)} unknown-reference shapes, all refused`);
  });

  it('3. DUPLICATE: one membership placed twice on one date and shift type', () => {
    const row = { membershipId: member(0), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY') };
    const verdict = verdictFor([row, row]);
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain(
      'duplicate-assignment',
    );
  });

  it('4. INELIGIBLE: a pair the snapshot verdict does not admit', () => {
    /* The class the race-produced corpus fixture found (see
     * `candidate-validation.ts`). Here it is provoked from the other end: the
     * qualifications fixture carries participants the FROZEN verdict marked
     * ineligible, and a candidate staffing one of them must be refused even
     * though the row references nothing unknown and breaches no rule. */
    const qualifications = corpus.find(
      (fixture) => fixture.corpusClass === 'qualifications',
    )?.document;
    expect(qualifications).toBeDefined();
    const document = qualifications as NonNullable<typeof qualifications>;
    const ineligible = document.participants.find((participant) =>
      participant.eligibility.every((entry) => !entry.eligible),
    );
    expect(ineligible, 'the fixture carries no ineligible participant — the case is vacuous')
      .toBeDefined();

    const verdict = validateCandidate({
      snapshot: document,
      assignments: [
        {
          membershipId: ineligible?.membershipId ?? '',
          date: document.startDate,
          shiftTypeId: document.shiftTypes[0]?.shiftTypeId ?? '',
          locationId: null,
        },
      ],
      expectedInputHash: 'x',
      reportedInputHash: 'x',
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.rejections.map((rejection) => rejection.reason)).toContain(
      'ineligible-assignment',
    );
  });

  it('5. HARD VIOLATION: a candidate that breaches the rules it was solved under', () => {
    /* Each of these is a rule the rule-heavy fixture actually carries, breached
     * on purpose. This is the class that matters most: the rows are all legal
     * references and the candidate would be indistinguishable from a correct one
     * without the independent evaluation.
     *
     * **Each case names the rule that must catch it**, and that is not
     * decoration. The first version asserted only that SOME breach was found,
     * and a probe showed every case passing for the wrong reason: a candidate of
     * one or two rows also under-fills coverage on every other date, so
     * `rh-min`/`rh-required` breach dozens of times and drown the breach the
     * case was built to demonstrate. An arm that disabled `LinkedShifts` in the
     * checker would still have seen this file pass. Naming the rule makes each
     * case depend on the evaluator it is about. */
    const breaches: readonly [
      string,
      string,
      { membershipId: string; date: string; shiftTypeId: string }[],
    ][] = [
      [
        'MaxCoverage: three members on one DAY cell where the ceiling is two',
        'rh-max',
        [
          { membershipId: member(0), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY') },
          { membershipId: member(1), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY') },
          { membershipId: member(2), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY') },
        ],
      ],
      [
        'MemberOfStaffGroup: the one participant outside the named group, on DAY',
        'rh-staffgroup',
        [{ membershipId: member(5), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY') }],
      ],
      [
        'MutuallyExclusive: DAY and NGT on one date for one member',
        'rh-mutex',
        [
          { membershipId: member(0), date: DATES[1] ?? '', shiftTypeId: shiftType('DAY') },
          { membershipId: member(0), date: DATES[1] ?? '', shiftTypeId: shiftType('NGT') },
        ],
      ],
      [
        'MinimumRestBetween: DAY ending 16:00 and CAL starting 18:00, same member, same date',
        'rh-rest',
        [
          { membershipId: member(0), date: DATES[1] ?? '', shiftTypeId: shiftType('DAY') },
          { membershipId: member(0), date: DATES[1] ?? '', shiftTypeId: shiftType('CAL') },
        ],
      ],
      [
        'NoAdjacent: DAY then CAL on consecutive dates for one member',
        'rh-noadjacent',
        [
          { membershipId: member(0), date: DATES[1] ?? '', shiftTypeId: shiftType('DAY') },
          { membershipId: member(0), date: DATES[2] ?? '', shiftTypeId: shiftType('CAL') },
        ],
      ],
      [
        'CallSpacing: two CAL assignments one day apart, where the rule asks for two',
        'rh-callspacing',
        [
          { membershipId: member(1), date: DATES[3] ?? '', shiftTypeId: shiftType('CAL') },
          { membershipId: member(1), date: DATES[4] ?? '', shiftTypeId: shiftType('CAL') },
        ],
      ],
      [
        'MaxConsecutive: six consecutive days for one member where the cap is five',
        'rh-consecutive',
        DATES.slice(0, 6).map((date) => ({
          membershipId: member(0),
          date,
          shiftTypeId: shiftType('DAY'),
        })),
      ],
      [
        /* The one breach in this list that ONLY `LinkedShifts` can catch —
         * nothing else in the rule-heavy fixture speaks about a lone EVE row.
         * It is what makes the `solver-checker-disabled` red case's api-side
         * arm real rather than incidentally covered by another rule. */
        'LinkedShifts: EVE without the NGT it is linked to, on one date',
        'rh-linked',
        [{ membershipId: member(0), date: DATES[5] ?? '', shiftTypeId: shiftType('EVE') }],
      ],
      [
        'AvoidDate: an AUX assignment on the avoided date',
        'rh-avoiddate',
        [{ membershipId: member(0), date: DATES[2] ?? '', shiftTypeId: shiftType('AUX') }],
      ],
    ];

    for (const [label, ruleKey, assignments] of breaches) {
      const verdict = verdictFor(assignments);
      expect(verdict.usable, `${label} was ACCEPTED`).toBe(false);
      expect(
        verdict.rejections.some((rejection) => rejection.reason === 'hard-violation'),
        `${label} was refused for the wrong reason: ${verdict.rejections
          .map((rejection) => rejection.reason)
          .join(',')}`,
      ).toBe(true);
      expect(
        verdict.findings
          .filter((finding) => finding.finding === 'breach')
          .map((finding) => finding.ruleKey),
        `${label}: the rule that was supposed to catch it did not`,
      ).toContain(ruleKey);
    }
    log(`      · ${String(breaches.length)} hard-rule breaches, each caught BY THE NAMED RULE`);
  });

  it('6. the checker REPORTS what it found — rule ids and counts, bounded, no payload', () => {
    /* Doc 35 §6d required behaviour 3: "the build outcome says why (violating
     * rule ids + counts, bounded detail)". A refusal nobody can act on sends a
     * scheduler back to a black box. */
    const verdict = verdictFor([
      { membershipId: member(5), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY') },
    ]);
    const breaches = verdict.findings.filter((finding) => finding.finding === 'breach');
    expect(breaches.length).toBeGreaterThan(0);
    for (const finding of breaches) {
      expect(typeof finding.ruleKey).toBe('string');
      expect(finding.ruleKey.length).toBeGreaterThan(0);
    }
    /* And nothing in a rejection carries the document. Every `detail` is a
     * fixed sentence about structure — a byte count, a class of mistake — and
     * never an id, a name or a row (I-07, non-bypass rule 9). */
    for (const rejection of verdict.rejections) {
      if (rejection.reason === 'hard-violation') continue;
      expect(rejection.detail).not.toContain(member(5));
      expect(rejection.detail.length).toBeLessThan(300);
    }
  });

  it('7. through the SEAM: validateBuildOutcome refuses a hand-built wrong outcome', () => {
    /* The same refusals, reached the way a build reaches them, so the check is
     * provably wired rather than merely present. */
    const outcome = {
      status: 'OPTIMAL',
      terminationReason: 'completed',
      canonicalInputHash: 'f'.repeat(64),
      assignments: [
        { membershipId: member(5), date: DATES[0] ?? '', shiftTypeId: shiftType('DAY'), locationId: null },
      ],
      runtime: {
        imageDigest: 'unknown',
        solverVersion: 'unknown',
        compilerVersion: 'unknown',
        platformArch: 'unknown',
        languageRuntime: 'unknown',
        reproducibilityMode: 'best-effort',
      },
      elapsedMs: 1,
      explanation: null,
      objectiveTiers: [],
      objectiveValue: null,
      refusalCode: null,
    } as unknown as SolveOutcomeDetail;

    const verdict = validateBuildOutcome({
      snapshot: {
        snapshotId: 'fixture',
        canonicalInputHash: HASH,
        document: ruleHeavy as NonNullable<typeof ruleHeavy>,
        replayed: false,
      } as never,
      outcome,
      reproducibility: 'best-effort',
    });
    expect(verdict).not.toBeNull();
    expect(verdict?.usable).toBe(false);
    /* A worker claiming OPTIMAL does not settle anything: the checker's verdict
     * is authoritative over the worker's status, which is the whole reason the
     * redundancy exists. */
    const reasons = (verdict?.rejections ?? []).map((rejection) => rejection.reason);
    expect(reasons).toContain('input-hash-mismatch');
    expect(reasons).toContain('hard-violation');
  });

  it('8. MUTATION CONTROL: an HONEST candidate is ACCEPTED', () => {
    /* Without this, every case above would pass against a validator whose
     * answer was `usable: false` — while every real build was refused. */
    const document = small as NonNullable<typeof small>;
    const dates = [document.startDate, document.endDate];
    const shiftTypeId = document.shiftTypes[0]?.shiftTypeId ?? '';
    const verdict = validateCandidate({
      snapshot: document,
      /* Demand is one per date and there are three eligible participants: one
       * row per date, on different members, breaching nothing because the
       * fixture carries no rules to breach. */
      assignments: dates.map((date, index) => ({
        membershipId: document.participants[index]?.membershipId ?? '',
        date,
        shiftTypeId,
        locationId: null,
      })),
      expectedInputHash: 'small',
      reportedInputHash: 'small',
    });
    expect(
      verdict.rejections.map((rejection) => rejection.reason),
      'the validator refuses an honest candidate — every refusal above proves nothing',
    ).toEqual([]);
    expect(verdict.hardViolations).toBe(0);
    expect(verdict.usable).toBe(true);
    log('      · MUTATION CONTROL: the honest candidate is accepted');
  });
});
