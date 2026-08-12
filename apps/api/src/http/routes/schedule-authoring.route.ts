import {
  addAssignmentRequestSchema,
  candidateListSchema,
  cellResultSchema,
  cloneVersionRequestSchema,
  createPeriodRequestSchema,
  periodTransitionRequestSchema,
  createVersionRequestSchema,
  isUuid,
  MAX_PERIOD_DAYS,
  moveCreditRequestSchema,
  reassignAssignmentRequestSchema,
  removeAssignmentRequestSchema,
  scheduleConflictListSchema,
  scheduleGridSchema,
  schedulePeriodListSchema,
  schedulePeriodResultSchema,
  replaceRequirementsRequestSchema,
  scheduleRequirementSetSchema,
  scheduleVersionListSchema,
  scheduleVersionResultSchema,
  setPinRequestSchema,
  staleEditBodySchema,
  staleSetVersionBodySchema,
  validationProblemBodySchema,
  voidCreditRequestSchema,
  type Candidate,
  type GridAssignment,
  type GridCell,
  type GridLocation,
} from '@schedulepoint/contracts';
import type { Decision, FieldProblem } from '@schedulepoint/domain';
import { addDays, resolveLocalTime, resolveShiftInterval } from '@schedulepoint/domain';
import type { FoldPolicy, LocalResolution } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { createHash } from 'node:crypto';

import { evaluateAction, evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import * as catalogue from '../../catalogue/service.js';
import type { Database } from '../../db/schema.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
import { transactionNow } from '../../profiles/work-profiles.js';
import { ScheduleDeniedError, SchedulePreconditionError } from '../../schedule/errors.js';
import { calendarDate, digestRows } from '../../schedule/render.js';
import { transitionPeriodStatus } from '../../schedule/publication.js';
import * as schedule from '../../schedule/service.js';
import { resolveRenderTimezone, timezoneBasisState } from '../../schedule/timezone.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The scheduler-facing schedule-authoring surface (OPUS-M3-004; SPEC-05, doc 07,
 * CAP-014 / CAP-019 / CAP-020).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## This is the MANUAL path, and manual is not the production mechanism
 *
 * Non-bypass rule 7 (I-05): manual scheduling is "override, recovery,
 * fixed-assignment input, and development-stage only". Everything below is a
 * human editing a DRAFT — creating a period, stating demand, assigning somebody,
 * overriding with a reason, pinning a fixed assignment the M4 solver will later
 * consume as INPUT. Nothing here anticipates, approximates or substitutes for
 * the automated engine, and no route offers to "fill" or "generate" anything.
 *
 * ## The service is frozen; this file is a transport
 *
 * Packet 32 §10a: `apps/api/src/schedule/**` is frozen to every UX packet. Every
 * mutation below is a call into `schedule/service.ts` — which owns the
 * capability evaluation, the draft-only check and the audit event — and this
 * file adds transport, shape validation, reads, and the compare-and-set. **No
 * audit event is written here**, because every audit row is the service's and a
 * second writer would be an audit row outside the module that owns the chain
 * (non-bypass rule 6).
 *
 * Note the count precisely, because an earlier version of this comment got it
 * wrong: it is at least one row per mutation, not exactly one. An assignment
 * carrying an override reason emits TWO — `schedule.assignment.added` and
 * `schedule.assignment.overridden` — which is the service's design.
 *
 * ## The shape every mutating route has, and why it never varies
 *
 * ```
 * runtime.run(command, async (uow) => {
 *   const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *   if (!decision.allowed) return denied(decision);   // nothing written
 *   … parse body … compare-and-set … call the service …
 * })
 * ```
 *
 * FAD-12's ordering, identical to `catalogue.route.ts` and `rules.route.ts`
 * deliberately: three slices having the same shape is what makes a deviation
 * visible in review. **Body parsing happens inside the unit of work, after the
 * verdict** (the SBX-001 disclosure finding): parsing first lets an actor who
 * holds nothing in this group send `{}` and receive a `400` describing the body,
 * while a genuinely absent route answers `404`, and those two must be
 * indistinguishable.
 *
 * The service re-evaluates the same action key when it is called. That is
 * deliberate duplication, not an oversight: the route's evaluation is what the
 * fail-closed `onSend` guard requires, and the service's is what makes the
 * service safe for every caller including the fixtures. Both run inside the same
 * transaction against the same state.
 *
 * ## The compare-and-set (PO-DEC-18)
 *
 * > "stale-edit handling: server-authoritative CAS — a stale edit is refused
 * > with an explicit refetch flow, never silently merged."
 *
 * Every cell mutation carries `expectedCellRevision`. The revision is recomputed
 * HERE, inside the transaction, immediately before the service is called, and a
 * mismatch answers `409 STALE_EDIT` carrying the current revision. Nothing is
 * merged, nothing is retried, and the client is told to re-read.
 *
 * ### Being in one transaction is NOT enough, and the first version of this file
 * ### claimed that it was
 *
 * That claim — "the read and the write are the same transaction, so no third
 * party can land an edit between them" — was **false**, and an independent
 * review disproved it by running the race. `PgUnitOfWorkRunner` issues a plain
 * `BEGIN`, so every unit of work is **READ COMMITTED**, and an unlocked `SELECT`
 * under READ COMMITTED gives no protection at all: two transactions read the
 * same pre-state, both find their token current, and both write. Measured: two
 * concurrent requirement writes carrying the same `expectedRevision` **both
 * answered 200 in 11 of 12 rounds**, and the database kept one writer's value
 * while the other was handed a revision for a state that never existed.
 *
 * ### What actually makes it atomic
 *
 * `lockAnchor` takes a transaction-scoped **advisory lock on the anchor being
 * edited** — the cell, or the requirement — as the FIRST statement of the
 * compare-and-set, before the read. Competing writers on the same anchor
 * therefore serialize: the second one blocks until the first commits, its
 * subsequent read (a fresh READ COMMITTED snapshot) sees the committed write,
 * the revision no longer matches, and it gets the explicit `409` and the refetch
 * flow that PO-DEC-18 requires.
 *
 * The lock is taken INSIDE `compareAndSet`/`compareAndSetRequirement` rather
 * than by each route, so a caller cannot forget it. That is deliberate: the
 * defect this closes was invisible in review precisely because every route
 * *looked* correct.
 *
 * Three properties worth stating because each was a live failure:
 *
 *  - **One lock per transaction, taken first.** No lock ordering exists, so no
 *    deadlock can arise from this mechanism.
 *  - **The key is tenant-qualified.** Advisory locks are per-DATABASE, so the
 *    organization and group are part of the hashed string. A hash collision
 *    across tenants costs a brief wait and can never cost correctness.
 *  - **It is taken after the authorization verdict**, so an unauthorized caller
 *    cannot contend for locks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Policies. Two existing action keys; this packet adds no domain vocabulary.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Period administration — `schedule.period.administer`, CAP-019/CAP-020.
 *
 * Creating a planning window and stating how much staffing a date needs is
 * period administration, not version authoring: a period outlives every version
 * inside it, and doc 08 §6 separates the two powers.
 */
export const PERIOD_ADMINISTER_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-019' },
  actionScope: 'group',
  action: {
    key: 'schedule.period.administer',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Draft authoring — `schedule.version.edit`, CAP-014.
 *
 * Distinct from `schedule.publish`, which is grant-only and belongs to
 * OPUS-M3-005. Nothing on this surface publishes, and nothing on it can reach a
 * published version: `assertEditable` in the service refuses, and D-15a's
 * triggers refuse independently.
 */
export const VERSION_EDIT_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-014' },
  actionScope: 'group',
  action: {
    key: 'schedule.version.edit',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * The eligibility read's OWN action key (CAP-058), evaluated separately.
 *
 * See `resolveEligibilityVisibility` for why this is a second evaluation rather
 * than a widening of `schedule.version.edit`.
 */
const ELIGIBILITY_ACTION = {
  key: 'staffing.qualification_holding.read',
  moduleKey: 'core_scheduling',
  scope: 'group',
  requiresObjectPolicy: false,
} as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

type Uow = Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0];

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  /** PO-DEC-18: the caller's revision is not the server's. Never merged. */
  | { readonly kind: 'stale'; readonly currentRevision: string }
  /** OPUS-M4-000A: a whole-set replacement's aggregate `expectedVersion` is stale. */
  | { readonly kind: 'stale-set'; readonly currentVersion: number }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] };

const MAX_PROBLEM_MESSAGE = 300;

/** Parses a body into the outcome shape. Called after the verdict, never before. */
function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): Outcome<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    field: (issue.path.length > 0 ? issue.path.join('.') : 'body').slice(0, 64),
    message:
      issue.message.length > MAX_PROBLEM_MESSAGE
        ? `${issue.message.slice(0, MAX_PROBLEM_MESSAGE - 1)}…`
        : issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0 ? problems : [{ field: 'body', message: 'The request body is not valid.' }],
  };
}

/**
 * The mapping from the service's typed precondition failures to responses.
 *
 * `VERSION_NOT_EDITABLE` and `VERSION_LOCKED` are 409s: the caller was
 * authorized and the world (or the version's state) is not what the edit
 * assumed. Everything else the service raises names a row that is not there, and
 * "not there" and "not yours" are deliberately the same reply because RLS makes
 * another group's row invisible.
 */
const CONFLICT_CODES = new Set(['VERSION_NOT_EDITABLE', 'VERSION_LOCKED', 'OPEN_HARD_BREACH']);

function outcomeOfServiceError<T>(error: unknown): Outcome<T> | null {
  if (error instanceof ScheduleDeniedError) return { kind: 'denied', decision: error.decision };
  if (error instanceof SchedulePreconditionError) {
    return CONFLICT_CODES.has(error.code) ? { kind: 'conflict' } : { kind: 'not-found' };
  }
  return null;
}

async function withSchedule<T>(
  request: FastifyRequest,
  run: (uow: Uow) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };

    try {
      return await run(uow);
    } catch (error) {
      const mapped = outcomeOfServiceError<T>(error);
      if (mapped !== null) return mapped;
      // A NON-database, non-service fault is re-thrown to `setErrorHandler`,
      // which logs it with its stack and answers 500 with the fixed message.
      // Catching everything would turn a bug in this process into a 404 whose
      // log line asserted "refused by the database" about an unexamined cause
      // (catalogue review finding V-02).
      if (!isPostgresError(error)) throw error;
      // A CONSTRAINT collision is a concurrency answer, not a missing row. The
      // first version mapped every database refusal to 404, so the loser of an
      // empty-cell add race — refused by `shifts_unique_in_version` reached
      // through the service's select-then-insert — was told the cell did not
      // exist. The lock above makes that particular race a clean 409 STALE_EDIT
      // instead; this keeps every OTHER collision (D-1a's exclusion, a
      // double-insert) in the 409 class rather than mislabelling it.
      if (
        error.code === PG_ERRORS.uniqueViolation ||
        error.code === PG_ERRORS.exclusionViolation
      ) {
        request.log.warn(
          { correlationId: request.correlationId, sqlstate: error.code },
          'schedule statement refused by a constraint — reported as a conflict',
        );
        return { kind: 'conflict' };
      }
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'schedule statement refused by the database',
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
  if (outcome.kind === 'stale') {
    return reply.code(409).send(
      staleEditBodySchema.parse({
        error: {
          code: 'STALE_EDIT',
          message:
            'Somebody else changed this while you were editing. Your change was not applied — reload and try again.',
          correlationId: request.correlationId,
          currentRevision: outcome.currentRevision,
        },
      }),
    );
  }
  if (outcome.kind === 'stale-set') {
    /* The aggregate cousin of STALE_EDIT (OPUS-M4-000A): the whole-set save is
     * refused WITH the current set version, so the client re-reads the set and
     * decides again. Never merged, never retried blind. */
    return reply.code(409).send(
      staleSetVersionBodySchema.parse({
        error: {
          code: 'STALE_SET_VERSION',
          message: 'The set changed since it was loaded. Re-read it and decide again.',
          currentVersion: outcome.currentVersion,
          correlationId: request.correlationId,
        },
      }),
    );
  }
  if (outcome.kind === 'conflict') {
    return reply.code(409).send({
      error: {
        code: 'CONFLICT',
        message: 'The request could not be completed.',
        correlationId: request.correlationId,
      },
    });
  }
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
 * Time: the server owns the instant, never the browser
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The instant at which `HH:MM` on `YYYY-MM-DD` occurs in `timeZone`.
 *
 * ## This is now a thin delegation, and that is the point (OPUS-M4-000B)
 *
 * It used to be a hand-rolled two-pass offset conversion living in this file.
 * The two passes were real and necessary — a single pass puts a shift on the
 * wrong side of a DST change — but the implementation had two defects doc 34
 * §4-F names:
 *
 *  1. **It could not see a DST FOLD.** On a fall-back day both of its probes
 *     land on the same offset, so `01:30` resolved to one instant and the other
 *     occurrence was invisible. "Ambiguous" and "unique" were the same answer.
 *     `packages/domain/test/time/zoned-time.test.ts` runs the old algorithm as a
 *     mutation control and proves exactly this.
 *  2. **Its GAP behaviour was unstated.** The test that covered it said outright
 *     "*Any answer is a choice*" and asserted only that the result was not NaN.
 *     An unstated rule is one nobody can review and one the next editor can
 *     change without noticing.
 *
 * Both rules are now stated, pinned and shared: `resolveLocalTime` implements
 * **R-B4** (a gap resolves FORWARD by the transition's own gap duration — 30
 * minutes in Lord Howe, two hours in Troll, not a hard-coded hour) and **R-B5**
 * (a fold resolves by ROLE: a shift START takes the earlier occurrence, a shift
 * END the later). Keeping the conversion here would mean the browser-facing
 * surface and the solver-facing surface could drift on what 02:30 means.
 *
 * Exported unchanged in shape for `apps/api/test/schedule/authoring-time.test.ts`.
 */
export function zonedInstant(
  date: string,
  time: string,
  timeZone: string,
  foldPolicy: FoldPolicy = 'earliest',
): Date {
  return resolveLocalTime(timeZone, date, time, foldPolicy).instant;
}

/**
 * The same resolution, with the DST case NAMED rather than collapsed to an
 * instant.
 *
 * `zonedInstant` throws away the discriminant, which is right for the callers
 * that only need a `timestamptz`. This is what a caller uses when it has to
 * TELL somebody — and what the proofs assert on, so a gap or a fold cannot be
 * observed only as "some instant came back".
 */
export function zonedResolution(
  date: string,
  time: string,
  timeZone: string,
  foldPolicy: FoldPolicy = 'earliest',
): LocalResolution {
  return resolveLocalTime(timeZone, date, time, foldPolicy);
}

/**
 * `YYYY-MM-DD` one day after `date`.
 *
 * Delegated to `packages/domain/src/calendar` (OPUS-M4-000B). The previous body
 * went through `Date.UTC`, which SILENTLY ROLLS OVER an invalid input —
 * `Date.UTC(2027, 1, 29)` is `2027-03-01` — so a calendar-invalid date that
 * reached it came back as a real, wrong date rather than as an error. `addDays`
 * asserts the input is a real calendar date first.
 */
function nextDay(date: string): string {
  return addDays(date, 1);
}

/**
 * Every date in `[start, end]`, ascending.
 *
 * **Throws rather than truncating.** The first version stopped at an iteration
 * guard of 400 and returned what it had, so a period longer than that rendered a
 * schedule that was not the schedule — in BOTH renderings, with nothing on
 * screen saying so. A rota that silently omits its last months is worse than an
 * error, so this raises and the request becomes a logged 500 with the fixed
 * message, while `MAX_PERIOD_DAYS` stops such a period being created at all.
 * Reaching the throw means a row exists that the authoring surface could not
 * have written.
 */
function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    if (dates.length >= MAX_PERIOD_DAYS) {
      throw new Error(
        `SCHEDULE_PERIOD_TOO_LONG: a period spanning more than ${String(MAX_PERIOD_DAYS)} days ` +
          `cannot be rendered (${start}..${end}); it predates the length bound and needs splitting`,
      );
    }
    dates.push(cursor);
    cursor = nextDay(cursor);
  }
  return dates;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Serializing competing writers — what makes the compare-and-set atomic
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A stable 64-bit advisory-lock key for an anchor string.
 *
 * Computed HERE rather than with `hashtextextended` in SQL for two reasons: it
 * is a pure function this repository can test for determinism without a
 * database, and it does not depend on the stability of a PostgreSQL internal
 * hash across versions — a key that changed between releases would silently stop
 * serializing the writers it used to.
 *
 * `readBigInt64BE` yields the SIGNED 64-bit value `pg_advisory_xact_lock(bigint)`
 * expects; an unsigned reading would overflow `bigint` for half of all inputs.
 */
export function advisoryLockKey(anchor: string): bigint {
  return createHash('sha256').update(anchor, 'utf8').digest().readBigInt64BE(0);
}

/**
 * Take the transaction-scoped advisory lock for one anchor.
 *
 * Released by COMMIT or ROLLBACK — there is no unlock path to forget, and a
 * failed request cannot strand a lock.
 */
async function lockAnchor(uow: Uow, anchor: string): Promise<void> {
  // TENANT-QUALIFIED: advisory locks are per-database, and two groups editing
  // "the same" date and shift type must not contend by accident.
  const key = advisoryLockKey(
    `${uow.context.organizationId}|${uow.context.groupId ?? ''}|${anchor}`,
  ).toString();
  await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(uow.query as Kysely<Database>);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Revisions — the compare-and-set token
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The revision of one grid cell.
 *
 * A digest of CONTENT, not of a timestamp: `timestamptz` read back through
 * node-postgres is millisecond-truncated, so two edits inside one millisecond
 * would digest identically and the second would silently overwrite the first —
 * exactly the merge PO-DEC-18 forbids. Every field a cell mutation can change is
 * in the digest, so any of them moving invalidates a held token.
 *
 * `digestRows` is the schedule module's own length-prefixed digest (frozen, and
 * reused rather than reimplemented), so no value a scheduler can type can forge
 * a field boundary inside the token.
 */
export function cellRevision(assignments: readonly GridAssignment[]): string {
  return digestRows(
    assignments.map((assignment) => ({
      identity: assignment.assignmentIdentityId,
      snapshot: assignment.snapshotId,
      membership: assignment.membershipId,
      status: assignment.status,
      pinned: assignment.isPinned,
      pick: assignment.pickPosition,
      startsAt: assignment.startsAt,
      endsAt: assignment.endsAt,
      overridden: assignment.overrideReasonGiven,
      credit: assignment.creditId,
      credited: assignment.creditedMembershipId,
      creditStatus: assignment.creditStatus,
      // OPUS-M4-000B. A cell mutation can now change WHERE the shift happens,
      // and a token that ignored it would let a concurrent relocation pass the
      // compare-and-set and be overwritten silently — the same defect every
      // other field in this digest exists to close. `locationName` and
      // `locationArchived` are deliberately NOT here: they are derived from the
      // location row, not from the cell, so an administrator renaming or
      // archiving a location must not invalidate a scheduler's held token.
      location: assignment.locationId,
    })),
  );
}

/* The per-cell `requirementRevision` digest that lived here is retired with
 * the per-cell requirement PUT (OPUS-M4-000A): the aggregate set version in
 * `staffing_set_versions` is the requirement editor's one CAS token now. */

/* ────────────────────────────────────────────────────────────────────────────
 * Reads
 * ──────────────────────────────────────────────────────────────────────────── */

interface SnapshotRow {
  id: string;
  assignment_identity_id: string;
  membership_id: string;
  shift_id: string;
  date: string | Date;
  starts_at: Date;
  ends_at: Date;
  origin: string;
  pick_position: number | null;
  is_pinned: boolean;
  status: string;
  override_reason: string | null;
}

interface CreditRow {
  id: string;
  assignment_identity_id: string;
  credited_membership_id: string;
  status: string;
}

/** The active content of one version, keyed by `date|shiftTypeId`. */
async function readCells(uow: Uow, versionId: string): Promise<Map<string, GridAssignment[]>> {
  const query = uow.query as Kysely<Database>;

  const rows = (await query
    .selectFrom('assignment_snapshots')
    .innerJoin('shifts', 'shifts.id', 'assignment_snapshots.shift_id')
    .leftJoin('locations', 'locations.id', 'shifts.location_id')
    .select([
      'assignment_snapshots.id as id',
      'assignment_snapshots.assignment_identity_id as assignment_identity_id',
      'assignment_snapshots.membership_id as membership_id',
      'assignment_snapshots.shift_id as shift_id',
      'assignment_snapshots.date as date',
      'assignment_snapshots.starts_at as starts_at',
      'assignment_snapshots.ends_at as ends_at',
      'assignment_snapshots.origin as origin',
      'assignment_snapshots.pick_position as pick_position',
      'assignment_snapshots.is_pinned as is_pinned',
      'assignment_snapshots.status as status',
      'assignment_snapshots.override_reason as override_reason',
      'shifts.shift_type_id as shift_type_id',
      // OPUS-M4-000B: the location is a property of the SHIFT, so it arrives
      // through the join that is already here. `locations` is LEFT-joined
      // because `location_id` is nullable and a shift without one is a stated
      // allowed state, not a broken row.
      'shifts.location_id as location_id',
      'locations.name as location_name',
      'locations.status as location_status',
    ])
    .where('assignment_snapshots.version_id', '=', versionId)
    // ACTIVE only. A cancelled snapshot is retained so "was this person ever on
    // this draft?" stays answerable, but it is not content the grid renders and
    // it is not content the compare-and-set is about.
    .where('assignment_snapshots.status', '=', 'active')
    .execute()) as unknown as (SnapshotRow & {
    shift_type_id: string;
    location_id: string | null;
    location_name: string | null;
    location_status: string | null;
  })[];

  const credits = (await query
    .selectFrom('credits')
    .select(['id', 'assignment_identity_id', 'credited_membership_id', 'status'])
    .where('source_version_id', '=', versionId)
    .execute()) as unknown as CreditRow[];
  const creditByIdentity = new Map(credits.map((credit) => [credit.assignment_identity_id, credit]));

  const cells = new Map<string, GridAssignment[]>();
  for (const row of rows) {
    const credit = creditByIdentity.get(row.assignment_identity_id);
    const assignment: GridAssignment = {
      assignmentIdentityId: row.assignment_identity_id,
      snapshotId: row.id,
      membershipId: row.membership_id,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.status === 'cancelled' ? 'cancelled' : 'active',
      origin: (['manual', 'solver', 'clone', 'picklist', 'import'] as const).includes(
        row.origin as 'manual',
      )
        ? (row.origin as GridAssignment['origin'])
        : 'manual',
      isPinned: row.is_pinned,
      // The reason TEXT never reaches the wire — only that one was given.
      overrideReasonGiven: row.override_reason !== null,
      pickPosition: row.pick_position,
      creditId: credit?.id ?? null,
      creditedMembershipId: credit?.credited_membership_id ?? null,
      creditStatus: (credit?.status as GridAssignment['creditStatus']) ?? null,
      locationId: row.location_id,
      locationName: row.location_name,
      // Archiving RETAINS existing references (migration 0014 refuses only new
      // ones), so a live schedule can legitimately name a decommissioned place
      // and the grid has to say so rather than render it as any other location.
      locationArchived: row.location_status === 'archived',
    };
    const key = cellKey(calendarDate(row.date), row.shift_type_id);
    const list = cells.get(key) ?? [];
    list.push(assignment);
    cells.set(key, list);
  }

  // A total, tie-free order, so the digest and the rendering are both stable
  // whatever order the plan returned rows in.
  for (const list of cells.values()) {
    list.sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) ||
        a.membershipId.localeCompare(b.membershipId) ||
        a.assignmentIdentityId.localeCompare(b.assignmentIdentityId),
    );
  }
  return cells;
}

export function cellKey(date: string, shiftTypeId: string): string {
  return `${date}|${shiftTypeId}`;
}

/** The active group memberships a cell editor may offer. */
async function readRoster(
  uow: Uow,
): Promise<{ membershipId: string; displayName: string; staffingKind: 'staff' | 'locum'; status: 'invited' | 'active' | 'suspended' | 'ended' }[]> {
  const query = uow.query as Kysely<Database>;
  const rows = (await query
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.id as id',
      'memberships.staffing_kind as staffing_kind',
      'memberships.status as status',
      'users.display_name as display_name',
    ])
    .where('memberships.kind', '=', 'group')
    .orderBy('users.display_name')
    .execute()) as unknown as {
    id: string;
    staffing_kind: string;
    status: string;
    display_name: string;
  }[];

  return rows.map((row) => ({
    membershipId: row.id,
    displayName: row.display_name,
    staffingKind: row.staffing_kind === 'locum' ? 'locum' : 'staff',
    status: row.status as 'invited' | 'active' | 'suspended' | 'ended',
  }));
}

async function loadPeriod(
  uow: Uow,
  periodId: string,
): Promise<PeriodRow | undefined> {
  const query = uow.query as Kysely<Database>;
  return (await query
    .selectFrom('schedule_periods')
    .select(['id', 'name', 'start_date', 'end_date', 'status'])
    .where('id', '=', periodId)
    .executeTakeFirst()) as unknown as PeriodRow | undefined;
}

interface VersionRow {
  id: string;
  period_id: string;
  version_number: number | null;
  state: string;
  lock_state: string;
  is_current: boolean;
  cloned_from_version_id: string | null;
}

async function loadVersionRow(uow: Uow, versionId: string): Promise<VersionRow | undefined> {
  const query = uow.query as Kysely<Database>;
  return (await query
    .selectFrom('schedule_versions')
    .select([
      'id',
      'period_id',
      'version_number',
      'state',
      'lock_state',
      'is_current',
      'cloned_from_version_id',
    ])
    .where('id', '=', versionId)
    .executeTakeFirst()) as unknown as VersionRow | undefined;
}

function versionView(row: VersionRow) {
  return {
    id: row.id,
    periodId: row.period_id,
    versionNumber: row.version_number,
    state: row.state as 'draft',
    lockState: row.lock_state as 'unlocked',
    isCurrent: row.is_current,
    clonedFromVersionId: row.cloned_from_version_id,
    isEditable: row.state === 'draft' && row.lock_state === 'unlocked',
  };
}

interface PeriodRow {
  id: string;
  name: string;
  start_date: string | Date;
  end_date: string | Date;
  status: string;
}

function periodView(row: PeriodRow) {
  return {
    id: row.id,
    name: row.name,
    startDate: calendarDate(row.start_date),
    endDate: calendarDate(row.end_date),
    status: row.status as 'planning',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Eligibility: the absent-vs-empty ruling, in one function
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Whether this caller may be told anything about credentials — the SERVER half
 * of the absent-vs-empty ruling (packet 32 §10b, "Owns rulings").
 *
 * ## The problem
 *
 * A scheduler holds `schedule.version.edit`. Eligibility is derived from
 * `qualification_holdings`, which doc 06 §3.2 classifies `SENSITIVE-PII` and
 * whose RLS SELECT policies carry a capability predicate: without
 * `staffing.qualification_holding.read` a caller sees **no holdings** — and
 * `listMembershipEligibility` then reports every requirement as missing and
 * every member as `eligible: false`.
 *
 * That answer is not merely unhelpful, it is FALSE in the direction that matters.
 * "Nobody is qualified" and "you cannot see who is qualified" are different
 * facts, and rendering the second as the first would tell a scheduler that a
 * qualified colleague is not qualified — a patient-safety-adjacent lie produced
 * by an access-control artefact. The catalogue service says the same thing from
 * its own side: its answer "is a report about what the caller can see, not a
 * verdict about the member".
 *
 * ## The ruling implemented here (the proposed default)
 *
 * The eligibility read's OWN action key is evaluated separately, in this
 * transaction, through the same evaluator. Allowed → eligibility is KNOWN and
 * computed. Denied → eligibility is **ABSENT**: every candidate's `eligible` is
 * `null`, the whole roster is still offered, and the client is required to say
 * so in words. Absent is never collapsed into empty and never rendered as "no".
 *
 * Assignment is not blocked in either arm, because this surface IS the override
 * and recovery mechanism (non-bypass rule 7) and eligibility here is a report
 * rather than an enforcement point — enforcement against qualifications belongs
 * to M3-008's publication-time validation and to the M4 engine, each computing
 * with its own credential.
 *
 * **Reversing the ruling is one edit**: return `false` unconditionally to make
 * eligibility always absent, or drop the second evaluation and let the RLS
 * artefact through to make absent indistinguishable from empty. Nothing else in
 * the file reads the capability.
 */
export async function resolveEligibilityVisibility(
  uow: Uow,
  request: FastifyRequest,
): Promise<boolean> {
  const { context } = requireTenantContext(request);
  const { decision } = await evaluateAction(uow.query as Kysely<Database>, {
    context: {
      principalUserId: context.principalUserId,
      expectedOrganizationId: context.expectedOrganizationId,
      expectedGroupId: context.expectedGroupId,
      membershipId: context.membershipId,
    },
    action: ELIGIBILITY_ACTION,
  });
  return decision.allowed;
}

/**
 * Whether an override reason is REQUIRED for this assignment — the enforcement
 * half of the eligibility ruling.
 *
 * The ruling's table decides, and it decides in exactly one direction:
 *
 * | Caller sees | Requirement |
 * |---|---|
 * | eligibility ABSENT (no CAP-058 key) | **no reason can be demanded** — there is nothing to override, and demanding one would train schedulers to type "n/a" into a field the audit trail depends on |
 * | no row for this member × shift type | the same: absent per row |
 * | `eligible: true` | none |
 * | `eligible: false` | **required** |
 *
 * Until this existed the reason was decorative: a blank one saved, the client
 * sent no field at all, and nothing on the server looked. That hollowed out both
 * the ruling's required-reason arm and non-bypass rule 7's override discipline —
 * an override that records no reason is not an override, it is an edit.
 */
async function overrideReasonRequired(
  uow: Uow,
  request: FastifyRequest,
  input: { readonly membershipId: string; readonly shiftTypeId: string },
): Promise<boolean> {
  // ABSENT: the caller cannot see credentials, so nothing can be demanded.
  if (!(await resolveEligibilityVisibility(uow, request))) return false;

  const at = await transactionNow(uow.query as Kysely<Database>);
  const rows = await catalogue.listMembershipEligibility(uow, input.membershipId, at);
  const forShiftType = rows.find((row) => row.shiftTypeId === input.shiftTypeId);
  // A missing row is ABSENT for this member, not ineligible — the same ruling,
  // applied per row.
  return forShiftType !== undefined && !forShiftType.eligible;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────────────────── */

export default function scheduleAuthoringRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/schedule';

  /* ── periods ────────────────────────────────────── CAP-019 / CAP-020 ──── */

  app.get(`${base}/periods`, { config: PERIOD_ADMINISTER_CONFIG }, async (request, reply) => {
    const outcome = await withSchedule(request, async (uow) => {
      const query = uow.query as Kysely<Database>;
      const rows = (await query
        .selectFrom('schedule_periods')
        .select(['id', 'name', 'start_date', 'end_date', 'status'])
        .orderBy('start_date')
        .execute()) as unknown as PeriodRow[];
      return { kind: 'ok' as const, value: rows.map(periodView) };
    });

    return respond(request, reply, outcome, (periods) =>
      schedulePeriodListSchema.parse({ periods, correlationId: request.correlationId }),
    );
  });

  app.post(`${base}/periods`, { config: PERIOD_ADMINISTER_CONFIG }, async (request, reply) => {
    const outcome = await withSchedule(request, async (uow) => {
      const parsed = parseBody(createPeriodRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      // The service owns the capability check, the insert and the audit event.
      // D-2's no-overlap exclusion is the control on the range; a friendly
      // pre-check here would only race it.
      const id = await schedule.createPeriod(uow, actorOf(request), {
        name: parsed.value.name,
        startDate: parsed.value.startDate,
        endDate: parsed.value.endDate,
      });
      const row = await loadPeriod(uow, id);
      if (row === undefined) return { kind: 'not-found' as const };
      return { kind: 'ok' as const, value: periodView(row) };
    });

    return respond(request, reply, outcome, (period) =>
      schedulePeriodResultSchema.parse({ period, correlationId: request.correlationId }),
    );
  });

  /* ── requirements ───────────────────────────────── CAP-019 / CAP-020 ──── */

  /**
   * The load-before-edit read (OPUS-M4-000A): the period's requirement rows
   * PLUS the aggregate set version the whole-set save must present. The
   * per-row revision tokens the pre-M4 editor carried are gone from this wire
   * shape — the aggregate version subsumes them, and two tokens for one edit
   * would be two answers to "what did I read".
   */
  app.get(
    `${base}/periods/:periodId/requirements`,
    { config: PERIOD_ADMINISTER_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        return { kind: 'ok' as const, value: await schedule.readRequirementSet(uow, periodId) };
      });

      return respond(request, reply, outcome, (set) =>
        scheduleRequirementSetSchema.parse({
          periodId,
          requirements: set.requirements,
          version: set.version,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /**
   * The WHOLE-SET requirements replacement (OPUS-M4-000A; doc 34 §4-A).
   *
   * Saving produces exactly the presented set; an omitted entry is DELETED
   * (the canonical rule, stated in the contract and on the page). The
   * aggregate `expectedVersion` CAS refuses interleaving — the service takes
   * the advisory lock BEFORE its reads, so two concurrent replacements can
   * never combine into a union. A stale save answers `409 STALE_SET_VERSION`
   * with the current version (PO-DEC-18's explicit refetch flow). One user
   * action, one request, one audit event when — and only when — something
   * moved (I-10; FAD-24).
   */
  app.put(
    `${base}/periods/:periodId/requirements`,
    { config: PERIOD_ADMINISTER_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, periodId);
        if (period === undefined) return { kind: 'not-found' as const };
        const parsed = parseBody(replaceRequirementsRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const result = await schedule.replaceRequirements(uow, actorOf(request), periodId, {
          requirements: parsed.value.requirements,
          expectedVersion: parsed.value.expectedVersion,
        });
        if (result.kind === 'stale-set') return result;
        if (result.kind === 'invalid') {
          return {
            kind: 'invalid' as const,
            problems: result.problems.map((problem) => ({
              field: problem.field,
              message: problem.message,
            })),
          };
        }
        return { kind: 'ok' as const, value: result.value };
      });

      return respond(request, reply, outcome, (result) =>
        scheduleRequirementSetSchema.parse({
          periodId,
          requirements: result.requirements,
          version: result.version,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /* ── versions ───────────────────────────────────────────────── CAP-014 ── */

  app.get(
    `${base}/periods/:periodId/versions`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        const query = uow.query as Kysely<Database>;
        const rows = (await query
          .selectFrom('schedule_versions')
          .select([
            'id',
            'period_id',
            'version_number',
            'state',
            'lock_state',
            'is_current',
            'cloned_from_version_id',
            'created_at',
          ])
          .where('period_id', '=', periodId)
          .orderBy('created_at')
          .execute()) as unknown as (VersionRow & { created_at: Date })[];
        return { kind: 'ok' as const, value: rows.map(versionView) };
      });

      return respond(request, reply, outcome, (versions) =>
        scheduleVersionListSchema.parse({
          periodId,
          versions,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  app.post(
    `${base}/periods/:periodId/versions`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        const parsed = parseBody(createVersionRequestSchema, request.body ?? {});
        if (parsed.kind !== 'ok') return parsed;

        const id = await schedule.createDraftVersion(uow, actorOf(request), periodId);
        const row = await loadVersionRow(uow, id);
        if (row === undefined) return { kind: 'not-found' as const };
        return { kind: 'ok' as const, value: versionView(row) };
      });

      return respond(request, reply, outcome, (version) =>
        scheduleVersionResultSchema.parse({ version, correlationId: request.correlationId }),
      );
    },
  );

  /**
   * Clone a version into a new draft.
   *
   * This is how a published version is amended: SPEC-05 §6.1 — clone, edit the
   * clone, publish forward. **There is no route on this surface that edits a
   * published version**, and if one were written the service and D-15a would
   * both refuse it.
   */
  app.post(`${base}/versions/clone`, { config: VERSION_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withSchedule(request, async (uow) => {
      const parsed = parseBody(cloneVersionRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const id = await schedule.cloneVersion(uow, actorOf(request), parsed.value.sourceVersionId);
      const row = await loadVersionRow(uow, id);
      if (row === undefined) return { kind: 'not-found' as const };
      return { kind: 'ok' as const, value: versionView(row) };
    });

    return respond(request, reply, outcome, (version) =>
      scheduleVersionResultSchema.parse({ version, correlationId: request.correlationId }),
    );
  });

  /* ── the grid ───────────────────────────────────────────────── CAP-014 ── */

  app.get(
    `${base}/versions/:versionId/grid`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const version = await loadVersionRow(uow, versionId);
        if (version === undefined) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, version.period_id);
        if (period === undefined) return { kind: 'not-found' as const };

        const query = uow.query as Kysely<Database>;
        const shiftTypes = (await query
          .selectFrom('shift_types')
          .select(['id', 'code', 'name', 'start_time', 'end_time', 'crosses_midnight', 'status'])
          .where('status', '=', 'active')
          .orderBy('report_order')
          .orderBy('code')
          .execute()) as unknown as {
          id: string;
          code: string;
          name: string;
          start_time: string;
          end_time: string;
          crosses_midnight: boolean;
        }[];

        const requirements = (await query
          .selectFrom('schedule_requirements')
          .select(['date', 'shift_type_id', 'required_count'])
          .where('period_id', '=', version.period_id)
          .execute()) as unknown as {
          date: string | Date;
          shift_type_id: string;
          required_count: number;
        }[];

        const conflicts = (await query
          .selectFrom('schedule_conflicts')
          .select(['id', 'severity', 'state', 'explanation'])
          .where('version_id', '=', versionId)
          .orderBy('id')
          .execute()) as unknown as {
          id: string;
          severity: string;
          state: string;
          explanation: string | null;
        }[];

        /* OPUS-M4-000B: the zone this version's instants were derived under —
         * the version's recorded basis where it has one, the group's current
         * zone otherwise. A PUBLISHED version therefore keeps rendering under
         * the zone it was published with, so an administrator changing the
         * group's timezone cannot move a schedule that is already immutable
         * (I-18). `source` carries which of the two answered, so the fallback is
         * visible rather than disguised as a snapshot. */
        const renderZone = await resolveRenderTimezone(uow, versionId);
        const basisState = await timezoneBasisState(uow, versionId);

        /* Archived locations are INCLUDED. Existing shifts still reference them
         * and the grid has to label those; the client offers only the active
         * ones as a NEW target, and the database refuses the rest regardless
         * (`SCHEDULE_SHIFT_LOCATION_ARCHIVED`). */
        const locationRows = (await query
          .selectFrom('locations')
          .select(['id', 'name', 'site_label', 'timezone', 'status'])
          .orderBy('name')
          .execute()) as unknown as {
          id: string;
          name: string;
          site_label: string | null;
          timezone: string | null;
          status: string;
        }[];
        const locations: GridLocation[] = locationRows.map((row) => ({
          id: row.id,
          name: row.name,
          siteLabel: row.site_label,
          // DISPLAY METADATA ONLY. The GROUP timezone governs every schedule
          // semantic (OPUS-M4-000B's ruling; doc 06 §Time). Nothing computes
          // from this value — `renderZone` above is what every instant on this
          // payload was derived under.
          timezone: row.timezone,
          archived: row.status === 'archived',
        }));

        const assignmentsByCell = await readCells(uow, versionId);
        const requiredByCell = new Map(
          requirements.map((row) => [
            cellKey(calendarDate(row.date), row.shift_type_id),
            row.required_count,
          ]),
        );

        const keys = new Set([...assignmentsByCell.keys(), ...requiredByCell.keys()]);
        const cells: GridCell[] = [...keys]
          .sort()
          .map((key) => {
            const [date = '', shiftTypeId = ''] = key.split('|');
            const assignments = assignmentsByCell.get(key) ?? [];
            return {
              date,
              shiftTypeId,
              requiredCount: requiredByCell.get(key) ?? 0,
              assignments,
              revision: cellRevision(assignments),
            };
          })
          // A requirement for a shift type that has since been retired is not a
          // cell the grid can render; dropping it here keeps the response
          // consistent with the axes rather than describing a column that is
          // not there.
          .filter((cell) => shiftTypes.some((shiftType) => shiftType.id === cell.shiftTypeId));

        return {
          kind: 'ok' as const,
          value: {
            version: versionView(version),
            period: periodView(period),
            dates: datesBetween(calendarDate(period.start_date), calendarDate(period.end_date)),
            shiftTypes: shiftTypes.map((shiftType) => ({
              id: shiftType.id,
              code: shiftType.code,
              name: shiftType.name,
              startTime: shiftType.start_time.slice(0, 5),
              endTime: shiftType.end_time.slice(0, 5),
              crossesMidnight: shiftType.crosses_midnight,
            })),
            cells,
            emptyCellRevision: cellRevision([]),
            conflicts: conflicts.map((conflict) => ({
              id: conflict.id,
              severity: conflict.severity as 'info',
              state: conflict.state as 'open',
              explanation: conflict.explanation,
            })),
            roster: await readRoster(uow),
            locations,
            timezone: renderZone.zone,
            timezoneSource: renderZone.source,
            tzdbVersion: renderZone.tzdb,
            timezoneStale: basisState.kind === 'stale',
          },
        };
      });

      return respond(request, reply, outcome, (grid) =>
        scheduleGridSchema.parse({ ...grid, correlationId: request.correlationId }),
      );
    },
  );

  app.get(
    `${base}/versions/:versionId/conflicts`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const query = uow.query as Kysely<Database>;
        const rows = (await query
          .selectFrom('schedule_conflicts')
          .select(['id', 'severity', 'state', 'explanation'])
          .where('version_id', '=', versionId)
          .orderBy('id')
          .execute()) as unknown as {
          id: string;
          severity: string;
          state: string;
          explanation: string | null;
        }[];
        return {
          kind: 'ok' as const,
          value: rows.map((row) => ({
            id: row.id,
            severity: row.severity as 'info',
            state: row.state as 'open',
            explanation: row.explanation,
          })),
        };
      });

      return respond(request, reply, outcome, (conflicts) =>
        scheduleConflictListSchema.parse({
          versionId,
          conflicts,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /* ── the cell editor's candidate list (the eligibility ruling) ─ CAP-014 ── */

  app.get(
    `${base}/versions/:versionId/candidates`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const params = request.query as { date?: string; shiftTypeId?: string };

      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const date = params.date ?? '';
        const shiftTypeId = params.shiftTypeId ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isUuid(shiftTypeId)) {
          return { kind: 'not-found' as const };
        }
        const version = await loadVersionRow(uow, versionId);
        if (version === undefined) return { kind: 'not-found' as const };

        const roster = await readRoster(uow);
        const cells = await readCells(uow, versionId);
        const assigned = new Set(
          (cells.get(cellKey(date, shiftTypeId)) ?? []).map((row) => row.membershipId),
        );

        const eligibilityKnown = await resolveEligibilityVisibility(uow, request);

        // One transaction clock for every row. Expiry makes eligibility
        // time-dependent, and two rows evaluated against two clock readings
        // inside one transaction is the class the in-force loader exists to
        // prevent.
        const at = await transactionNow(uow.query as Kysely<Database>);

        const candidates: Candidate[] = [];
        for (const member of roster) {
          if (member.status !== 'active') continue;
          let eligible: boolean | null = null;
          let missing: string[] = [];
          if (eligibilityKnown) {
            // The SHIPPED eligibility rule, reused rather than re-derived: a
            // second selection rule for holdings is the S-01 defect class, and
            // `loader-is-the-only-selector.test.ts` fails the build on one.
            const rows = await catalogue.listMembershipEligibility(uow, member.membershipId, at);
            const forShiftType = rows.find((row) => row.shiftTypeId === shiftTypeId);
            // A shift type with no row is ABSENT for this member, not
            // ineligible — the same ruling, applied per row.
            eligible = forShiftType === undefined ? null : forShiftType.eligible;
            missing = forShiftType === undefined ? [] : [...forShiftType.missingQualificationIds];
          }
          candidates.push({
            membershipId: member.membershipId,
            displayName: member.displayName,
            staffingKind: member.staffingKind,
            eligible,
            missingQualificationIds: missing,
            alreadyAssigned: assigned.has(member.membershipId),
          });
        }

        return { kind: 'ok' as const, value: { eligibilityKnown, candidates } };
      });

      return respond(request, reply, outcome, (result) =>
        candidateListSchema.parse({
          date: params.date,
          shiftTypeId: params.shiftTypeId,
          eligibilityKnown: result.eligibilityKnown,
          candidates: result.candidates,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /* ── cell mutations. Draft-only, compare-and-set, service-owned audit ─────
   *
   * The requirement editor's per-cell compare-and-set that used to live here
   * (`compareAndSetRequirement`) is SUPERSEDED by the whole-set aggregate CAS
   * in `schedule/service.ts` `replaceRequirements` (OPUS-M4-000A): the same
   * lock-then-read discipline, on the aggregate the editor actually presents.
   * The cell CAS below is unchanged. */

  /**
   * Re-read one cell and compare it against what the caller believed.
   *
   * The advisory lock is taken FIRST, so a competing writer on this cell blocks
   * until this transaction commits and then reads the committed result. Being in
   * one transaction is not enough on its own — see this file's header.
   */
  async function compareAndSet(
    uow: Uow,
    versionId: string,
    date: string,
    shiftTypeId: string,
    expected: string,
  ): Promise<{ kind: 'ok'; assignments: GridAssignment[] } | { kind: 'stale'; currentRevision: string }> {
    // FIRST, before the read. This is the whole control: without it the read is
    // an unlocked SELECT under READ COMMITTED and two writers both pass.
    await lockAnchor(uow, `cell:${versionId}:${date}:${shiftTypeId}`);
    const cells = await readCells(uow, versionId);
    const assignments = cells.get(cellKey(date, shiftTypeId)) ?? [];
    const current = cellRevision(assignments);
    if (current !== expected) return { kind: 'stale', currentRevision: current };
    return { kind: 'ok', assignments };
  }

  /** The cell as it stands after a mutation — what every mutation returns. */
  async function cellAfter(
    uow: Uow,
    versionId: string,
    date: string,
    shiftTypeId: string,
  ): Promise<GridCell> {
    const cells = await readCells(uow, versionId);
    const assignments = cells.get(cellKey(date, shiftTypeId)) ?? [];
    const query = uow.query as Kysely<Database>;
    const version = await loadVersionRow(uow, versionId);
    const requirement =
      version === undefined
        ? undefined
        : ((await query
            .selectFrom('schedule_requirements')
            .select(['required_count'])
            .where('period_id', '=', version.period_id)
            .where('date', '=', date)
            .where('shift_type_id', '=', shiftTypeId)
            .executeTakeFirst()) as unknown as { required_count: number } | undefined);

    return {
      date,
      shiftTypeId,
      requiredCount: requirement?.required_count ?? 0,
      assignments,
      revision: cellRevision(assignments),
    };
  }

  /** Where an identity currently sits, so a targeted mutation knows its cell. */
  async function locateIdentity(
    uow: Uow,
    versionId: string,
    identityId: string,
  ): Promise<{ date: string; shiftTypeId: string } | null> {
    const cells = await readCells(uow, versionId);
    for (const [key, assignments] of cells) {
      if (assignments.some((row) => row.assignmentIdentityId === identityId)) {
        const [date = '', shiftTypeId = ''] = key.split('|');
        return { date, shiftTypeId };
      }
    }
    return null;
  }

  app.post(
    `${base}/versions/:versionId/assignments`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const parsed = parseBody(addAssignmentRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        const input = parsed.value;

        const version = await loadVersionRow(uow, versionId);
        if (version === undefined) return { kind: 'not-found' as const };

        const cas = await compareAndSet(
          uow,
          versionId,
          input.date,
          input.shiftTypeId,
          input.expectedCellRevision,
        );
        if (cas.kind === 'stale') return cas;

        // The override gate. A blank reason never reaches here — the contract
        // rejects an empty string — so absence is the only case to check.
        if (input.overrideReason === undefined) {
          if (await overrideReasonRequired(uow, request, input)) {
            return {
              kind: 'invalid' as const,
              problems: [
                {
                  field: 'overrideReason',
                  message:
                    'This person does not hold every credential this shift type requires. Record why you are assigning them anyway.',
                },
              ],
            };
          }
        }

        const query = uow.query as Kysely<Database>;
        const shiftType = (await query
          .selectFrom('shift_types')
          .select(['start_time', 'end_time', 'crosses_midnight'])
          .where('id', '=', input.shiftTypeId)
          .executeTakeFirst()) as unknown as
          | { start_time: string; end_time: string; crosses_midnight: boolean }
          | undefined;
        if (shiftType === undefined) return { kind: 'not-found' as const };

        /* The SERVER derives the instants, from the shift type's times and the
         * GROUP's zone. A browser that computed them would write the viewer's
         * zone into the schedule, and two schedulers in two zones would author
         * two different shifts from the same click.
         *
         * The zone is the version's BASIS (OPUS-M4-000B): a draft records the
         * zone it was created under, and every instant written into it resolves
         * against that same zone. Deriving against the group's CURRENT zone
         * instead would let a mid-draft timezone change produce a version whose
         * rows were built under two different interpretations — which no
         * staleness check can untangle afterwards, because the rows carry no
         * record of which one built them.
         *
         * `resolveShiftInterval` applies R-B4 and R-B5: a start in a DST gap is
         * normalized FORWARD by the transition's own gap, a start in a fold
         * takes the earlier occurrence and an end in a fold the later — the
         * pairing that keeps `ends_at > starts_at` across a fall-back and covers
         * the repeated hour exactly once. It also owns the overnight decision,
         * so `crosses_midnight` on the catalogue row and the derived end date
         * cannot disagree. */
        const renderZone = await resolveRenderTimezone(uow, versionId);
        const interval = resolveShiftInterval(
          renderZone.zone,
          input.date,
          shiftType.start_time.slice(0, 5),
          shiftType.end_time.slice(0, 5),
        );

        await schedule.addManualAssignment(uow, actorOf(request), {
          versionId,
          membershipId: input.membershipId,
          shiftTypeId: input.shiftTypeId,
          date: input.date,
          startsAt: interval.startsAt,
          endsAt: interval.endsAt,
          locationId: input.locationId ?? null,
          ...(input.isPinned === undefined ? {} : { isPinned: input.isPinned }),
          ...(input.overrideReason === undefined ? {} : { overrideReason: input.overrideReason }),
        });

        return {
          kind: 'ok' as const,
          value: await cellAfter(uow, versionId, input.date, input.shiftTypeId),
        };
      });

      return respond(request, reply, outcome, (cell) =>
        cellResultSchema.parse({ cell, correlationId: request.correlationId }),
      );
    },
  );

  app.post(
    `${base}/versions/:versionId/assignments/:identityId/removal`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId, identityId } = request.params as {
        versionId?: string;
        identityId?: string;
      };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        if (identityId === undefined || !isUuid(identityId)) return { kind: 'not-found' as const };
        const parsed = parseBody(removeAssignmentRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const at = await locateIdentity(uow, versionId, identityId);
        if (at === null) return { kind: 'not-found' as const };

        const cas = await compareAndSet(
          uow,
          versionId,
          at.date,
          at.shiftTypeId,
          parsed.value.expectedCellRevision,
        );
        if (cas.kind === 'stale') return cas;

        await schedule.removeAssignment(
          uow,
          actorOf(request),
          versionId,
          identityId,
          parsed.value.reason,
        );
        return { kind: 'ok' as const, value: await cellAfter(uow, versionId, at.date, at.shiftTypeId) };
      });

      return respond(request, reply, outcome, (cell) =>
        cellResultSchema.parse({ cell, correlationId: request.correlationId }),
      );
    },
  );

  app.post(
    `${base}/versions/:versionId/assignments/:identityId/reassignment`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId, identityId } = request.params as {
        versionId?: string;
        identityId?: string;
      };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        if (identityId === undefined || !isUuid(identityId)) return { kind: 'not-found' as const };
        const parsed = parseBody(reassignAssignmentRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const at = await locateIdentity(uow, versionId, identityId);
        if (at === null) return { kind: 'not-found' as const };

        const cas = await compareAndSet(
          uow,
          versionId,
          at.date,
          at.shiftTypeId,
          parsed.value.expectedCellRevision,
        );
        if (cas.kind === 'stale') return cas;

        // The IDENTITY is preserved — that is what makes the affected-staff diff
        // say "this assignment moved from A to B" rather than "one vanished and
        // an unrelated one appeared".
        await schedule.reassignAssignment(
          uow,
          actorOf(request),
          versionId,
          identityId,
          parsed.value.toMembershipId,
          parsed.value.reason,
        );
        return { kind: 'ok' as const, value: await cellAfter(uow, versionId, at.date, at.shiftTypeId) };
      });

      return respond(request, reply, outcome, (cell) =>
        cellResultSchema.parse({ cell, correlationId: request.correlationId }),
      );
    },
  );

  /**
   * The fixed-assignment pin.
   *
   * A SOLVER INPUT, not an editing control (doc 07, SPEC-05): pinning says "the
   * M4 engine may not move this", which is exactly the sense in which manual
   * content is fixed input rather than a schedule in its own right.
   */
  app.put(
    `${base}/versions/:versionId/assignments/:identityId/pin`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId, identityId } = request.params as {
        versionId?: string;
        identityId?: string;
      };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        if (identityId === undefined || !isUuid(identityId)) return { kind: 'not-found' as const };
        const parsed = parseBody(setPinRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const at = await locateIdentity(uow, versionId, identityId);
        if (at === null) return { kind: 'not-found' as const };

        const cas = await compareAndSet(
          uow,
          versionId,
          at.date,
          at.shiftTypeId,
          parsed.value.expectedCellRevision,
        );
        if (cas.kind === 'stale') return cas;

        await schedule.setPin(uow, actorOf(request), versionId, identityId, parsed.value.isPinned);
        return { kind: 'ok' as const, value: await cellAfter(uow, versionId, at.date, at.shiftTypeId) };
      });

      return respond(request, reply, outcome, (cell) =>
        cellResultSchema.parse({ cell, correlationId: request.correlationId }),
      );
    },
  );

  /* ── credits: the tenth concept, and draft-only (FAD-22(1)) ─────────────── */

  app.put(
    `${base}/versions/:versionId/assignments/:identityId/credit`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId, identityId } = request.params as {
        versionId?: string;
        identityId?: string;
      };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        if (identityId === undefined || !isUuid(identityId)) return { kind: 'not-found' as const };
        const parsed = parseBody(moveCreditRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const at = await locateIdentity(uow, versionId, identityId);
        if (at === null) return { kind: 'not-found' as const };

        const cas = await compareAndSet(
          uow,
          versionId,
          at.date,
          at.shiftTypeId,
          parsed.value.expectedCellRevision,
        );
        if (cas.kind === 'stale') return cas;

        const snapshot = cas.assignments.find((row) => row.assignmentIdentityId === identityId);
        if (snapshot === undefined) return { kind: 'not-found' as const };

        // Moving a credit NEVER touches the snapshot — that separation is the
        // whole point of the tenth concept, and the service writes only
        // `credits`. It is draft-only because a credit against a published
        // version is frozen by D-15a and could never be corrected.
        await schedule.moveCredit(uow, actorOf(request), {
          versionId,
          assignmentIdentityId: identityId,
          snapshotId: snapshot.snapshotId,
          creditedMembershipId: parsed.value.creditedMembershipId,
          ...(parsed.value.weight === undefined ? {} : { weight: parsed.value.weight }),
          ...(parsed.value.reason === undefined ? {} : { reason: parsed.value.reason }),
        });
        return { kind: 'ok' as const, value: await cellAfter(uow, versionId, at.date, at.shiftTypeId) };
      });

      return respond(request, reply, outcome, (cell) =>
        cellResultSchema.parse({ cell, correlationId: request.correlationId }),
      );
    },
  );

  app.post(
    `${base}/versions/:versionId/credits/:creditId/void`,
    { config: VERSION_EDIT_CONFIG },
    async (request, reply) => {
      const { versionId, creditId } = request.params as { versionId?: string; creditId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        if (creditId === undefined || !isUuid(creditId)) return { kind: 'not-found' as const };
        const parsed = parseBody(voidCreditRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const cells = await readCells(uow, versionId);
        let located: { date: string; shiftTypeId: string } | null = null;
        for (const [key, assignments] of cells) {
          if (assignments.some((row) => row.creditId === creditId)) {
            const [date = '', shiftTypeId = ''] = key.split('|');
            located = { date, shiftTypeId };
          }
        }
        if (located === null) return { kind: 'not-found' as const };

        const cas = await compareAndSet(
          uow,
          versionId,
          located.date,
          located.shiftTypeId,
          parsed.value.expectedCellRevision,
        );
        if (cas.kind === 'stale') return cas;

        await schedule.voidCredit(uow, actorOf(request), creditId);
        return {
          kind: 'ok' as const,
          value: await cellAfter(uow, versionId, located.date, located.shiftTypeId),
        };
      });

      return respond(request, reply, outcome, (cell) =>
        cellResultSchema.parse({ cell, correlationId: request.correlationId }),
      );
    },
  );

  /* ── the period lifecycle transition ─────────────────── OPUS-M4-000C ──── */

  /**
   * Close or reopen a schedule period (doc 34 §4-G).
   *
   * `schedule_periods.status` has existed since migration 0009 with a
   * three-value domain and NOTHING enforcing it: a `closed` period accepted new
   * versions, new requirements and new publications exactly as an open one did.
   * Migration 0015 closes the enforcement half at the database; this is the
   * explicit, audited transition that is the only way past those refusals.
   *
   * The service owns the capability check, the row lock, the legality table and
   * the audit event — as every other write on this surface does. This handler is
   * transport and shape validation, deliberately self-contained: it is appended
   * as its own block and touches no assignment or authoring endpoint above it.
   */
  app.put(
    `${base}/periods/:periodId/status`,
    { config: PERIOD_ADMINISTER_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withSchedule(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        // Body parsing INSIDE the unit of work and AFTER the verdict (SBX-001):
        // parsing first lets an actor who holds nothing in this group tell an
        // absent route from a present one by the shape of the refusal.
        const parsed = parseBody(periodTransitionRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        await transitionPeriodStatus(uow, actorOf(request), periodId, parsed.value.to);
        const row = await loadPeriod(uow, periodId);
        if (row === undefined) return { kind: 'not-found' as const };
        return { kind: 'ok' as const, value: periodView(row) };
      });

      return respond(request, reply, outcome, (period) =>
        schedulePeriodResultSchema.parse({ period, correlationId: request.correlationId }),
      );
    },
  );
}

/**
 * The acting principal, as the schedule service's actor.
 *
 * The evaluator needs the USER; RLS needs the membership, which travels on the
 * unit of work's context rather than here.
 */
function actorOf(request: FastifyRequest): { principalUserId: string } {
  const { context } = requireTenantContext(request);
  return { principalUserId: context.principalUserId };
}
