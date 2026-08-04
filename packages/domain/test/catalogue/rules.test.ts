import {
  CATALOGUE_DAYS,
  CATALOGUE_DAY_LABELS,
  SHIFT_PALETTES,
  SHIFT_PALETTE_KEYS,
  SHIFT_TEXT_STYLES,
  SHIFT_TEXT_STYLE_DEFINITIONS,
  canonicalPickPositions,
  crossesMidnight,
  isShiftPaletteKey,
  isShiftTextStyle,
  isTimeOfDay,
  minutesSinceMidnight,
  pickPositionIncreaseProblems,
  pickPositionProblems,
  shiftLengthMinutes,
  shiftPaletteLabel,
  shiftTypeProblems,
  type ShiftTypeDraft,
} from '../../src/catalogue/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The catalogue's pure rules, with no database anywhere.
 *
 * These are the functions an authoring form calls to say *which field* is wrong
 * before it makes a request, and they are the second reading of rules migration
 * 0005 also enforces. Both readings exist deliberately: the database is the
 * control, and this is what makes a validation summary that links to fields
 * possible at all.
 */

const VALID: ShiftTypeDraft = {
  code: 'DAY',
  name: 'Day shift',
  description: null,
  displayPaletteKey: 'indigo',
  displayTextStyle: 'regular',
  startTime: '07:00',
  endTime: '19:00',
  isOnCall: false,
  attractsStipend: false,
  isManualOnly: false,
  isDailyPick: true,
  includeInStatistics: true,
  isLeaveOfAbsence: false,
  allowOnRequest: true,
  allowOffRequest: true,
  reportOrder: 0,
  creditWeight: 1,
};

describe('times of day', () => {
  it('accepts 24-hour HH:MM and nothing else', () => {
    for (const good of ['00:00', '07:30', '23:59', '12:00']) {
      expect(isTimeOfDay(good), good).toBe(true);
    }
    for (const bad of ['24:00', '7:30', '07:60', '07:30:00', '0730', '', 'noon']) {
      expect(isTimeOfDay(bad), bad).toBe(false);
    }
  });

  it('minutesSinceMidnight is total and returns null rather than NaN', () => {
    expect(minutesSinceMidnight('00:00')).toBe(0);
    expect(minutesSinceMidnight('07:30')).toBe(450);
    expect(minutesSinceMidnight('23:59')).toBe(1439);
    // `null`, not `NaN`: a NaN propagates silently through every arithmetic
    // expression downstream and surfaces as a blank field three screens later.
    expect(minutesSinceMidnight('nonsense')).toBeNull();
  });
});

describe('crossesMidnight is derived, not asked', () => {
  it('is false when the shift ends later the same day', () => {
    expect(crossesMidnight('07:00', '19:00')).toBe(false);
    expect(crossesMidnight('00:00', '00:01')).toBe(false);
  });

  it('is true when the shift ends at or before its start', () => {
    expect(crossesMidnight('19:00', '07:00')).toBe(true);
    // Equal times are a TWENTY-FOUR HOUR shift, which does cross midnight. A
    // zero-length shift is not something the catalogue can express, and reading
    // it as one would silently create shifts of no duration.
    expect(crossesMidnight('08:00', '08:00')).toBe(true);
  });

  it('propagates a malformed time as null instead of guessing', () => {
    expect(crossesMidnight('nope', '19:00')).toBeNull();
    expect(crossesMidnight('07:00', 'nope')).toBeNull();
  });

  it('shiftLengthMinutes measures across midnight correctly', () => {
    expect(shiftLengthMinutes('07:00', '19:00')).toBe(720);
    expect(shiftLengthMinutes('19:00', '07:00')).toBe(720);
    expect(shiftLengthMinutes('22:00', '06:30')).toBe(510);
    expect(shiftLengthMinutes('08:00', '08:00')).toBe(24 * 60);
  });
});

describe('shift type validation is field-addressed and complete', () => {
  it('a valid draft has no problems', () => {
    expect(shiftTypeProblems(VALID)).toEqual([]);
  });

  it('reports ALL problems, not the first — a form that reveals one per submit takes four', () => {
    const problems = shiftTypeProblems({
      ...VALID,
      code: '   ',
      name: '',
      startTime: 'nope',
      creditWeight: -1,
    });
    const fields = problems.map((problem) => problem.field);
    expect(fields).toContain('code');
    expect(fields).toContain('name');
    expect(fields).toContain('startTime');
    expect(fields).toContain('creditWeight');
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });

  it('every problem names a field the form has a control for', () => {
    const known = new Set(Object.keys(VALID));
    const problems = shiftTypeProblems({
      ...VALID,
      code: '',
      name: '',
      description: '   ',
      startTime: 'x',
      endTime: 'y',
      isManualOnly: true,
      isDailyPick: true,
      reportOrder: -1,
      creditWeight: 5000,
    });
    for (const problem of problems) {
      expect(known, `${problem.field} is not a draft field`).toContain(problem.field);
      // Rendered verbatim in a `role="alert"` summary, so it has to read as a
      // sentence rather than as an error code.
      expect(problem.message.length).toBeGreaterThan(10);
      expect(problem.message.endsWith('.')).toBe(true);
    }
  });

  it('manual-only and daily-pick contradict, and the problem is on the pick field', () => {
    const problems = shiftTypeProblems({ ...VALID, isManualOnly: true, isDailyPick: true });
    expect(problems.map((problem) => problem.field)).toEqual(['isDailyPick']);
  });

  it('leave-of-absence and statistics visibility are INDEPENDENT — no invented rule', () => {
    // Deliberate: the research records the flags as independent and says nothing
    // about their interaction. Constraining them would convert an absence of
    // evidence into a rule (CLAUDE.md §2).
    expect(shiftTypeProblems({ ...VALID, isLeaveOfAbsence: true, includeInStatistics: true })).toEqual(
      [],
    );
    expect(
      shiftTypeProblems({ ...VALID, isLeaveOfAbsence: true, includeInStatistics: false }),
    ).toEqual([]);
  });
});

describe('pick positions', () => {
  it('canonical form is ascending and distinct', () => {
    expect(canonicalPickPositions([3, 1, 1, 2])).toEqual([1, 2, 3]);
    expect(canonicalPickPositions([])).toEqual([]);
    expect(canonicalPickPositions([5])).toEqual([5]);
  });

  it('positions above the ceiling are refused, and the message says what the ceiling is', () => {
    expect(pickPositionProblems([1, 2, 3], 3)).toEqual([]);
    const problems = pickPositionProblems([1, 4], 3);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe('allowedPickPositions');
    expect(problems[0]?.message).toContain('3');
  });

  it('a position below 1 is refused', () => {
    expect(pickPositionProblems([0], 5).map((p) => p.field)).toEqual(['allowedPickPositions']);
    expect(pickPositionProblems([-2], 5)).toHaveLength(1);
  });

  it('a non-integer is refused before anything else, so the later messages are meaningful', () => {
    const problems = pickPositionProblems([1.5], 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain('whole numbers');
  });

  it('the count may rise or stay, never fall', () => {
    expect(pickPositionIncreaseProblems(3, 3)).toEqual([]);
    expect(pickPositionIncreaseProblems(3, 30)).toEqual([]);
    const lowered = pickPositionIncreaseProblems(30, 3);
    expect(lowered).toHaveLength(1);
    expect(lowered[0]?.field).toBe('pickPositionCount');
    // The message explains WHY, because "not allowed" invites a support ticket
    // and "published history references it" does not.
    expect(lowered[0]?.message).toContain('increased');
    expect(lowered[0]?.message).toContain('30');
  });

  it('a negative or fractional count is refused', () => {
    expect(pickPositionIncreaseProblems(0, -1)).toHaveLength(1);
    expect(pickPositionIncreaseProblems(0, 2.5)).toHaveLength(1);
  });
});

describe('the display token sets are closed and labelled', () => {
  it('every palette key has a definition and a human label', () => {
    expect(SHIFT_PALETTES.map((palette) => palette.key)).toEqual([...SHIFT_PALETTE_KEYS]);
    for (const palette of SHIFT_PALETTES) {
      // The label is what makes "colour is never the sole carrier" (SPEC-14 §2)
      // achievable: the interface renders the word beside the swatch.
      expect(palette.label.length).toBeGreaterThan(2);
      expect(shiftPaletteLabel(palette.key)).toBe(palette.label);
    }
  });

  it('every text style has a definition and a label', () => {
    expect(SHIFT_TEXT_STYLE_DEFINITIONS.map((style) => style.key)).toEqual([...SHIFT_TEXT_STYLES]);
  });

  it('the guards accept only members', () => {
    for (const key of SHIFT_PALETTE_KEYS) expect(isShiftPaletteKey(key)).toBe(true);
    expect(isShiftPaletteKey('#ff0000')).toBe(false);
    expect(isShiftPaletteKey('crimson')).toBe(false);
    for (const style of SHIFT_TEXT_STYLES) expect(isShiftTextStyle(style)).toBe(true);
    expect(isShiftTextStyle('blink')).toBe(false);
  });
});

describe('the demand day enumeration', () => {
  it('has eight members, and holiday is one of them', () => {
    expect(CATALOGUE_DAYS).toHaveLength(8);
    expect(CATALOGUE_DAYS).toContain('holiday');
  });

  it('every day has a label a form can render', () => {
    for (const day of CATALOGUE_DAYS) {
      expect(CATALOGUE_DAY_LABELS[day].length).toBeGreaterThan(2);
    }
  });
});
