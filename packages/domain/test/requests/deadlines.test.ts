import {
  DEADLINE_ROLLS,
  LATE_SUBMISSION_POLICIES,
  classifySubmission,
  deadlineBindsInStatus,
  deadlineRollExhausted,
  effectiveDeadline,
  isNonWorkingDay,
  rollDeadline,
  REQUEST_STATUSES,
  EXPIRY_SOURCE_STATUSES,
  type CalendarDate,
  type DeadlineRoll,
  type GroupDeadlinePolicy,
} from '@schedulepoint/domain';
import { describe, expect, it } from 'vitest';

/**
 * SPEC-08 §3 and §7 R-09 — deadline boundaries and the three roll
 * configurations, as pure domain properties (OPUS-M5-001, doc 42 §5c Part B).
 *
 * > R-09 | Deadline boundary; holiday roll forward/backward/exact | **Correct in
 * > each configuration**
 *
 * ## Every date here is synthetic and far-future
 *
 * 2046 and 2047, chosen for the same reason the migration cycles use far-future
 * dates: a fixture date that could be confused with a real schedule is a fixture
 * date somebody eventually reads as one. No organization, site or person name
 * from the research appears anywhere in this file.
 *
 * ## The weekday facts are stated, not assumed
 *
 * Each case names the weekday it depends on in a comment, and the first test
 * asserts those weekdays directly. A roll test whose premise ("the 15th is a
 * Saturday") were wrong would still pass or fail for reasons unrelated to the
 * roll, and the failure message would send a reader looking in the wrong place.
 */

/** No holidays — so weekends are the only non-working days. */
const NO_HOLIDAYS: ReadonlySet<CalendarDate> = new Set();

const policy = (
  overrides: Partial<GroupDeadlinePolicy> & { readonly until?: CalendarDate },
): GroupDeadlinePolicy => ({
  requestUntil:
    overrides.requestUntil ??
    (overrides.until === undefined
      ? { mode: 'closed' }
      : { mode: 'fixed_date', until: overrides.until }),
  deadlineRolls: overrides.deadlineRolls ?? 'exact',
  lateSubmission: overrides.lateSubmission ?? 'reject',
});

describe('the calendar premises these cases rest on', () => {
  it('the named weekdays are what the roll cases assume', () => {
    /* 2046-06-16 is a Saturday and 2046-06-17 a Sunday; 2046-06-15 is the Friday
     * before and 2046-06-18 the Monday after. Every roll case below is built on
     * exactly this window. */
    expect(isNonWorkingDay('2046-06-15', NO_HOLIDAYS), '2046-06-15 is a Friday').toBe(false);
    expect(isNonWorkingDay('2046-06-16', NO_HOLIDAYS), '2046-06-16 is a Saturday').toBe(true);
    expect(isNonWorkingDay('2046-06-17', NO_HOLIDAYS), '2046-06-17 is a Sunday').toBe(true);
    expect(isNonWorkingDay('2046-06-18', NO_HOLIDAYS), '2046-06-18 is a Monday').toBe(false);
  });

  it('a `group_holidays` date is non-working even on a weekday', () => {
    /* §3's whole reason for existing: "the deadline is Friday" is ambiguous when
     * Friday is a holiday. */
    expect(isNonWorkingDay('2046-06-15', new Set(['2046-06-15']))).toBe(true);
  });

  it('the two policy vocabularies are the closed sets §3 names', () => {
    expect([...DEADLINE_ROLLS]).toEqual(['forward', 'backward', 'exact']);
    expect([...LATE_SUBMISSION_POLICIES]).toEqual(['reject', 'accept_as_late']);
  });
});

describe('R-09 — the three roll configurations, on the SAME nominal date', () => {
  /* One nominal date, three policies, three different answers. That is the whole
   * of §3's "Explicit, because 'the deadline is Friday' is ambiguous when Friday
   * is a holiday" — and the three answers must genuinely differ, or the policy
   * is not doing anything. */
  const saturday: CalendarDate = '2046-06-16';

  it('`forward` moves a weekend deadline to the following Monday', () => {
    expect(rollDeadline(saturday, 'forward', NO_HOLIDAYS)).toBe('2046-06-18');
  });

  it('`backward` moves it to the preceding Friday', () => {
    expect(rollDeadline(saturday, 'backward', NO_HOLIDAYS)).toBe('2046-06-15');
  });

  it('`exact` leaves it exactly where it is', () => {
    expect(rollDeadline(saturday, 'exact', NO_HOLIDAYS)).toBe(saturday);
  });

  it('the three answers are genuinely DIFFERENT — the policy is not inert', () => {
    const answers = new Set(
      DEADLINE_ROLLS.map((roll) => rollDeadline(saturday, roll, NO_HOLIDAYS)),
    );
    expect(answers.size).toBe(3);
  });

  it('a WORKING day is unmoved by every roll, including forward and backward', () => {
    /* The roll acts only when it has to. A `forward` policy that moved every
     * deadline would shorten nothing and lengthen everything, silently. */
    for (const roll of DEADLINE_ROLLS) {
      expect(rollDeadline('2046-06-18', roll, NO_HOLIDAYS), roll).toBe('2046-06-18');
    }
  });

  it('rolls SKIP a run of non-working days rather than stepping one', () => {
    /* Friday is a holiday and Saturday and Sunday are the weekend, so `forward`
     * from Friday must reach Monday — three days — and `backward` must reach
     * Thursday. A one-step implementation would land on Saturday and Thursday
     * respectively, and only the forward case would look wrong. */
    const holidays = new Set(['2046-06-15']);
    expect(rollDeadline('2046-06-15', 'forward', holidays)).toBe('2046-06-18');
    expect(rollDeadline('2046-06-15', 'backward', holidays)).toBe('2046-06-14');
  });

  it('a calendar with no working day at all is reported rather than looped', () => {
    /* A group that entered a whole year as holidays. The roll returns the
     * unmoved date — defined, and no more permissive than any alternative — and
     * the condition is reported separately so a caller can raise a configuration
     * alarm without the roll having to decide that a deadline is the place for
     * one. */
    /* The set must cover MORE than the roll's 366-step bound in both directions
     * from the nominal date, or the roll finds a working day just past the edge
     * of the fixture and the case proves nothing about exhaustion. Authored at
     * 400 days each way and corrected to 800 after the first run returned
     * `2047-02-05` — the day after the fixture ended. */
    const everyDay = new Set<CalendarDate>();
    for (let day = -800; day <= 800; day += 1) {
      const at = new Date(Date.UTC(2046, 5, 15));
      at.setUTCDate(at.getUTCDate() + day);
      everyDay.add(at.toISOString().slice(0, 10));
    }
    expect(rollDeadline('2046-06-15', 'forward', everyDay)).toBe('2046-06-15');
    expect(deadlineRollExhausted('2046-06-15', 'forward', everyDay)).toBe(true);
    /* …and it is FALSE in the ordinary case, so the flag is not stuck on. */
    expect(deadlineRollExhausted('2046-06-15', 'forward', NO_HOLIDAYS)).toBe(false);
    expect(deadlineRollExhausted('2046-06-15', 'exact', everyDay)).toBe(false);
  });
});

describe('§3 — the effective deadline from the group policy', () => {
  it('`closed` yields no deadline at all, and is NOT an absent date', () => {
    /* Migration 0010 kept `closed` distinct from "never configured" precisely so
     * these two could not be the same row. The computation keeps them distinct
     * too: `closed` is its own answer, not a null date. */
    expect(effectiveDeadline(policy({}), NO_HOLIDAYS, null)).toEqual({ kind: 'closed' });
  });

  it('`fixed_date` reports the nominal AND the effective date, and whether it moved', () => {
    const rolled = effectiveDeadline(
      policy({ until: '2046-06-16', deadlineRolls: 'forward' }),
      NO_HOLIDAYS,
      null,
    );
    expect(rolled).toEqual({
      kind: 'dated',
      nominal: '2046-06-16',
      effective: '2046-06-18',
      rolled: true,
    });

    const unmoved = effectiveDeadline(
      policy({ until: '2046-06-18', deadlineRolls: 'forward' }),
      NO_HOLIDAYS,
      null,
    );
    expect(unmoved).toEqual({
      kind: 'dated',
      nominal: '2046-06-18',
      effective: '2046-06-18',
      rolled: false,
    });
  });

  it('`days_before_period_start` counts back from the period', () => {
    const result = effectiveDeadline(
      policy({
        requestUntil: { mode: 'days_before_period_start', leadDays: 14 },
        deadlineRolls: 'exact',
      }),
      NO_HOLIDAYS,
      '2046-07-02',
    );
    expect(result).toEqual({
      kind: 'dated',
      nominal: '2046-06-18',
      effective: '2046-06-18',
      rolled: false,
    });
  });

  it('`days_before_period_start` with NO period start is CLOSED, not open', () => {
    /* Failing in the permissive direction would let a request in against a
     * deadline nobody could name — "a client-side deadline is not a deadline"
     * with the client replaced by an absence. */
    const result = effectiveDeadline(
      policy({
        requestUntil: { mode: 'days_before_period_start', leadDays: 14 },
      }),
      NO_HOLIDAYS,
      null,
    );
    expect(result).toEqual({ kind: 'closed' });
  });

  it('a lead of zero days means the period start itself', () => {
    const result = effectiveDeadline(
      policy({ requestUntil: { mode: 'days_before_period_start', leadDays: 0 } }),
      NO_HOLIDAYS,
      '2046-07-02',
    );
    expect(result).toMatchObject({ kind: 'dated', nominal: '2046-07-02' });
  });
});

describe('R-09 — the deadline BOUNDARY, inclusive', () => {
  const onTime = policy({ until: '2046-06-18', deadlineRolls: 'exact' });

  it('the day BEFORE the deadline is on time', () => {
    expect(classifySubmission(onTime, NO_HOLIDAYS, null, '2046-06-17')).toEqual({
      kind: 'on-time',
      effective: '2046-06-18',
    });
  });

  it('the deadline day ITSELF is on time — the boundary is inclusive', () => {
    /* "accepted until <date>" is what staff are shown (research 02 §4), and
     * "until the 18th" excluding the 18th is the off-by-one this asserts against. */
    expect(classifySubmission(onTime, NO_HOLIDAYS, null, '2046-06-18')).toEqual({
      kind: 'on-time',
      effective: '2046-06-18',
    });
  });

  it('the day AFTER is late', () => {
    expect(classifySubmission(onTime, NO_HOLIDAYS, null, '2046-06-19')).toEqual({
      kind: 'late-rejected',
      effective: '2046-06-18',
    });
  });

  it('the boundary MOVES with the roll — the three configurations differ at the edge', () => {
    /* The same submission date, the same nominal deadline, three policies. Under
     * `backward` it is late; under `exact` and `forward` it is not. This is the
     * case that would go green under any roll implementation that quietly did
     * nothing, so it is the one worth having. */
    const nominal: CalendarDate = '2046-06-16';
    const submittedOn: CalendarDate = '2046-06-16';

    const at = (roll: DeadlineRoll): string =>
      classifySubmission(
        policy({ until: nominal, deadlineRolls: roll }),
        NO_HOLIDAYS,
        null,
        submittedOn,
      ).kind;

    expect(at('exact')).toBe('on-time');
    expect(at('forward')).toBe('on-time');
    expect(at('backward')).toBe('late-rejected');
  });
});

describe('§3 — late submission is CONFIGURED, never implicit', () => {
  const late: CalendarDate = '2046-06-19';

  it('`reject` refuses, and the refusal carries the effective deadline', () => {
    const result = classifySubmission(
      policy({ until: '2046-06-18', lateSubmission: 'reject' }),
      NO_HOLIDAYS,
      null,
      late,
    );
    expect(result).toEqual({ kind: 'late-rejected', effective: '2046-06-18' });
  });

  it('`accept_as_late` admits it, and says so', () => {
    const result = classifySubmission(
      policy({ until: '2046-06-18', lateSubmission: 'accept_as_late' }),
      NO_HOLIDAYS,
      null,
      late,
    );
    expect(result).toEqual({ kind: 'late-accepted', effective: '2046-06-18' });
  });

  it('a CLOSED window refuses regardless of the late policy', () => {
    /* `accept_as_late` widens a deadline; it does not open a window that is
     * shut. A group that closed submissions has made a decision, and a late
     * policy is not a way around it. */
    for (const lateSubmission of LATE_SUBMISSION_POLICIES) {
      expect(
        classifySubmission(policy({ lateSubmission }), NO_HOLIDAYS, null, late).kind,
        lateSubmission,
      ).toBe('window-closed');
    }
  });

  it('the late policy changes NOTHING for an on-time submission', () => {
    for (const lateSubmission of LATE_SUBMISSION_POLICIES) {
      expect(
        classifySubmission(
          policy({ until: '2046-06-18', lateSubmission }),
          NO_HOLIDAYS,
          null,
          '2046-06-17',
        ),
      ).toEqual({ kind: 'on-time', effective: '2046-06-18' });
    }
  });
});

describe('§3 — "re-validated at every transition, not only at submission"', () => {
  it('the deadline binds in exactly the three UNDECIDED statuses', () => {
    /* The same three V-31 enumerates as `expired`'s only legal sources, and that
     * is not a coincidence: a deadline acts on a request nobody has decided, and
     * on no other. A fourth status here would be a status from which a stale date
     * could un-decide a decision. */
    for (const status of REQUEST_STATUSES) {
      expect(deadlineBindsInStatus(status), status).toBe(
        (EXPIRY_SOURCE_STATUSES as readonly string[]).includes(status),
      );
    }
  });

  it('it does NOT bind once a decision or a publication exists', () => {
    for (const status of ['approved', 'denied', 'consumed_by_build', 'reflected_in_version'])
      expect(deadlineBindsInStatus(status), status).toBe(false);
  });
});
