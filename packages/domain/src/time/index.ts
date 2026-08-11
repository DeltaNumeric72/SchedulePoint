/**
 * `packages/domain/src/time` — zone semantics (OPUS-M4-000B; doc 34 §4-F).
 * DST gap (R-B4) and fold (R-B5) rulings, overnight intervals, extreme offsets.
 */
export {
  DegenerateShiftIntervalError,
  isKnownTimeZone,
  isWallClockTime,
  localDayLengthHours,
  minutesOfDay,
  offsetMillisAt,
  offsetMinutesAt,
  resolveLocalTime,
  resolveShiftInterval,
  zonedDayWindow,
  zonedParts,
  type FoldPolicy,
  type LocalResolution,
  type ShiftInterval,
  type WallClockTime,
} from './zoned-time.js';
