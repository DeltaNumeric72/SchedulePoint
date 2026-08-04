import { describe, expect, it } from 'vitest';

import {
  RULE_NODE_KEYS,
  RULE_NODE_KINDS,
  RULE_SCHEMA_VERSION,
  assertKindsCoverUnion,
  canonicalStringify,
  isRuleNodeKind,
  parseJson,
  ruleProblems,
  ruleSensitivity,
  type Rule,
} from '../../src/rules/index.js';
import { everyNodeSample, hardRuleFor, softRuleFor } from './samples.js';

describe('the closed node set', () => {
  it('has a declared kind for every union member and no extras', () => {
    // assertKindsCoverUnion is a Record<RuleNodeKind, true>; its keys must equal
    // RULE_NODE_KINDS exactly, so the array cannot drift from the union.
    expect(new Set(Object.keys(assertKindsCoverUnion))).toEqual(new Set(RULE_NODE_KINDS));
  });

  it('constructs, recognises and validates one instance of every node', () => {
    for (const node of everyNodeSample()) {
      expect(isRuleNodeKind(node.kind)).toBe(true);
      const rule = hardRuleFor(node.kind);
      expect(ruleProblems(rule)).toEqual([]);
    }
  });

  it('the declared key allowlist matches every sample node exactly', () => {
    // Keeps `RULE_NODE_KEYS` honest: a field added to a node interface without an
    // entry there would silently become unvalidated, which is the hole N-1 closed.
    for (const node of everyNodeSample()) {
      const declared = RULE_NODE_KEYS[node.kind];
      expect(declared, `no key allowlist for ${node.kind}`).toBeDefined();
      expect(new Set(declared), `key allowlist drift on ${node.kind}`).toEqual(
        new Set(Object.keys(node)),
      );
    }
  });

  it('rejects an unknown SIBLING key smuggled beside valid fields (the reviewer probe)', () => {
    // The independent review's exact probe: valid node, valid values, plus two
    // extra keys. Validation used to pass — nothing looked at keys it did not
    // expect — so the domain layer claimed "no escape hatch" while carrying one.
    const smuggled = {
      ...hardRuleFor('RequiredCount'),
      predicate: {
        kind: 'RequiredCount',
        count: 1,
        customExpression: 'staff.length > 3',
        customPayload: { sql: 'SELECT 1' },
      },
    } as unknown as Rule;
    const paths = ruleProblems(smuggled).map((p) => p.path);
    expect(paths).toContain('predicate.customExpression');
    expect(paths).toContain('predicate.customPayload');
  });

  it('rejects an unknown key on the scope, on a date range, and on a pattern segment', () => {
    const scoped = {
      ...hardRuleFor('RequiredCount'),
      scope: { customScope: ['x'], dateRange: { from: '2026-01-01', to: '2026-01-02', tz: 'UTC' } },
    } as unknown as Rule;
    const scopePaths = ruleProblems(scoped).map((p) => p.path);
    expect(scopePaths).toContain('scope.customScope');
    expect(scopePaths).toContain('scope.dateRange.tz');

    const segmented = {
      ...hardRuleFor('PatternRule'),
      predicate: {
        kind: 'PatternRule',
        trigger: 'call',
        daysOfWeek: ['fri'],
        segments: [{ offsetDays: 0, shiftType: 'call', script: 'x' }],
      },
    } as unknown as Rule;
    expect(ruleProblems(segmented).map((p) => p.path)).toContain('predicate.segments.0.script');
  });

  it('rejects a date that passes the shape but is not a calendar date', () => {
    // `Date.parse('2026-02-30T00:00:00Z')` SUCCEEDS — it rolls forward to 2 March —
    // so these validated and were stored verbatim before N-8.
    for (const bad of ['2026-02-30', '2026-13-01', '2026-04-31', '2025-02-29']) {
      const rule = {
        ...hardRuleFor('AvoidDate'),
        predicate: { kind: 'AvoidDate', date: bad },
      } as unknown as Rule;
      expect(
        ruleProblems(rule).some((p) => p.path === 'predicate.date'),
        `${bad} was accepted as a calendar date`,
      ).toBe(true);
    }
    // A real leap day still validates — the check must not be over-eager.
    const leap = {
      ...hardRuleFor('AvoidDate'),
      predicate: { kind: 'AvoidDate', date: '2028-02-29' },
    } as unknown as Rule;
    expect(ruleProblems(leap)).toEqual([]);
  });

  it('rejects an unknown kind as an escape-hatch attempt (no free-expression node)', () => {
    expect(isRuleNodeKind('CustomExpression')).toBe(false);
    const smuggled = {
      ruleKey: 'escape',
      name: 'raw predicate',
      ruleSchemaVersion: RULE_SCHEMA_VERSION,
      classification: 'HARD',
      scope: {},
      predicate: { kind: 'RawJson', sql: 'anything' },
    } as unknown as Rule;
    const problems = ruleProblems(smuggled);
    expect(problems.some((p) => p.path === 'predicate')).toBe(true);
  });
});

describe('field-addressed validation', () => {
  it('addresses the failing field, not a sentence', () => {
    const rule = {
      ruleKey: 'BAD KEY',
      name: '',
      ruleSchemaVersion: RULE_SCHEMA_VERSION,
      classification: 'HARD',
      scope: { dateRange: { from: '2026-02-10', to: '2026-01-01' } },
      predicate: { kind: 'RequiredCount', count: 0 },
    } as unknown as Rule;
    const paths = ruleProblems(rule).map((p) => p.path);
    expect(paths).toContain('ruleKey');
    expect(paths).toContain('name');
    expect(paths).toContain('scope.dateRange.to');
    expect(paths).toContain('predicate.count');
  });

  it('enforces the hard/soft weight discipline (both directions)', () => {
    const hardWithWeight = { ...hardRuleFor('MinCoverage'), weight: 5 } as unknown as Rule;
    expect(ruleProblems(hardWithWeight).some((p) => p.path === 'weight')).toBe(true);

    const softWithoutWeight = {
      ...softRuleFor('MinCoverage'),
      weight: undefined,
    } as unknown as Rule;
    expect(ruleProblems(softWithoutWeight).some((p) => p.path === 'weight')).toBe(true);

    const softZeroWeight = { ...softRuleFor('MinCoverage'), weight: 0 } as unknown as Rule;
    expect(ruleProblems(softZeroWeight).some((p) => p.path === 'weight')).toBe(true);
  });

  it('validates adversarial inputs: boundary weights, empty scopes, unicode names', () => {
    // Unicode name is accepted (a name is free display text, not a protected path).
    const unicode = { ...softRuleFor('MaxCoverage'), name: 'Rota café — 夜勤 🏥' };
    expect(ruleProblems(unicode)).toEqual([]);

    // A pick-position list may not be empty.
    const emptyPick = hardRuleFor('PickPositionRestriction');
    const broken = {
      ...emptyPick,
      predicate: { kind: 'PickPositionRestriction', allowedPickPositions: [] },
    } as unknown as Rule;
    expect(ruleProblems(broken).some((p) => p.path === 'predicate.allowedPickPositions')).toBe(
      true,
    );

    // fteFraction is bounded to [0,1].
    const overFte = {
      ...hardRuleFor('WeekdayFteLimit'),
      predicate: { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 1.5 },
    } as unknown as Rule;
    expect(overFte).toBeDefined();
    expect(ruleProblems(overFte).some((p) => p.path === 'predicate.fteFraction')).toBe(true);
  });
});

describe('sensitivity is derived from the AST', () => {
  it('is INTERNAL when the scope names individuals (staff_rules-class content)', () => {
    const named: Rule = { ...hardRuleFor('AvoidDate'), scope: { memberships: ['m01'] } };
    expect(ruleSensitivity(named)).toBe('INTERNAL');
  });
  it('is NONE when no membership is named', () => {
    expect(ruleSensitivity(hardRuleFor('RequiredCount'))).toBe('NONE');
  });
});

describe('canonical serialization round trip (named proof 1)', () => {
  it('is lossless and canonical-equal for every node, HARD and SOFT', () => {
    for (const kind of RULE_NODE_KINDS) {
      for (const rule of [hardRuleFor(kind), softRuleFor(kind)]) {
        const once = canonicalStringify(rule);
        const reparsed = parseJson(once);
        const twice = canonicalStringify(reparsed);
        expect(twice).toBe(once);
        // Re-validation after the round trip still passes.
        expect(ruleProblems(reparsed as Rule)).toEqual([]);
      }
    }
  });

  it('is stable under key reordering of the source object', () => {
    const a = {
      predicate: { count: 2, kind: 'RequiredCount' },
      classification: 'HARD',
      name: 'n',
      ruleKey: 'k',
      ruleSchemaVersion: 1,
      scope: {},
    };
    const b = {
      ruleKey: 'k',
      classification: 'HARD',
      scope: {},
      name: 'n',
      ruleSchemaVersion: 1,
      predicate: { kind: 'RequiredCount', count: 2 },
    };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('detects a corrupted field (the round-trip proof cannot be satisfied vacuously)', () => {
    const rule = hardRuleFor('RequiredCount');
    const original = canonicalStringify(rule);
    const corrupted = parseJson(original) as { predicate: { count: number } };
    corrupted.predicate.count = 999;
    expect(canonicalStringify(corrupted)).not.toBe(original);
  });
});
