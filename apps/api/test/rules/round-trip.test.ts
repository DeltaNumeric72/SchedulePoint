import {
  RULE_NODE_KINDS,
  RULE_SCHEMA_VERSION,
  canonicalStringify,
  compileRuleSetToCanonicalString,
  ruleProblems,
  type Rule,
  type RuleNode,
  type RuleNodeKind,
} from '@schedulepoint/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRule, loadRuleForRoundTrip, compileActiveRules } from '../../src/rules/service.js';
import { ownedMulti } from '../support/owned-multi.js';
import { createRuntime, type Runtime } from '../support/harness.js';

/**
 * **Named proof 1, against a REAL database: author → persist → compile → load →
 * re-validate → re-serialize, with canonical-form equality** (SPEC-04 §3.2, and
 * the packet's round-trip requirement).
 *
 * ## Why the in-memory proof was not enough
 *
 * `packages/domain/test/rules/ast-validate.test.ts` proves the round trip over
 * the AST alone: serialize, parse, re-serialize, compare. That establishes the
 * *serializer* is lossless. It says nothing about **PostgreSQL** being lossless,
 * and PostgreSQL is where the rule actually lives: `jsonb` does not store bytes,
 * it stores a parsed tree and re-renders it, dropping duplicate keys, reordering
 * object members, and normalising numeric literals (`1.50` → `1.50`, `1e2` →
 * `100`). Any one of those would silently change a stored rule between the save
 * and the next load, and every downstream `input_hash` with it.
 *
 * So this file writes each rule through the real service into the real table
 * under the real unit of work, reads it back, re-validates the reconstructed
 * AST, and compares the canonical bytes with what was authored.
 *
 * ## Every node kind, not a sample
 *
 * The loop runs over `RULE_NODE_KINDS` — all thirty — because the failure mode is
 * per-node: it is one node's numeric or array member that `jsonb` renders
 * differently, and a spot check of five would pass while the sixth was lossy.
 */

const multi = ownedMulti('rules-round-trip', { profile: 'full' });

let runtime: Runtime;

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 3 });
});

afterAll(async () => {
  await runtime.destroy();
});

/** One valid instance of every node. Kept here rather than imported from the
 *  domain test tree: a test package must not depend on another package's tests,
 *  and the parity that matters (every KIND is covered) is asserted below. */
const SAMPLES: Record<RuleNodeKind, RuleNode> = {
  RequiredCount: { kind: 'RequiredCount', count: 2 },
  MinCoverage: { kind: 'MinCoverage', min: 1 },
  MaxCoverage: { kind: 'MaxCoverage', max: 3 },
  RequiresQualification: {
    kind: 'RequiresQualification',
    qualification: 'acls',
    validAt: 'shift_date',
  },
  MemberOfStaffGroup: { kind: 'MemberOfStaffGroup', staffGroup: 'senior' },
  ValidGroupRestriction: { kind: 'ValidGroupRestriction', validGroup: 'icu_pool' },
  PickPositionRestriction: { kind: 'PickPositionRestriction', allowedPickPositions: [0, 1, 2] },
  MaxAssignmentsInWindow: { kind: 'MaxAssignmentsInWindow', max: 5, windowDays: 7 },
  WeekdayFteLimit: { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.5 },
  WorkPercentageTarget: { kind: 'WorkPercentageTarget', targetPercentage: 80 },
  MaxConsecutive: { kind: 'MaxConsecutive', maxDays: 4 },
  MinimumRestBetween: { kind: 'MinimumRestBetween', minHours: 11 },
  CallSpacing: { kind: 'CallSpacing', minDaysBetweenCalls: 3 },
  NoAdjacent: { kind: 'NoAdjacent', shiftTypeA: 'night', shiftTypeB: 'day' },
  ForbiddenSequence: { kind: 'ForbiddenSequence', sequence: ['night', 'day'] },
  PatternRule: {
    kind: 'PatternRule',
    trigger: 'call',
    daysOfWeek: ['fri', 'sat'],
    segments: [
      { offsetDays: 0, shiftType: 'call' },
      { offsetDays: 1, shiftType: 'post_call' },
    ],
  },
  AlternatingWeek: { kind: 'AlternatingWeek', onShiftType: 'clinic', cycleWeeks: 2 },
  TemplateAdherence: { kind: 'TemplateAdherence', template: 'four_week_block', cycleWeeks: 4 },
  LinkedShifts: { kind: 'LinkedShifts', shiftTypes: ['am', 'pm'] },
  ImpliesAssignment: { kind: 'ImpliesAssignment', ifShiftType: 'day', thenShiftType: 'evening' },
  MutuallyExclusive: { kind: 'MutuallyExclusive', shiftTypes: ['day', 'night'] },
  RequestHonoured: { kind: 'RequestHonoured', requestType: 'day_off' },
  ShiftPreference: { kind: 'ShiftPreference', shiftType: 'clinic', strength: 'prefer' },
  AvoidDate: { kind: 'AvoidDate', date: '2026-12-25' },
  FairnessBalance: { kind: 'FairnessBalance', metric: 'weekend_load', normalisation: 'per_fte' },
  CreditDistribution: { kind: 'CreditDistribution', metric: 'credits' },
  StaffOverLocumPriority: { kind: 'StaffOverLocumPriority', windowDays: 30 },
  LocumRestriction: { kind: 'LocumRestriction', restriction: 'locum_last_resort' },
  FixedAssignment: { kind: 'FixedAssignment', assignmentIdentity: 'period-01-day-m01' },
  ProtectedRange: { kind: 'ProtectedRange', from: '2026-01-01', to: '2026-01-14' },
};

function schedulerContext(): {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
} {
  const alpha = multi().alpha;
  return {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'rules-round-trip',
  };
}

describe('the round trip is lossless against a real database (named proof 1)', () => {
  it('covers every node kind in the closed set — the loop cannot silently shrink', () => {
    expect(new Set(Object.keys(SAMPLES))).toEqual(new Set(RULE_NODE_KINDS));
  });

  it('author → persist → load → re-validate → re-serialize is canonical-equal, for every node', async () => {
    const context = schedulerContext();

    for (const kind of RULE_NODE_KINDS) {
      const predicate = SAMPLES[kind];
      // A HARD and a SOFT rule per node: the weight column is `numeric`, which is
      // exactly the type most likely to come back spelled differently.
      for (const classification of ['HARD', 'SOFT'] as const) {
        const ruleKey = `rt_${classification.toLowerCase()}_${kind.toLowerCase()}`;
        const authored: Rule =
          classification === 'HARD'
            ? {
                ruleKey,
                name: `Round trip ${kind}`,
                ruleSchemaVersion: RULE_SCHEMA_VERSION,
                classification: 'HARD',
                scope: {},
                predicate,
              }
            : {
                ruleKey,
                name: `Round trip ${kind}`,
                ruleSchemaVersion: RULE_SCHEMA_VERSION,
                classification: 'SOFT',
                weight: 12.5,
                scope: {},
                predicate,
              };

        const authoredBytes = canonicalStringify(authored);

        const loaded = await runtime.runner.run(context, async (uow) => {
          const created = await createRule(uow, {
            ruleKey: authored.ruleKey,
            name: authored.name,
            classification: authored.classification,
            ...(authored.classification === 'SOFT' ? { weight: authored.weight } : {}),
            scope: authored.scope,
            predicate: authored.predicate,
          } as never);
          expect(created.kind, `${kind}/${classification} did not persist`).toBe('ok');
          // Loaded in a SEPARATE statement from the insert's RETURNING, so the
          // value genuinely made a round trip through storage rather than being
          // handed back from the insert's own in-memory tuple.
          return loadRuleForRoundTrip(uow, authored.ruleKey);
        });

        expect(loaded, `${kind}/${classification} did not load back`).not.toBeNull();
        const reloaded = loaded as Rule;

        // RE-VALIDATE the reconstructed AST — a rule that comes back invalid is
        // a lossy round trip even if the bytes happen to match.
        expect(ruleProblems(reloaded), `${kind}/${classification} failed re-validation`).toEqual(
          [],
        );

        // RE-SERIALIZE and compare canonical bytes.
        expect(
          canonicalStringify(reloaded),
          `${kind}/${classification} round trip was not canonical-equal`,
        ).toBe(authoredBytes);
      }
    }
  }, 240_000);

  it('what was persisted compiles to the same bytes as what was authored', async () => {
    const context = schedulerContext();

    // Authors its OWN key space rather than reading the rows the test above
    // happens to have written: under a shuffled seed that test may not have run
    // yet, and a proof that depends on execution order is not a proof (FAD-15 —
    // seed 740673 found exactly this).
    const authored: Rule[] = RULE_NODE_KINDS.map((kind) => ({
      ruleKey: `cmp_hard_${kind.toLowerCase()}`,
      name: `Round trip ${kind}`,
      ruleSchemaVersion: RULE_SCHEMA_VERSION,
      classification: 'HARD' as const,
      scope: {},
      predicate: SAMPLES[kind],
    }));
    const expected = compileRuleSetToCanonicalString(
      [...authored].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : 1)),
      RULE_SCHEMA_VERSION,
    );

    await runtime.runner.run(context, async (uow) => {
      for (const rule of authored) {
        await createRule(uow, {
          ruleKey: rule.ruleKey,
          name: rule.name,
          classification: 'HARD',
          scope: {},
          predicate: rule.predicate,
        } as never);
      }
    });

    const fromDatabase = await runtime.runner.run(context, async (uow) =>
      compileActiveRules(
        uow,
        authored.map((rule) => rule.ruleKey),
      ),
    );

    expect(fromDatabase).toBe(expected);
  }, 120_000);

  it('MUTATION CONTROL: a single corrupted field breaks the equality', async () => {
    // The proof above must not be satisfiable vacuously. If tampering with one
    // stored field still compared equal, the comparison would be measuring
    // nothing — this is the falsifiability arm of the round-trip claim.
    const context = schedulerContext();

    const authored: Rule = {
      ruleKey: 'rt_mutation_control',
      name: 'Round trip mutation control',
      ruleSchemaVersion: RULE_SCHEMA_VERSION,
      classification: 'HARD',
      scope: {},
      predicate: { kind: 'RequiredCount', count: 2 },
    };

    const { authoredBytes, tamperedBytes } = await runtime.runner.run(context, async (uow) => {
      await createRule(uow, {
        ruleKey: authored.ruleKey,
        name: authored.name,
        classification: 'HARD',
        scope: {},
        predicate: authored.predicate,
      } as never);
      const loaded = (await loadRuleForRoundTrip(uow, authored.ruleKey)) as Rule;
      const tampered: Rule = {
        ...loaded,
        predicate: { kind: 'RequiredCount', count: 3 },
      };
      return {
        authoredBytes: canonicalStringify(loaded),
        tamperedBytes: canonicalStringify(tampered),
      };
    });

    expect(tamperedBytes).not.toBe(authoredBytes);
  }, 60_000);
});
