import type { ScheduleDay, ScheduleEntry } from '@schedulepoint/contracts';

/**
 * The one model both renderings consume (OPUS-M3-006).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why a model rather than two components reading the response
 *
 * The packet requires an accessible calendar **and** a first-class tabular
 * alternative, and "first-class" has to mean *the same data*, not "roughly the
 * same data". The authoring surface established the mechanism and this reuses
 * it: neither rendering walks the API response. Both walk this model, and both
 * emit the same `data-entry-summary` per entry, so `apps/web/e2e/my-schedule.spec.ts`
 * can compare the two sets and a divergence is a failing test rather than
 * something a reviewer might notice.
 *
 * ## Nothing here computes a time, a date, or a zone
 *
 * Every local date and wall-clock time on screen was resolved by the server
 * against `groups.timezone`. This module groups and labels; it never converts.
 * A browser that formatted `startsAt` itself would render a Sydney rota in
 * London time, and the night shift would move to the wrong day — which is the
 * defect the whole server-side-resolution rule exists to prevent.
 *
 * The one thing computed from a `Date` here is the WEEKDAY of a `YYYY-MM-DD`
 * label, and it is computed in UTC from the date components alone (`Date.UTC`),
 * so it cannot drift with the viewer's zone.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Monday-first, because a rota week is a working week. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The parts of a `YYYY-MM-DD`, read as components rather than parsed as an instant. */
function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** 0 = Monday … 6 = Sunday. Computed in UTC so the viewer's zone cannot shift it. */
export function weekdayIndex(date: string): number {
  const { year, month, day } = parts(date);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

/** `4 June 2029` — a human label for a calendar date, built from its components. */
export function longDate(date: string): string {
  const { year, month, day } = parts(date);
  return `${String(day)} ${MONTHS[month - 1] ?? ''} ${String(year)}`;
}

/** `4 Jun` — the compact label a narrow calendar cell can hold. */
export function shortDate(date: string): string {
  const { month, day } = parts(date);
  return `${String(day)} ${(MONTHS[month - 1] ?? '').slice(0, 3)}`;
}

/** `YYYY-MM-DD` shifted by `days`, by calendar arithmetic in UTC. */
export function shiftDate(date: string, days: number): string {
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * What one entry says, in one line.
 *
 * This is the string BOTH renderings emit as `data-entry-summary`, and it is the
 * thing the e2e equality assertion compares. It carries every field a reader
 * acts on — which day, which shift, when it runs, and whether this is the shift
 * beginning or the tail of one that began yesterday — so two renderings agreeing
 * on it cannot be showing materially different schedules.
 */
export function entrySummary(date: string, entry: ScheduleEntry): string {
  const span = entry.isContinuation
    ? `continues from ${entry.startTime} on ${entry.startDate}, until ${entry.endTime}`
    : entry.continuesToNextDay
      ? `${entry.startTime} until ${entry.endTime} on ${entry.endDate}`
      : `${entry.startTime}–${entry.endTime}`;
  return `${date}|${entry.shiftTypeCode}|${span}|${entry.membershipId}`;
}

/**
 * The words a reader sees for an overnight shift.
 *
 * Two different sentences on the two days, deliberately. "22:00–06:00" repeated
 * on both days would say the person works sixteen hours; naming the direction is
 * what makes one assignment rendered twice legible as one assignment.
 */
export function describeSpan(entry: ScheduleEntry): string {
  if (entry.isContinuation) {
    return `Continues from ${entry.startTime} on ${longDate(entry.startDate)}, until ${entry.endTime}`;
  }
  if (entry.continuesToNextDay) {
    return `${entry.startTime} until ${entry.endTime} the next day (${longDate(entry.endDate)})`;
  }
  return `${entry.startTime}–${entry.endTime}`;
}

/** A short badge for the same fact, for a calendar cell that has no room for a sentence. */
export function spanBadge(entry: ScheduleEntry): string | null {
  if (entry.isContinuation) return 'continues';
  if (entry.continuesToNextDay) return 'overnight';
  return null;
}

export interface CalendarCell {
  /** `null` for the leading/trailing blanks that align the first and last weeks. */
  readonly date: string | null;
  readonly entries: readonly ScheduleEntry[];
}

/**
 * The returned days, aligned into Monday-first weeks.
 *
 * Leading and trailing blanks are `date: null` cells rather than omitted, so
 * every week has exactly seven columns and the grid's row/column arithmetic is
 * uniform — a ragged first row is how a calendar comes to put Tuesday under the
 * Monday heading.
 */
export function buildWeeks(days: readonly ScheduleDay[]): readonly (readonly CalendarCell[])[] {
  if (days.length === 0) return [];
  const cells: CalendarCell[] = [];

  const firstDate = days[0]?.date ?? '';
  for (let index = 0; index < weekdayIndex(firstDate); index += 1) {
    cells.push({ date: null, entries: [] });
  }
  for (const day of days) cells.push({ date: day.date, entries: day.entries });
  while (cells.length % 7 !== 0) cells.push({ date: null, entries: [] });

  const weeks: CalendarCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
}

export interface EntryRow {
  readonly date: string;
  readonly entry: ScheduleEntry;
}

/** Every entry, flattened in date order — the tabular alternative's row set. */
export function buildEntryRows(days: readonly ScheduleDay[]): readonly EntryRow[] {
  return days.flatMap((day) => day.entries.map((entry) => ({ date: day.date, entry })));
}

/**
 * The sentence the live region announces after a load.
 *
 * SP-HR: a status that only appears visually is a status a screen-reader user
 * never receives. It counts ENTRIES rather than assignments, and says so, because
 * an overnight shift contributes two entries and silently reporting "5 shifts"
 * for four shifts would be wrong in a way nobody could see.
 */
export function announceSchedule(rows: readonly EntryRow[], from: string, to: string): string {
  if (rows.length === 0) {
    return `No shifts between ${longDate(from)} and ${longDate(to)}.`;
  }
  const continuations = rows.filter((row) => row.entry.isContinuation).length;
  const shifts = rows.length - continuations;
  const tail =
    continuations === 0
      ? ''
      : ` ${String(continuations)} of them ${continuations === 1 ? 'continues' : 'continue'} from the previous day.`;
  return `${String(shifts)} ${shifts === 1 ? 'shift' : 'shifts'} between ${longDate(from)} and ${longDate(to)}.${tail}`;
}
