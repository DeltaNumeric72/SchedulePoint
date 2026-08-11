/**
 * `packages/domain/src/calendar` — true calendar-date semantics (OPUS-M4-000B;
 * doc 34 §4-F). Pure: no clock, no zone, no I/O.
 */
export {
  InvalidCalendarDateError,
  MAX_CALENDAR_YEAR,
  MIN_CALENDAR_YEAR,
  addDays,
  assertCalendarDate,
  compareCalendarDates,
  dateFromEpochDays,
  datesInRange,
  dayOfWeek,
  daysBetween,
  daysFromEpoch,
  daysInMonth,
  formatCalendarDate,
  inclusiveDayCount,
  isCalendarDate,
  isLeapYear,
  isWithinDateRange,
  parseCalendarDate,
  type CalendarDate,
  type CalendarParts,
} from './calendar-date.js';
