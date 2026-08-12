import { describe, expect, it } from 'vitest';

import { RULE_NODE_KINDS, type RuleNode, type RuleNodeKind } from '../../src/rules/ast.js';
import {
  AST_BOUNDS,
  evaluationCostBound,
  maximumEvaluationCostBound,
  nodeBoundProblems,
  scopeBoundProblems,
  scopeCardinality,
  valueDepth,
} from '../../src/rules/bounds.js';
import {
  EVALUATED_HARD_RULE_KINDS,
  NOT_EVALUABLE_REASONS,
} from '../../src/rules/hard-rule-check.js';
import {
  RULE_KIND_METADATA,
  RULE_KIND_PENDING_RULINGS,
  buildRuleKindRegistry,
  renderRuleKindRegistry,
} from '../../src/rules/registry.js';
import { ruleProblems } from '../../src/rules/validate.js';
import type { Rule } from '../../src/rules/ast.js';

/**
 * **Named proof — the rule-kind registry is generated, and the AST is bounded**
 * (OPUS-M4-000C; doc 34 §4-D).
 *
 * Two properties, both of which used to be claims in prose:
 *
 *  - the registry's counts come from code, its two sets partition the closed
 *    node set, and every kind has an owner (non-bypass rule 11);
 *  - the AST is bounded in depth, list length, numeric range and scope
 *    cardinality, and the checker's evaluation cost has a stated ceiling that a
 *    pathological-but-legal rule cannot exceed.
 */

function hardRule(predicate: RuleNode, scope: Rule['scope'] = {}): Rule {
  return {
    ruleKey: 'bounds_probe',
    name: 'Bounds probe',
    ruleSchemaVersion: 1,
    classification: 'HARD',
    scope,
    predicate,
  };
}

describe('the rule-kind registry is generated, not typed', () => {
  const registry = buildRuleKindRegistry();

  it('covers exactly the closed node set, once each', () => {
    expect(registry.entries).toHaveLength(RULE_NODE_KINDS.length);
    expect(registry.counts.uniqueKinds).toBe(RULE_NODE_KINDS.length);
    expect(new Set(registry.entries.map((entry) => entry.kind))).toEqual(new Set(RULE_NODE_KINDS));
  });

  it('the evaluated and not-evaluable sets PARTITION it — disjoint and total', () => {
    const evaluated = registry.entries.filter((entry) => entry.evaluated).map((e) => e.kind);
    const notEvaluable = registry.entries.filter((entry) => !entry.evaluated).map((e) => e.kind);

    expect(new Set(evaluated)).toEqual(new Set(EVALUATED_HARD_RULE_KINDS));
    expect(new Set(notEvaluable)).toEqual(new Set(Object.keys(NOT_EVALUABLE_REASONS)));
    // Disjoint…
    expect(evaluated.filter((kind) => notEvaluable.includes(kind))).toEqual([]);
    // …and total, asserted as two numbers so neither can drift alone.
    expect(registry.counts.evaluated).toBe(6);
    expect(registry.counts.notEvaluable).toBe(24);
    expect(registry.counts.evaluated + registry.counts.notEvaluable).toBe(30);
  });

  it('the not-evaluable classes and the families each account for every kind', () => {
    const classTotal = registry.counts.byNotEvaluableClass.reduce((sum, row) => sum + row.count, 0);
    expect(classTotal).toBe(registry.counts.notEvaluable);

    const familyTotal = registry.counts.byFamily.reduce((sum, row) => sum + row.count, 0);
    expect(familyTotal).toBe(registry.counts.uniqueKinds);
  });

  it('CORRECTS the three counts step-06 typed by hand', () => {
    /* The whole reason the registry is generated. `step-06-node-kinds.md` §3b
     * headed its table "7 kinds" while the table held 8; §3c headed "7 kinds"
     * while the code puts `StaffOverLocumPriority` in `data-not-modelled-at-m3`,
     * leaving 6; and §5's prose said "Ten of the twenty-four are one ruling away"
     * while its own table summed to eleven. */
    const byClass = new Map(registry.counts.byNotEvaluableClass.map((r) => [r.class, r.count]));
    expect(byClass.get('semantics-not-pinned')).toBe(8);
    expect(byClass.get('constrains-the-search-not-the-content')).toBe(6);
    expect(byClass.get('grouping-unit-not-pinned')).toBe(3);
    expect(byClass.get('identifier-domain-not-pinned')).toBe(3);
    expect(byClass.get('data-not-modelled-at-m3')).toBe(4);

    expect(registry.counts.oneRulingAway).toBe(11);
    expect(registry.oneRulingAwayKinds).toHaveLength(11);
  });

  it('every kind has an OWNER — nothing is dropped, deferred without one, or narrowed', () => {
    // Non-bypass rule 11, made mechanical. There is no `unowned` value in the
    // type, so this asserts the weaker thing the type cannot: that no kind is
    // parked on a milestone while claiming to be evaluated, or vice versa.
    for (const entry of registry.entries) {
      expect(entry.milestoneOwner).toBeTruthy();
      if (entry.evaluated) {
        expect(entry.evaluationOwner).toBe('independent-checker');
        expect(entry.semanticRuling).not.toBeNull();
      } else {
        expect(['solver-and-validator', 'awaiting-ruling', 'awaiting-input']).toContain(
          entry.evaluationOwner,
        );
        // An unevaluated kind has EITHER a pinned reason it is not content-checkable
        // (it constrains the search) or a named blocker. Never silence.
        const explained =
          entry.semanticRuling !== null ||
          entry.pendingRuling !== null ||
          entry.notEvaluableReason !== null;
        expect(explained).toBe(true);
      }
    }
  });

  it('every kind an author can write has metadata — a new node cannot slip in', () => {
    expect(new Set(Object.keys(RULE_KIND_METADATA))).toEqual(new Set(RULE_NODE_KINDS));
  });

  it('every pending ruling has a STABLE id and is cited by at least one kind', () => {
    const ids = RULE_KIND_PENDING_RULINGS.map((ruling) => ruling.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^RK-RULING-\d{2}$/);

    const cited = new Set(registry.citedRulings.map((entry) => entry.ruling.id));
    for (const id of ids) expect(cited.has(id)).toBe(true);
  });

  it('renders deterministically — the artifact comparison is a real comparison', () => {
    expect(renderRuleKindRegistry(buildRuleKindRegistry())).toBe(
      renderRuleKindRegistry(buildRuleKindRegistry()),
    );
  });
});

describe('the AST is bounded', () => {
  it('refuses an oversized list, an oversized number and an oversized scope', () => {
    const longSequence = Array.from({ length: AST_BOUNDS.maxSequenceLength + 1 }, () => 'A');
    expect(
      nodeBoundProblems({ kind: 'ForbiddenSequence', sequence: longSequence }, 'predicate'),
    ).toEqual([{ path: 'predicate.sequence', message: expect.stringContaining('more than 32') }]);

    expect(
      nodeBoundProblems(
        { kind: 'MaxAssignmentsInWindow', max: 5, windowDays: AST_BOUNDS.maxWindowDays + 1 },
        'predicate',
      ),
    ).toEqual([{ path: 'predicate.windowDays', message: expect.stringContaining('366') }]);

    const wideScope = {
      memberships: Array.from({ length: AST_BOUNDS.maxScopeMemberships + 1 }, (_, i) => `m${String(i)}`),
    };
    expect(scopeBoundProblems(hardRule({ kind: 'MaxConsecutive', maxDays: 3 }, wideScope))).toEqual([
      { path: 'scope.memberships', message: expect.stringContaining('1000') },
    ]);
  });

  it('the bounds are reachable — a rule AT the limit is legal', () => {
    /* A bound nobody can reach is a bound that never fires, and a test that only
     * exercised the refusal would not notice one set to zero. */
    const atLimit = hardRule(
      {
        kind: 'ForbiddenSequence',
        sequence: Array.from({ length: AST_BOUNDS.maxSequenceLength }, () => 'A'),
      },
      { memberships: Array.from({ length: AST_BOUNDS.maxScopeMemberships }, (_, i) => `m${String(i)}`) },
    );
    expect(ruleProblems(atLimit)).toEqual([]);
  });

  it('the bounds are enforced through the WHOLE-rule validator, not only in isolation', () => {
    // The domain validator is what a background job, a migration or any future
    // non-HTTP writer calls. A bound that only the contract enforced would be a
    // bound with a documented way round it.
    const overLimit = hardRule({
      kind: 'MutuallyExclusive',
      shiftTypes: Array.from({ length: AST_BOUNDS.maxShiftTypesInNode + 1 }, (_, i) => `S${String(i)}`),
    });
    expect(ruleProblems(overLimit).map((problem) => problem.path)).toContain(
      'predicate.shiftTypes',
    );
  });

  it('the closed node set is FLAT, so the depth bound has slack rather than being decorative', () => {
    // The deepest legal predicate is a PatternRule and its segments: node →
    // array → object = 3. The bound exists so that adding a nesting node later
    // cannot silently make an unbounded tree legal.
    const deepest: RuleNode = {
      kind: 'PatternRule',
      trigger: 'A',
      daysOfWeek: ['mon'],
      segments: [{ offsetDays: 1, shiftType: 'B' }],
    };
    expect(valueDepth(deepest)).toBe(AST_BOUNDS.maxNodeDepth);
    expect(nodeBoundProblems(deepest, 'predicate')).toEqual([]);
  });

  it('every node kind has a bounds branch — a new kind cannot skip the bounds', () => {
    // `nodeBoundProblems` is exhaustive over the union (its `assertNever`), and
    // this exercises every arm so the exhaustiveness is not merely compiled.
    for (const kind of RULE_NODE_KINDS) {
      const sample = SAMPLES[kind];
      expect(() => nodeBoundProblems(sample, 'predicate')).not.toThrow();
    }
  });
});

describe('the checker has a stated evaluation-cost bound', () => {
  it('the cost grows with the assignment count and the scope, and nothing else', () => {
    const narrow = hardRule({ kind: 'MaxConsecutive', maxDays: 3 });
    const wide = hardRule({ kind: 'MaxConsecutive', maxDays: 3 }, { memberships: ['a', 'b', 'c'] });

    expect(evaluationCostBound(narrow, 100)).toBeLessThan(evaluationCostBound(wide, 100));
    expect(evaluationCostBound(narrow, 100)).toBeLessThan(evaluationCostBound(narrow, 1_000));
    expect(scopeCardinality(wide)).toBe(3);
  });

  it('a PATHOLOGICAL-but-legal rule stays under the ceiling every legal rule shares', () => {
    /* The point of the bound argument: the worst rule the validator will ADMIT
     * still has a computable ceiling. This builds that rule — every scope array
     * at its maximum, the largest list node — confirms the validator admits it,
     * and confirms its cost bound is under the closed-form maximum. */
    const pathological = hardRule(
      {
        kind: 'MutuallyExclusive',
        shiftTypes: Array.from({ length: AST_BOUNDS.maxShiftTypesInNode }, (_, i) => `S${String(i)}`),
      },
      {
        shiftTypes: Array.from({ length: AST_BOUNDS.maxScopeShiftTypes }, (_, i) => `T${String(i)}`),
        staffGroups: Array.from({ length: AST_BOUNDS.maxScopeStaffGroups }, (_, i) => `G${String(i)}`),
        memberships: Array.from({ length: AST_BOUNDS.maxScopeMemberships }, (_, i) => `M${String(i)}`),
      },
    );
    expect(ruleProblems(pathological)).toEqual([]);

    const assignments = 10_000;
    expect(evaluationCostBound(pathological, assignments)).toBeLessThanOrEqual(
      maximumEvaluationCostBound(assignments),
    );
    // And the ceiling itself is a FINITE, stated number rather than a shrug.
    expect(Number.isFinite(maximumEvaluationCostBound(assignments))).toBe(true);
  });
});

/** One valid instance of every node, so the bounds sweep is total. */
const SAMPLES: Record<RuleNodeKind, RuleNode> = {
  RequiredCount: { kind: 'RequiredCount', count: 2 },
  MinCoverage: { kind: 'MinCoverage', min: 1 },
  MaxCoverage: { kind: 'MaxCoverage', max: 3 },
  RequiresQualification: {
    kind: 'RequiresQualification',
    qualification: 'acls',
    validAt: 'shift_date',
  },
  MemberOfStaffGroup: { kind: 'MemberOfStaffGroup', staffGroup: 'seniors' },
  ValidGroupRestriction: { kind: 'ValidGroupRestriction', validGroup: 'theatre' },
  PickPositionRestriction: { kind: 'PickPositionRestriction', allowedPickPositions: [0, 1] },
  MaxAssignmentsInWindow: { kind: 'MaxAssignmentsInWindow', max: 3, windowDays: 7 },
  WeekdayFteLimit: { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.5 },
  WorkPercentageTarget: { kind: 'WorkPercentageTarget', targetPercentage: 80 },
  MaxConsecutive: { kind: 'MaxConsecutive', maxDays: 5 },
  MinimumRestBetween: { kind: 'MinimumRestBetween', minHours: 11 },
  CallSpacing: { kind: 'CallSpacing', minDaysBetweenCalls: 3 },
  NoAdjacent: { kind: 'NoAdjacent', shiftTypeA: 'A', shiftTypeB: 'B' },
  ForbiddenSequence: { kind: 'ForbiddenSequence', sequence: ['A', 'B'] },
  PatternRule: {
    kind: 'PatternRule',
    trigger: 'A',
    daysOfWeek: ['mon'],
    segments: [{ offsetDays: 1, shiftType: 'B' }],
  },
  AlternatingWeek: { kind: 'AlternatingWeek', onShiftType: 'A', cycleWeeks: 2 },
  TemplateAdherence: { kind: 'TemplateAdherence', template: 'winter', cycleWeeks: 4 },
  LinkedShifts: { kind: 'LinkedShifts', shiftTypes: ['A', 'B'] },
  ImpliesAssignment: { kind: 'ImpliesAssignment', ifShiftType: 'A', thenShiftType: 'B' },
  MutuallyExclusive: { kind: 'MutuallyExclusive', shiftTypes: ['A', 'B'] },
  RequestHonoured: { kind: 'RequestHonoured', requestType: 'vacation' },
  ShiftPreference: { kind: 'ShiftPreference', shiftType: 'A', strength: 'prefer' },
  AvoidDate: { kind: 'AvoidDate', date: '2033-01-01' },
  FairnessBalance: { kind: 'FairnessBalance', metric: 'credits', normalisation: 'none' },
  CreditDistribution: { kind: 'CreditDistribution', metric: 'credits' },
  StaffOverLocumPriority: { kind: 'StaffOverLocumPriority', windowDays: 30 },
  LocumRestriction: { kind: 'LocumRestriction', restriction: 'no_locum' },
  FixedAssignment: { kind: 'FixedAssignment', assignmentIdentity: 'period-01-day-m01' },
  ProtectedRange: { kind: 'ProtectedRange', from: '2033-01-01', to: '2033-01-14' },
};
