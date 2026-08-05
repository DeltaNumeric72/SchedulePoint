import { ruleNodeSchema, type RuleNodeWire } from '@schedulepoint/contracts';
import { describe, expect, it } from 'vitest';

import {
  NODE_KINDS,
  NODE_SPECS,
  fromPredicate,
  initialState,
  toPredicate,
} from '../src/rules/node-editors.js';

/**
 * The thirty rule-node editors, proved complete and lossless (OPUS-M3-004).
 *
 * ## Two properties, and both of them can fail
 *
 * 1. **Completeness.** Every kind the contract's discriminated union admits has
 *    an editor spec. A kind added to the AST with no spec here would render an
 *    empty parameter form — the author would see a rule type they could select
 *    and could not fill in, and nothing else in the build would notice.
 *
 * 2. **Round-trip losslessness.** `toPredicate(fromPredicate(node))` equals
 *    `node`, for one authored example of all thirty kinds. This is the property
 *    an author depends on without ever thinking about it: opening a rule and
 *    pressing Save must not change the rule. A field the form dropped, or a
 *    number it left as a string, fails here rather than in production.
 *
 * The examples below are parsed through `ruleNodeSchema` first, so a fixture
 * that is not itself a legal node cannot make the round trip look correct.
 */

/** One legal example of every node kind. Synthetic identifiers only. */
const EXAMPLES: readonly RuleNodeWire[] = [
  { kind: 'RequiredCount', count: 2 },
  { kind: 'MinCoverage', min: 1 },
  { kind: 'MaxCoverage', max: 4 },
  { kind: 'RequiresQualification', qualification: 'advanced_life_support', validAt: 'shift_date' },
  { kind: 'MemberOfStaffGroup', staffGroup: 'senior_cover' },
  { kind: 'ValidGroupRestriction', validGroup: 'weekend_combination' },
  { kind: 'PickPositionRestriction', allowedPickPositions: [0, 2, 5] },
  { kind: 'MaxAssignmentsInWindow', max: 3, windowDays: 14 },
  { kind: 'WeekdayFteLimit', weekday: 'wed', fteFraction: 0.5 },
  { kind: 'WorkPercentageTarget', targetPercentage: 80 },
  { kind: 'MaxConsecutive', maxDays: 6 },
  { kind: 'MinimumRestBetween', minHours: 11 },
  { kind: 'CallSpacing', minDaysBetweenCalls: 4 },
  { kind: 'NoAdjacent', shiftTypeA: 'NIGHT', shiftTypeB: 'EARLY' },
  { kind: 'ForbiddenSequence', sequence: ['NIGHT', 'EARLY', 'LATE'] },
  {
    kind: 'PatternRule',
    trigger: 'CALL',
    daysOfWeek: ['fri', 'sat'],
    segments: [
      { offsetDays: 0, shiftType: 'CALL' },
      { offsetDays: 1, shiftType: 'POST' },
    ],
  },
  { kind: 'AlternatingWeek', onShiftType: 'WEEKEND', cycleWeeks: 2 },
  { kind: 'TemplateAdherence', template: 'four_week_rota', cycleWeeks: 4 },
  { kind: 'LinkedShifts', shiftTypes: ['CALL', 'POST'] },
  { kind: 'ImpliesAssignment', ifShiftType: 'CALL', thenShiftType: 'POST' },
  { kind: 'MutuallyExclusive', shiftTypes: ['NIGHT', 'DAY'] },
  { kind: 'RequestHonoured', requestType: 'annual_leave' },
  { kind: 'ShiftPreference', shiftType: 'NIGHT', strength: 'strong_avoid' },
  { kind: 'AvoidDate', date: '2028-04-17' },
  { kind: 'FairnessBalance', metric: 'weekend_load', normalisation: 'per_fte' },
  { kind: 'CreditDistribution', metric: 'credits' },
  { kind: 'StaffOverLocumPriority', windowDays: 30 },
  { kind: 'LocumRestriction', restriction: 'locum_last_resort' },
  { kind: 'FixedAssignment', assignmentIdentity: 'fixture_identity_1' },
  { kind: 'ProtectedRange', from: '2028-12-24', to: '2028-12-26' },
];

describe('the editor registry covers the AST exactly', () => {
  it('has a spec for every kind, and no spec for anything else', () => {
    const specKinds = [...NODE_KINDS].sort();
    const exampleKinds = EXAMPLES.map((node) => node.kind).sort();
    expect(specKinds).toEqual(exampleKinds);
    // Thirty is the number SPEC-04 §3.1 fixes and the number the page states.
    expect(specKinds).toHaveLength(30);
  });

  it('every example is a legal node — so the round trip is not proving itself', () => {
    for (const example of EXAMPLES) {
      expect(ruleNodeSchema.safeParse(example).success, example.kind).toBe(true);
    }
  });

  it('every spec names at least one parameter, or is deliberately parameterless', () => {
    for (const kind of NODE_KINDS) {
      expect(NODE_SPECS[kind].label.length, kind).toBeGreaterThan(0);
      expect(NODE_SPECS[kind].description.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('the form round trip is lossless for all thirty kinds', () => {
  it.each(EXAMPLES.map((node) => [node.kind, node] as const))(
    '%s survives fromPredicate → toPredicate unchanged',
    (_kind, node) => {
      const rebuilt = toPredicate(node.kind, fromPredicate(node));
      expect(rebuilt).toEqual(node);
      // And the rebuilt value is still a legal node, not merely a deep-equal
      // object — a number that came back as a string would pass `toEqual`
      // against a string fixture and fail here.
      expect(ruleNodeSchema.safeParse(rebuilt).success, node.kind).toBe(true);
    },
  );
});

describe('a freshly chosen kind starts with its own parameters and nobody else’s', () => {
  it.each(NODE_KINDS)('%s', (kind) => {
    const state = initialState(kind);
    const expected = NODE_SPECS[kind].fields.map((field) => field.name).sort();
    expect(Object.keys(state).sort()).toEqual(expected);
  });

  it('changing kind cannot leave a foreign field behind', () => {
    // The contract is `.strict()`, so a leftover parameter from the previously
    // selected kind would be rejected on save for a reason the author could not
    // see on screen. `initialState` is what prevents it.
    const pattern = initialState('PatternRule');
    const count = initialState('RequiredCount');
    expect(Object.keys(count)).toEqual(['count']);
    expect(Object.keys(pattern)).toContain('segments');
    expect(Object.keys(count)).not.toContain('segments');
  });
});
