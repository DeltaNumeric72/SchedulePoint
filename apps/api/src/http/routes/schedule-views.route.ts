import {
  dailySheetQuerySchema,
  dailySheetSchema,
  isUuid,
  personalScheduleSchema,
  scheduleRangeQuerySchema,
  validationProblemBodySchema,
  type ScheduleDay,
  type ScheduleEntry,
} from '@schedulepoint/contracts';
import type { Decision, FieldProblem } from '@schedulepoint/domain';
import { addDays } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import type { Database } from '../../db/schema.js';
import { isPostgresError } from '../../db/pg-errors.js';
import { MEMBERSHIP_AGGREGATE } from '../context/target-resolution.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';
// The DST-correct local-time → instant conversion, reused rather than
// reimplemented. See `zonedWindow` below for why a second copy would be the
// defect rather than the tidy choice.
import { zonedInstant } from './schedule-authoring.route.js';

/**
 * The staff-facing schedule READ surface (OPUS-M3-006; doc 07 §1, CAP-020).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Two reads, and what each one is
 *
 * | Route | Is | Is not |
 * |---|---|---|
 * | `…/published-schedule/members/:membershipId` | one person's own assignments in the group's CURRENT published schedule, over a bounded date range | a lookup for somebody else's schedule — see the self-scoping section |
 * | `…/published-schedule/daily-sheet?date=` | the **daily assignment sheet**: everybody working that date in the current published schedule (doc 07 §7, CAP-020) | the picklist `daily_assignments` module, which is a turn-taking mechanism and is **M9** |
 *
 * Doc 07 §1 keeps ten schedule concepts distinct and this file collapses none of
 * them. Nothing here selects, offers, claims or sequences anything; there is no
 * pick position, no turn, and no write of any kind. **This module contains no
 * INSERT, UPDATE or DELETE** — a published version is immutable (I-18) and staff
 * read it.
 *
 * ## Drafts are invisible at the QUERY level, never filtered afterwards
 *
 * Doc 07 §1: a draft schedule version "is not visible to staff". The way that is
 * true here is a two-clause predicate on the version join in `readPublished`,
 * applied by every read on this surface, so a draft row is never selected in the
 * first place. It is not fetched-then-filtered, because a filter is a line of
 * code somebody can move above a `return` and a predicate is not.
 *
 * The red case `draft-invisibility` in `scripts/red-cases/run.mjs` deletes those
 * two clauses and requires `apps/api/test/schedule/views-http.test.ts` to fail.
 * A proof of invisibility that cannot be falsified proves nothing, and a seeded
 * draft is what makes it falsifiable: the fixture holds a draft version carrying
 * an assignment for the same member on a date inside the same range.
 *
 * **There are two independent controls, and the red arm reports the first.**
 * With the predicate gone the draft's rows ARE selected — the test asserts that
 * directly in SQL, running the route's own selection with and without the
 * clauses — and then the response fails to serialize, because a draft version
 * has no `version_number` (D-9 allocates it inside the publication transaction)
 * and the contract requires a positive one. So the red arm fails with a `500`
 * rather than with a rendered draft. That is honest to report and stronger than
 * one control: staff-visible content that was never published cannot be
 * represented on this wire at all.
 *
 * ## Self-scoping, and what it actually means here
 *
 * The personal route names a membership in its path and declares SPEC-06's
 * object policy with `ownershipRequired: true` and **no ownership override**, so
 * L5.1 refuses any membership that is not the acting one — for every role,
 * including a scheduler and a group administrator. The target is resolved INSIDE
 * the unit of work, so a sibling group's membership is invisible to RLS, the
 * target is `null`, and the denial is `OBJECT_POLICY` → the single `404` body
 * every tenant not-found in this server produces. Member A asking for member B,
 * a member of another group, and a membership id that names nothing therefore
 * produce byte-identical replies.
 *
 * **There is deliberately no cross-group EX-2 read here.** `context-probe`
 * performs one so an authorized actor gets `409 CONTEXT_TARGET_MISMATCH` rather
 * than `404`; on a staff read surface that `409` would tell a member that a
 * named person exists in another group, which is disclosure this surface has no
 * reason to make.
 *
 * And the query is self-scoped too: it filters on `uow.context.membershipId` —
 * the verified context's membership — rather than on the path parameter. The
 * authorization decides the request; the predicate decides the rows. If the
 * policy declaration were ever disarmed, the rows returned would still be the
 * caller's own.
 *
 * ## The daily sheet shows colleagues, and that is the roles document's §6
 *
 * `docs/fable/08-roles-and-permissions.md` §6's "View published schedules" row
 * is `✓` for Member, Viewer, Scheduler and Group Admin, and `—` for Telecom.
 * The full path rather than "doc 08": under the repo's citation convention a
 * bare "08" resolves to `docs/architecture/08`, whose §6 is Explainability — a
 * different document.
 *
 * A rota is a shared artifact: knowing who is on with you is the point of
 * publishing it. So the sheet is not self-scoped, is gated on its own read key,
 * and carries no more about a colleague than the authoring roster already does —
 * a display name, a shift type, and times.
 *
 * ## Time: the server resolves every local rendering
 *
 * The authoring surface's rule is "the client never computes an instant". The
 * read side's mirror is **the client never computes a local time**. Every entry
 * carries its instants AND the local dates and wall-clock times the group's zone
 * resolves them to, so a browser in another zone renders strings rather than
 * doing zone arithmetic of its own. There is one zone conversion in this system
 * and it is tested against DST transitions.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Policies. Two READ action keys, and neither implies a write.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One's own published schedule — `schedule.own_published.read`, CAP-020.
 *
 * `requiresObjectPolicy: true` with `ownershipRequired: true` and **no
 * `ownershipOverrideCapability`**. The omission is the ruling: no administrative
 * capability lifts the ownership requirement on this route, so "show me
 * somebody's personal schedule" is not a power that exists. A scheduler who
 * needs to see a colleague's shifts uses the daily sheet or the authoring grid,
 * each authorized on its own key.
 */
export const OWN_SCHEDULE_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-020' },
  actionScope: 'group',
  action: {
    key: 'schedule.own_published.read',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/** The daily assignment sheet — `schedule.published.read`, CAP-020. */
export const DAILY_SHEET_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-020' },
  actionScope: 'group',
  action: {
    key: 'schedule.published.read',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes — the same four shapes the authoring surface uses
 * ──────────────────────────────────────────────────────────────────────────── */

type Uow = Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0];

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] };

const MAX_PROBLEM_MESSAGE = 300;

/**
 * Parse a query string into the outcome shape.
 *
 * Called **after** the authorization verdict, never before — the SBX-001
 * disclosure finding. Parsing first would let an actor who holds nothing in this
 * group send `?from=nonsense` and receive a `422` describing the parameter,
 * while a genuinely absent route answers `404`; those two must be
 * indistinguishable.
 */
function parseQuery<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  query: unknown,
): Outcome<T> {
  const parsed = schema.safeParse(query);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    field: (issue.path.length > 0 ? issue.path.join('.') : 'query').slice(0, 64),
    message:
      issue.message.length > MAX_PROBLEM_MESSAGE
        ? `${issue.message.slice(0, MAX_PROBLEM_MESSAGE - 1)}…`
        : issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0
        ? problems
        : [{ field: 'query', message: 'The request query is not valid.' }],
  };
}

/**
 * Run a read inside one unit of work, after one authorization verdict.
 *
 * `target` is computed inside the transaction (so RLS scopes the resolution) and
 * handed to the evaluator, which is what makes the personal route's L5.1
 * declaration have consequences rather than being inert — the defect an
 * independent review found on `context-probe`, where a resolved decision was
 * computed and then thrown away.
 */
async function withViews<T>(
  request: FastifyRequest,
  options: {
    readonly resolveTarget?: (uow: Uow) => Promise<{
      organizationId: string;
      groupId: string | null;
      ownerMembershipId: string | null;
    } | null>;
    readonly run: (uow: Uow) => Promise<Outcome<T>>;
  },
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    try {
      const resolved = await options.resolveTarget?.(uow);
      const { decision } = await evaluateInTransaction(uow.query, {
        request,
        context,
        route,
        target:
          options.resolveTarget === undefined
            ? null
            : resolved === null || resolved === undefined
              ? null
              : {
                  organizationId: resolved.organizationId,
                  groupId: resolved.groupId,
                  type: MEMBERSHIP_AGGREGATE,
                  ownerMembershipId: resolved.ownerMembershipId,
                  state: null,
                },
      });
      if (!decision.allowed) return { kind: 'denied', decision };

      return await options.run(uow);
    } catch (error) {
      // A non-database fault is re-thrown to `setErrorHandler`, which logs it
      // with its stack and answers 500 with the fixed message. Catching
      // everything would turn a bug in this process into a 404 whose log line
      // asserted "refused by the database" about an unexamined cause.
      if (!isPostgresError(error)) throw error;
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'schedule read refused by the database',
      );
      return { kind: 'not-found' };
    }
  });
}

function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
  body: (value: T) => unknown,
): FastifyReply | unknown {
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'invalid') {
    return reply.code(422).send(
      validationProblemBodySchema.parse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: request.correlationId,
          problems: outcome.problems,
        },
      }),
    );
  }
  return body(outcome.value);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Local time in the group's zone
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The local calendar date and wall-clock time of `instant` in `timeZone`.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only zone database
 * Node ships; `hourCycle: 'h23'` is what makes midnight `00:00` rather than
 * `24:00`, which matters because `00:00` is the value the exclusive-end rule
 * below tests for.
 *
 * Exported for `apps/api/test/schedule/views-time.test.ts`, which drives it
 * across both DST transitions in a southern- and a northern-hemisphere zone.
 */
export function localPartsIn(
  instant: Date,
  timeZone: string,
): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const year = read('year').padStart(4, '0');
  return {
    date: `${year}-${read('month')}-${read('day')}`,
    // `h23` yields 00..23, but a formatter that ever produced `24` for midnight
    // would silently push a shift onto the wrong day, so it is normalised here
    // rather than assumed away.
    time: `${read('hour') === '24' ? '00' : read('hour')}:${read('minute')}`,
  };
}

/**
 * `YYYY-MM-DD` one day after / before `date`.
 *
 * Delegated to `packages/domain/src/calendar` (OPUS-M4-000B). The previous
 * bodies went through `Date.UTC`, which SILENTLY ROLLS OVER an invalid input —
 * `Date.UTC(2027, 1, 29)` is `2027-03-01` — so a calendar-invalid date came back
 * as a real, wrong date instead of an error. `addDays` asserts a real calendar
 * date first, and both surfaces now share one implementation rather than each
 * keeping its own copy.
 */
function nextDay(date: string): string {
  return addDays(date, 1);
}

function previousDay(date: string): string {
  return addDays(date, -1);
}

/**
 * The instants bounding `[from, to]` as whole local days in `timeZone`.
 *
 * The window is selected by INSTANT overlap rather than by the snapshot's `date`
 * column, and that is deliberate. `date` is the shift's local start date, so a
 * date-range predicate would miss the overnight shift that started the day
 * BEFORE the window and runs into it — the very case this packet exists to
 * render correctly. Widening the date predicate by a day would work for shifts
 * shorter than 48 hours and fail silently for anything longer; an instant
 * overlap is exact for any duration.
 *
 * `zonedInstant` is imported from the authoring route rather than copied. Its
 * two-pass conversion is what makes a DST boundary land on the right side, it is
 * driven across four transitions by an existing test, and a second copy here
 * would be a second thing to keep correct — which is how two surfaces come to
 * disagree about when a day starts.
 */
function zonedWindow(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedInstant(from, '00:00', timeZone),
    // Exclusive: midnight at the START of the day after `to`.
    end: zonedInstant(nextDay(to), '00:00', timeZone),
  };
}

/**
 * Every local date an assignment occupies, given its resolved local endpoints.
 *
 * **The end is exclusive at midnight.** A shift running 16:00 → 00:00 has a
 * local end date of the following day, and it does not occupy that day: nobody
 * is at work at any point during it. Treating the end date as occupied would put
 * a phantom entry on the next morning's sheet for every evening shift in the
 * system.
 */
export function daysCovered(
  startDate: string,
  endDate: string,
  endTime: string,
): readonly string[] {
  const last = endTime === '00:00' ? previousDay(endDate) : endDate;
  if (last <= startDate) return [startDate];

  const dates: string[] = [];
  let cursor = startDate;
  // A bound rather than an open loop: a corrupt pair of instants must not spin.
  // 400 is far past any shift a shift type can express (≤ 24 hours) and past any
  // plausible manual assignment; reaching it means data no code path can write.
  while (cursor <= last && dates.length < 400) {
    dates.push(cursor);
    cursor = nextDay(cursor);
  }
  return dates;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The read
 * ──────────────────────────────────────────────────────────────────────────── */

interface PublishedRow {
  assignment_identity_id: string;
  membership_id: string;
  display_name: string;
  starts_at: Date;
  ends_at: Date;
  shift_type_id: string;
  code: string;
  name: string;
  is_on_call: boolean;
  version_id: string;
  version_number: number | null;
  period_id: string;
  /* OPUS-M4-000B. The location the shift happens at (nullable — a stated
   * allowed state), and the interpretation the version was published under. */
  location_id: string | null;
  location_name: string | null;
  location_status: string | null;
  timezone_basis: string | null;
}

/**
 * Every published assignment overlapping the window, optionally narrowed to one
 * membership.
 *
 * The membership narrowing takes the VERIFIED context's membership rather than
 * anything from the request, so the personal view cannot be pointed at somebody
 * else even if its authorization declaration were disarmed.
 */
async function readPublished(
  uow: Uow,
  window: { start: Date; end: Date },
  onlyMembershipId: string | null,
): Promise<readonly PublishedRow[]> {
  const query = uow.query as Kysely<Database>;

  /* ── THE PUBLISHED-ONLY PREDICATE ─────────────────────────────────────────
   *
   * Two clauses on the version join, applied here, in the one place this
   * surface reads content from. Doc 07 §1: a draft version "is not visible to
   * staff", and this is what makes that true — the rows are never selected, so
   * there is nothing to filter afterwards and nothing a later `return` can be
   * moved above.
   *
   * **Neither clause is redundant, and that is measured rather than asserted.**
   * State the coupling precisely, because the first version of this comment did
   * not: publication step 08 supersedes the outgoing version AND clears its
   * `is_current` in one transaction, so on any state the application can produce
   * today *either clause alone would suffice* — a reviewer removed each in turn
   * and the suite still passed. **Nothing enforces that coupling**: there is no
   * CHECK saying `is_current ⇒ state = 'published'`, only one function that
   * maintains both together.
   *
   * So `views-http.test.ts` crafts the two decoupled states through transitions
   * the database itself permits — `published`/`not current` (D-15b's own
   * outgoing-version transition) and `draft`/`current` — inside a rolled-back
   * transaction, and measures which clause excludes each: both clauses 0 rows,
   * state-only 2, is_current-only 1. Each clause is what excludes one of them.
   *
   * The `draft-invisibility` red case in `scripts/red-cases/run.mjs` deletes
   * these two lines and `views-http.test.ts` goes red, which is what makes
   * "drafts are invisible" a measured property rather than a claim. That test
   * also runs THIS selection with and without the clauses directly in SQL, so
   * the difference the predicate makes is stated as a number rather than
   * inferred from a failing suite. See the file header for which of the two
   * controls the red arm actually reports. */
  let builder = query
    .selectFrom('assignment_snapshots')
    .innerJoin('schedule_versions', 'schedule_versions.id', 'assignment_snapshots.version_id')
    .innerJoin('shifts', 'shifts.id', 'assignment_snapshots.shift_id')
    .innerJoin('shift_types', 'shift_types.id', 'shifts.shift_type_id')
    // LEFT: `shifts.location_id` is nullable and an un-located shift is an
    // ordinary single-site rota, not a broken row (OPUS-M4-000B).
    .leftJoin('locations', 'locations.id', 'shifts.location_id')
    .innerJoin('memberships', 'memberships.id', 'assignment_snapshots.membership_id')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'assignment_snapshots.assignment_identity_id as assignment_identity_id',
      'assignment_snapshots.membership_id as membership_id',
      'assignment_snapshots.starts_at as starts_at',
      'assignment_snapshots.ends_at as ends_at',
      'users.display_name as display_name',
      'shift_types.id as shift_type_id',
      'shift_types.code as code',
      'shift_types.name as name',
      'shift_types.is_on_call as is_on_call',
      'schedule_versions.id as version_id',
      'schedule_versions.version_number as version_number',
      'schedule_versions.period_id as period_id',
      'shifts.location_id as location_id',
      'locations.name as location_name',
      'locations.status as location_status',
      'schedule_versions.timezone_basis as timezone_basis',
    ])
    // A cancelled snapshot is retained so "was this person ever on this
    // version?" stays answerable; it is not content anybody is working.
    .where('assignment_snapshots.status', '=', 'active')
    // Instant overlap, half-open on both sides, so a shift touching the window
    // by a minute is in and one ending exactly at its start is out.
    .where('assignment_snapshots.ends_at', '>', window.start)
    .where('assignment_snapshots.starts_at', '<', window.end)
    .where('schedule_versions.state', '=', 'published')
    .where('schedule_versions.is_current', '=', true);

  if (onlyMembershipId !== null) {
    builder = builder.where('assignment_snapshots.membership_id', '=', onlyMembershipId);
  }

  return (await builder
    .orderBy('assignment_snapshots.starts_at')
    .orderBy('shift_types.code')
    .orderBy('users.display_name')
    .orderBy('assignment_snapshots.assignment_identity_id')
    .execute()) as unknown as PublishedRow[];
}

/** The group's IANA zone. Every local rendering on this surface resolves against it. */
async function groupTimezone(uow: Uow): Promise<string> {
  const query = uow.query as Kysely<Database>;
  const row = (await query
    .selectFrom('groups')
    .select(['timezone'])
    .where('id', '=', uow.context.groupId as string)
    .executeTakeFirst()) as unknown as { timezone: string } | undefined;
  // `groups.timezone` is NOT NULL with a backfilling default, so the fallback is
  // unreachable through the schema; it exists so a missing row can never make a
  // rendering depend on the SERVER's zone, which is the failure that would be
  // invisible until somebody deployed to a machine set to something else.
  return row?.timezone ?? 'UTC';
}

/**
 * One database row, expanded into one entry per local day it occupies.
 *
 * `windowFrom`/`windowTo` clip the expansion to the requested range: an
 * overnight shift starting the day before the window contributes only its
 * continuation, and one starting on the last day contributes only its first
 * half. Both halves still carry `startDate`/`endDate`, so the surface can say
 * "continues from 22:00 on 1 March" even when 1 March is not on screen.
 */
function entriesFor(
  row: PublishedRow,
  timeZone: string,
  windowFrom: string,
  windowTo: string,
): readonly { date: string; entry: ScheduleEntry }[] {
  /* OPUS-M4-000B; doc 34 §4-F. The WALL CLOCK of a published assignment is
   * rendered under the zone its version was PUBLISHED with, not under the
   * group's current zone. A published version is immutable (I-18), and a
   * rendering that moved when an administrator changed a setting would be a
   * mutation of published history performed by a surface that never touched the
   * row. `timezone_basis` is NULL for versions published before migration 0014,
   * and those fall back to the group's zone — the behaviour this surface has
   * always had — with `timezoneSource` saying so on the wire rather than
   * presenting a fallback as a snapshot.
   *
   * `timeZone` (the group's current zone) still cuts the CALENDAR AXIS below: a
   * view has to present one calendar, and bucketing each entry into a different
   * one would produce a sheet whose days do not line up with each other. The two
   * facts are both on the payload and neither is hidden. */
  const renderZone = row.timezone_basis ?? timeZone;
  const renderSource: 'version-snapshot' | 'group-current' =
    row.timezone_basis === null ? 'group-current' : 'version-snapshot';

  const start = localPartsIn(row.starts_at, renderZone);
  const end = localPartsIn(row.ends_at, renderZone);
  /* The DAY BUCKETS come from the group's current zone — one calendar for the
   * whole view — while the times above are the published ones. */
  const axisStart = localPartsIn(row.starts_at, timeZone);
  const axisEnd = localPartsIn(row.ends_at, timeZone);
  const days = daysCovered(axisStart.date, axisEnd.date, axisEnd.time);
  const last = days[days.length - 1] ?? axisStart.date;

  const produced: { date: string; entry: ScheduleEntry }[] = [];
  for (const date of days) {
    if (date < windowFrom || date > windowTo) continue;
    produced.push({
      date,
      entry: {
        assignmentIdentityId: row.assignment_identity_id,
        membershipId: row.membership_id,
        displayName: row.display_name,
        shiftTypeId: row.shift_type_id,
        shiftTypeCode: row.code,
        shiftTypeName: row.name,
        isOnCall: row.is_on_call,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        startDate: start.date,
        endDate: end.date,
        startTime: start.time,
        endTime: end.time,
        isContinuation: date !== axisStart.date,
        continuesToNextDay: date !== last,
        versionId: row.version_id,
        // A published version always has a gapless number (D-9), allocated in
        // the publication transaction. `0` is unreachable and would fail the
        // contract's `positive()`, which is the right way for an impossible
        // state to surface.
        versionNumber: row.version_number ?? 0,
        periodId: row.period_id,
        locationId: row.location_id,
        locationName: row.location_name,
        // Archiving a location RETAINS every existing reference (migration
        // 0014 refuses only NEW ones), so a live published schedule can name a
        // decommissioned place and the reader has to be told which.
        locationArchived: row.location_status === 'archived',
        timezone: renderZone,
        timezoneSource: renderSource,
      },
    });
  }
  return produced;
}

/** Every date in `[from, to]`, ascending. The range is bounded by the contract. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = nextDay(cursor);
  }
  return dates;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────────────────── */

export default function scheduleViewRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/published-schedule';

  /**
   * One person's own published schedule, over a bounded range.
   *
   * The membership is in the PATH so the object policy has something to bind
   * (SPEC-01 §2.3 step 6): a route with no target would have nothing for L5.1 to
   * refuse, and "self-scoped" would be a property of the query alone with no
   * authorization consequence anybody could test.
   */
  app.get(`${base}/members/:membershipId`, { config: OWN_SCHEDULE_CONFIG }, async (request, reply) => {
    const { membershipId } = request.params as { membershipId?: string };

    const outcome = await withViews<{
      membershipId: string;
      displayName: string;
      timezone: string;
      from: string;
      to: string;
      days: ScheduleDay[];
    }>(request, {
      resolveTarget: async (uow) => {
        if (membershipId === undefined || !isUuid(membershipId)) return null;
        const query = uow.query as Kysely<Database>;
        // Resolved under the GROUP-scoped unit of work, so a sibling group's
        // membership is invisible and the denial is the ordinary 404 rather
        // than a 409 disclosing that the person exists elsewhere.
        const row = (await query
          .selectFrom('memberships')
          .select(['id', 'organization_id', 'group_id'])
          .where('id', '=', membershipId)
          .executeTakeFirst()) as unknown as
          | { id: string; organization_id: string; group_id: string | null }
          | undefined;
        if (row === undefined) return null;
        return {
          organizationId: row.organization_id,
          groupId: row.group_id,
          ownerMembershipId: row.id,
        };
      },
      run: async (uow) => {
        const parsed = parseQuery(scheduleRangeQuerySchema, request.query);
        if (parsed.kind !== 'ok') return parsed;
        const { from, to } = parsed.value;

        const actingMembershipId = uow.context.membershipId;
        if (actingMembershipId === null) {
          // Unreachable through the middleware, which requires an acting
          // membership for a group-scoped capability route. A system actor
          // reaching a personal view would have no "own" to scope to, and
          // defaulting one in would be exactly the widening this route refuses.
          return { kind: 'not-found' as const };
        }

        const timezone = await groupTimezone(uow);
        const window = zonedWindow(from, to, timezone);
        const rows = await readPublished(uow, window, actingMembershipId);

        const byDate = new Map<string, ScheduleEntry[]>();
        for (const row of rows) {
          for (const produced of entriesFor(row, timezone, from, to)) {
            const list = byDate.get(produced.date) ?? [];
            list.push(produced.entry);
            byDate.set(produced.date, list);
          }
        }

        const query = uow.query as Kysely<Database>;
        const self = (await query
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select(['users.display_name as display_name'])
          .where('memberships.id', '=', actingMembershipId)
          .executeTakeFirst()) as unknown as { display_name: string } | undefined;
        if (self === undefined) return { kind: 'not-found' as const };

        return {
          kind: 'ok' as const,
          value: {
            membershipId: actingMembershipId,
            displayName: self.display_name,
            timezone,
            from,
            to,
            days: datesBetween(from, to).map((date) => ({
              date,
              entries: byDate.get(date) ?? [],
            })),
          },
        };
      },
    });

    return respond(request, reply, outcome, (schedule) =>
      personalScheduleSchema.parse({ ...schedule, correlationId: request.correlationId }),
    );
  });

  /**
   * The daily assignment sheet for one date.
   *
   * A read of the published master schedule (doc 07 §7, CAP-020) — **not** the
   * picklist `daily_assignments` module, which is a different concept with a
   * different lifecycle and belongs to M9. Nothing here offers a turn.
   */
  app.get(`${base}/daily-sheet`, { config: DAILY_SHEET_CONFIG }, async (request, reply) => {
    const outcome = await withViews<{
      date: string;
      timezone: string;
      entries: ScheduleEntry[];
    }>(request, {
      run: async (uow) => {
        const parsed = parseQuery(dailySheetQuerySchema, request.query);
        if (parsed.kind !== 'ok') return parsed;
        const { date } = parsed.value;

        const timezone = await groupTimezone(uow);
        const window = zonedWindow(date, date, timezone);
        const rows = await readPublished(uow, window, null);

        const entries: ScheduleEntry[] = [];
        for (const row of rows) {
          for (const produced of entriesFor(row, timezone, date, date)) {
            entries.push(produced.entry);
          }
        }

        return { kind: 'ok' as const, value: { date, timezone, entries } };
      },
    });

    return respond(request, reply, outcome, (sheet) =>
      dailySheetSchema.parse({ ...sheet, correlationId: request.correlationId }),
    );
  });
}
