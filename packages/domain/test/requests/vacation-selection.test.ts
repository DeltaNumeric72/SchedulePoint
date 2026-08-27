import {
  VACATION_SELECTION_OPERATIONS,
  VACATION_SELECTION_STATUSES,
  VACATION_SELECTION_TRANSITIONS,
  VACATION_STATUS_TO_REQUEST_STATUS,
  compareSelectionsForDisplay,
  derivedRequestStatus,
  grantVariance,
  orderSelectionsForDisplay,
  selectionEdgeRootPath,
  selectionOperationIsLegal,
  selectionOperationVerdict,
  selectionStatusForRootStatus,
  selectionTransitionIsLegal,
  transitionIsLegal,
  vacationStatusPairAgrees,
  type RequestStatus,
  type SelectionOrderKey,
  type VacationSelectionStatus,
} from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-08 §5.3's selection lifecycle, R-15's mapping in both directions, and the
 * ORDERING matrix — as PURE domain properties (OPUS-M5-003, doc 42 §5f).
 *
 * ## What this file is and is not
 *
 * It holds the domain to SPEC-08 read as a DOCUMENT, from an independently
 * transcribed table. It is **not** the agreement with the database — that is
 * `apps/api/test/requests/vacation-status-mapping-agreement.test.ts`, which needs
 * a cluster to compare `app_vacation_derived_request_status` to the constant
 * here.
 *
 * The two are deliberately separate, for the reason
 * `packages/domain/test/requests/transitions.test.ts` gives about its own pair: a
 * single test comparing the domain to the database would go green if BOTH
 * drifted from the specification in the same direction, which is what happens
 * when somebody "fixes" one layer by copying the other.
 */

/** §5.3's lifecycle, transcribed independently from the specification. */
const SPEC_SELECTION_EDGES: readonly { from: VacationSelectionStatus; to: VacationSelectionStatus }[] =
  [
    /* §5.3: "`available → pending → approved → committed`". */
    { from: 'available', to: 'pending' },
    { from: 'pending', to: 'approved' },
    { from: 'approved', to: 'committed' },
    /* §5.3: "with `denied`, `withdrawn`, and `expired` terminals". A decision or
     * a withdrawal or an expiry acts on a selection awaiting one. */
    { from: 'pending', to: 'denied' },
    { from: 'pending', to: 'withdrawn' },
    { from: 'pending', to: 'expired' },
    /* doc 09 §2.2's diagram: "approved --> withdrawn: withdrawn before commit",
     * and §2's vacation column carries the root edge `approved → withdrawn`. */
    { from: 'approved', to: 'withdrawn' },
    /* §5.6: "Reversal (`committed → reversed`)". */
    { from: 'committed', to: 'reversed' },
  ];

describe('§5.3 — the selection lifecycle matrix', () => {
  it('carries exactly the edges the specification states, and no others', () => {
    const spec = new Set(SPEC_SELECTION_EDGES.map((edge) => `${edge.from}|${edge.to}`));
    const implemented = new Set(
      VACATION_SELECTION_TRANSITIONS.map((edge) => `${edge.from}|${edge.to}`),
    );
    expect([...implemented].sort()).toEqual([...spec].sort());
  });

  it('every (from × to) pair gets the same verdict from the predicate as from the table', () => {
    let legal = 0;
    let illegal = 0;
    for (const from of VACATION_SELECTION_STATUSES) {
      for (const to of VACATION_SELECTION_STATUSES) {
        const expected = SPEC_SELECTION_EDGES.some(
          (edge) => edge.from === from && edge.to === to,
        );
        expect(selectionTransitionIsLegal(from, to), `${from} → ${to}`).toBe(expected);
        if (expected) legal += 1;
        else illegal += 1;
      }
    }
    /* Non-vacuity in both directions: a matrix that permitted everything, or
     * nothing, would agree with a transcription that did the same. */
    expect(legal).toBe(SPEC_SELECTION_EDGES.length);
    expect(illegal).toBeGreaterThan(0);
  });

  it('a terminal status has no outgoing edge at all', () => {
    for (const terminal of ['denied', 'withdrawn', 'expired', 'reversed'] as const) {
      const outgoing = VACATION_SELECTION_STATUSES.filter((to) =>
        selectionTransitionIsLegal(terminal, to),
      );
      expect(outgoing, `${terminal} must be terminal`).toEqual([]);
    }
  });

  it('nothing re-enters `available` — a selection becomes a request once', () => {
    for (const from of VACATION_SELECTION_STATUSES) {
      expect(selectionTransitionIsLegal(from, 'available'), `${from} → available`).toBe(false);
    }
  });
});

describe('§5.3 relates to §2 by a PATH, not by a cell', () => {
  it('every selection edge but the creation walks a real §2 path in the vacation column', () => {
    for (const edge of VACATION_SELECTION_TRANSITIONS) {
      const path = selectionEdgeRootPath(edge.from, edge.to);
      expect(path, `${edge.from} → ${edge.to} has no §2 path`).not.toBeNull();

      if (edge.from === 'available') {
        /* The creation edge. §5.3's `available` has NO root row, so what this
         * edge produces is the root's creation rather than a transition — an
         * empty path, and the emptiness is the instruction. */
        expect(path).toEqual([]);
        continue;
      }

      let cursor = VACATION_STATUS_TO_REQUEST_STATUS[edge.from] as RequestStatus;
      for (const hop of path ?? []) {
        expect(
          transitionIsLegal('vacation-selection', cursor, hop),
          `${edge.from} → ${edge.to}: ${cursor} → ${hop} is not in §2`,
        ).toBe(true);
        cursor = hop;
      }
      expect(cursor, `${edge.from} → ${edge.to} must END at its mapped root status`).toBe(
        VACATION_STATUS_TO_REQUEST_STATUS[edge.to],
      );
    }
  });

  it('the two DECISION edges take the BINDING two-step; the others take one hop', () => {
    /* M5-000b finding #1: §2 has no `submitted → approved` cell for any subtype,
     * so a decision walks `submitted → under_review → approved` inside one
     * transaction. A withdrawal is not a decision and needs no intermediate. */
    expect(selectionEdgeRootPath('pending', 'approved')).toEqual(['under_review', 'approved']);
    expect(selectionEdgeRootPath('pending', 'denied')).toEqual(['under_review', 'denied']);
    expect(selectionEdgeRootPath('pending', 'withdrawn')).toEqual(['withdrawn']);
    expect(selectionEdgeRootPath('approved', 'withdrawn')).toEqual(['withdrawn']);
    expect(selectionEdgeRootPath('approved', 'committed')).toEqual(['reflected_in_version']);
    expect(selectionEdgeRootPath('committed', 'reversed')).toEqual(['reversed']);
  });

  it('an illegal selection edge has no path, whatever §2 would allow', () => {
    expect(selectionEdgeRootPath('withdrawn', 'pending')).toBeNull();
    expect(selectionEdgeRootPath('denied', 'approved')).toBeNull();
    expect(selectionEdgeRootPath('available', 'approved')).toBeNull();
  });
});

describe('the member operations this packet implements', () => {
  it('`submit` is legal from `available` and from nowhere else', () => {
    for (const status of VACATION_SELECTION_STATUSES) {
      expect(selectionOperationIsLegal(status, 'submit'), `${status}`).toBe(
        status === 'available',
      );
    }
  });

  it('`withdraw` is legal from `pending` and from `approved`, and nowhere else', () => {
    for (const status of VACATION_SELECTION_STATUSES) {
      expect(selectionOperationIsLegal(status, 'withdraw'), `${status}`).toBe(
        status === 'pending' || status === 'approved',
      );
    }
  });

  it('a committed week is NOT withdrawn — its undo is §5.6 reversal', () => {
    /* Two spellings for one act would leave §5.3's mapping unable to say which
     * one a terminal selection meant. The reversal edge exists and the
     * withdrawal edge does not. */
    expect(selectionOperationIsLegal('committed', 'withdraw')).toBe(false);
    expect(selectionTransitionIsLegal('committed', 'reversed')).toBe(true);
  });

  it('every refusal carries a reason a caller can branch on', () => {
    let refused = 0;
    for (const status of VACATION_SELECTION_STATUSES) {
      for (const operation of VACATION_SELECTION_OPERATIONS) {
        const verdict = selectionOperationVerdict(status, operation);
        if (verdict.allowed) {
          expect(selectionTransitionIsLegal(status, verdict.to)).toBe(true);
        } else {
          refused += 1;
          expect(verdict.reason).toBeTruthy();
        }
      }
    }
    expect(refused, 'the cross-product must refuse SOMETHING').toBeGreaterThan(0);
  });
});

describe('R-15 — the §5.3 mapping, in both directions', () => {
  it('the forward table is exactly SPEC-08 §5.3, row for row', () => {
    /* Transcribed from the specification's own table rather than read off the
     * constant, so a change to the constant fails here rather than agreeing with
     * itself. */
    expect(VACATION_STATUS_TO_REQUEST_STATUS).toEqual({
      available: null,
      pending: 'submitted',
      approved: 'approved',
      committed: 'reflected_in_version',
      denied: 'denied',
      withdrawn: 'withdrawn',
      expired: 'expired',
      reversed: 'reversed',
    });
  });

  it('the forward table is INJECTIVE, which is what makes the inverse a function', () => {
    const roots = VACATION_SELECTION_STATUSES.map((status) =>
      VACATION_STATUS_TO_REQUEST_STATUS[status],
    ).filter((root): root is RequestStatus => root !== null);
    expect(new Set(roots).size, 'two selection statuses map to one root status').toBe(roots.length);
  });

  it('inverse ∘ forward is the identity on every status that has a root', () => {
    for (const status of VACATION_SELECTION_STATUSES) {
      const root = derivedRequestStatus(status);
      if (root === null) {
        /* `available` — §5.3's "*no request row yet*". There is nothing to
         * invert, and inventing a root for it is the thing the null forbids. */
        expect(status).toBe('available');
        continue;
      }
      expect(selectionStatusForRootStatus(root), `${status} → ${root} → ?`).toBe(status);
    }
  });

  it('the three root statuses §5.3 produces from NOTHING invert to null', () => {
    /* Migration 0022's header §2 records the declared tension: D-20 admits
     * `draft`, `under_review` and `superseded_by_revision` for the vacation
     * column, and D-27 refuses the row. A display that invented a label for one
     * of them would be rendering a state the database says cannot exist. */
    for (const root of ['draft', 'under_review', 'superseded_by_revision'] as const) {
      expect(selectionStatusForRootStatus(root), root).toBeNull();
    }
  });

  it('the pair predicate accepts exactly the mapped pairs and refuses every other', () => {
    let agreed = 0;
    let disagreed = 0;
    const roots: readonly (RequestStatus | null)[] = [
      null,
      'draft',
      'submitted',
      'under_review',
      'approved',
      'denied',
      'withdrawn',
      'reflected_in_version',
      'reversed',
      'expired',
      'superseded_by_revision',
    ];
    for (const status of VACATION_SELECTION_STATUSES) {
      for (const root of roots) {
        const expected = VACATION_STATUS_TO_REQUEST_STATUS[status] === root;
        expect(vacationStatusPairAgrees(status, root), `${status} / ${String(root)}`).toBe(
          expected,
        );
        if (expected) agreed += 1;
        else disagreed += 1;
      }
    }
    /* Non-vacuity: exactly one root per selection status agrees, and the rest do
     * not. A predicate that returned `true` always would fail the second count. */
    expect(agreed).toBe(VACATION_SELECTION_STATUSES.length);
    expect(disagreed).toBeGreaterThan(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The ORDERING MATRIX — doc 42 §5f's forward obligation from M5-001
 *
 * "the ordering the selection list presents … is written as a matrix test, not
 * left to the query's accident."
 *
 * Each case isolates ONE level: the two rows differ on that level and are EQUAL
 * on every level above it, so a comparator that ignored the level under test
 * would return 0 and the case would fail. That is the positive control per level.
 * ──────────────────────────────────────────────────────────────────────────── */

const AT = (iso: string): Date => new Date(iso);

const ORDERING_MATRIX: readonly {
  readonly level: 'week' | 'submitted' | 'id';
  readonly why: string;
  readonly first: SelectionOrderKey;
  readonly second: SelectionOrderKey;
}[] = [
  {
    level: 'week',
    why: 'the earlier WEEK leads, whatever the submission instants say',
    /* The later week was submitted FIRST, so a comparator that led with the
     * instant would order these the other way round. */
    first: { weekStart: '2049-06-07', submittedAt: AT('2049-05-02T00:00:00Z'), id: 'b' },
    second: { weekStart: '2049-06-14', submittedAt: AT('2049-05-01T00:00:00Z'), id: 'a' },
  },
  {
    level: 'submitted',
    why: 'within one week the EARLIER claim leads',
    /* Same week; the earlier instant has the LATER id, so an id-only comparator
     * would order these the other way round. */
    first: { weekStart: '2049-06-07', submittedAt: AT('2049-05-01T00:00:00Z'), id: 'b' },
    second: { weekStart: '2049-06-07', submittedAt: AT('2049-05-02T00:00:00Z'), id: 'a' },
  },
  {
    level: 'submitted',
    why: 'an UNSUBMITTED selection sorts after every claim in its week (nulls last)',
    first: { weekStart: '2049-06-07', submittedAt: AT('2049-05-02T00:00:00Z'), id: 'a' },
    second: { weekStart: '2049-06-07', submittedAt: null, id: 'b' },
  },
  {
    level: 'id',
    why: 'equal on both earlier levels, the stable id makes the order TOTAL',
    first: { weekStart: '2049-06-07', submittedAt: AT('2049-05-01T00:00:00Z'), id: 'aaa' },
    second: { weekStart: '2049-06-07', submittedAt: AT('2049-05-01T00:00:00Z'), id: 'bbb' },
  },
];

describe('the selection ORDERING matrix', () => {
  it.each(ORDERING_MATRIX)('$level: $why', ({ first, second }) => {
    expect(compareSelectionsForDisplay(first, second)).toBeLessThan(0);
    /* Antisymmetry, per case. A comparator that returned a negative number both
     * ways would satisfy the line above and produce a different list on every
     * sort. */
    expect(compareSelectionsForDisplay(second, first)).toBeGreaterThan(0);
  });

  it('is reflexive: a row compared with itself is equal', () => {
    for (const row of ORDERING_MATRIX) {
      expect(compareSelectionsForDisplay(row.first, row.first)).toBe(0);
    }
  });

  it('orders a whole list, and does not mutate the input', () => {
    const input: readonly SelectionOrderKey[] = [
      { weekStart: '2049-06-14', submittedAt: AT('2049-05-01T00:00:00Z'), id: 'c' },
      { weekStart: '2049-06-07', submittedAt: null, id: 'd' },
      { weekStart: '2049-06-07', submittedAt: AT('2049-05-03T00:00:00Z'), id: 'b' },
      { weekStart: '2049-06-07', submittedAt: AT('2049-05-02T00:00:00Z'), id: 'a' },
    ];
    const before = input.map((row) => row.id);

    expect(orderSelectionsForDisplay(input).map((row) => row.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(input.map((row) => row.id), 'the input list must not be re-ordered in place').toEqual(
      before,
    );
  });
});

describe('§5.5 — the advisory variance indicator', () => {
  it('is `within` while the entitlement covers what is consumed', () => {
    expect(grantVariance({ unitsTotal: 3, unitsConsumed: 1, overrideUnits: 0 })).toMatchObject({
      bound: 3,
      remaining: 2,
      overEntitlement: 0,
      state: 'within',
    });
  });

  it('is `at-entitlement` when the last unit is gone — its own value, not `within`', () => {
    expect(grantVariance({ unitsTotal: 2, unitsConsumed: 2, overrideUnits: 0 })).toMatchObject({
      remaining: 0,
      overEntitlement: 0,
      state: 'at-entitlement',
    });
  });

  it('measures the overage against the ENTITLEMENT, not against the raised bound', () => {
    /* V-28: an audited override RAISES the bound so the unconditional CHECK still
     * holds. A variance display measured against the raised bound would show
     * every override as "within", hiding the one event it exists to surface. */
    const variance = grantVariance({ unitsTotal: 1, unitsConsumed: 2, overrideUnits: 1 });
    expect(variance.bound, 'the bound rose with the override').toBe(2);
    expect(variance.overEntitlement, 'and the overage is measured against the entitlement').toBe(1);
    expect(variance.state).toBe('over-entitlement');
    expect(variance.remaining).toBe(0);
  });

  it('never reports a negative balance', () => {
    /* D-21's floor is the database's and is unconditional; a display that
     * printed "-1 left" would be describing a row that cannot exist. */
    expect(grantVariance({ unitsTotal: 0, unitsConsumed: 0, overrideUnits: 0 }).remaining).toBe(0);
    expect(grantVariance({ unitsTotal: 1, unitsConsumed: 3, overrideUnits: 2 }).remaining).toBe(0);
  });
});
