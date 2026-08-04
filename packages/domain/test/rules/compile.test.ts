import { describe, expect, it } from 'vitest';

import {
  COMPILER_VERSION,
  RULE_NODE_KINDS,
  RULE_SCHEMA_VERSION,
  canonicalStringify,
  compileRule,
  compileRuleSet,
  compileRuleSetToCanonicalString,
  type Rule,
} from '../../src/rules/index.js';
import { everyNodeSample, hardRuleFor, softRuleFor } from './samples.js';

describe('the compiler covers the closed node set (named proof 3, runtime half)', () => {
  it('compiles every node kind to a model element', () => {
    for (const node of everyNodeSample()) {
      const compiled = compileRule(hardRuleFor(node.kind));
      expect(compiled.modelElement.length).toBeGreaterThan(0);
      expect(compiled.kind).toBe(node.kind);
    }
  });
});

describe('the hard/soft invariant is structural (named proof 4, compiler half)', () => {
  it('never maps a HARD rule to an objective term', () => {
    for (const kind of RULE_NODE_KINDS) {
      const compiled = compileRule(hardRuleFor(kind));
      expect(compiled.role).toBe('constraint');
      expect(compiled.weight).toBeNull();
    }
  });

  it('always maps a SOFT rule to an objective term carrying its weight', () => {
    for (const kind of RULE_NODE_KINDS) {
      const compiled = compileRule(softRuleFor(kind, 7));
      expect(compiled.role).toBe('objective');
      expect(compiled.weight).toBe(7);
    }
  });
});

describe('compiler determinism (named proof 2)', () => {
  it('is byte-identical across repeated compilation of the same input', () => {
    const rules: Rule[] = RULE_NODE_KINDS.map((kind, i) =>
      i % 2 === 0 ? hardRuleFor(kind) : softRuleFor(kind),
    );
    const a = compileRuleSetToCanonicalString(rules, RULE_SCHEMA_VERSION);
    const b = compileRuleSetToCanonicalString(rules, RULE_SCHEMA_VERSION);
    expect(b).toBe(a);
  });

  it('is invariant to source key order but sensitive to values', () => {
    const ruleA = {
      ruleKey: 'k',
      name: 'n',
      ruleSchemaVersion: 1,
      classification: 'HARD',
      scope: {},
      predicate: { kind: 'MaxAssignmentsInWindow', windowDays: 7, max: 5 },
    } as unknown as Rule;
    const ruleB = {
      predicate: { max: 5, kind: 'MaxAssignmentsInWindow', windowDays: 7 },
      scope: {},
      classification: 'HARD',
      ruleSchemaVersion: 1,
      name: 'n',
      ruleKey: 'k',
    } as unknown as Rule;
    expect(canonicalStringify(compileRule(ruleA))).toBe(canonicalStringify(compileRule(ruleB)));

    const ruleC = {
      ...ruleA,
      predicate: { kind: 'MaxAssignmentsInWindow', max: 6, windowDays: 7 },
    } as Rule;
    expect(canonicalStringify(compileRule(ruleC))).not.toBe(canonicalStringify(compileRule(ruleA)));
  });

  it('records the compiler and schema versions on the compiled set', () => {
    const compiled = compileRuleSet([hardRuleFor('RequiredCount')], RULE_SCHEMA_VERSION);
    expect(compiled.compilerVersion).toBe(COMPILER_VERSION);
    expect(compiled.ruleSchemaVersion).toBe(RULE_SCHEMA_VERSION);
    expect(compiled.elements).toHaveLength(1);
  });

  it('preserves rule order in the compiled set', () => {
    const compiled = compileRuleSet(
      [hardRuleFor('MinCoverage'), softRuleFor('MaxCoverage'), hardRuleFor('RequiredCount')],
      RULE_SCHEMA_VERSION,
    );
    expect(compiled.elements.map((e) => e.kind)).toEqual([
      'MinCoverage',
      'MaxCoverage',
      'RequiredCount',
    ]);
  });
});
