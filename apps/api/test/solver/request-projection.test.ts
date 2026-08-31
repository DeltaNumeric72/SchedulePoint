import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SolveRequestSpec } from '@schedulepoint/domain';

import { OBJECTIVE_PROFILE_DIGEST } from '../../src/solver/objective-record.js';
import { buildRequestProjection } from '../../src/solver/request-projection.js';
import { canonicalInputHash } from '../../src/solver/snapshot-store.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { DETERMINISTIC_PARAMETERS, SOLVED_STATUSES, applySolverEnv } from '../support/solver.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **SPEC-08 §6's projection — the assembly's rules, and R-14's BEHAVIOURAL half**
 * (OPUS-M5-004, doc 42 §5h).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Three questions, three files
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain/test/requests/solver-projection.test.ts` asks WHICH
 * *(subtype, status)* pairs project — §6's table and its exhaustive exclusion
 * list, checkable against the document without a database.
 *
 * This file asks the two questions that one cannot:
 *
 *  1. **Does the assembly EXPAND and WINDOW correctly** — a time-off range into
 *     one row per date, a committed vacation week into its five working days
 *     through the same `vacationWeekDates` the commit uses, everything outside
 *     the snapshot's window dropped, everything deduplicated and sorted because
 *     `input_hash` covers the document.
 *  2. **Does a `HardOff` row actually STOP the solver** — R-14's required
 *     outcome is behavioural: *"the rebuild cannot schedule the person on their
 *     approved day off"*. A projection row nothing reads cannot produce that, so
 *     this is proven against the REAL worker subprocess rather than against a
 *     stub, with a control that would catch the model ignoring the field.
 *
 * `apps/api/test/requests/vacation-commit-http.test.ts` asks the third: does the
 * commit that produces the vacation half of `HardOff` work at all.
 *
 * ## Synthetic only
 *
 * Every id is minted here and every date is 2027's. No name of any kind.
 */

const MEMBER_A = '11111111-1111-4111-8111-111111111111';
const MEMBER_B = '22222222-2222-4222-8222-222222222222';
const SHIFT_TYPE = '33333333-3333-4333-8333-333333333333';
const SHIFT_GROUP = '44444444-4444-4444-8444-444444444444';

const WINDOW = { startDate: '2027-03-01', endDate: '2027-03-07' } as const;

const EMPTY = {
  timeOff: [],
  noCall: [],
  availability: [],
  shiftPreference: [],
  shiftGroupOff: [],
  committedVacation: [],
} as const;

describe('SPEC-08 §6 — the projection assembly', () => {
  it('expands a time-off RANGE into one row per date, and clips to the window', () => {
    /* D-19's `(range_start, range_end)` half. The range deliberately starts
     * BEFORE the window and ends inside it, so both halves of the clip are
     * exercised by one row: a projection that carried the whole range would
     * enlarge the hash with dates the model has no variables on. */
    const projection = buildRequestProjection(
      {
        ...EMPTY,
        timeOff: [
          { membershipId: MEMBER_A, targetDate: null, rangeStart: '2027-02-26', rangeEnd: '2027-03-03' },
        ],
      },
      { ...WINDOW, availabilityIsBinding: false },
    );
    expect(projection.hardOff.map((row) => row.date)).toEqual([
      '2027-03-01',
      '2027-03-02',
      '2027-03-03',
    ]);
  });

  it('expands a committed vacation WEEK into Monday..Friday — the commit\'s own five', () => {
    /* `vacationWeekDates` has two readers and this is the second one. 2027-03-01
     * is a Monday, so the five are the 1st to the 5th and the weekend is
     * deliberately absent — a `HardOff` row for a day with no shifts constrains
     * nothing while implying the product has an opinion about somebody's
     * Saturday. */
    const projection = buildRequestProjection(
      { ...EMPTY, committedVacation: [{ membershipId: MEMBER_B, weekStart: '2027-03-01' }] },
      { ...WINDOW, availabilityIsBinding: false },
    );
    expect(projection.hardOff).toEqual([
      { membershipId: MEMBER_B, date: '2027-03-01' },
      { membershipId: MEMBER_B, date: '2027-03-02' },
      { membershipId: MEMBER_B, date: '2027-03-03' },
      { membershipId: MEMBER_B, date: '2027-03-04' },
      { membershipId: MEMBER_B, date: '2027-03-05' },
    ]);
  });

  it('DEDUPLICATES and SORTS — two sources naming one day produce one row', () => {
    /* A time-off request and a committed vacation week can name the same day for
     * the same person, and §6 has one `HardOff` row for a (membership, date).
     * The order is fixed too, because `input_hash` covers the whole document and
     * two assemblies of one world that differed only in row order would be two
     * different problems by the hash's account. */
    const projection = buildRequestProjection(
      {
        ...EMPTY,
        noCall: [{ membershipId: MEMBER_B, targetDate: '2027-03-02' }],
        timeOff: [
          { membershipId: MEMBER_B, targetDate: '2027-03-02', rangeStart: null, rangeEnd: null },
        ],
        committedVacation: [{ membershipId: MEMBER_A, weekStart: '2027-03-01' }],
      },
      { ...WINDOW, availabilityIsBinding: false },
    );
    const keys = projection.hardOff.map((row) => `${row.membershipId}|${row.date}`);
    expect(new Set(keys).size, 'no duplicate (membership, date)').toBe(keys.length);
    expect([...keys], 'sorted, so the hash is stable').toEqual([...keys].sort());
  });

  it('§6\'s `HardOn` qualifier: BOTH branches of "where group policy makes it binding"', () => {
    /* The gate is total and both branches are exercised, which is what keeps the
     * rule shipped even though its configured source does not exist yet (see
     * `request-projection.ts`'s docblock — no group column says whether an
     * approved availability BINDS). An availability the policy does not make
     * binding is ABSENT from the projection, not a softer row: §6 has no third
     * kind for it. */
    const sources = {
      ...EMPTY,
      availability: [{ membershipId: MEMBER_A, targetDate: '2027-03-04' }],
    };
    expect(
      buildRequestProjection(sources, { ...WINDOW, availabilityIsBinding: false }).hardOn,
    ).toEqual([]);
    expect(
      buildRequestProjection(sources, { ...WINDOW, availabilityIsBinding: true }).hardOn,
    ).toEqual([{ membershipId: MEMBER_A, date: '2027-03-04' }]);
  });

  it('FAD-60 — the strength travels VERBATIM, and the strongest wins a collision', () => {
    /* Two requests can name one (person, date, shift type) — one
     * `accepted_as_input`, an older one `reflected_in_version`. §6 has ONE
     * `SoftPreference` row for that cell, so the stronger is kept: dropping one
     * by read order would make the projection order-dependent, and keeping both
     * would put two weights on one cell, which is not a shape §6 has. */
    const projection = buildRequestProjection(
      {
        ...EMPTY,
        shiftPreference: [
          { membershipId: MEMBER_A, targetDate: '2027-03-03', shiftTypeId: SHIFT_TYPE, strength: 'low' },
          { membershipId: MEMBER_A, targetDate: '2027-03-03', shiftTypeId: SHIFT_TYPE, strength: 'high' },
        ],
      },
      { ...WINDOW, availabilityIsBinding: false },
    );
    expect(projection.softPreference).toEqual([
      { membershipId: MEMBER_A, date: '2027-03-03', shiftTypeId: SHIFT_TYPE, strength: 'high' },
    ]);
  });

  it('I-07 — the emitted rows carry ONLY ids and dates: no status, no subtype, no text', () => {
    /* The M5-00C payload-keys pattern, applied to the projection. §6's own design
     * is that "a status whose meaning is subtype-dependent cannot leak into the
     * model"; this asserts the emitted OBJECT KEYS rather than trusting the type,
     * because a type is erased and a document that has been through `jsonb` and a
     * Python worker is not a type.
     *
     * A non-vacuity control first: every array is non-empty, so the key
     * assertions below are about rows rather than about nothing. */
    const projection = buildRequestProjection(
      {
        ...EMPTY,
        timeOff: [
          { membershipId: MEMBER_A, targetDate: '2027-03-02', rangeStart: null, rangeEnd: null },
        ],
        availability: [{ membershipId: MEMBER_B, targetDate: '2027-03-02' }],
        shiftPreference: [
          {
            membershipId: MEMBER_A,
            targetDate: '2027-03-03',
            shiftTypeId: SHIFT_TYPE,
            strength: 'medium',
          },
        ],
        shiftGroupOff: [
          { membershipId: MEMBER_B, targetDate: '2027-03-04', shiftGroupId: SHIFT_GROUP },
        ],
      },
      { ...WINDOW, availabilityIsBinding: true },
    );

    expect(projection.hardOff.length).toBeGreaterThan(0);
    expect(projection.hardOn.length).toBeGreaterThan(0);
    expect(projection.softPreference.length).toBeGreaterThan(0);
    expect(projection.shiftGroupOff.length).toBeGreaterThan(0);

    for (const row of projection.hardOff) {
      expect(Object.keys(row).sort()).toEqual(['date', 'membershipId']);
    }
    for (const row of projection.hardOn) {
      expect(Object.keys(row).sort()).toEqual(['date', 'membershipId']);
    }
    for (const row of projection.softPreference) {
      expect(Object.keys(row).sort()).toEqual([
        'date',
        'membershipId',
        'shiftTypeId',
        'strength',
      ]);
    }
    for (const row of projection.shiftGroupOff) {
      expect(Object.keys(row).sort()).toEqual(['date', 'membershipId', 'shiftGroupId']);
    }

    /* And the whole document's projection carries no `status`, `subtype`,
     * `reason`, `reasonCode` or `overrideReason` anywhere — asserted over the
     * serialized bytes, which is what actually crosses to the worker. */
    const serialized = JSON.stringify(projection);
    for (const forbidden of ['status', 'subtype', 'reason', 'reasonCode', 'overrideReason']) {
      expect(serialized, `the projection must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-14's BEHAVIOURAL half — against the REAL worker subprocess
 * ──────────────────────────────────────────────────────────────────────────── */

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

function specFor(payload: ReturnType<typeof syntheticProblem>): SolveRequestSpec {
  return {
    protocolVersion: 1,
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    buildRunId: randomUUID(),
    correlationId: `hard-off-${randomUUID().slice(0, 8)}`,
    snapshotId: randomUUID(),
    canonicalInputHash: canonicalInputHash(payload),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
  };
}

describe('SPEC-08 R-14 — a HardOff day is not schedulable, on the real worker', () => {
  it('the model cannot place the person on their approved day off', async () => {
    /* Four participants and one required assignment a day, so the problem stays
     * FEASIBLE with one person unavailable — the assertion is about WHO, not
     * about feasibility. (When nobody else is eligible the honest outcome is
     * `infeasible`, which is its own build state distinct from `failed`, doc 08
     * §4; that case is the next one.) */
    const base = syntheticProblem({ participants: 4, days: 3, requiredCount: 1 });
    const absent = base.participants[0]?.membershipId ?? '';
    const offDate = base.startDate;
    expect(absent).not.toBe('');

    /* THE CONTROL, first: with an EMPTY projection the solver is free to use
     * that person on that date, so the case below can only be the HardOff row.
     * Without this control a solver that never picked participant 0 would make
     * the assertion pass while proving nothing (FAD-15 red case 4). */
    const control = await solveOnWorker(specFor(base));
    expect(SOLVED_STATUSES, control.status).toContain(control.status);

    const withHardOff = await solveOnWorker(
      specFor({
        ...base,
        requestProjection: {
          ...base.requestProjection,
          hardOff: [{ membershipId: absent, date: offDate }],
        },
      }),
    );
    expect(
      SOLVED_STATUSES,
      `the problem stays posable with three others eligible (${withHardOff.status})`,
    ).toContain(withHardOff.status);

    const placedOnOffDate = (withHardOff.assignments ?? []).filter(
      (assignment) => assignment.membershipId === absent && assignment.date === offDate,
    );
    expect(
      placedOnOffDate,
      'R-14: the rebuild must not schedule the person on their approved day off',
    ).toHaveLength(0);

    /* And the person is still usable on the OTHER days — the row is a per-DATE
     * unavailability window (doc 08 §3.2), not a removal of the participant. */
    const elsewhere = (withHardOff.assignments ?? []).filter(
      (assignment) => assignment.membershipId === absent,
    );
    for (const assignment of elsewhere) {
      expect(assignment.date).not.toBe(offDate);
    }
  }, 240_000);

  it('when NOBODY else is eligible the outcome is INFEASIBLE, reported honestly', async () => {
    /* The consequence of a hard candidate filter over a HARD demand equality,
     * owned rather than worked around: removing the only eligible person from a
     * day makes the day unsatisfiable, and `infeasible` is a statement about the
     * PROBLEM — a different build state from `failed`, which is a statement
     * about the system (doc 08 §4, and `builds/states.ts` keeps them apart).
     *
     * This is R-14's requirement in its sharpest form: the rebuild does not
     * schedule the person on their day off, and it does not pretend the day is
     * covered either. */
    const base = syntheticProblem({ participants: 1, days: 1, requiredCount: 1 });
    const only = base.participants[0]?.membershipId ?? '';

    const control = await solveOnWorker(specFor(base));
    expect(
      SOLVED_STATUSES,
      `the control must be solvable, or the case proves nothing (${control.status})`,
    ).toContain(control.status);

    const blocked = await solveOnWorker(
      specFor({
        ...base,
        requestProjection: {
          ...base.requestProjection,
          hardOff: [{ membershipId: only, date: base.startDate }],
        },
      }),
    );
    expect(blocked.status).toBe('INFEASIBLE');
  }, 240_000);

  it('the OBJECTIVE is byte-untouched by v3 — the worker echoes the same digest', async () => {
    /* `HardOff` is a CANDIDATE FILTER, not an objective term, and the claim that
     * v3 changed nothing about the objective is asserted rather than stated.
     *
     * Both directions in one measurement: the platform's digest of
     * `E2_OBJECTIVE_PROFILE` is unchanged (it is the constant every earlier
     * packet's proofs used), AND the worker — which mirrors the profile in
     * Python and echoes its own digest on every response — agrees over a v3
     * document. A profile edited on either side would part the two.
     *
     * The second solve carries a `HardOff` row, so the agreement holds over a
     * document whose projection is POPULATED rather than only over an empty one. */
    const base = syntheticProblem({ participants: 3, days: 2, requiredCount: 1 });
    const absent = base.participants[0]?.membershipId ?? '';

    const plain = await solveOnWorker(specFor(base));
    const withProjection = await solveOnWorker(
      specFor({
        ...base,
        requestProjection: {
          ...base.requestProjection,
          hardOff: [{ membershipId: absent, date: base.startDate }],
        },
      }),
    );

    /* The digest the WORKER computed over its own mirror of the profile, echoed
     * on the response — not a value this process supplied. */
    expect(plain.objectiveProfile?.digest).toBe(OBJECTIVE_PROFILE_DIGEST);
    expect(withProjection.objectiveProfile?.digest).toBe(OBJECTIVE_PROFILE_DIGEST);
    expect(withProjection.objectiveProfile?.digest).toBe(plain.objectiveProfile?.digest);
  }, 240_000);
});
