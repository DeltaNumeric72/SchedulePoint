import {
  ACCEPTED_AS_INPUT_SUBTYPES,
  EXPIRY_SOURCE_STATUSES,
  INITIAL_REQUEST_STATUS_BY_SUBTYPE,
  REQUEST_OPERATIONS,
  REQUEST_STATUSES,
  REQUEST_STATUSES_BY_SUBTYPE,
  REQUEST_SUBTYPES,
  REQUEST_TRANSITIONS,
  REVIEWED_SUBTYPES,
  initialRequestStatus,
  isLegalInitialStatus,
  legalTransitionsFrom,
  operationIsLegal,
  operationStatusPath,
  operationVerdict,
  transitionIsLegal,
  withdrawalRequiresRevision,
  type RequestStatus,
  type RequestSubtype,
} from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-08 §2's matrices and §7's R-01, as PURE domain properties (OPUS-M5-001).
 *
 * ## What this file is and is not
 *
 * It is the DOMAIN half of R-01's double enforcement, checked against SPEC-08 §2
 * read as a document. It is **not** the agreement with the database — that is
 * `apps/api/test/requests/transition-matrix-agreement.test.ts`, which walks the
 * same cross-product against `app_request_transition_is_legal` and needs a
 * cluster to do it.
 *
 * The two are deliberately separate. A single test comparing the domain to the
 * database would go green if BOTH drifted from §2 in the same direction, which
 * is exactly what happens when somebody "fixes" one layer by copying the other.
 * So this file holds the matrix to the SPECIFICATION, cell by cell, from
 * SPEC-08 §2's printed table — and the agreement test holds the two
 * IMPLEMENTATIONS to each other.
 */

/** §2's table, transcribed independently from the specification. */
const SPEC_MATRIX: readonly {
  readonly from: RequestStatus;
  readonly to: RequestStatus;
  readonly subtypes: readonly RequestSubtype[];
}[] = [
  {
    from: 'draft',
    to: 'submitted',
    subtypes: [
      'availability',
      'time-off',
      'no-call',
      'shift-preference',
      'shift-group-off',
      'vacation-selection',
    ],
  },
  {
    from: 'submitted',
    to: 'under_review',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off', 'vacation-selection'],
  },
  { from: 'submitted', to: 'accepted_as_input', subtypes: ['availability', 'shift-preference'] },
  {
    from: 'under_review',
    to: 'approved',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off', 'vacation-selection'],
  },
  {
    from: 'under_review',
    to: 'denied',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off', 'vacation-selection'],
  },
  {
    from: 'submitted',
    to: 'withdrawn',
    subtypes: [
      'availability',
      'time-off',
      'no-call',
      'shift-preference',
      'shift-group-off',
      'vacation-selection',
    ],
  },
  {
    from: 'under_review',
    to: 'withdrawn',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off', 'vacation-selection'],
  },
  {
    from: 'approved',
    to: 'withdrawn',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off', 'vacation-selection'],
  },
  /* V-31. */
  { from: 'accepted_as_input', to: 'withdrawn', subtypes: ['availability', 'shift-preference'] },
  /* FAD-55, 2026-08-26 — §4's withdrawal-after-reflection row and R-10, added to
   * §2 by this packet's own dated amendment. Five subtypes; vacation's undo is
   * §5.6's `reflected_in_version → reversed`. */
  {
    from: 'reflected_in_version',
    to: 'withdrawn',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-preference', 'shift-group-off'],
  },
  {
    from: 'approved',
    to: 'consumed_by_build',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off'],
  },
  { from: 'accepted_as_input', to: 'consumed_by_build', subtypes: ['shift-preference'] },
  {
    from: 'consumed_by_build',
    to: 'reflected_in_version',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-preference', 'shift-group-off'],
  },
  { from: 'approved', to: 'reflected_in_version', subtypes: ['vacation-selection'] },
  { from: 'consumed_by_build', to: 'unsatisfied', subtypes: ['shift-preference'] },
  { from: 'reflected_in_version', to: 'reversed', subtypes: ['vacation-selection'] },
  {
    from: 'submitted',
    to: 'expired',
    subtypes: [
      'availability',
      'time-off',
      'no-call',
      'shift-preference',
      'shift-group-off',
      'vacation-selection',
    ],
  },
  {
    from: 'under_review',
    to: 'expired',
    subtypes: [
      'availability',
      'time-off',
      'no-call',
      'shift-preference',
      'shift-group-off',
      'vacation-selection',
    ],
  },
  {
    from: 'accepted_as_input',
    to: 'expired',
    subtypes: [
      'availability',
      'time-off',
      'no-call',
      'shift-preference',
      'shift-group-off',
      'vacation-selection',
    ],
  },
  {
    from: 'approved',
    to: 'superseded_by_revision',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off', 'vacation-selection'],
  },
];

const specEdges = new Set(
  SPEC_MATRIX.flatMap((edge) => edge.subtypes.map((s) => `${s}|${edge.from}|${edge.to}`)),
);

describe('SPEC-08 §2 — the transition matrices, cell by cell', () => {
  it('the FULL cross-product agrees with the specification, in both directions', () => {
    /* Every (subtype × from × to) triple, not a sample. 6 × 13 × 13 = 1 014
     * cells, of which the specification marks a small minority permitted — so a
     * matrix that accidentally permitted everything would fail on the first
     * unmarked cell, and one that permitted nothing would fail on the first
     * marked one. Both directions are asserted because only one of them catches
     * an over-permissive matrix, which is the dangerous direction. */
    const disagreements: string[] = [];
    let permitted = 0;
    let forbidden = 0;

    for (const subtype of REQUEST_SUBTYPES) {
      for (const from of REQUEST_STATUSES) {
        for (const to of REQUEST_STATUSES) {
          const expected = specEdges.has(`${subtype}|${from}|${to}`);
          const actual = transitionIsLegal(subtype, from, to);
          if (expected) permitted += 1;
          else forbidden += 1;
          if (expected !== actual) {
            disagreements.push(
              `${subtype}: ${from} → ${to} — specification says ${String(expected)}, matrix says ${String(actual)}`,
            );
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
    /* Non-vacuity: the loop actually visited both classes. A cross-product test
     * whose "expected" set was empty would pass by asserting nothing. */
    expect(permitted).toBeGreaterThan(0);
    expect(forbidden).toBeGreaterThan(0);
    expect(permitted + forbidden).toBe(
      REQUEST_SUBTYPES.length * REQUEST_STATUSES.length * REQUEST_STATUSES.length,
    );
  });

  it('has NO self-edges — §2 contains no cell whose ends are the same status', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      for (const status of REQUEST_STATUSES) {
        expect(transitionIsLegal(subtype, status, status), `${subtype}: ${status} → itself`).toBe(
          false,
        );
      }
    }
  });

  /**
   * §2 and D-20 are different claims, and where they do not line up the
   * EFFECTIVE rule is their intersection.
   *
   * ## A recorded observation, not a defect — and deliberately not "fixed"
   *
   * §2's `→ expired` row carries a ✓ in **every** subtype column, and names its
   * three sources once for all of them: `submitted`, `under_review`,
   * `accepted_as_input`. But those three are not in every subtype's D-20 domain.
   * `shift-preference` has no `under_review` (nobody reviews a non-binding
   * preference), and `time-off`, `no-call`, `shift-group-off` and
   * `vacation-selection` have no `accepted_as_input`. So a handful of §2 cells
   * name a source status their own subtype can never hold, and are therefore
   * unreachable.
   *
   * **This is the same class as the third SPEC-08 finding already on record from
   * M5-000b** — "§2's vacation domain admits `draft`/`under_review`/
   * `superseded_by_revision` which §5.3 never produces; the effective set is the
   * intersection" — and it is handled the same way: both layers stay implemented
   * LITERALLY, and the intersection is where the rule actually bites.
   *
   * Migration 0021's `app_request_transition_is_legal` spells the expiry clause
   * with no subtype restriction either, so the domain matrix and the database
   * agree cell for cell — which is the property the agreement test checks and
   * the reason this must not be "tidied" on one side. Narrowing the domain copy
   * to the intersection would make the two disagree and would be a one-layer
   * edit of exactly the kind FAD-55 exists to prevent.
   *
   * The unreachable set is ENUMERATED rather than merely tolerated, so that a
   * change to either §2 or D-20 shows up here as a failing list rather than
   * passing unnoticed.
   */
  it('the unreachable cells are exactly the known §2-vs-D-20 intersection gaps', () => {
    const unreachable: string[] = [];
    for (const edge of REQUEST_TRANSITIONS) {
      for (const subtype of edge.subtypes) {
        const domain = REQUEST_STATUSES_BY_SUBTYPE[subtype];
        if (!domain.includes(edge.from) || !domain.includes(edge.to)) {
          unreachable.push(`${subtype}: ${edge.from} → ${edge.to}`);
        }
      }
    }

    expect(unreachable.sort()).toEqual([
      'no-call: accepted_as_input → expired',
      'shift-group-off: accepted_as_input → expired',
      'shift-preference: under_review → expired',
      'time-off: accepted_as_input → expired',
      'vacation-selection: accepted_as_input → expired',
    ]);
  });

  it('every REACHABLE edge has both ends in its subtype\'s D-20 domain', () => {
    /* The positive half of the case above: outside the five enumerated gaps,
     * §2 and D-20 do not contradict each other. An edge into a status the domain
     * forbids would be refused by a CHECK rather than by the transition guard —
     * a refusal whose message described the wrong problem. */
    for (const edge of REQUEST_TRANSITIONS) {
      for (const subtype of edge.subtypes) {
        const domain = REQUEST_STATUSES_BY_SUBTYPE[subtype];
        if (!domain.includes(edge.from)) continue;
        expect(domain, `${subtype}: ${edge.to} is not in its own D-20 domain`).toContain(edge.to);
      }
    }
  });
});

describe('V-31 — `expired` has exactly three legal sources (R-23)', () => {
  it('the three, and no other status, reaches `expired` for ANY subtype', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      for (const from of REQUEST_STATUSES) {
        const expected = (EXPIRY_SOURCE_STATUSES as readonly string[]).includes(from);
        expect(transitionIsLegal(subtype, from, 'expired'), `${subtype}: ${from} → expired`).toBe(
          expected,
        );
      }
    }
  });

  it("R-23's two NAMED attempts are refused for every subtype", () => {
    /* SPEC-08 R-23: "Attempt `reflected_in_version → expired` and
     * `approved → expired` → Rejected." Named rather than derived from the loop
     * above, so the specific rows the specification calls out are visible in the
     * test report. */
    for (const subtype of REQUEST_SUBTYPES) {
      expect(transitionIsLegal(subtype, 'reflected_in_version', 'expired')).toBe(false);
      expect(transitionIsLegal(subtype, 'approved', 'expired')).toBe(false);
    }
  });
});

describe('the initial-INSERT status ruling (doc 42 §5c Part A)', () => {
  it('the five non-vacation subtypes are created at `draft`; vacation at `submitted`', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      expect(initialRequestStatus(subtype)).toBe(
        subtype === 'vacation-selection' ? 'submitted' : 'draft',
      );
    }
    expect(Object.keys(INITIAL_REQUEST_STATUS_BY_SUBTYPE).sort()).toEqual(
      [...REQUEST_SUBTYPES].sort(),
    );
  });

  it('EXACTLY ONE status per subtype is a legal creation status', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      const legal = REQUEST_STATUSES.filter((status) => isLegalInitialStatus(subtype, status));
      expect(legal, `${subtype} must have exactly one creation status`).toHaveLength(1);
      expect(legal[0]).toBe(initialRequestStatus(subtype));
    }
  });

  it('every initial status is in its subtype\'s own D-20 domain', () => {
    /* A creation status outside the domain would be a rule that refuses every
     * INSERT, and the failure would look like a transition problem. */
    for (const subtype of REQUEST_SUBTYPES) {
      expect(REQUEST_STATUSES_BY_SUBTYPE[subtype]).toContain(initialRequestStatus(subtype));
    }
  });
});

describe('the subtype groupings §2 uses', () => {
  it('`REVIEWED_SUBTYPES` is every subtype except shift-preference', () => {
    /* Derived assertion rather than a second literal list: the property is
     * "shift-preference is the one that is never reviewed", and a test that
     * restated the list would go green if both lists changed together. */
    expect([...REVIEWED_SUBTYPES].sort()).toEqual(
      REQUEST_SUBTYPES.filter((s) => s !== 'shift-preference').sort(),
    );
    for (const subtype of REQUEST_SUBTYPES) {
      const reviewable = transitionIsLegal(subtype, 'submitted', 'under_review');
      expect(reviewable).toBe(subtype !== 'shift-preference');
    }
  });

  it('R-03: `shift-preference` can never reach `approved`, by any edge', () => {
    for (const from of REQUEST_STATUSES) {
      expect(transitionIsLegal('shift-preference', from, 'approved')).toBe(false);
      expect(transitionIsLegal('shift-preference', from, 'denied')).toBe(false);
    }
    /* …and D-20 refuses the VALUE as well, which is what makes an INSERT
     * refusable when there is no edge to refuse. */
    expect(REQUEST_STATUSES_BY_SUBTYPE['shift-preference']).not.toContain('approved');
  });

  it('`accepted_as_input` belongs to availability and shift-preference alone', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      const expected = (ACCEPTED_AS_INPUT_SUBTYPES as readonly string[]).includes(subtype);
      expect(transitionIsLegal(subtype, 'submitted', 'accepted_as_input')).toBe(expected);
    }
  });

  it('`unsatisfied` is shift-preference\'s alone and `reversed` is vacation\'s alone', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      const toUnsatisfied = REQUEST_STATUSES.some((from) =>
        transitionIsLegal(subtype, from, 'unsatisfied'),
      );
      const toReversed = REQUEST_STATUSES.some((from) =>
        transitionIsLegal(subtype, from, 'reversed'),
      );
      expect(toUnsatisfied).toBe(subtype === 'shift-preference');
      expect(toReversed).toBe(subtype === 'vacation-selection');
    }
  });
});

describe('R-01 — the (subtype × status × operation) cross-product', () => {
  it('every cell has a verdict, and a permitted cell names a target status', () => {
    let allowed = 0;
    let refused = 0;

    for (const subtype of REQUEST_SUBTYPES) {
      for (const status of REQUEST_STATUSES) {
        for (const operation of REQUEST_OPERATIONS) {
          const verdict = operationVerdict(subtype, status, operation);
          if (verdict.allowed) {
            allowed += 1;
            /* A permitted operation must land somewhere §2 actually permits —
             * so the operation layer cannot invent an edge the matrix lacks.
             *
             * ── OPUS-M5-002: this assertion was `transitionIsLegal(subtype,
             * status, verdict.to)`, a ONE-EDGE check, and it is replaced by a
             * PATH check. The replacement is strictly stronger, and the reason it
             * is needed is M5-000b finding #1.
             *
             * Until this packet every operation was one edge, so the endpoint and
             * the edge were the same question. §4's decision is TWO: §2 carries no
             * `submitted → approved` cell for any subtype, so an approval from
             * `submitted` walks `submitted → under_review → approved` inside one
             * transaction. Against the old assertion a CORRECT implementation
             * fails, because the endpoint is genuinely not one edge away.
             *
             * The new assertion keeps the old one's meaning and adds to it: every
             * HOP must be in §2 (so no edge can be invented, exactly as before)
             * AND the walk must end at the verdict's target (so no intermediate
             * can be invented either, which the one-edge check never asked). */
            const path = operationStatusPath(subtype, status, operation);
            expect(path, `${subtype}/${status}/${operation} has no §2 path`).not.toBeNull();
            let cursor = status;
            for (const hop of path ?? []) {
              expect(
                transitionIsLegal(subtype, cursor, hop),
                `${subtype}/${status}/${operation}: ${cursor} → ${hop} is not in §2`,
              ).toBe(true);
              cursor = hop;
            }
            expect(cursor, `${subtype}/${status}/${operation} must END at its target`).toBe(
              verdict.to,
            );
          } else {
            refused += 1;
            expect(verdict.reason).toBeTruthy();
          }
          expect(operationIsLegal(subtype, status, operation)).toBe(verdict.allowed);
        }
      }
    }

    expect(allowed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(allowed + refused).toBe(
      REQUEST_SUBTYPES.length * REQUEST_STATUSES.length * REQUEST_OPERATIONS.length,
    );
  });

  it('a status outside the subtype\'s D-20 domain is refused as such, not as a bad edge', () => {
    /* The refusal must describe the right problem: a caller holding a status the
     * subtype can never hold is holding a row that cannot exist. */
    const verdict = operationVerdict('time-off', 'unsatisfied', 'withdraw');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('status-not-in-subtype-domain');
  });

  it('`submit` is legal from `draft` alone, and never for vacation', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      for (const status of REQUEST_STATUSES_BY_SUBTYPE[subtype]) {
        const expected = subtype !== 'vacation-selection' && status === 'draft';
        expect(
          operationIsLegal(subtype, status, 'submit'),
          `${subtype}/${status}/submit`,
        ).toBe(expected);
      }
    }
    /* Vacation's root is CREATED at `submitted`, so there is no existing root to
     * submit — the operation does not exist for it rather than being refused
     * from a particular status. */
    const verdict = operationVerdict('vacation-selection', 'draft', 'submit');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe('operation-not-available-for-subtype');
  });
});

describe('R-22 — withdrawal boundaries', () => {
  it('succeeds from submitted / under_review / approved / accepted_as_input', () => {
    /* Per subtype: each of the four only where §2's column carries it. */
    expect(operationIsLegal('time-off', 'submitted', 'withdraw')).toBe(true);
    expect(operationIsLegal('time-off', 'under_review', 'withdraw')).toBe(true);
    expect(operationIsLegal('time-off', 'approved', 'withdraw')).toBe(true);
    expect(operationIsLegal('shift-preference', 'accepted_as_input', 'withdraw')).toBe(true);
    expect(operationIsLegal('availability', 'accepted_as_input', 'withdraw')).toBe(true);
  });

  it('is REFUSED after `consumed_by_build`, for every subtype', () => {
    /* R-22's named boundary. A build has taken the request as input; pulling it
     * out from under the run is not a withdrawal. */
    for (const subtype of REQUEST_SUBTYPES) {
      expect(
        operationIsLegal(subtype, 'consumed_by_build', 'withdraw'),
        `${subtype}: consumed_by_build → withdrawn must be refused`,
      ).toBe(false);
    }
  });

  it("R-22's shift-preference pair, exactly as §7 states it", () => {
    /* "Shift-preference withdrawn while `accepted_as_input`, and again after
     * `consumed_by_build` → Withdrawal succeeds before consumption, is rejected
     * after it." */
    expect(operationIsLegal('shift-preference', 'accepted_as_input', 'withdraw')).toBe(true);
    expect(operationIsLegal('shift-preference', 'consumed_by_build', 'withdraw')).toBe(false);
  });
});

describe('R-10 / FAD-55 — withdrawal after `reflected_in_version`', () => {
  it('succeeds for the five non-vacation subtypes', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      const expected = subtype !== 'vacation-selection';
      expect(
        operationIsLegal(subtype, 'reflected_in_version', 'withdraw'),
        `${subtype}: reflected_in_version → withdrawn`,
      ).toBe(expected);
    }
  });

  it('vacation uses §5.6 REVERSAL instead, and has both spellings only once', () => {
    expect(operationIsLegal('vacation-selection', 'reflected_in_version', 'withdraw')).toBe(false);
    /* Its undo exists — as `reversed`, which §2 already carried. The point is
     * that there is exactly ONE spelling, not none. */
    expect(transitionIsLegal('vacation-selection', 'reflected_in_version', 'reversed')).toBe(true);
  });

  it('the revision flag is true for exactly ONE source status', () => {
    const sources = REQUEST_STATUSES.filter((status) => withdrawalRequiresRevision(status));
    expect(sources).toEqual(['reflected_in_version']);
  });

  it('a withdrawal from `approved` requires NO revision — nothing was published yet', () => {
    expect(withdrawalRequiresRevision('approved')).toBe(false);
    expect(withdrawalRequiresRevision('submitted')).toBe(false);
    expect(withdrawalRequiresRevision('accepted_as_input')).toBe(false);
  });
});

describe('`legalTransitionsFrom` reports §2 rather than a second copy of it', () => {
  it('agrees with the predicate for every (subtype × status)', () => {
    for (const subtype of REQUEST_SUBTYPES) {
      for (const from of REQUEST_STATUSES) {
        const reported = new Set(legalTransitionsFrom(subtype, from));
        for (const to of REQUEST_STATUSES) {
          expect(reported.has(to), `${subtype}: ${from} → ${to}`).toBe(
            transitionIsLegal(subtype, from, to),
          );
        }
      }
    }
  });
});
