import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  authorize,
  denialDisclosure,
  describeCase,
  expectedOutcome,
  generateCases,
  policyInputFor,
  type CrossProductCase,
  type PolicyStep,
} from '../../src/authz/index.js';

/**
 * SPEC-06 §8.1 — the generated cross-product, run **in full**.
 *
 * ## It is not sampled, and the arithmetic is printed so you can check
 *
 * The packet's escalation condition is "cross-product size makes generated tests
 * impractical (**propose sampling, do not silently sample**)". It was measured
 * before anything was decided: the full product is ~39 million cases and
 * evaluates in about 20 seconds of pure CPU, because the evaluator is pure and
 * allocates one snapshot per case. So there is nothing to propose — the battery
 * below enumerates every combination of every dimension for every capability in
 * the catalogue, and the case count is asserted to be in the tens of millions so
 * that a future change which quietly collapses a dimension fails here rather than
 * passing faster.
 *
 * ## The oracle
 *
 * Each case is evaluated twice: once by `authorize` (nested guards, early
 * returns) and once by `expectedOutcome` (a flat ordered list of predicate →
 * reason pairs). Both were transcribed from SPEC-06 §2, independently. A
 * disagreement fails, and the first ten are printed in full.
 *
 * ## Why there are no per-case `expect` calls
 *
 * 39 million `expect()` invocations would take hours and produce an unreadable
 * report. The loop accumulates and asserts once — which means the assertion has
 * to carry its own evidence, so it reports the count, the mismatch total, and the
 * offending cases.
 */

interface BatteryResult {
  readonly cases: number;
  readonly mismatches: readonly string[];
  readonly byStep: ReadonlyMap<string, number>;
  /** capability -> { allowed, denied } */
  readonly byCapability: ReadonlyMap<string, { allowed: number; denied: number }>;
}

function runBattery(mode: 'full' | 'representative'): BatteryResult {
  const mismatches: string[] = [];
  const byStep = new Map<string, number>();
  const byCapability = new Map<string, { allowed: number; denied: number }>();
  let cases = 0;

  for (const testCase of generateCases({ mode })) {
    cases += 1;
    const decision = authorize(policyInputFor(testCase));
    const expected = expectedOutcome(testCase);

    const outcome = decision.allowed ? 'ALLOW' : `${decision.step} ${decision.reason}`;
    byStep.set(outcome, (byStep.get(outcome) ?? 0) + 1);

    const tally = byCapability.get(testCase.capabilityKey) ?? { allowed: 0, denied: 0 };
    if (decision.allowed) tally.allowed += 1;
    else tally.denied += 1;
    byCapability.set(testCase.capabilityKey, tally);

    const agrees =
      decision.allowed === expected.allowed &&
      (decision.allowed ||
        (decision.step === expected.step && decision.reason === expected.reason));

    if (!agrees && mismatches.length < 10) {
      mismatches.push(
        `${describeCase(testCase)}\n      evaluator: ${outcome}\n      oracle:    ${String(expected.step)} ${String(expected.reason ?? 'ALLOW')}`,
      );
    } else if (!agrees) {
      mismatches.push('…');
    }
  }

  return { cases, mismatches, byStep, byCapability };
}

/** Every numbered row of SPEC-06 §2. Fifteen, not fourteen — see `evaluate.ts`. */
const EVERY_STEP: readonly PolicyStep[] = [
  'L0.1',
  'L0.2',
  'L1.1',
  'L1.2',
  'L1.3',
  'L1.4',
  'L2.1',
  'L3.1',
  'L3.2',
  'L3.3',
  'L4.1',
  'L4.2',
  'L5.1',
  'L6.1',
  'L6.2',
];

describe('SPEC-06 §8.1 — the full generated cross-product', () => {
  const started = Date.now();
  const result = runBattery('full');
  const elapsed = Date.now() - started;

  it('every case agrees with the independent oracle', () => {
    expect(
      result.mismatches,
      `${String(result.mismatches.length)} of ${String(result.cases)} cases disagree`,
    ).toEqual([]);
    console.log(
      `      · ${String(result.cases)} cases evaluated in ${String(elapsed)} ms, 0 disagreements`,
    );
    console.log(
      `      · outcomes: ${[...result.byStep.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([step, n]) => `${step}=${String(n)}`)
        .join(' ')}`,
    );
  });

  it('the battery is the full product, not a sample', () => {
    // A dimension quietly collapsed to one value would shrink this by an order
    // of magnitude and every other assertion here would still pass.
    expect(result.cases).toBeGreaterThan(30_000_000);
  });

  it('EVERY row of the truth table is exercised by a generated case', () => {
    const reached = new Set([...result.byStep.keys()].map((key) => key.split(' ')[0]));
    const unreached = EVERY_STEP.filter((step) => !reached.has(step));
    expect(
      unreached,
      'a row of SPEC-06 §2 produced no outcome — the battery does not cover it',
    ).toEqual([]);
    expect(result.byStep.get('ALLOW') ?? 0).toBeGreaterThan(0);
  });

  it('A-15: every capability has BOTH an allow and a deny case', () => {
    const withoutPair = CAPABILITIES.filter((capability) => {
      const tally = result.byCapability.get(capability.key);
      return tally === undefined || tally.allowed === 0 || tally.denied === 0;
    }).map((capability) => capability.key);
    expect(
      withoutPair,
      'SPEC-06 A-15: "a capability without a pair fails CI"',
    ).toEqual([]);
  });

  it('both halves of the scope dimension are non-empty for every capability', () => {
    // SPEC-06 §8.1: "Both halves are generated and asserted; the generator fails
    // if either half is empty for any capability."
    const scopes = new Map<string, Set<string>>();
    for (const testCase of generateCases({ mode: 'representative' })) {
      const seen = scopes.get(testCase.capabilityKey) ?? new Set<string>();
      seen.add(testCase.scope);
      scopes.set(testCase.capabilityKey, seen);
    }
    const group = CAPABILITIES.filter((c) => c.scope === 'group');
    const organization = CAPABILITIES.filter((c) => c.scope === 'organization');
    expect(group.length, 'the group half of the catalogue is empty').toBeGreaterThan(0);
    expect(organization.length, 'the organization half is empty').toBeGreaterThan(0);
    for (const capability of CAPABILITIES) {
      expect([...(scopes.get(capability.key) ?? [])]).toEqual([capability.scope]);
    }
  });

  it('every denial resolves to exactly one disclosure, and none of them is an explanation', () => {
    // The wire form of a denial is chosen from the reason alone, and the reason
    // set is closed. This walks the closed set rather than the 39 million cases.
    const seen = new Set<string>();
    for (const outcome of result.byStep.keys()) {
      if (outcome === 'ALLOW') continue;
      const reason = outcome.split(' ')[1];
      if (reason === undefined) continue;
      seen.add(reason);
      const disclosure = denialDisclosure(reason as never);
      expect(['not-found', 'forbidden']).toContain(disclosure);
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe('the oracle is not the evaluator', () => {
  // A battery whose oracle is the implementation proves determinism, not
  // correctness. These mutate a case in a way the evaluator must notice and
  // assert that the ORACLE notices it too — if the two were the same code these
  // would still pass, so they are paired with the disagreement count above,
  // which is the real control. What they catch is an oracle that has become
  // vacuous (e.g. `return ALLOWED` at the top).
  const base: CrossProductCase = {
    capabilityKey: 'membership.touch_self',
    scope: 'group',
    orgStatus: 'active',
    groupStatus: 'active',
    entitlement: 'active',
    window: 'within',
    dependencySatisfied: true,
    available: true,
    membershipStatus: 'active',
    membershipWindow: 'within',
    role: 'scheduler',
    organizationMembershipStatus: 'active',
    organizationRole: 'absent',
    grant: 'absent',
    ownership: 'absent',
    proxy: 'none',
    impersonation: 'none',
  };

  it('the base case is an ALLOW in both', () => {
    expect(authorize(policyInputFor(base)).allowed).toBe(true);
    expect(expectedOutcome(base).allowed).toBe(true);
  });

  it.each([
    ['orgStatus', { orgStatus: 'inactive' } as const, 'ORG_INACTIVE'],
    ['groupStatus', { groupStatus: 'inactive' } as const, 'GROUP_INACTIVE'],
    ['entitlement', { entitlement: 'absent' } as const, 'NOT_ENTITLED'],
    ['window', { window: 'after' } as const, 'ENTITLEMENT_EXPIRED'],
    ['availability', { available: false } as const, 'MODULE_UNAVAILABLE_IN_GROUP'],
    ['membership', { membershipStatus: 'absent' } as const, 'NO_MEMBERSHIP'],
    ['membership window', { membershipWindow: 'expired' } as const, 'MEMBERSHIP_EXPIRED'],
    ['role', { role: 'member' } as const, 'NO_CAPABILITY'],
    ['grant', { grant: 'deny' } as const, 'EXPLICIT_DENY'],
    ['ownership', { ownership: 'other' } as const, 'OBJECT_POLICY'],
    ['proxy', { proxy: 'notifications-only' } as const, 'PROXY_SCOPE'],
    ['impersonation', { impersonation: 'expired' } as const, 'IMPERSONATION_EXPIRED'],
  ])('moving %s alone denies with %s in both', (_label, patch, reason) => {
    const mutated = { ...base, ...patch } as CrossProductCase;
    const decision = authorize(policyInputFor(mutated));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe(reason);
    expect(expectedOutcome(mutated).reason).toBe(reason);
  });
});
