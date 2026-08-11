/**
 * `packages/domain/src/time` — zone semantics: DST gaps, DST folds, overnight
 * intervals, and the extreme offsets (OPUS-M4-000B; doc 34 §4-F).
 *
 * ## The one zone database this repository has
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only tz database
 * Node ships. Everything below is built on it, and on nothing else: no clock is
 * read, no host zone is consulted, no library is imported (this package imports
 * nothing — `.dependency-cruiser.cjs` `domain-imports-nothing`). `Intl` is an
 * ECMAScript builtin, not a Node builtin, so using it does not widen the
 * package's dependency surface.
 *
 * The tzdb RULE-SET identifier is deliberately NOT read here. `process.versions.tz`
 * is a Node global, and this package may not read one; the identifier is
 * captured in `apps/api/src/schedule/timezone.ts` and travels in as data.
 *
 * ## The three cases a local wall-clock time can be in, and what we do
 *
 * A `(zone, date, HH:MM)` triple does not always name exactly one instant.
 * Doc 34 §4-F requires each case to be explicit, stated, and test-pinned, so
 * each is a distinct member of a discriminated result rather than a silent
 * coercion:
 *
 *  - **`unique`** — the ordinary case. One instant.
 *  - **`gap`** — the local time does not exist (spring-forward). **Ruling R-B4:
 *    a gap resolves FORWARD, by the transition's own gap duration**, so
 *    `02:30` on a `02:00 → 03:00` day becomes `03:30` local. The alternative —
 *    refusing — was considered and rejected: a shift type's times are fixed
 *    catalogue values, so refusing would make one calendar day per year
 *    unschedulable for that shift type with no authoring remedy, and the hour
 *    still has to be covered by somebody. Forward is also the convention
 *    `java.time` and ICU already use, so a reader coming from either is not
 *    surprised. The result CARRIES `normalization: 'gap-forward'` and the shift
 *    of the instant, so no caller can consume a normalized time believing it
 *    was the authored one.
 *  - **`fold`** — the local time happens twice (fall-back). **Ruling R-B5: a
 *    fold resolves to the occurrence the caller's ROLE selects — a shift START
 *    takes the FIRST (earlier offset), a shift END takes the SECOND (later
 *    offset).** Both halves matter and they are one rule, not two: taking the
 *    first for both would make a shift that spans the transition an hour
 *    shorter than the wall clock says and could produce `ends_at <= starts_at`
 *    on a short overnight (which `assignment_snapshots_interval` refuses, as a
 *    500 rather than a schedule); taking the second for both would silently
 *    start the shift an hour late and leave the repeated hour uncovered. Start
 *    early / end late is the only pairing under which the repeated hour is
 *    covered exactly once and the interval is never degenerate.
 *
 * Neither ruling is a preference expressed in code and nowhere else: both are
 * returned as data, both are asserted in `packages/domain/test/time/`, and both
 * are offered for FAD ratification in the packet's return report.
 */

import { addDays, assertCalendarDate } from '../calendar/calendar-date.js';

/** `HH:MM` in 24-hour form. Seconds are not authored anywhere in this product. */
export type WallClockTime = string;

const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `true` iff `value` is a `HH:MM` wall-clock time. */
export function isWallClockTime(value: string): boolean {
  return TIME_SHAPE.test(value);
}

/** Minutes since local midnight, or `null` when `value` is not `HH:MM`. */
export function minutesOfDay(value: WallClockTime): number | null {
  const match = TIME_SHAPE.exec(value);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * `true` iff `zone` is an IANA zone this runtime's tz database knows.
 *
 * The only way to ask is to try to build a formatter, which throws `RangeError`
 * for an unknown identifier. `UTC` and offset-style identifiers such as
 * `+05:30` are accepted by `Intl` and are accepted here too; the product's
 * storage constraint (`groups_timezone_nonempty`, 1..64 chars) is separate and
 * is not this function's business.
 */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The local calendar and wall-clock parts of `instant` in `zone`.
 *
 * `en-US` with explicit numeric fields and `hour12: false` is used because it is
 * the one locale/option combination whose part set is fully specified by the
 * options; a locale-dependent format string would make this vary by host.
 *
 * `hourCycle: 'h23'` is set explicitly: `hour12: false` alone yields `24` for
 * midnight in some ICU versions, which would silently produce a `24:00` time
 * and a date one day early.
 */
export function zonedParts(
  zone: string,
  instant: Date,
): { date: string; time: WallClockTime; year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(instant);

  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  const year = Number(field('year'));
  const month = Number(field('month'));
  const day = Number(field('day'));
  const hour = Number(field('hour'));
  const minute = Number(field('minute'));

  return {
    date:
      `${String(year).padStart(4, '0')}-` +
      `${String(month).padStart(2, '0')}-` +
      `${String(day).padStart(2, '0')}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    year,
    month,
    day,
    hour,
    minute,
  };
}

/**
 * The local wall-clock reading of `instant` in `zone`, expressed as the epoch
 * milliseconds those same components would have if they were UTC.
 *
 * This is the quantity the resolution below compares against, and it is the
 * only honest way to ask "does this instant read as the wall time I asked for?"
 */
function wallMillis(zone: string, instant: Date): number {
  const parts = zonedParts(zone, instant);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

/**
 * The UTC offset of `zone` at `instant`, in milliseconds (east of UTC positive).
 *
 * `UTC+14` (Pacific/Kiritimati) and `UTC−12` (Etc/GMT+12) are both inside the
 * range this returns, and both are fixture-pinned.
 */
export function offsetMillisAt(zone: string, instant: Date): number {
  return wallMillis(zone, instant) - instant.getTime();
}

/** The offset in minutes, for display and for the extreme-offset fixtures. */
export function offsetMinutesAt(zone: string, instant: Date): number {
  return offsetMillisAt(zone, instant) / MS_PER_MINUTE;
}

/** Which occurrence a fold resolves to. See ruling R-B5 above. */
export type FoldPolicy = 'earliest' | 'latest';

/**
 * The outcome of resolving a local wall-clock time in a zone.
 *
 * Every member carries `instant`, so a caller that ignores the discriminant
 * still gets a usable answer; every member also carries WHAT happened, so a
 * caller that cares can surface it. Nothing here can silently normalise: the
 * normalisation is a field.
 */
export type LocalResolution =
  | {
      readonly kind: 'unique';
      readonly instant: Date;
      readonly offsetMillis: number;
    }
  | {
      readonly kind: 'gap';
      readonly instant: Date;
      readonly offsetMillis: number;
      /** R-B4. Always `'gap-forward'`; named so a reader need not infer it. */
      readonly normalization: 'gap-forward';
      /** How far the instant was moved, in milliseconds — the transition's gap. */
      readonly shiftedByMillis: number;
      /** The local time actually produced, e.g. `03:30` for a requested `02:30`. */
      readonly resolvedLocalTime: WallClockTime;
    }
  | {
      readonly kind: 'fold';
      readonly instant: Date;
      readonly offsetMillis: number;
      /** R-B5. Which occurrence this resolution took. */
      readonly disambiguation: FoldPolicy;
      readonly earliestInstant: Date;
      readonly latestInstant: Date;
    };

/**
 * Resolve `(zone, date, time)` to an instant, naming the DST case explicitly.
 *
 * ## The algorithm, and why the obvious one is wrong
 *
 * The obvious approach — take the offset at the nominal instant, subtract it,
 * done — silently loses the second occurrence of a fold: on a fall-back day
 * both probes land on the SAME offset, so `01:30` resolves to one instant and
 * the other one is never seen. The measured consequence is that "ambiguous"
 * becomes indistinguishable from "unique", and R-B5 becomes unimplementable.
 *
 * So both offsets in play around the date are probed — 24 hours either side of
 * the nominal reading, which brackets every transition in the tz database
 * (transitions are never less than a day apart in any zone this product can be
 * configured with) — and each produces a CANDIDATE instant. A candidate is
 * VALID iff reading it back in the zone yields exactly the requested wall time.
 *
 *   two valid candidates  → `fold`
 *   one valid candidate   → `unique`
 *   no valid candidate    → `gap`; the later candidate is taken (R-B4)
 *
 * `date` must already be a real calendar date (`../calendar`) and `time` a
 * `HH:MM`; both are asserted, because a rolled-over date reaching here is the
 * defect `../calendar` exists to close and must not be laundered into an
 * instant.
 */
export function resolveLocalTime(
  zone: string,
  date: string,
  time: WallClockTime,
  foldPolicy: FoldPolicy = 'earliest',
): LocalResolution {
  /* The calendar check, not a shape check, and it is here rather than at the
   * caller because `Date.UTC(2027, 1, 29)` is `2027-03-01`: a shape-valid,
   * calendar-invalid date reaching the line below would be SILENTLY laundered
   * into a real instant on the wrong day. `assertCalendarDate` throws
   * `INVALID_CALENDAR_DATE` instead. `/^\d{4}-\d{2}-\d{2}$/` is deliberately
   * not what guards this. */
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`ZONED_TIME_BAD_DATE: ${JSON.stringify(date)} is not YYYY-MM-DD`);
  }
  const { year, month, day } = assertCalendarDate(date);

  const minutes = minutesOfDay(time);
  if (minutes === null) {
    throw new Error(`ZONED_TIME_BAD_TIME: ${JSON.stringify(time)} is not HH:MM`);
  }

  const nominal = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60, 0, 0);

  const probeBefore = offsetMillisAt(zone, new Date(nominal - MS_PER_DAY));
  const probeAfter = offsetMillisAt(zone, new Date(nominal + MS_PER_DAY));

  const first = nominal - probeBefore;
  const second = nominal - probeAfter;
  const distinct: number[] = first === second ? [first] : [first, second];

  const valid: number[] = distinct
    .filter((millis) => wallMillis(zone, new Date(millis)) === nominal)
    .sort((a, b) => a - b);

  if (valid.length === 1) {
    const instant = new Date(valid[0] as number);
    return { kind: 'unique', instant, offsetMillis: offsetMillisAt(zone, instant) };
  }

  if (valid.length >= 2) {
    const earliestInstant = new Date(valid[0] as number);
    const latestInstant = new Date(valid[valid.length - 1] as number);
    const instant = foldPolicy === 'earliest' ? earliestInstant : latestInstant;
    return {
      kind: 'fold',
      instant,
      offsetMillis: offsetMillisAt(zone, instant),
      disambiguation: foldPolicy,
      earliestInstant,
      latestInstant,
    };
  }

  /* R-B4: the gap. The LATER candidate is the one on the post-transition
   * offset, so taking it advances the local reading by exactly the gap. */
  const later = Math.max(...distinct);
  const instant = new Date(later);
  const produced = zonedParts(zone, instant);
  return {
    kind: 'gap',
    instant,
    offsetMillis: offsetMillisAt(zone, instant),
    normalization: 'gap-forward',
    shiftedByMillis: wallMillis(zone, instant) - nominal,
    resolvedLocalTime: produced.time,
  };
}

/**
 * A resolved shift interval — the server's derivation of `starts_at`/`ends_at`
 * from a catalogue shift type's fixed local times and the GROUP's timezone.
 *
 * ## Overnight (doc 34 §4-F)
 *
 * `endTime <= startTime` means the shift crosses midnight and ends on the NEXT
 * calendar day. That is a derivation, not an input: the client never computes
 * an instant (the authoring contract says so), and a `date` on this surface is
 * always the shift's START date. The **attribution** of an overnight shift to
 * both calendar days for RENDERING is OPUS-M3-006's behaviour and is untouched
 * here; this function decides only which instants the interval spans.
 *
 * ## Fold policy is not a parameter of the caller's choosing
 *
 * R-B5 is applied here and nowhere else: the START resolves `earliest`, the END
 * resolves `latest`. A caller cannot opt out, because the pairing — not either
 * half — is what keeps a fold-spanning shift from collapsing.
 *
 * ## The interval is resolved JOINTLY, not endpoint by endpoint (R-B4a)
 *
 * This is a correction, and the defect it closes was real and shipped in this
 * packet's first implementation. Resolving the two endpoints INDEPENDENTLY is
 * wrong whenever the START falls in a DST gap: R-B4 pushes the start forward by
 * the gap width, the end is resolved where it was, and a shift SHORTER than the
 * gap therefore ends BEFORE it starts. Measured across the three fixture zones,
 * **399** (start, end) pairs produced a zero or negative interval —
 * `America/New_York` 78, `Australia/Lord_Howe` 21, `Antarctica/Troll` 300 —
 * with `02:30 → 03:00` in New York giving `elapsed = −30`. It reached the
 * database as a `500` on the `assignment_snapshots_interval` CHECK.
 *
 * **R-B4a: when the START is gap-normalized, the WHOLE interval translates
 * forward by the same gap width.** The end moves with the start.
 *
 * Why this and not the alternatives:
 *
 *  - **Consistency with R-B4.** R-B4 already rules that a gap start moves
 *    forward. Moving the start ALONE silently shortens the authored shift and,
 *    past the gap width, inverts it. Moving both preserves the authored
 *    wall-clock duration exactly, which is what a shift type's fixed times mean.
 *  - **Refusing was rejected, for R-B4's own reason.** A shift type's times are
 *    fixed catalogue values, so refusing would make one calendar day a year
 *    unschedulable for that type with no authoring remedy — and the hour still
 *    has to be covered. Refusing only the SHORT shifts would be worse still: a
 *    rule whose behaviour flips on the shift's duration is one nobody can hold
 *    in their head.
 *  - **The residual guard stays.** If the translated end still does not exceed
 *    the start — reachable only if the translated end lands inside a second
 *    transition — a typed `DegenerateShiftIntervalError` is thrown. It is a
 *    backstop, not the mechanism, and it is thrown rather than swallowed so a
 *    degenerate interval can never again reach the database as a 500.
 */
export interface ShiftInterval {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly crossesMidnight: boolean;
  /** `YYYY-MM-DD` — the calendar day `endsAt` falls on, in the same zone. */
  readonly endDate: string;
  readonly start: LocalResolution;
  readonly end: LocalResolution;
  /** Wall-clock duration in minutes, as authored (ignores the DST shift). */
  readonly nominalDurationMinutes: number;
  /** Real elapsed duration in minutes — differs from nominal across a transition. */
  readonly elapsedMinutes: number;
}

/**
 * Thrown when a shift interval cannot be resolved to a positive duration.
 *
 * A backstop for R-B4a, not its mechanism. It exists because the alternative to
 * throwing is returning `endsAt <= startsAt`, which the database refuses with a
 * CHECK violation — a 500 for what a caller can be told about precisely.
 */
export class DegenerateShiftIntervalError extends Error {
  readonly code = 'DEGENERATE_SHIFT_INTERVAL';
  readonly zone: string;
  readonly startsAt: Date;
  readonly endsAt: Date;

  constructor(zone: string, date: string, startTime: string, endTime: string, startsAt: Date, endsAt: Date) {
    super(
      `DEGENERATE_SHIFT_INTERVAL: ${startTime}–${endTime} on ${date} in ${zone} resolves to ` +
        `${startsAt.toISOString()}–${endsAt.toISOString()}, which does not advance. A shift must ` +
        'have a positive duration.',
    );
    this.name = 'DegenerateShiftIntervalError';
    this.zone = zone;
    this.startsAt = startsAt;
    this.endsAt = endsAt;
  }
}

/** `(date, HH:MM)` advanced by whole minutes, rolling the calendar date. */
function addLocalMinutes(
  date: string,
  time: WallClockTime,
  deltaMinutes: number,
): { date: string; time: WallClockTime } {
  const minutes = (minutesOfDay(time) ?? 0) + deltaMinutes;
  const dayShift = Math.floor(minutes / (24 * 60));
  const withinDay = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    date: dayShift === 0 ? date : addDays(date, dayShift),
    time: `${String(Math.floor(withinDay / 60)).padStart(2, '0')}:${String(withinDay % 60).padStart(2, '0')}`,
  };
}

export function resolveShiftInterval(
  zone: string,
  date: string,
  startTime: WallClockTime,
  endTime: WallClockTime,
): ShiftInterval {
  const startMinutes = minutesOfDay(startTime);
  const endMinutes = minutesOfDay(endTime);
  if (startMinutes === null || endMinutes === null) {
    throw new Error('ZONED_TIME_BAD_TIME: a shift interval needs two HH:MM times');
  }

  const crossesMidnight = endMinutes <= startMinutes;
  const endDate = crossesMidnight ? addDays(date, 1) : date;

  const start = resolveLocalTime(zone, date, startTime, 'earliest');

  /* R-B4a. The end is translated by the START's gap normalization, so the whole
   * shift moves together and the authored wall-clock duration survives. For
   * every non-gap start this is a zero shift and the end resolves exactly where
   * it did before. */
  const gapShiftMinutes =
    start.kind === 'gap' ? Math.round(start.shiftedByMillis / MS_PER_MINUTE) : 0;
  const translatedEnd = addLocalMinutes(endDate, endTime, gapShiftMinutes);
  const end = resolveLocalTime(zone, translatedEnd.date, translatedEnd.time, 'latest');

  if (end.instant.getTime() <= start.instant.getTime()) {
    throw new DegenerateShiftIntervalError(zone, date, startTime, endTime, start.instant, end.instant);
  }

  const nominalDurationMinutes = crossesMidnight
    ? 24 * 60 - startMinutes + endMinutes
    : endMinutes - startMinutes;

  return {
    startsAt: start.instant,
    endsAt: end.instant,
    crossesMidnight,
    endDate: translatedEnd.date,
    start,
    end,
    nominalDurationMinutes,
    elapsedMinutes: (end.instant.getTime() - start.instant.getTime()) / MS_PER_MINUTE,
  };
}

/**
 * The instants bounding `[from, to]` as whole LOCAL days in `zone` — the window
 * a date-ranged read uses.
 *
 * The upper bound is the start of the day AFTER `to`, so the range is
 * half-open and a shift ending exactly at local midnight belongs to the day it
 * started on rather than to both. A gap or fold at local midnight resolves by
 * the same rulings (start-of-day takes `earliest`; the gap moves forward),
 * which is why this goes through `resolveLocalTime` rather than assuming
 * `00:00` always exists — it does not, in the zones that transition at
 * midnight.
 */
export function zonedDayWindow(
  zone: string,
  from: string,
  to: string,
): { start: Date; end: Date } {
  return {
    start: resolveLocalTime(zone, from, '00:00', 'earliest').instant,
    end: resolveLocalTime(zone, addDays(to, 1), '00:00', 'earliest').instant,
  };
}

/** Hours in the local day `date` of `zone` — 23, 24 or 25 across a transition. */
export function localDayLengthHours(
  zone: string,
  date: string,
): number {
  const start = resolveLocalTime(zone, date, '00:00', 'earliest').instant;
  const next = resolveLocalTime(zone, addDays(date, 1), '00:00', 'earliest').instant;
  return (next.getTime() - start.getTime()) / MS_PER_HOUR;
}
