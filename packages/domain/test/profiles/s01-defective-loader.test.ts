import { describe, expect, it } from 'vitest';

import { selectInForce, type EffectiveDated } from '../../src/profiles/in-force.js';
import { BOUNDARY_CASES, type BoundaryCase } from './boundary-battery.js';

/**
 * **RED CASE — a loader that reintroduces the S-01 defect is caught by the
 * boundary battery.**
 *
 * The packet's red case, stated in its own words: "a loader variant using
 * arbitrary-row selection (the S-01 defect, reintroduced deliberately in a red
 * case) is caught by the boundary battery".
 *
 * ## What S-01 actually was
 *
 * `docs/evidence/EV-M1-AUTHZ`. `entitlements` is effective-dated with a `[)`
 * EXCLUDE constraint, so more than one row per key is the **designed** steady
 * state. The loader had no window predicate and no total order, so whichever row
 * PostgreSQL returned last won. One legitimate administrative re-window made
 * every action in that module 404 organization-wide, with nothing raised and
 * nothing in the logs pointing at the table. It was found by an independent
 * reviewer, not by a test.
 *
 * ## Why this file runs the SHIPPED battery
 *
 * A red case that writes its own scenario proves that the scenario catches the
 * defect. It proves nothing about the battery the project actually ships — and
 * "the battery would catch it" was exactly the unexamined assumption last time.
 * `BOUNDARY_CASES` is imported, not copied, so:
 *
 *   * narrowing the battery makes this file report FEWER caught defects and fail;
 *   * deleting a boundary case that a defect depends on fails here immediately.
 *
 * Each variant below is a plausible implementation someone would write in good
 * faith. That is the point — none of them looks wrong at its own call site.
 */

type Selector = (rows: readonly EffectiveDated[], at: Date) => EffectiveDated | null;

interface DefectiveVariant {
  readonly name: string;
  readonly howItGetsWritten: string;
  readonly select: Selector;
}

const parse = (value: string): number => Date.parse(value);

const DEFECTIVE_VARIANTS: readonly DefectiveVariant[] = [
  {
    name: 'S-01 verbatim — whichever row the database returned last',
    howItGetsWritten:
      '`const row = rows[rows.length - 1]` after a SELECT with no window predicate. This is the ' +
      'shape that shipped in `load-policy-input.ts` and 404\'d an organization.',
    select: (rows) => rows[rows.length - 1] ?? null,
  },
  {
    name: 'S-01 tidied up — the first row',
    howItGetsWritten:
      '`rows[0]`, or the SQL equivalent `LIMIT 1` with no ORDER BY. Looks deliberate, is not: ' +
      'the packet names this exact spelling as prohibited.',
    select: (rows) => rows[0] ?? null,
  },
  {
    name: 'the latest-starting row — `ORDER BY effective_from DESC LIMIT 1`',
    howItGetsWritten:
      'The version a careful engineer writes after being told "no arbitrary rows, add an ORDER ' +
      'BY". It is deterministic and still wrong: it applies a FUTURE-DATED change today, which ' +
      'is the defect that turns "schedule a change for the 1st" into "the change took effect ' +
      'when I saved it".',
    select: (rows) => {
      const sorted = [...rows].sort((a, b) => parse(b.effectiveFrom) - parse(a.effectiveFrom));
      return sorted[0] ?? null;
    },
  },
  {
    name: 'the open-ended row — "the one with no end date is the current one"',
    howItGetsWritten:
      'Reads as an obvious shortcut and is right most of the time. It answers with the live row ' +
      'when asked about a historical instant, and answers with a future row before it starts.',
    select: (rows) => rows.find((row) => row.effectiveTo === null) ?? null,
  },
  {
    name: 'closed upper bound — `[from, to]` instead of `[from, to)`',
    howItGetsWritten:
      'An inclusive `<=` on the upper bound. It makes the instant of change belong to BOTH ' +
      'windows, which is the ambiguity the EXCLUDE constraint refuses to store — so the loader ' +
      'and the database disagree about what the schema permits.',
    select: (rows, at) => {
      const instant = at.getTime();
      const matches = rows.filter((row) => {
        const from = parse(row.effectiveFrom);
        if (Number.isNaN(from) || instant < from) return false;
        if (row.effectiveTo === null) return true;
        return instant <= parse(row.effectiveTo);
      });
      return matches[0] ?? null;
    },
  },
];

/** Every battery case the variant answers differently from the shipped rule. */
function casesCaught(variant: DefectiveVariant): BoundaryCase[] {
  return BOUNDARY_CASES.filter((testCase) => {
    const at = new Date(testCase.at);
    const shipped = selectInForce(testCase.rows, at);
    const expected = shipped.kind === 'in-force' ? shipped.row.id : null;

    let observed: string | null;
    try {
      observed = variant.select(testCase.rows, at)?.id ?? null;
    } catch {
      // A variant that crashes on a case is also caught by it — noisily, which is
      // the better failure. Recorded as caught rather than swallowed.
      return true;
    }
    return observed !== expected;
  });
}

describe('RED: the boundary battery catches a loader that reintroduces S-01', () => {
  it('GREEN control — the SHIPPED rule answers every battery case correctly', () => {
    // Green before red, always. Without this, a battery whose expectations were
    // themselves wrong would make every variant below look caught.
    const wrong = BOUNDARY_CASES.filter((testCase) => {
      const selection = selectInForce(testCase.rows, new Date(testCase.at));
      const observed = selection.kind === 'in-force' ? selection.row.id : null;
      return observed !== testCase.expectedId;
    });
    expect(wrong.map((c) => c.name), 'the shipped rule fails its own battery').toEqual([]);
  });

  for (const variant of DEFECTIVE_VARIANTS) {
    it(`catches: ${variant.name}`, () => {
      const caught = casesCaught(variant);
      expect(
        caught.map((testCase) => testCase.name),
        `the boundary battery did NOT catch "${variant.name}". ${variant.howItGetsWritten}`,
      ).not.toEqual([]);
    });
  }

  it('the battery catches EVERY defective variant, and reports which case caught each', () => {
    const summary = DEFECTIVE_VARIANTS.map((variant) => ({
      variant: variant.name,
      caughtBy: casesCaught(variant).map((testCase) => testCase.name),
    }));
    const uncaught = summary.filter((entry) => entry.caughtBy.length === 0);
    expect(uncaught, 'a defective loader variant survived the whole battery').toEqual([]);

    // The retained artifact for this red case: which battery case caught each
    // variant. A reviewer can delete that case and watch this file go red.
    for (const entry of summary) {
      process.stdout.write(
        `      \u00b7 ${entry.variant}\n          caught by: ${entry.caughtBy[0] ?? '(none)'}\n`,
      );
    }
  });

  it('MUTATION: shrink the battery to its green cases and the red case goes green', () => {
    // The control on the control. If the battery consisted only of cases where a
    // row IS in force at an unambiguous instant, the "open-ended row" variant
    // would survive it — which is what "the battery must contain the boundary
    // cases, not merely many cases" means, made falsifiable.
    const shrunk = BOUNDARY_CASES.filter(
      (testCase) => testCase.name === 'a single open-ended row governs from its start instant onward',
    );
    expect(shrunk.length, 'the control case is missing from the battery').toBe(1);

    const openEndedVariant = DEFECTIVE_VARIANTS.find((v) => v.name.startsWith('the open-ended row'));
    expect(openEndedVariant).toBeDefined();
    if (openEndedVariant === undefined) return;

    const survivedShrunk = shrunk.every((testCase) => {
      const at = new Date(testCase.at);
      const shipped = selectInForce(testCase.rows, at);
      const expected = shipped.kind === 'in-force' ? shipped.row.id : null;
      return (openEndedVariant.select(testCase.rows, at)?.id ?? null) === expected;
    });
    expect(
      survivedShrunk,
      'the shrunk battery already catches the variant, so this mutation proves nothing',
    ).toBe(true);

    // …and the FULL battery does catch it. The difference between the two lines
    // is the value of the boundary cases, measured rather than asserted.
    expect(casesCaught(openEndedVariant).length).toBeGreaterThan(0);
  });
});
