import {
  classifySubmission,
  effectiveDeadline,
  zonedParts,
  type CalendarDate,
  type EffectiveDeadline,
  type GroupDeadlinePolicy,
  type RequestUntilPolicy,
  type SubmissionTiming,
  type UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * SPEC-08 §3's deadline computation — the IMPURE half (OPUS-M5-001, Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The split, and why the line is where it is
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain/src/requests/deadlines.ts` holds the arithmetic: given a
 * policy, a holiday calendar and a date, what is the effective deadline and is a
 * submission late. It has no clock and no database handle, because
 * `packages/domain` imports nothing — and because a deadline calculator with a
 * clock inside it is one you cannot test at a boundary, which is where every
 * interesting case lives.
 *
 * This file supplies the three things that calculator cannot fetch: the group's
 * policy row, the group's `group_holidays` calendar, and **the calendar date it
 * is right now in the group's own timezone**.
 *
 * ## The timezone is not a detail
 *
 * "Requests close on the 15th" means the 15th where the group works. A server
 * comparing UTC instants would close a US group's window several hours early and
 * an Asia-Pacific group's several hours late, every time — and the error would be
 * invisible except to the people it refused. So the submission date is resolved
 * through the group's `timezone` column with the same helper the schedule
 * surfaces use, and there is exactly one zone conversion in this system.
 *
 * ## `expires_at` is stored as an INSTANT, from a DATE
 *
 * `requests.expires_at` is `timestamptz` (SPEC-08 §1.1) and the policy is a
 * calendar date. The instant is the **end** of the effective deadline day in the
 * group's zone — the first instant of the following day — so that a request
 * submitted at 23:59 local on the deadline is inside it. Taking midnight at the
 * START of the day would silently make the deadline the day before, which is the
 * ambiguity §3's roll policy exists to remove rather than to introduce.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** The group's §3 configuration and the calendar it is evaluated against. */
export interface GroupDeadlineContext {
  readonly policy: GroupDeadlinePolicy;
  readonly holidays: ReadonlySet<CalendarDate>;
  readonly timezone: string;
}

interface GroupPolicyRow {
  readonly timezone: string;
  readonly request_until_mode: 'closed' | 'fixed_date' | 'days_before_period_start';
  readonly request_until_date: string | null;
  readonly request_until_lead_days: number | null;
  readonly deadline_rolls: 'forward' | 'backward' | 'exact';
  readonly late_submission_policy: 'reject' | 'accept_as_late';
}

/**
 * Rebuild 0010's discriminated triple from its three columns.
 *
 * The `groups_request_until_shape` CHECK guarantees exactly the columns each
 * mode needs are populated, so each branch's non-null assertion is the
 * database's, not this function's. The `closed` fallbacks exist anyway: if the
 * CHECK were ever dropped, a malformed row must close the window rather than
 * open one, and a `??` that failed the other way would be a fail-open path
 * reached only by a schema accident nobody was watching for.
 */
function toRequestUntilPolicy(row: GroupPolicyRow): RequestUntilPolicy {
  switch (row.request_until_mode) {
    case 'closed':
      return { mode: 'closed' };
    case 'fixed_date':
      return row.request_until_date === null
        ? { mode: 'closed' }
        : { mode: 'fixed_date', until: row.request_until_date };
    case 'days_before_period_start':
      return row.request_until_lead_days === null
        ? { mode: 'closed' }
        : { mode: 'days_before_period_start', leadDays: row.request_until_lead_days };
  }
}

/**
 * Load the group's §3 context: policy, holiday calendar, timezone.
 *
 * The group is the one in `uow.context` — never a parameter. A deadline
 * computed for a group other than the declared one would be a deadline from
 * outside the tenant context that authorized the request, and RLS would not
 * object because `groups` is legitimately readable in its own tenant.
 */
export async function loadGroupDeadlineContext(uow: Uow): Promise<GroupDeadlineContext | null> {
  const groupId = uow.context.groupId;
  if (groupId === null) return null;

  /* ── The TYPED builder, not a SQL template, and the reason is NR-16 ─────────
   *
   * Both reads below were first written as multi-line `sql` templates, and the
   * I-15 architecture scan refused one of them: a line beginning `from groups`
   * is a BARE SQL LINE naming a tenant table, which the NR-16 detector flags
   * wherever it appears. The detector is lexical rather than dataflow — it
   * cannot tell a `uow.query` template from a `client.query` one — which is
   * exactly why `BARE_LINE_BASELINE` pins the modules that legitimately hold
   * such SQL.
   *
   * **This file is deliberately NOT added to that baseline.** The baseline's own
   * docblock describes it as modules "carrying a bare-line hit that PREDATES the
   * detector", pinned so that "a NEW bare-line query anywhere fails". A brand-new
   * file has no such history, and filing it under a pre-existing-debt list would
   * be mislabelling new debt as old — the one thing a baseline must never be
   * used for.
   *
   * The builder removes the raw SQL rather than reformatting around the
   * detector, so the control is satisfied by having nothing to detect instead of
   * by a line break moved to a friendlier column.
   *
   * The two `::text` casts remain, as `sql` fragments INSIDE the builder: `date`
   * columns come back from node-postgres as JavaScript `Date` objects, and both
   * of these are calendar dates that §3 compares as `YYYY-MM-DD` strings. Casting
   * in the database is what makes the declared `string` types true at runtime. */
  const row = await uow.query
    .selectFrom('groups')
    .select((eb) => [
      'timezone',
      'request_until_mode',
      sql<string | null>`${eb.ref('request_until_date')}::text`.as('request_until_date'),
      'request_until_lead_days',
      'deadline_rolls',
      'late_submission_policy',
    ])
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (row === undefined) return null;

  const holidayRows = await uow.query
    .selectFrom('group_holidays')
    .select((eb) => [sql<string>`${eb.ref('holiday_date')}::text`.as('holiday_date')])
    .where('group_id', '=', groupId)
    .execute();

  return {
    policy: {
      requestUntil: toRequestUntilPolicy(row),
      deadlineRolls: row.deadline_rolls,
      lateSubmission: row.late_submission_policy,
    },
    holidays: new Set(holidayRows.map((holiday) => holiday.holiday_date)),
    timezone: row.timezone,
  };
}

/**
 * The calendar date `instant` falls on, in the group's own zone.
 *
 * `zonedParts` already formats the date; this is a name for the question rather
 * than a second computation, so every deadline comparison in this file goes
 * through the one zone conversion the schedule surfaces use.
 */
export function localDate(instant: Date, timezone: string): CalendarDate {
  return zonedParts(timezone, instant).date;
}

/** §3's deadline for this group, before any question about a particular submission. */
export function deadlineFor(
  context: GroupDeadlineContext,
  periodStart: CalendarDate | null,
): EffectiveDeadline {
  return effectiveDeadline(context.policy, context.holidays, periodStart);
}

/** §3's classification of a submission at `at`, in the group's own zone. */
export function classifyAt(
  context: GroupDeadlineContext,
  periodStart: CalendarDate | null,
  at: Date,
): SubmissionTiming {
  return classifySubmission(
    context.policy,
    context.holidays,
    periodStart,
    localDate(at, context.timezone),
  );
}

/**
 * The INSTANT a deadline date expires at: the first instant of the following
 * day, in the group's zone.
 *
 * Found by scanning minute by minute for local midnight rather than by adding a
 * fixed number of hours, because a fixed offset is wrong twice a year in every
 * zone that observes DST — and the deadline day is exactly as likely to be one of
 * those as any other. `zonedParts` is the same helper every other local
 * rendering in this system goes through.
 *
 * The search is over a two-day window around the naive UTC midnight, which
 * covers every real zone offset (UTC−12 to UTC+14) with room to spare.
 */
export function deadlineInstant(deadlineDate: CalendarDate, timezone: string): Date {
  const nextDay = nextCalendarDay(deadlineDate);
  const naive = Date.parse(`${nextDay}T00:00:00.000Z`);

  /* Scan minute by minute across a 48-hour window and take the FIRST instant
   * whose local date is `nextDay` and whose local time is midnight. Minute
   * granularity is enough: every zone offset in use is a whole number of
   * minutes. */
  const startOfScan = naive - 24 * 60 * 60_000;
  for (let minute = 0; minute <= 48 * 60; minute += 1) {
    const candidate = new Date(startOfScan + minute * 60_000);
    const parts = zonedParts(timezone, candidate);
    if (parts.hour === 0 && parts.minute === 0 && parts.date === nextDay) {
      return candidate;
    }
  }

  /* Unreachable for a real zone. A DST transition that SKIPS local midnight
   * would land here — the naive instant is returned, which is at most one
   * offset's distance from the true boundary and never earlier than the
   * deadline day itself. Returning something is required: `expires_at` is NOT
   * NULL, and a submission cannot be refused because a zone is unusual. */
  return new Date(naive);
}

function nextCalendarDay(date: CalendarDate): CalendarDate {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}
