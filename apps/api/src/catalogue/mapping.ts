import type { ShiftGroup, ShiftType, StaffGroup, ValidGroup } from '@schedulepoint/contracts';
import type {
  CatalogueDayColumn,
  ShiftPaletteKeyColumn,
  ShiftTextStyleColumn,
} from '../db/schema.js';

/**
 * Row → wire.
 *
 * Small, boring, and worth its own module for one reason: **the two shapes are
 * deliberately not the same**, and the places where they differ are decisions.
 *
 * | Column | Wire | Why |
 * |---|---|---|
 * | `start_time` `HH:MM:SS` | `HH:MM` | PostgreSQL renders `time` with seconds; a rota is not that precise, and a form that round-trips `07:30:00` into a `type="time"` input has to strip them anyway |
 * | `credit_weight` `numeric` (string) | `number` | node-postgres returns `numeric` as a **string** to avoid float loss. The contract's consumer is arithmetic, so it is parsed exactly once, here |
 * | `id` | `shiftTypeId` | the wire name says which aggregate it identifies; three `id` fields in one response body is how a client passes the wrong one |
 */

/** `HH:MM:SS` (or `HH:MM:SS.mmm`) → `HH:MM`. */
export function timeToWire(value: string): string {
  return value.slice(0, 5);
}

/** `HH:MM` → `HH:MM:00`, the form PostgreSQL's `time` parser expects. */
export function timeFromWire(value: string): string {
  return `${value}:00`;
}

/** `numeric` arrives as a string. Parsed once, here, and nowhere else. */
export function numericToWire(value: string): number {
  return Number(value);
}

export interface ShiftTypeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  display_palette_key: ShiftPaletteKeyColumn;
  display_text_style: ShiftTextStyleColumn;
  start_time: string;
  end_time: string;
  crosses_midnight: boolean;
  is_on_call: boolean;
  attracts_stipend: boolean;
  is_manual_only: boolean;
  is_daily_pick: boolean;
  include_in_statistics: boolean;
  is_leave_of_absence: boolean;
  allow_on_request: boolean;
  allow_off_request: boolean;
  report_order: number;
  credit_weight: string;
  status: 'active' | 'retired';
  effective_from: Date;
  effective_to: Date | null;
  version: number;
}

export function shiftTypeToWire(row: ShiftTypeRow): ShiftType {
  return {
    shiftTypeId: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    displayPaletteKey: row.display_palette_key,
    displayTextStyle: row.display_text_style,
    startTime: timeToWire(row.start_time),
    endTime: timeToWire(row.end_time),
    crossesMidnight: row.crosses_midnight,
    isOnCall: row.is_on_call,
    attractsStipend: row.attracts_stipend,
    isManualOnly: row.is_manual_only,
    isDailyPick: row.is_daily_pick,
    includeInStatistics: row.include_in_statistics,
    isLeaveOfAbsence: row.is_leave_of_absence,
    allowOnRequest: row.allow_on_request,
    allowOffRequest: row.allow_off_request,
    reportOrder: row.report_order,
    creditWeight: numericToWire(row.credit_weight),
    status: row.status,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to === null ? null : row.effective_to.toISOString(),
    version: row.version,
  };
}

export interface ShiftGroupRow {
  id: string;
  name: string;
  description: string | null;
  scoring_mode: 'hard' | 'weighted';
  weight: string | null;
  allow_request: boolean;
  request_off_label: string | null;
  status: 'active' | 'archived';
  version: number;
}

export function shiftGroupToWire(row: ShiftGroupRow, shiftTypeIds: readonly string[]): ShiftGroup {
  return {
    shiftGroupId: row.id,
    name: row.name,
    description: row.description,
    scoringMode: row.scoring_mode,
    weight: row.weight === null ? null : numericToWire(row.weight),
    allowRequest: row.allow_request,
    requestOffLabel: row.request_off_label,
    shiftTypeIds: [...shiftTypeIds],
    status: row.status,
    version: row.version,
  };
}

export interface StaffGroupRow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
  version: number;
}

export function staffGroupToWire(
  row: StaffGroupRow,
  membershipIds: readonly string[],
): StaffGroup {
  return {
    staffGroupId: row.id,
    name: row.name,
    description: row.description,
    membershipIds: [...membershipIds],
    status: row.status,
    version: row.version,
  };
}

export interface ValidGroupRow {
  id: string;
  name: string;
  allowed_pick_positions: number[];
  status: 'active' | 'archived';
  version: number;
}

export function validGroupToWire(
  row: ValidGroupRow,
  shiftTypeIds: readonly string[],
): ValidGroup {
  return {
    validGroupId: row.id,
    name: row.name,
    shiftTypeIds: [...shiftTypeIds],
    allowedPickPositions: [...row.allowed_pick_positions],
    status: row.status,
    version: row.version,
  };
}

export type { CatalogueDayColumn };
