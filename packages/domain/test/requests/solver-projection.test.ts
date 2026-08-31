import {
  PROJECTED_STATUSES,
  PROJECTION_EXCLUDED_STATUSES,
  PROJECTION_RULE,
  REQUEST_PREFERENCE_STRENGTHS,
  REQUEST_PROJECTION_KINDS,
  REQUEST_STATUSES,
  REQUEST_SUBTYPES,
  SOFT_PREFERENCE_WEIGHTS,
  entersProjection,
  projectionDisposition,
  softPreferenceWeight,
} from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

/**
 * **SPEC-08 §6's projection rule, and FAD-60's weight table** (OPUS-M5-004,
 * doc 42 §5h).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What this file is for, and what it deliberately is not
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §6 makes two claims that are checkable without a database, and both have been
 * wrong in this specification before:
 *
 *  1. **the include table**, whose `reflected_in_version` row is V-31 — the
 *     amendment that closed a hole in which a request already honoured by a
 *     published version had UNDEFINED projection membership. Excluded, a rebuild
 *     could schedule the person on their approved day off and §6 is the only
 *     gate. R-14 is that scenario end to end; this file is its rule half.
 *  2. **the exclusion list**, which §6 calls exhaustive against §2's status set.
 *     It is exhaustive of the statuses §6 DECIDED — seven — and §2's set has
 *     thirteen. The two §6 never mentions are `under_review` and
 *     `superseded_by_revision`. This file asserts the PARTITION rather than the
 *     list, so a fourteenth status added to §2 without a §6 disposition fails
 *     here rather than defaulting to one.
 *
 * The assembly (which reads rows and expands dates) is
 * `apps/api/test/solver/request-projection.test.ts`; the behavioural half —
 * a rebuild that cannot schedule somebody on their day off — is
 * `apps/api/test/solver/rebuild-hard-off.test.ts` on a REAL build. Three files,
 * three questions, and none of them restates another.
 */

describe('SPEC-08 §6 — the projection rule', () => {
  it('the four row kinds are §6\'s four, in §6\'s printed order', () => {
    /* By NAME and in ORDER, not by count: a swap would be as wrong as an
     * addition and a count would catch neither. */
    expect([...REQUEST_PROJECTION_KINDS]).toEqual([
      'HardOff',
      'HardOn',
      'SoftPreference',
      'ShiftGroupOff',
    ]);
  });

  it('§6\'s table, cell for cell — every subtype\'s kind and its status list', () => {
    /* Laid out as §6 prints it so a reviewer can compare by eye. `time-off` and
     * `no-call` share a cell in the specification and share one here. */
    expect(PROJECTION_RULE['time-off']).toEqual({
      kind: 'HardOff',
      statuses: ['approved', 'consumed_by_build', 'reflected_in_version'],
    });
    expect(PROJECTION_RULE['no-call']).toEqual({
      kind: 'HardOff',
      statuses: ['approved', 'consumed_by_build', 'reflected_in_version'],
    });
    /* §6's "committed vacation", in the ROOT vocabulary §5.3's mapping produces:
     * a `committed` selection's derived root status IS `reflected_in_version`. */
    expect(PROJECTION_RULE['vacation-selection']).toEqual({
      kind: 'HardOff',
      statuses: ['reflected_in_version'],
    });
    expect(PROJECTION_RULE['availability']).toEqual({
      kind: 'HardOn',
      statuses: ['approved', 'reflected_in_version'],
    });
    expect(PROJECTION_RULE['shift-preference']).toEqual({
      kind: 'SoftPreference',
      statuses: ['accepted_as_input', 'reflected_in_version'],
    });
    expect(PROJECTION_RULE['shift-group-off']).toEqual({
      kind: 'ShiftGroupOff',
      statuses: ['approved', 'reflected_in_version'],
    });
  });

  it('V-31 — `reflected_in_version` is in EVERY row, which is the amendment', () => {
    /* The single most consequential cell in §6, and the one that was missing.
     * Asserted for all six subtypes rather than for the one R-14 names, because
     * the hole V-31 closed was in the table rather than in a row. */
    for (const subtype of REQUEST_SUBTYPES) {
      expect(
        entersProjection(subtype, 'reflected_in_version'),
        `${subtype} must project at reflected_in_version (V-31)`,
      ).toBe(true);
    }
  });

  it('the never-enters list is EXHAUSTIVE against §2\'s status set — a partition', () => {
    /* Three assertions, and together they are the exhaustiveness claim:
     *   1. nothing is in both halves,
     *   2. nothing is in neither,
     *   3. the two halves cover §2's set exactly.
     * A list-equality assertion would prove none of the three, because it would
     * be comparing the file to itself. */
    const projected = new Set(PROJECTED_STATUSES);
    const excluded = new Set(PROJECTION_EXCLUDED_STATUSES);

    for (const status of REQUEST_STATUSES) {
      const inProjected = projected.has(status);
      const inExcluded = excluded.has(status);
      expect(inProjected && inExcluded, `${status} is in BOTH halves`).toBe(false);
      expect(inProjected || inExcluded, `${status} is in NEITHER half — §6 says nothing`).toBe(true);
    }
    expect(projected.size + excluded.size).toBe(REQUEST_STATUSES.length);
  });

  it('§6\'s seven NAMED exclusions never enter, for any subtype', () => {
    /* §6's own sentence, status by status and subtype by subtype: "A request in
     * `draft`, `submitted`, `denied`, `withdrawn`, `expired`, `unsatisfied`, or
     * `reversed` never enters the projection." */
    const named = [
      'draft',
      'submitted',
      'denied',
      'withdrawn',
      'expired',
      'unsatisfied',
      'reversed',
    ] as const;
    for (const status of named) {
      for (const subtype of REQUEST_SUBTYPES) {
        expect(
          entersProjection(subtype, status),
          `${subtype}/${status} must never enter the projection`,
        ).toBe(false);
        expect(projectionDisposition(subtype, status)).toBeNull();
      }
    }
  });

  it('the two §6 names in NEITHER list are excluded, by name and with a reason', () => {
    /* `under_review` is undecided (§2's own reading, and the two-step's
     * intermediate); `superseded_by_revision` is a decision that has been
     * reversed. Both are live-promise failures, which is §6's own principle. */
    for (const subtype of REQUEST_SUBTYPES) {
      expect(entersProjection(subtype, 'under_review')).toBe(false);
      expect(entersProjection(subtype, 'superseded_by_revision')).toBe(false);
    }
    expect(PROJECTION_EXCLUDED_STATUSES).toContain('under_review');
    expect(PROJECTION_EXCLUDED_STATUSES).toContain('superseded_by_revision');
  });

  it('the disposition is TOTAL over the whole (subtype × status) cross-product', () => {
    let projected = 0;
    let excluded = 0;
    for (const subtype of REQUEST_SUBTYPES) {
      for (const status of REQUEST_STATUSES) {
        const kind = projectionDisposition(subtype, status);
        if (kind === null) {
          excluded += 1;
        } else {
          projected += 1;
          expect(REQUEST_PROJECTION_KINDS as readonly string[]).toContain(kind);
          /* A projected pair's kind is its SUBTYPE's kind — no subtype produces
           * two row kinds, which is what makes one array per kind a shape a
           * consumer can trust. */
          expect(kind).toBe(PROJECTION_RULE[subtype].kind);
        }
        expect(entersProjection(subtype, status)).toBe(kind !== null);
      }
    }
    expect(projected).toBeGreaterThan(0);
    expect(excluded).toBeGreaterThan(0);
    expect(projected + excluded).toBe(REQUEST_SUBTYPES.length * REQUEST_STATUSES.length);
  });

  it('`consumed_by_build` projects for the two subtypes §6 names and no others', () => {
    /* §6 gives `consumed_by_build` to the `HardOff` cell only — "time-off and
     * no-call in approved, consumed_by_build, or reflected_in_version" — and to
     * nothing else. An availability being consumed by a build does not make it
     * binding, and a shift preference being consumed does not make it stronger. */
    expect(entersProjection('time-off', 'consumed_by_build')).toBe(true);
    expect(entersProjection('no-call', 'consumed_by_build')).toBe(true);
    for (const subtype of ['availability', 'shift-preference', 'shift-group-off'] as const) {
      expect(entersProjection(subtype, 'consumed_by_build')).toBe(false);
    }
  });

  it('a vacation selection projects at `reflected_in_version` and NOWHERE else', () => {
    /* §6's `HardOff` cell says "committed vacation" and §5.3 makes that exactly
     * one root status. An `approved` vacation week is NOT off yet — it has not
     * been committed to a version — and projecting it would make the commit
     * itself meaningless. */
    for (const status of REQUEST_STATUSES) {
      expect(
        entersProjection('vacation-selection', status),
        `vacation-selection/${status}`,
      ).toBe(status === 'reflected_in_version');
    }
  });
});

describe('FAD-60 — the preference-strength weight table', () => {
  /* The three properties FAD-60 declares NOT to be latitude. The VALUES are
   * latitude (against doc 08 §3.3's objective-term structure); these are not,
   * and they are asserted over the closed vocabulary rather than over the three
   * literals, so a fourth strength would fail here rather than default to
   * something. */

  it('is TOTAL over `REQUEST_PREFERENCE_STRENGTHS`', () => {
    for (const strength of REQUEST_PREFERENCE_STRENGTHS) {
      const weight = softPreferenceWeight(strength);
      expect(weight, `${strength} has no weight`).toBeTypeOf('number');
      expect(Number.isFinite(weight)).toBe(true);
    }
    expect(Object.keys(SOFT_PREFERENCE_WEIGHTS).sort()).toEqual(
      [...REQUEST_PREFERENCE_STRENGTHS].sort(),
    );
  });

  it('is STRICTLY MONOTONE — low < medium < high', () => {
    expect(softPreferenceWeight('low')).toBeLessThan(softPreferenceWeight('medium'));
    expect(softPreferenceWeight('medium')).toBeLessThan(softPreferenceWeight('high'));
    /* Strict, not merely non-decreasing: two strengths with one weight would make
     * the three-value vocabulary a two-value one, which is the lossiness FAD-60
     * refuses in the other direction. */
    expect(new Set(Object.values(SOFT_PREFERENCE_WEIGHTS)).size).toBe(
      REQUEST_PREFERENCE_STRENGTHS.length,
    );
  });

  it('is POSITIVE — every weight rewards, none penalises', () => {
    /* doc 08 §3.3's preference row is "Reward honoured ON / preferred-shift
     * requests". A zero would make a stated preference count for nothing; a
     * negative one would make the projection express `avoid`, which FAD-60 says
     * is UNREACHABLE from a request by construction — a request states a
     * preference FOR its named shift type. */
    for (const strength of REQUEST_PREFERENCE_STRENGTHS) {
      expect(softPreferenceWeight(strength), `${strength} must reward`).toBeGreaterThan(0);
    }
  });

  it('every weight is an INTEGER — doc 08 §3.4\'s one global scale, not a second one', () => {
    /* §3.4: "Decide the scaling factor once, globally, and document it — a
     * per-rule ad-hoc choice produces objective terms that are not comparable."
     * A fractional table here would be exactly that second precision. */
    for (const strength of REQUEST_PREFERENCE_STRENGTHS) {
      expect(Number.isInteger(softPreferenceWeight(strength))).toBe(true);
    }
  });

  it('the strengths are the REQUEST vocabulary, never the rules AST\'s signed one', () => {
    /* FAD-60's core: three unsigned values, and no member of the AST's four-value
     * signed vocabulary appears anywhere in this table. A mapping able to express
     * `avoid` would manufacture a hostile preference nobody stated. */
    expect([...REQUEST_PREFERENCE_STRENGTHS]).toEqual(['low', 'medium', 'high']);
    const keys = Object.keys(SOFT_PREFERENCE_WEIGHTS);
    for (const signed of ['strong_prefer', 'prefer', 'avoid', 'strong_avoid']) {
      expect(keys).not.toContain(signed);
    }
  });
});
