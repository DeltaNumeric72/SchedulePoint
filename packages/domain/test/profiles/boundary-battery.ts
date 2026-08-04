import type { EffectiveDated, NoRowReason } from '../../src/profiles/in-force.js';

/**
 * **The boundary battery, as data.**
 *
 * The packet requires the in-force rule to be "proven at boundaries (instant of
 * change, future-dated rows present, gaps, first/last row, timezone-explicit
 * instants)". Those cases live here, in one table, rather than inline in the test
 * that checks them — for one reason, and it is the reason the whole packet exists.
 *
 * `docs/evidence/EV-M1-AUTHZ` finding S-01 was an arbitrary-row read of an
 * effective-dated table. The packet's red case is that **a loader variant which
 * reintroduces that defect must be caught by this battery** — and a red case that
 * runs its own private copy of the cases proves only that the copy catches it.
 * Exported as data, the battery is literally the same input in both places:
 *
 *   `in-force.test.ts`         runs it against the SHIPPED rule — every case passes
 *   `s01-defective-loader.test.ts` runs it against three DEFECTIVE variants and
 *                              asserts each is caught, naming the case that caught it
 *
 * Narrow the battery and the red case goes green, which is the failure the shape
 * is designed to make visible.
 */

export interface BoundaryCase {
  readonly name: string;
  /** Deliberately given in a scrambled order; the rule must not depend on it. */
  readonly rows: readonly EffectiveDated[];
  readonly at: string;
  /** The id that must be selected, or `null` when no row is in force. */
  readonly expectedId: string | null;
  /** When `expectedId` is `null`, which of the four facts this is. */
  readonly expectedReason?: NoRowReason;
  /** Why this case is in the battery. Read by reviewers, not by code. */
  readonly why: string;
}

const row = (id: string, from: string, to: string | null): EffectiveDated => ({
  id,
  effectiveFrom: from,
  effectiveTo: to,
});

/** The three-window history a superseded membership actually has. */
const HISTORY: readonly EffectiveDated[] = [
  // Scrambled on purpose. A rule that quietly depends on `ORDER BY` passes when
  // the fixture is sorted and fails in production the first time a plan changes.
  row('p2', '2024-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  row('p3', '2026-01-01T00:00:00.000Z', null),
  row('p1', '2022-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'),
];

export const BOUNDARY_CASES: readonly BoundaryCase[] = [
  /* ── the instant of change: the single most important pair ───────────────── */
  {
    name: 'instant of change — the exact start instant belongs to the NEW row',
    rows: HISTORY,
    at: '2024-01-01T00:00:00.000Z',
    expectedId: 'p2',
    why:
      'Windows are half-open, [from, to). The instant a supersession takes effect is the FIRST ' +
      'instant of the successor and NOT the last instant of the predecessor. A closed upper ' +
      'bound would make both rows match here, which is precisely the ambiguity the EXCLUDE ' +
      'constraint refuses to store.',
  },
  {
    name: 'instant of change — one millisecond earlier still belongs to the OLD row',
    rows: HISTORY,
    at: '2023-12-31T23:59:59.999Z',
    expectedId: 'p1',
    why: 'The other side of the same boundary. Without it, a rule that always preferred the later row would pass.',
  },
  {
    name: 'instant of change — one millisecond later is unambiguously the new row',
    rows: HISTORY,
    at: '2024-01-01T00:00:00.001Z',
    expectedId: 'p2',
    why: 'Brackets the boundary from both directions so an off-by-one cannot hide.',
  },

  /* ── first and last row ──────────────────────────────────────────────────── */
  {
    name: 'first row — the earliest window governs at its own start instant',
    rows: HISTORY,
    at: '2022-01-01T00:00:00.000Z',
    expectedId: 'p1',
    why: 'The first row is a boundary in its own right: nothing precedes it to fall back to.',
  },
  {
    name: 'last row — an open-ended window governs indefinitely',
    rows: HISTORY,
    at: '2099-06-01T00:00:00.000Z',
    expectedId: 'p3',
    why:
      'An open end is spelled NULL, never `infinity`. A rule that compared against a parsed ' +
      'upper bound without handling NULL would return nothing here.',
  },
  {
    name: 'before the first row — NOT the first row, and the reason says so',
    rows: HISTORY,
    at: '2021-06-01T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'before-first',
    why:
      'The S-01 shape, stated positively: a member had no profile before their first one was ' +
      'authored, and answering "the earliest row" would silently apply an arrangement that did ' +
      'not yet exist.',
  },

  /* ── future-dated rows present ───────────────────────────────────────────── */
  {
    name: 'future-dated row present — the row in force NOW still governs',
    rows: [
      row('current', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      row('future', '2027-01-01T00:00:00.000Z', null),
    ],
    at: '2026-08-03T00:00:00.000Z',
    expectedId: 'current',
    why:
      'Authoring a future-dated change must not alter the present verdict. A rule that took the ' +
      'latest-starting row — which is what "ORDER BY effective_from DESC LIMIT 1" does — returns ' +
      'the FUTURE row here and applies a change that has not happened yet.',
  },
  {
    name: 'future-dated row present — and it governs once its instant arrives',
    rows: [
      row('current', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      row('future', '2027-01-01T00:00:00.000Z', null),
    ],
    at: '2027-01-01T00:00:00.000Z',
    expectedId: 'future',
    why: 'The other direction, so a rule that simply ignored future rows is caught too.',
  },
  {
    name: 'only future rows exist — nothing is in force yet',
    rows: [row('f1', '2030-01-01T00:00:00.000Z', null), row('f2', '2028-01-01T00:00:00.000Z', '2029-01-01T00:00:00.000Z')],
    at: '2026-08-03T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'before-first',
    why: 'A membership whose only profile starts next year has no profile today.',
  },

  /* ── gaps ────────────────────────────────────────────────────────────────── */
  {
    name: 'gap between two closed windows — no row, and the reason is `gap`',
    rows: [
      row('a', '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z'),
      row('b', '2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    ],
    at: '2024-01-01T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'gap',
    why:
      'A member on unpaid leave has a genuine gap. Reporting "the most recent row" here would ' +
      'apply an arrangement that had ended — the S-01 defect exactly, one table over.',
  },
  {
    name: 'gap before an open-ended future row',
    rows: [
      row('a', '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z'),
      row('b', '2025-01-01T00:00:00.000Z', null),
    ],
    at: '2024-01-01T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'gap',
    why: 'A gap is a gap whether or not what follows it is open-ended.',
  },
  {
    name: 'after the last closed window — `after-last`, not `gap`',
    rows: [row('a', '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z')],
    at: '2024-01-01T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'after-last',
    why:
      'A membership that ended is a different fact from a membership with a hole in the middle. ' +
      'Collapsing the two is what makes an effective-dating defect unreadable from a log line.',
  },
  {
    name: 'the exact end instant of the only window is already outside it',
    rows: [row('a', '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z')],
    at: '2023-01-01T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'after-last',
    why: '[from, to) — the upper bound is exclusive, at the boundary as well as away from it.',
  },

  /* ── timezone-explicit instants ──────────────────────────────────────────── */
  {
    name: 'timezone-explicit instant — +02:00 resolves to the same instant as its UTC form',
    rows: HISTORY,
    at: '2024-01-01T02:00:00.000+02:00',
    expectedId: 'p2',
    why:
      'Identical instant to `2024-01-01T00:00:00Z`, written the way a European client writes it. ' +
      'A rule comparing strings rather than instants gets this wrong, and gets it wrong for a ' +
      'boundary — which is where the consequence is a whole wrong profile.',
  },
  {
    name: 'timezone-explicit instant — -05:00, one millisecond before a change, is still the old row',
    rows: HISTORY,
    at: '2023-12-31T18:59:59.999-05:00',
    expectedId: 'p1',
    why:
      'The same boundary from the other side of the world. Effective dating is exactly where ' +
      '"the 1st" means two different instants, so both forms are in the battery.',
  },

  /* ── no rows ─────────────────────────────────────────────────────────────── */
  {
    name: 'no rows at all',
    rows: [],
    at: '2026-08-03T00:00:00.000Z',
    expectedId: null,
    expectedReason: 'no-rows',
    why: 'A membership with no work profile authored. Distinct from every other "none" above.',
  },

  /* ── single row, both sides ──────────────────────────────────────────────── */
  {
    name: 'a single open-ended row governs from its start instant onward',
    rows: [row('only', '2026-01-01T00:00:00.000Z', null)],
    at: '2026-01-01T00:00:00.000Z',
    expectedId: 'only',
    why: 'The ordinary case, included so the battery has a green control it would be embarrassing to fail.',
  },
];
