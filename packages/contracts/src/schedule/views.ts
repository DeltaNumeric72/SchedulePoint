import { z } from 'zod';

/**
 * The staff-facing schedule READ surface's wire shapes (OPUS-M3-006; doc 07 §1,
 * SPEC-05, CAP-020).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Two reads, and neither of them is the picklist
 *
 * Doc 07 §1 keeps ten schedule concepts distinct, and two of the distinctions
 * decide the shape of everything below:
 *
 *  - **Published schedule version** — "an immutable, staff-visible snapshot". A
 *    DRAFT is explicitly "not visible to staff". Every shape here describes
 *    published content only, and the server never sends a draft row through
 *    them (the predicate that guarantees it is in the route, and it has its own
 *    red case).
 *  - **The daily assignment sheet** is a READ of the published master schedule
 *    for one date (CAP-020, doc 07 §7). It is **not** the picklist
 *    `daily_assignments` module, which is a turn-taking mechanism and is M9.
 *    Nothing here selects, offers, claims, or sequences anything; there is no
 *    pick position and no turn on this surface.
 *
 * ## Every time on the wire is already resolved against the group's zone
 *
 * The authoring contract's rule — "the client never computes an instant" — has a
 * mirror on the read side, and it is the same rule for the same reason: **the
 * client never computes a local time either.** A browser in another zone that
 * formatted `startsAt` itself would show a Sydney rota in London time, and a
 * night shift would silently land on the wrong day.
 *
 * So the server resolves each assignment against `groups.timezone` and sends:
 *
 *  - the instants (`startsAt`, `endsAt`) — the unambiguous truth, for anything
 *    that needs to compute;
 *  - the LOCAL calendar dates the assignment spans (`startDate`, `endDate`);
 *  - the LOCAL wall-clock times (`startTime`, `endTime`) as `HH:MM`;
 *  - `timezone`, so the surface can name the zone it is showing.
 *
 * A client renders those strings. It does no zone arithmetic, which means there
 * is exactly one zone conversion in the system and it is tested against DST
 * transitions rather than trusted.
 *
 * ## An overnight shift appears on BOTH days, and says which day it began
 *
 * A 22:00 → 06:00 shift is one assignment that occupies two calendar days. It is
 * emitted **once per local day it covers**: on its start date with
 * `isContinuation: false` and `continuesToNextDay: true`, and on the following
 * date with `isContinuation: true`. Both carry the same
 * `assignmentIdentityId`, because it is the same assignment — a reader who
 * counted rows without reading `isContinuation` would count it twice, and that
 * is why the flag is a required field rather than an optional hint.
 *
 * Showing it on only one of the two days is the failure this exists to prevent:
 * a night-shift worker looking at Tuesday must see that they are working from
 * Monday 22:00, and a scheduler looking at Monday must see the shift that
 * begins that evening.
 *
 * ## What is deliberately NOT here
 *
 *  - **No feed and no token.** An iCalendar/webcal export with a bearer token in
 *    a URL is a delivery mechanism with its own privacy posture, and it belongs
 *    to the notification/calendar milestone. In-app views only.
 *  - **No override reason text, no conflict explanation, no credit.** They are
 *    authoring concepts; a staff member reads who works when.
 *  - **No patient-identifying content of any kind** (I-07). Nothing on this
 *    surface carries free text a clinician could type into.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');
const instant = z.string().datetime();
/** Local wall-clock time in the group's zone, as the server resolved it. */
const localTime = z.string().regex(/^\d{2}:\d{2}$/, 'a time is HH:MM');
/** An IANA zone name, as `groups.timezone` holds it. */
const timezone = z.string().min(1).max(64);

/**
 * The longest range a personal schedule read accepts, in days.
 *
 * 92 — one quarter including the longest three-month run. It is a product bound
 * rather than a technical one, and it exists for the reason the authoring
 * surface's `MAX_PERIOD_DAYS` exists: a read with no bound is a read that
 * eventually returns a year of rows to a phone, and the failure mode of an
 * unbounded range is a page that never finishes rather than an error anybody can
 * act on.
 *
 * A range longer than this is REFUSED (422, naming the field). It is never
 * silently truncated — a schedule that quietly omits its last weeks is worse
 * than one that says it cannot show them.
 */
export const MAX_VIEW_DAYS = 92;

/** Whole days from `from` to `to` inclusive. */
function inclusiveDayCount(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Queries
 * ──────────────────────────────────────────────────────────────────────────── */

export const scheduleRangeQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .superRefine((value, ctx) => {
    if (value.to < value.from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'The end of the range is before its start.',
      });
      return;
    }
    const days = inclusiveDayCount(value.from, value.to);
    if (days > MAX_VIEW_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: `A schedule view covers at most ${String(MAX_VIEW_DAYS)} days; this range is ${String(days)}.`,
      });
    }
  });
export type ScheduleRangeQuery = z.infer<typeof scheduleRangeQuerySchema>;

export const dailySheetQuerySchema = z.object({ date: isoDate }).strict();
export type DailySheetQuery = z.infer<typeof dailySheetQuerySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Entries
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One assignment, as it appears on ONE local day.
 *
 * `membershipId` and `displayName` are present on both surfaces. On the personal
 * view they are always the caller's own — the route derives the membership from
 * the verified context and never from a body — and on the daily sheet they name
 * the colleague working the shift, which is the whole point of a sheet.
 *
 * `displayName` comes from `users.display_name`, the same field the authoring
 * roster already discloses to any context in the same organization through
 * membership. No email, no credential, nothing patient-related.
 */
export const scheduleEntrySchema = z
  .object({
    assignmentIdentityId: uuid,
    membershipId: uuid,
    displayName: z.string().min(1).max(200),

    shiftTypeId: uuid,
    shiftTypeCode: z.string().min(1).max(32),
    shiftTypeName: z.string().min(1).max(120),
    isOnCall: z.boolean(),

    /** The unambiguous truth. Both are UTC instants. */
    startsAt: instant,
    endsAt: instant,

    /** The local calendar days the assignment spans, in the group's zone. */
    startDate: isoDate,
    endDate: isoDate,
    /** Local wall-clock, in the group's zone. */
    startTime: localTime,
    endTime: localTime,

    /**
     * True when the day this entry appears on is NOT the day the assignment
     * began — the second (or later) day of an overnight shift.
     */
    isContinuation: z.boolean(),
    /** True when the assignment runs past the end of the day it appears on. */
    continuesToNextDay: z.boolean(),

    /** The published version this content came from. Never a draft. */
    versionId: uuid,
    versionNumber: z.number().int().positive(),
    periodId: uuid,
  })
  .strict();
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;

/**
 * One day of a personal schedule.
 *
 * Days with nothing on them are present with an empty `entries` array rather
 * than omitted: "you are not working" is an answer, and a calendar that skipped
 * the empty days would make the reader count squares to find out.
 */
export const scheduleDaySchema = z
  .object({ date: isoDate, entries: z.array(scheduleEntrySchema) })
  .strict();
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Responses
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A personal published schedule — CURRENT published versions only, self-scoped.
 *
 * `membershipId` is echoed so a client can assert it received the schedule it
 * asked about; the server derived it from the verified context, so the echo is a
 * check rather than a source of truth.
 */
export const personalScheduleSchema = z
  .object({
    membershipId: uuid,
    displayName: z.string().min(1).max(200),
    timezone,
    from: isoDate,
    to: isoDate,
    days: z.array(scheduleDaySchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type PersonalSchedule = z.infer<typeof personalScheduleSchema>;

/**
 * The daily assignment sheet for ONE date — a read of the published master
 * schedule (CAP-020), not the picklist module.
 */
export const dailySheetSchema = z
  .object({
    date: isoDate,
    timezone,
    entries: z.array(scheduleEntrySchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type DailySheet = z.infer<typeof dailySheetSchema>;
