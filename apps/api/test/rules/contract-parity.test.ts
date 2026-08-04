import { describe, expect, it } from 'vitest';

import {
  FAIRNESS_METRIC_VALUES,
  FAIRNESS_NORMALISATION_VALUES,
  LOCUM_RESTRICTION_VALUES,
  PREFERENCE_STRENGTH_VALUES,
  RULE_CLASSIFICATION_VALUES,
  RULE_WEEKDAY_VALUES,
  ruleNodeSchema,
} from '@schedulepoint/contracts';
import {
  FAIRNESS_METRICS,
  FAIRNESS_NORMALISATIONS,
  LOCUM_RESTRICTIONS,
  PREFERENCE_STRENGTHS,
  RULE_CLASSIFICATIONS,
  RULE_NODE_KINDS,
  RULE_WEEKDAYS,
} from '@schedulepoint/domain';

/**
 * `@schedulepoint/contracts` duplicates the rule enums and node kinds because the
 * layering rule forbids it importing `@schedulepoint/domain`. This test is the
 * assertion that keeps the two copies equal (the module headers promise it), so
 * drift is a failing test here rather than a mysterious save-time rejection.
 */

function unionKinds(): string[] {
  // zod discriminated-union options are ZodObjects whose `kind` is a literal.
  return ruleNodeSchema.options.map((option) => {
    const shape = option.shape as { kind: { value: string } };
    return shape.kind.value;
  });
}

describe('domain ⇄ contracts rule parity', () => {
  it('the discriminated union covers exactly the closed node set', () => {
    expect(new Set(unionKinds())).toEqual(new Set(RULE_NODE_KINDS));
  });

  it('the enums match one for one', () => {
    expect([...RULE_WEEKDAY_VALUES]).toEqual([...RULE_WEEKDAYS]);
    expect([...PREFERENCE_STRENGTH_VALUES]).toEqual([...PREFERENCE_STRENGTHS]);
    expect([...FAIRNESS_METRIC_VALUES]).toEqual([...FAIRNESS_METRICS]);
    expect([...FAIRNESS_NORMALISATION_VALUES]).toEqual([...FAIRNESS_NORMALISATIONS]);
    expect([...LOCUM_RESTRICTION_VALUES]).toEqual([...LOCUM_RESTRICTIONS]);
    expect([...RULE_CLASSIFICATION_VALUES]).toEqual([...RULE_CLASSIFICATIONS]);
  });

  it('rejects an unknown predicate kind on the wire (no escape hatch)', () => {
    const parsed = ruleNodeSchema.safeParse({ kind: 'RawJson', sql: 'anything' });
    expect(parsed.success).toBe(false);
  });
});
