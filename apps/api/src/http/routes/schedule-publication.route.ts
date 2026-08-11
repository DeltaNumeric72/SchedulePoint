import {
  affectedStaffDiffSchema,
  isUuid,
  publicationConfirmationPhrase,
  publicationFrictionTier,
  publicationPhraseMatches,
  publicationRecordListSchema,
  publicationReviewSchema,
  publishedScheduleSchema,
  publishRequestSchema,
  publishResultSchema,
  revertRequestSchema,
  scheduleVersionResultSchema,
  versionSignOffRequestSchema,
  staleReviewBodySchema,
  currentVersionMovedBodySchema,
  validationProblemBodySchema,
  versionComparisonSchema,
  versionHistorySchema,
  type AffectedMember,
  type AssignmentChangeView,
  type PublicationBlocker,
  type PublicationWarning,
  type PublishedVersionView,
  type VersionDifferenceWire,
} from '@schedulepoint/contracts';
import type { Decision, FieldProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import {
  evaluateAction,
  evaluateInTransaction,
  respondToDenial,
} from '../../authz/authorize-request.js';
import type { Database } from '../../db/schema.js';
import { isPostgresError, PG_ERRORS, pgFailureLogFields } from '../../db/pg-errors.js';
import { differenceByIdentity, type DiffSnapshot, type VersionDifference } from '../../schedule/diff.js';
import { ScheduleDeniedError, SchedulePreconditionError } from '../../schedule/errors.js';
import { findHardRuleFindings } from '../../schedule/hard-rule-revalidation.js';
import { publishRevert, publishVersion } from '../../schedule/publication.js';
import { calendarDate, digestRows } from '../../schedule/render.js';
import * as schedule from '../../schedule/service.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The publication and version-management surface (OPUS-M3-005; SPEC-05 §6/§6.1,
 * doc 07 §2–§4, CAP-014).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## The service is frozen; this file is a transport and a set of reads
 *
 * Packet 32 §10a: `apps/api/src/schedule/**` is frozen to every UX packet. The
 * two writes below are calls into `schedule/publication.ts` — which owns the
 * capability evaluation, the period lock, the idempotency record, the required
 * compare-and-set, the supersession, the audit rows and the single outbox event
 * — and this file adds transport, shape validation, reads, the confirmation
 * friction and one additional compare-and-set over the reviewed difference.
 * **No audit event is written here**, because every audit row is the service's
 * and a second writer would be an audit row outside the module that owns the
 * chain (non-bypass rule 6).
 *
 * ## Nothing here can edit a published version, and that is structural
 *
 * There is no route on this surface that writes to a version's content. The two
 * writes are `publishVersion` and `publishRevert`; a revert **clones forward**
 * (SPEC-05 §6.1) and never touches the row it reverts to. D-15a's triggers
 * refuse a content write against a published or superseded version independently
 * of anything decided here, and `assertEditable` in the frozen service refuses it
 * before that. The history read carries `isImmutable` per row so the interface
 * renders the same truth rather than deriving its own.
 *
 * ## The shape every route has, and why it never varies
 *
 * ```
 * runtime.run(command, async (uow) => {
 *   const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *   if (!decision.allowed) return denied(decision);   // nothing written, nothing read
 *   … parse body … lock … compare-and-set … call the service …
 * })
 * ```
 *
 * FAD-12's ordering, identical to `schedule-authoring.route.ts`,
 * `catalogue.route.ts` and `rules.route.ts` deliberately: four slices with the
 * same shape is what makes a deviation visible in review. **Body parsing happens
 * inside the unit of work, after the verdict** (the SBX-001 disclosure finding):
 * parsing first lets an actor who holds nothing in this group send `{}` and
 * receive a `400` describing the body, while a genuinely absent route answers
 * `404`, and those two must be indistinguishable.
 *
 * ## Two compare-and-sets, and why one was not enough
 *
 *  1. **`expectedPriorCurrentVersionId`** (FAD-22(2), required by the frozen
 *     service). It answers "did another publication win this period?". The loser
 *     is told which version is actually current and re-reads — never a silent
 *     supersession of something it never saw.
 *  2. **`expectedReviewDigest`** (this file). It answers "did the draft change
 *     between the review and the confirmation?". A co-author adding or removing
 *     an assignment in that window would otherwise be published by a human who
 *     confirmed a different set of changes. `409 STALE_REVIEW`, with the current
 *     digest, and an explicit re-read.
 *
 * Both are evaluated under a transaction-scoped advisory lock on the PERIOD,
 * taken before either read. Being in one transaction is not enough on its own:
 * `PgUnitOfWorkRunner` issues a plain `BEGIN`, so every unit of work is READ
 * COMMITTED, and an unlocked `SELECT` under READ COMMITTED gives two concurrent
 * confirmations the same pre-state. That exact defect was measured on the
 * authoring surface (11 of 12 rounds, both writers accepted) and fixed the same
 * way. The frozen service takes its own `SELECT … FOR UPDATE` on the period row
 * afterwards; the ordering is always advisory-then-row, in every handler, so no
 * deadlock can arise from this mechanism.
 *
 * ## The replay path skips both compare-and-sets, deliberately
 *
 * A retry carries the SAME idempotency key and the SAME
 * `expectedPriorCurrentVersionId` the client held at review time — but by then
 * the first attempt has committed, so the prior-current has moved to the version
 * that was just published and the CAS would (correctly, for a fresh publication)
 * refuse. Answering `409 CURRENT_VERSION_MOVED` to a retry of a publication that
 * already succeeded would tell a scheduler their publication failed when it
 * published. So when a publication record already exists for this (period, key),
 * the handler goes straight to the service, which reads its own record and
 * returns the RECORDED result with `replay: true`, emitting nothing.
 *
 * This mirrors the frozen service's own ordering (lock → idempotency read → state
 * check → CAS), for the same reason it has that ordering.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Policies. Three EXISTING action keys; this packet adds no domain vocabulary.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Reading versions, history, comparisons and the published schedule —
 * `schedule.version.edit`, CAP-014.
 *
 * **No new read-action key.** The packet permits one "only if missing", and it
 * is not missing: the authoring surface already reads the grid, the version list
 * and the conflict list under this key, these are the same scheduler reading the
 * same group's schedule, and doc 08 §6 puts all of it on one row. Minting
 * `schedule.version.read` would create a second key that every deployment would
 * have to grant alongside the first to preserve today's behaviour, and a key
 * nobody can be without is not an authorization boundary.
 *
 * The staff-facing self-scoped read is a genuinely different question and is
 * OPUS-M3-006's; nothing here answers it.
 */
export const VERSION_READ_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-014' },
  actionScope: 'group',
  action: {
    key: 'schedule.version.edit',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Publishing — `schedule.publish`, CAP-014. **Grant-only, never role-implied**
 * (doc 08 §4): a scheduler drafts freely, and making a draft the authoritative,
 * staff-visible schedule is a separate, named, granted act.
 */
export const PUBLISH_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-014' },
  actionScope: 'group',
  action: {
    key: 'schedule.publish',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/** Reverting — `schedule.revert`, CAP-014. Grant-only and DISTINCT from publish. */
export const REVERT_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-014' },
  actionScope: 'group',
  action: {
    key: 'schedule.revert',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/** The two keys the review evaluates a SECOND time, to render an honest deny state. */
const PUBLISH_ACTION = {
  key: 'schedule.publish',
  moduleKey: 'core_scheduling',
  scope: 'group',
  requiresObjectPolicy: false,
} as const;

const REVERT_ACTION = {
  key: 'schedule.revert',
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
  /** FAD-22(2): another publication won the period. Never a silent supersession. */
  | {
      readonly kind: 'cas-moved';
      readonly currentVersionId: string | null;
      /** The same version's NUMBER, so the interface can name it readably (review N3). */
      readonly currentVersionNumber: number | null;
    }
  /** The reviewed difference is not the difference that would be published. */
  | { readonly kind: 'stale-review'; readonly currentReviewDigest: string }
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
      problems.length > 0
        ? problems
        : [{ field: 'body', message: 'The request body is not valid.' }],
  };
}

/**
 * The mapping from the frozen service's typed precondition failures to responses.
 *
 * `CURRENT_VERSION_MOVED` is deliberately absent: it is handled where the handler
 * still holds the unit of work and can read back which version actually is
 * current, so the loser gets the explicit body rather than a generic conflict.
 */
const CONFLICT_CODES = new Set([
  'VERSION_STATE_UNEXPECTED',
  'VERSION_PERIOD_MISMATCH',
  'OPEN_HARD_BREACH',
  'VERSION_NOT_EDITABLE',
  'VERSION_LOCKED',
  'ILLEGAL_TRANSITION',
  'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_VERSION',
  'IDEMPOTENCY_KEY_INVALID',
  // SPEC-05 §6 step 06 (OPUS-M3-008). A conflict, not a validation failure: the
  // request was well formed and the caller authorized — the CONTENT breaches a
  // HARD rule, or names one this system cannot decide.
  'HARD_RULE_BREACH',
  // OPUS-M4-000A: the catalogue's shift-type qualification requirement edge is
  // unmet by an assignment in the version — enforced structurally, whether or
  // not a duplicate authored rule exists. Same class as HARD_RULE_BREACH for
  // the same reason.
  'QUALIFICATION_REQUIREMENT_BREACH',
]);

function outcomeOfServiceError<T>(error: unknown): Outcome<T> | null {
  if (error instanceof ScheduleDeniedError) return { kind: 'denied', decision: error.decision };
  if (error instanceof SchedulePreconditionError) {
    return CONFLICT_CODES.has(error.code) ? { kind: 'conflict' } : { kind: 'not-found' };
  }
  return null;
}

/**
 * Run one handler in a unit of work, and map its typed failures — **outside the
 * transaction, so a failure rolls the transaction back.**
 *
 * ## The defect this shape exists to prevent, which an earlier version had
 *
 * `schedule-authoring.route.ts` catches the service's typed errors INSIDE the
 * unit of work and returns an outcome. That is safe there, because every
 * authoring service function evaluates, loads and refuses *before* it writes, so
 * there is nothing partial to commit.
 *
 * **It is not safe here.** The publication transaction writes `state =
 * 'publishing'` at step 04 and only then re-checks the prerequisites at steps 05
 * and 08. Catching a step-05 `OPEN_HARD_BREACH` or a step-08
 * `CURRENT_VERSION_MOVED` inside the unit of work and returning normally makes
 * the runner COMMIT — which commits the `publishing` write, leaving the version
 * in a state only the reconciler can clear and blocking every later attempt to
 * publish it. Measured: with the period lock removed so the frozen service's own
 * compare-and-set could fire, the loser of a publication race was left
 * `publishing` rather than `approved`.
 *
 * So the mapping happens after `run` returns, where the only way out of a
 * failure is a thrown error, and a thrown error is a `ROLLBACK`. The publication
 * module's own guarantee — "failure means nothing happened" — is restored to the
 * HTTP surface rather than quietly weakened by it.
 *
 * `apps/api/test/schedule/publication-http.test.ts` asserts it directly: a
 * publication blocked by an open hard breach answers 409 and leaves the version
 * `approved`.
 */
async function withPublication<T>(
  request: FastifyRequest,
  run: (uow: Uow) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  try {
    return await request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
      const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
      // Nothing has been written, so returning (and committing an empty
      // transaction) is correct; a denial is not a failure of the unit of work.
      if (!decision.allowed) return { kind: 'denied', decision };
      return await run(uow);
    });
  } catch (error) {
    if (error instanceof SchedulePreconditionError && error.code === 'CURRENT_VERSION_MOVED') {
      // Reaching here means the frozen service refused a compare-and-set the
      // route had just verified under the period lock. The transaction has rolled
      // back; the current version id is not re-read because doing so would need a
      // second transaction to answer a case the lock makes unreachable.
      request.log.warn(
        { correlationId: request.correlationId },
        'the frozen service refused the compare-and-set the route had verified',
      );
      return { kind: 'cas-moved', currentVersionId: null, currentVersionNumber: null };
    }
    const mapped = outcomeOfServiceError<T>(error);
    if (mapped !== null) return mapped;
    // A NON-database, non-service fault is re-thrown to `setErrorHandler`, which
    // logs it with its stack and answers 500 with the fixed message. Catching
    // everything would turn a bug in this process into a 404 whose log line
    // asserted "refused by the database" about an unexamined cause.
    if (!isPostgresError(error)) throw error;
    if (error.code === PG_ERRORS.uniqueViolation || error.code === PG_ERRORS.exclusionViolation) {
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'publication statement refused by a constraint — reported as a conflict',
      );
      return { kind: 'conflict' };
    }
    /* The RESPONSE is unchanged — a fixed 404 whatever the SQLSTATE was. The LOG
     * distinguishes a control doing its job from a defect in this process, which
     * the uniform handler used to bury (M3-007 NB-3, applied to this surface
     * too). */
    const fields = { correlationId: request.correlationId, ...pgFailureLogFields(error) };
    if (fields.isDefect) request.log.error(fields, 'publication statement refused by the database');
    else request.log.warn(fields, 'publication statement refused by the database');
    return { kind: 'not-found' };
  }
}

function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
  body: (value: T) => unknown,
): FastifyReply | unknown {
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'cas-moved') {
    return reply.code(409).send(
      currentVersionMovedBodySchema.parse({
        error: {
          code: 'CURRENT_VERSION_MOVED',
          message:
            'Another publication reached this period first. Nothing was published — reload the review and decide again.',
          correlationId: request.correlationId,
          currentVersionId: outcome.currentVersionId,
          currentVersionNumber: outcome.currentVersionNumber,
        },
      }),
    );
  }
  if (outcome.kind === 'stale-review') {
    return reply.code(409).send(
      staleReviewBodySchema.parse({
        error: {
          code: 'STALE_REVIEW',
          message:
            'This draft changed while you were reviewing it. Nothing was published — reload the review and check the differences again.',
          correlationId: request.correlationId,
          currentReviewDigest: outcome.currentReviewDigest,
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
 * Serializing competing confirmations
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A stable 64-bit advisory-lock key for an anchor string.
 *
 * Computed here rather than with `hashtextextended` in SQL: it is a pure
 * function that can be tested for determinism without a database, and it does
 * not depend on the stability of a PostgreSQL internal hash across versions — a
 * key that changed between releases would silently stop serializing the writers
 * it used to. `readBigInt64BE` yields the SIGNED 64-bit value
 * `pg_advisory_xact_lock(bigint)` expects.
 */
export function publicationLockKey(anchor: string): bigint {
  return createHash('sha256').update(anchor, 'utf8').digest().readBigInt64BE(0);
}

/**
 * Take the transaction-scoped advisory lock for one period's publication.
 *
 * Released by COMMIT or ROLLBACK — there is no unlock path to forget, and a
 * failed request cannot strand a lock. TENANT-QUALIFIED, because advisory locks
 * are per-database and two groups must not contend by accident; a hash collision
 * across tenants costs a brief wait and can never cost correctness.
 */
async function lockPeriod(uow: Uow, periodId: string): Promise<void> {
  const key = publicationLockKey(
    `${uow.context.organizationId}|${uow.context.groupId ?? ''}|publication:${periodId}`,
  ).toString();
  await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(uow.query as Kysely<Database>);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reads
 * ──────────────────────────────────────────────────────────────────────────── */

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

interface VersionRow {
  id: string;
  period_id: string;
  version_number: number | null;
  state: string;
  lock_state: string;
  is_current: boolean;
  cloned_from_version_id: string | null;
  published_at: Date | null;
  published_by: string | null;
  superseded_at: Date | null;
  superseded_by_version_id: string | null;
  created_at: Date;
}

const VERSION_COLUMNS = [
  'id',
  'period_id',
  'version_number',
  'state',
  'lock_state',
  'is_current',
  'cloned_from_version_id',
  'published_at',
  'published_by',
  'superseded_at',
  'superseded_by_version_id',
  'created_at',
] as const;

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

/** `published` and `superseded` are the frozen states: the row can never change again (I-18). */
function isImmutableState(state: string): boolean {
  return state === 'published' || state === 'superseded';
}

async function loadPeriod(uow: Uow, periodId: string): Promise<PeriodRow | undefined> {
  return (await (uow.query as Kysely<Database>)
    .selectFrom('schedule_periods')
    .select(['id', 'name', 'start_date', 'end_date', 'status'])
    .where('id', '=', periodId)
    .executeTakeFirst()) as unknown as PeriodRow | undefined;
}

async function loadVersion(uow: Uow, versionId: string): Promise<VersionRow | undefined> {
  return (await (uow.query as Kysely<Database>)
    .selectFrom('schedule_versions')
    .select([...VERSION_COLUMNS])
    .where('id', '=', versionId)
    .executeTakeFirst()) as unknown as VersionRow | undefined;
}

/** The version that is current in a period right now, read under the lock. */
async function loadCurrentVersion(uow: Uow, periodId: string): Promise<VersionRow | undefined> {
  return (await (uow.query as Kysely<Database>)
    .selectFrom('schedule_versions')
    .select([...VERSION_COLUMNS])
    .where('period_id', '=', periodId)
    .where('is_current', '=', true)
    .executeTakeFirst()) as unknown as VersionRow | undefined;
}

/**
 * Every group membership's display name.
 *
 * No status filter: a person who has since left the group still appears on a
 * schedule they were assigned to, and rendering their row as an unnamed uuid
 * would make the history of what happened unreadable. `users.display_name` is
 * readable to any context in the same organization through membership — an
 * existing, deliberate boundary (migration 0001), not one this packet opens. No
 * email, no credential, nothing patient-related (I-07).
 */
async function readDisplayNames(uow: Uow): Promise<Map<string, string>> {
  const rows = (await (uow.query as Kysely<Database>)
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select(['memberships.id as id', 'users.display_name as display_name'])
    .where('memberships.kind', '=', 'group')
    .execute()) as unknown as { id: string; display_name: string }[];
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

interface SnapshotRow {
  assignment_identity_id: string;
  membership_id: string;
  date: string | Date;
  starts_at: Date;
  ends_at: Date;
  status: string;
  is_pinned: boolean;
  override_reason: string | null;
  shift_type_id: string;
}

async function readSnapshots(uow: Uow, versionId: string): Promise<SnapshotRow[]> {
  return (await (uow.query as Kysely<Database>)
    .selectFrom('assignment_snapshots')
    .innerJoin('shifts', 'shifts.id', 'assignment_snapshots.shift_id')
    .select([
      'assignment_snapshots.assignment_identity_id as assignment_identity_id',
      'assignment_snapshots.membership_id as membership_id',
      'assignment_snapshots.date as date',
      'assignment_snapshots.starts_at as starts_at',
      'assignment_snapshots.ends_at as ends_at',
      'assignment_snapshots.status as status',
      'assignment_snapshots.is_pinned as is_pinned',
      'assignment_snapshots.override_reason as override_reason',
      'shifts.shift_type_id as shift_type_id',
    ])
    .where('assignment_snapshots.version_id', '=', versionId)
    .execute()) as unknown as SnapshotRow[];
}

function diffSnapshotsOf(rows: readonly SnapshotRow[]): DiffSnapshot[] {
  return rows.map((row) => ({
    assignmentIdentityId: row.assignment_identity_id,
    membershipId: row.membership_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  }));
}

async function readShiftTypes(uow: Uow) {
  const rows = (await (uow.query as Kysely<Database>)
    .selectFrom('shift_types')
    .select(['id', 'code', 'name', 'start_time', 'end_time', 'crosses_midnight'])
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
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
    crossesMidnight: row.crosses_midnight,
  }));
}

async function readTimezone(uow: Uow): Promise<string> {
  const group = (await (uow.query as Kysely<Database>)
    .selectFrom('groups')
    .select(['timezone'])
    .where('id', '=', uow.context.groupId as string)
    .executeTakeFirst()) as unknown as { timezone: string } | undefined;
  return group?.timezone ?? 'UTC';
}

/* ────────────────────────────────────────────────────────────────────────────
 * The difference — the PURE function decides, this file decorates
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Compute the difference between two versions and dress it for a reader.
 *
 * **The pure function is the only thing that decides.** `differenceByIdentity`
 * — the frozen module's, unmodified — produces the changes and the affected set
 * from the two snapshot sets. Everything this function adds afterwards (the
 * date, the shift type, the two instants, the two display names, the per-person
 * tallies) is looked up per identity and cannot alter a kind, a membership, or
 * the membership of the affected set.
 *
 * That separation is what makes the packet's equality requirement checkable
 * rather than a matter of reading the code: `assignmentChangeCoreOf` projects
 * the rendered change back to exactly the four fields the pure function decided,
 * and `publication-diff-parity.test.ts` asserts the projection equals a direct
 * call of `differenceByIdentity` over the same rows.
 */
function decorateDifference(
  core: VersionDifference,
  before: readonly SnapshotRow[],
  after: readonly SnapshotRow[],
  names: ReadonlyMap<string, string>,
): VersionDifferenceWire {
  const byIdentity = new Map<string, SnapshotRow>();
  // The BEFORE side first, then the after side overwrites it: a change is best
  // described by where the assignment ended up, and a `removed` change has only
  // a before side to describe it.
  for (const row of before) byIdentity.set(row.assignment_identity_id, row);
  for (const row of after) byIdentity.set(row.assignment_identity_id, row);

  const changes: AssignmentChangeView[] = core.changes.map((change) => {
    const row = byIdentity.get(change.assignmentIdentityId);
    if (row === undefined) {
      // Unreachable: every identity in the difference came from one of the two
      // snapshot sets this map was built from. It raises rather than inventing a
      // placeholder date, because a rendered change describing the wrong shift
      // is worse than a logged 500.
      throw new Error(
        `PUBLICATION_DIFF_IDENTITY_MISSING: ${change.assignmentIdentityId} is in the difference ` +
          'but in neither snapshot set',
      );
    }
    return {
      assignmentIdentityId: change.assignmentIdentityId,
      kind: change.kind,
      fromMembershipId: change.fromMembershipId,
      toMembershipId: change.toMembershipId,
      date: calendarDate(row.date),
      shiftTypeId: row.shift_type_id,
      shiftTypeCode: '',
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      fromDisplayName:
        change.fromMembershipId === null ? null : (names.get(change.fromMembershipId) ?? null),
      toDisplayName:
        change.toMembershipId === null ? null : (names.get(change.toMembershipId) ?? null),
    };
  });

  return {
    changes,
    affectedMembershipIds: [...core.affectedMembershipIds],
    affectedMembers: tallyAffected(core, names),
  };
}

/**
 * Per-person tallies over the SAME changes.
 *
 * A reassignment counts on both sides — `reassignedAway` for the person who lost
 * the shift and `reassignedTo` for the one who gained it. Counting only the
 * gainer is the defect the affected set's union exists to prevent, one level up.
 */
function tallyAffected(
  core: VersionDifference,
  names: ReadonlyMap<string, string>,
): AffectedMember[] {
  const tally = new Map<string, AffectedMember>();
  const entry = (membershipId: string): AffectedMember => {
    const existing = tally.get(membershipId);
    if (existing !== undefined) return existing;
    const created: AffectedMember = {
      membershipId,
      displayName: names.get(membershipId) ?? null,
      added: 0,
      removed: 0,
      reassignedAway: 0,
      reassignedTo: 0,
      retimed: 0,
    };
    tally.set(membershipId, created);
    return created;
  };
  const bump = (membershipId: string, field: keyof AffectedMember): void => {
    const row = entry(membershipId) as unknown as Record<string, number>;
    row[field] = (row[field] ?? 0) + 1;
  };

  for (const change of core.changes) {
    if (change.kind === 'added' && change.toMembershipId !== null) {
      bump(change.toMembershipId, 'added');
    } else if (change.kind === 'removed' && change.fromMembershipId !== null) {
      bump(change.fromMembershipId, 'removed');
    } else if (change.kind === 'reassigned') {
      if (change.fromMembershipId !== null) bump(change.fromMembershipId, 'reassignedAway');
      if (change.toMembershipId !== null) bump(change.toMembershipId, 'reassignedTo');
    } else if (change.kind === 'retimed' && change.toMembershipId !== null) {
      bump(change.toMembershipId, 'retimed');
    }
  }

  // Sorted by membership id, matching `affectedMembershipIds`, so two runs never
  // differ and a diff of two responses is a diff of their content.
  return [...tally.values()].sort((a, b) => a.membershipId.localeCompare(b.membershipId));
}

/**
 * The digest the confirmation echoes.
 *
 * Over the CORE changes only — the four fields the pure function decided — so a
 * decoration change (a renamed person, a re-ordered shift-type list) can never
 * invalidate a review that is still accurate about what will happen to the
 * schedule. `digestRows` is the frozen module's length-prefixed digest, reused
 * rather than reimplemented, so no value a scheduler can type can forge a field
 * boundary inside the token.
 */
export function reviewDigestOf(core: VersionDifference): string {
  return digestRows(
    core.changes.map((change) => ({
      identity: change.assignmentIdentityId,
      kind: change.kind,
      from: change.fromMembershipId,
      to: change.toMembershipId,
    })),
  );
}

/** Load both sides and compute the difference. `from = null` means "against nothing". */
async function differenceBetween(
  uow: Uow,
  fromVersionId: string | null,
  toVersionId: string,
): Promise<{
  core: VersionDifference;
  wire: VersionDifferenceWire;
  before: SnapshotRow[];
  after: SnapshotRow[];
}> {
  const before = fromVersionId === null ? [] : await readSnapshots(uow, fromVersionId);
  const after = await readSnapshots(uow, toVersionId);
  const core = differenceByIdentity(diffSnapshotsOf(before), diffSnapshotsOf(after));
  const names = await readDisplayNames(uow);
  return { core, wire: decorateDifference(core, before, after, names), before, after };
}

/** Fill in each change's shift-type CODE from the catalogue read the caller already has. */
function withShiftTypeCodes(
  difference: VersionDifferenceWire,
  shiftTypes: readonly { id: string; code: string }[],
): VersionDifferenceWire {
  const codeById = new Map(shiftTypes.map((shiftType) => [shiftType.id, shiftType.code]));
  return {
    ...difference,
    changes: difference.changes.map((change) => ({
      ...change,
      // A retired shift type still has assignments in history; `?` rather than a
      // blank keeps the row readable and says that the code is unavailable.
      shiftTypeCode: codeById.get(change.shiftTypeId) ?? '?',
    })),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Blockers and warnings — each blocker predicts a refusal the server performs
 * ──────────────────────────────────────────────────────────────────────────── */

async function computeBlockers(uow: Uow, version: VersionRow): Promise<PublicationBlocker[]> {
  const blockers: PublicationBlocker[] = [];

  if (isImmutableState(version.state)) {
    blockers.push({
      code: 'VERSION_ALREADY_PUBLISHED',
      message:
        'This version has already been published. Amend it by cloning it into a new draft and publishing forward.',
      conflictId: null,
      ruleKey: null,
    });
  } else if (version.state !== 'approved') {
    blockers.push({
      code: 'VERSION_NOT_APPROVED',
      message: `This version is ${version.state}. Only an approved version can be published.`,
      conflictId: null,
      ruleKey: null,
    });
  }

  const hardBreaches = (await (uow.query as Kysely<Database>)
    .selectFrom('schedule_conflicts')
    .select(['id', 'explanation'])
    .where('version_id', '=', version.id)
    .where('severity', '=', 'hard-breach')
    .where('state', '=', 'open')
    .orderBy('id')
    .execute()) as unknown as { id: string; explanation: string | null }[];

  for (const conflict of hardBreaches) {
    blockers.push({
      code: 'OPEN_HARD_BREACH',
      message:
        conflict.explanation === null
          ? 'An open hard-breach conflict is recorded against this version.'
          : `Open hard breach: ${conflict.explanation}`.slice(0, 300),
      conflictId: conflict.id,
      ruleKey: null,
    });
  }

  /* SPEC-05 §6 step 06, PREDICTED here and PERFORMED in the publication
   * transaction (OPUS-M3-008).
   *
   * The review surface runs the same checker over the same content, so what a
   * scheduler is shown before confirming is what the server will do — the
   * property every other blocker on this branch already has. It is not the
   * control: the control is step 06 inside the transaction, which re-runs after
   * this read and can therefore refuse a publication this preview passed (a
   * credential expiring between the two is exactly that case). */
  for (const finding of await findHardRuleFindings(uow, version.id)) {
    blockers.push({
      code: finding.finding === 'breach' ? 'HARD_RULE_BREACH' : 'HARD_RULE_NOT_EVALUABLE',
      message: (finding.finding === 'breach'
        ? `HARD rule ${finding.ruleKey} (${finding.nodeKind}) is breached: ${finding.explanation}`
        : `HARD rule ${finding.ruleKey} (${finding.nodeKind}) cannot be checked by this system: ` +
          `${finding.explanation}. A HARD rule is never skipped, so publication is blocked.`
      ).slice(0, 300),
      conflictId: null,
      ruleKey: finding.ruleKey,
    });
  }

  return blockers;
}

async function computeWarnings(
  uow: Uow,
  version: VersionRow,
  after: readonly SnapshotRow[],
): Promise<PublicationWarning[]> {
  const warnings: PublicationWarning[] = [];
  const query = uow.query as Kysely<Database>;

  const active = after.filter((row) => row.status === 'active');
  if (active.length === 0) {
    warnings.push({
      code: 'NO_ACTIVE_ASSIGNMENTS',
      message: 'This version has no assignments. Publishing it would leave the period empty.',
      count: 1,
    });
  }

  /* Unmet demand is COUNTING, not rule execution: assignments in a cell against
   * the requirement stated for that cell. It is a WARNING and not a blocker —
   * nothing in SPEC-05, doc 07 or the publication transaction refuses a
   * publication for a short-staffed date, and inventing that refusal here would
   * be a business rule this packet has no authority to make. A rota is
   * frequently published knowingly short. */
  const requirements = (await query
    .selectFrom('schedule_requirements')
    .select(['date', 'shift_type_id', 'required_count'])
    .where('period_id', '=', version.period_id)
    .execute()) as unknown as {
    date: string | Date;
    shift_type_id: string;
    required_count: number;
  }[];

  const filled = new Map<string, number>();
  for (const row of active) {
    const key = `${calendarDate(row.date)}|${row.shift_type_id}`;
    filled.set(key, (filled.get(key) ?? 0) + 1);
  }
  const unmet = requirements.filter(
    (row) =>
      (filled.get(`${calendarDate(row.date)}|${row.shift_type_id}`) ?? 0) < row.required_count,
  ).length;
  if (unmet > 0) {
    warnings.push({
      code: 'UNMET_REQUIREMENT',
      message:
        unmet === 1
          ? '1 stated staffing requirement is not met. This does not block publication.'
          : `${String(unmet)} stated staffing requirements are not met. This does not block publication.`,
      count: unmet,
    });
  }

  const soft = (await query
    .selectFrom('schedule_conflicts')
    .select('id')
    .where('version_id', '=', version.id)
    .where('severity', '=', 'soft')
    .where('state', '=', 'open')
    .execute()) as unknown as { id: string }[];
  if (soft.length > 0) {
    warnings.push({
      code: 'OPEN_SOFT_CONFLICT',
      message:
        soft.length === 1
          ? '1 open soft-breach conflict is recorded. This does not block publication.'
          : `${String(soft.length)} open soft-breach conflicts are recorded. This does not block publication.`,
      count: soft.length,
    });
  }

  return warnings;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The two extra evaluations behind `canPublish` / `canRevert`
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Whether this caller holds a grant-only schedule capability, evaluated through
 * the same evaluator, in the same transaction, against current state (I-19).
 *
 * This is the SERVER half of SP-E §1.3 — "what a user cannot do is absent or
 * disabled-with-reason, but the server verdict is the truth". It exists so the
 * interface can be honest about a power the reader does not hold, and it is
 * **not** the authorization: the publish and revert routes declare their own
 * action keys, and the frozen service re-evaluates the same key inside the
 * publishing transaction. A client that ignored this flag would be refused twice
 * over.
 */
async function holdsGrant(
  uow: Uow,
  request: FastifyRequest,
  action: typeof PUBLISH_ACTION | typeof REVERT_ACTION,
): Promise<boolean> {
  const { context } = requireTenantContext(request);
  const { decision } = await evaluateAction(uow.query as Kysely<Database>, {
    context: {
      principalUserId: context.principalUserId,
      expectedOrganizationId: context.expectedOrganizationId,
      expectedGroupId: context.expectedGroupId,
      membershipId: context.membershipId,
    },
    action,
  });
  return decision.allowed;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────────────────── */

export default function schedulePublicationRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/schedule';

  /* ── the review ─────────────────────────────────────────────── CAP-014 ── */

  app.get(
    `${base}/versions/:versionId/publication-review`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const outcome = await withPublication(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const version = await loadVersion(uow, versionId);
        if (version === undefined) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, version.period_id);
        if (period === undefined) return { kind: 'not-found' as const };

        const current = await loadCurrentVersion(uow, version.period_id);
        // A version that IS current compares against what it superseded, not
        // against itself — otherwise a published version's review would show an
        // empty difference and claim nothing would change.
        const priorId = current === undefined || current.id === versionId ? null : current.id;
        const { core, wire, after } = await differenceBetween(uow, priorId, versionId);
        const shiftTypes = await readShiftTypes(uow);

        const blockers = await computeBlockers(uow, version);
        const warnings = await computeWarnings(uow, version, after);

        const tier = publicationFrictionTier({
          supersedesCurrentVersion: priorId !== null,
          affectedMembershipCount: core.affectedMembershipIds.length,
          isRevert: false,
        });

        const canPublish = await holdsGrant(uow, request, PUBLISH_ACTION);
        const canRevert = canPublish && (await holdsGrant(uow, request, REVERT_ACTION));

        return {
          kind: 'ok' as const,
          value: {
            version: versionView(version),
            period: periodView(period),
            currentVersion: current === undefined ? null : versionView(current),
            expectedPriorCurrentVersionId: priorId,
            reviewDigest: reviewDigestOf(core),
            difference: withShiftTypeCodes(wire, shiftTypes),
            blockers,
            warnings,
            canPublish,
            canRevert,
            frictionTier: tier,
            confirmationPhrase: publicationConfirmationPhrase({
              periodName: period.name,
              isRevert: false,
            }),
            timezone: await readTimezone(uow),
          },
        };
      });

      return respond(request, reply, outcome, (review) =>
        publicationReviewSchema.parse({ ...review, correlationId: request.correlationId }),
      );
    },
  );

  /* ── sign-off (DISCLOSED ADDITION — see the contract) ───────── CAP-014 ── */

  /**
   * Move a version along the lifecycle, short of publication.
   *
   * `schedule.version.edit`, not `schedule.publish`: approving a draft is not
   * publishing it, and the two powers are separate by design (doc 08 §4). The
   * frozen service owns the legality of the move (`LEGAL_TRANSITIONS`), the
   * hard-breach prerequisite on `approved`, and the audit event; this is
   * transport.
   *
   * **This route is not named in packet 32 §10d and is disclosed as an addition.**
   * Without it no version could reach `approved` through any HTTP surface, so the
   * publication flow this packet builds was unreachable end to end. It is one
   * handler over one existing service function and can be removed in one hunk.
   */
  app.post(
    `${base}/versions/:versionId/state`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const outcome = await withPublication(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const parsed = parseBody(versionSignOffRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        await schedule.transitionVersion(uow, actorOf(request), versionId, parsed.value.to);
        const row = await loadVersion(uow, versionId);
        if (row === undefined) return { kind: 'not-found' as const };
        return { kind: 'ok' as const, value: versionView(row) };
      });

      return respond(request, reply, outcome, (version) =>
        scheduleVersionResultSchema.parse({ version, correlationId: request.correlationId }),
      );
    },
  );

  /* ── the publication ────────────────────────────────────────── CAP-014 ── */

  /**
   * Publish a version.
   *
   * Ordering, and every step is load-bearing:
   *
   *  1. the route policy's verdict (`withPublication`), before the body is read;
   *  2. the body's shape;
   *  3. the advisory lock on the PERIOD — before any of the reads below, so two
   *     concurrent confirmations serialize rather than both reading the same
   *     pre-state under READ COMMITTED;
   *  4. the idempotency record. **If one exists, everything after this is
   *     skipped** and the service answers the recorded result as a replay;
   *  5. the confirmation friction, re-computed server-side from the server's own
   *     reading of the world;
   *  6. the review digest compare-and-set;
   *  7. the prior-current compare-and-set;
   *  8. the frozen service, which re-evaluates the capability, takes its own row
   *     lock, re-checks the prerequisites, and owns the audit and outbox writes.
   */
  app.post(
    `${base}/versions/:versionId/publication`,
    { config: PUBLISH_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const outcome = await withPublication(request, async (uow) => {
        if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' as const };
        const parsed = parseBody(publishRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        const input = parsed.value;

        const version = await loadVersion(uow, versionId);
        if (version === undefined) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, version.period_id);
        if (period === undefined) return { kind: 'not-found' as const };

        await lockPeriod(uow, version.period_id);

        const replaying = await recordedPublication(uow, version.period_id, input.idempotencyKey);

        if (replaying === undefined) {
          const current = await loadCurrentVersion(uow, version.period_id);
          const priorId = current === undefined || current.id === versionId ? null : current.id;
          const { core } = await differenceBetween(uow, priorId, versionId);

          const friction = checkFriction(
            {
              supersedesCurrentVersion: priorId !== null,
              affectedMembershipCount: core.affectedMembershipIds.length,
              isRevert: false,
            },
            period.name,
            input.confirmationPhrase,
          );
          if (friction !== null) return friction;

          const currentDigest = reviewDigestOf(core);
          if (currentDigest !== input.expectedReviewDigest) {
            return { kind: 'stale-review' as const, currentReviewDigest: currentDigest };
          }

          if (input.expectedPriorCurrentVersionId !== priorId) {
            return {
              kind: 'cas-moved' as const,
              currentVersionId: priorId,
              currentVersionNumber: priorId === null ? null : (current?.version_number ?? null),
            };
          }
        }

        return publishThrough(() =>
          publishVersion(
            uow,
            actorOf(request),
            {
              periodId: version.period_id,
              versionId,
              idempotencyKey: input.idempotencyKey,
              expectedPriorCurrentVersionId: input.expectedPriorCurrentVersionId,
            },
          ),
        );
      });

      return respond(request, reply, outcome, (result) =>
        publishResultSchema.parse({ ...result, correlationId: request.correlationId }),
      );
    },
  );

  /* ── revert by publishing forward ───────────────────────────── CAP-014 ── */

  /**
   * Revert a period to a historical version, by publishing FORWARD (SPEC-05 §6.1).
   *
   * > "Reverting to v3 creates v5 with v3's content. Deleting v4 would erase the
   * > fact that it happened."
   *
   * So this clones the target into a NEW draft, approves it and publishes that.
   * The version being reverted to is read and never written; the version being
   * reverted from is superseded exactly as any amendment supersedes it. Nothing
   * is deleted and history stays a straight line.
   *
   * **A replay does not clone.** Retrying a revert whose publication already
   * committed must not mint a second draft — a retried request that leaves a
   * stray approved-but-unpublished version behind is a leak the user cannot see.
   * So the idempotency record is read first and, when it exists, the recorded
   * version is handed straight to the service, which replays.
   */
  app.post(`${base}/periods/:periodId/revert`, { config: REVERT_CONFIG }, async (request, reply) => {
    const { periodId } = request.params as { periodId?: string };
    const outcome = await withPublication(request, async (uow) => {
      if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
      const parsed = parseBody(revertRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;
      const input = parsed.value;

      const period = await loadPeriod(uow, periodId);
      if (period === undefined) return { kind: 'not-found' as const };

      const target = await loadVersion(uow, input.revertToVersionId);
      // "Not there" and "not in this period" are the same reply, as "not there"
      // and "not yours" are: RLS makes another group's version invisible and the
      // three must be indistinguishable.
      if (target === undefined || target.period_id !== periodId) {
        return { kind: 'not-found' as const };
      }
      if (!isImmutableState(target.state)) {
        // Reverting to a draft is not a revert — it is publishing a draft, which
        // is the publication route. Refusing here keeps "revert" meaning exactly
        // one thing.
        return { kind: 'conflict' as const };
      }

      await lockPeriod(uow, periodId);

      const replaying = await recordedPublication(uow, periodId, input.idempotencyKey);
      if (replaying !== undefined) {
        return publishThrough(() =>
          publishRevert(uow, actorOf(request), {
            periodId,
            versionId: replaying.version_id,
            idempotencyKey: input.idempotencyKey,
            expectedPriorCurrentVersionId: input.expectedPriorCurrentVersionId,
            revertedToVersionId: input.revertToVersionId,
          }),
        );
      }

      const current = await loadCurrentVersion(uow, periodId);
      const priorId = current?.id ?? null;

      const friction = checkFriction(
        { supersedesCurrentVersion: priorId !== null, affectedMembershipCount: 0, isRevert: true },
        period.name,
        input.confirmationPhrase,
      );
      if (friction !== null) return friction;

      if (input.expectedPriorCurrentVersionId !== priorId) {
        return {
          kind: 'cas-moved' as const,
          currentVersionId: priorId,
          currentVersionNumber: priorId === null ? null : (current?.version_number ?? null),
        };
      }

      // The clone, the approval and the publication are one unit of work: a
      // failure at any point leaves no draft behind, because the transaction
      // rolls back whole.
      const actor = actorOf(request);
      const draftId = await schedule.cloneVersion(uow, actor, input.revertToVersionId);
      await schedule.transitionVersion(uow, actor, draftId, 'in_review');
      await schedule.transitionVersion(uow, actor, draftId, 'approved');

      return publishThrough(() =>
        publishRevert(uow, actor, {
          periodId,
          versionId: draftId,
          idempotencyKey: input.idempotencyKey,
          expectedPriorCurrentVersionId: input.expectedPriorCurrentVersionId,
          revertedToVersionId: input.revertToVersionId,
        }),
      );
    });

    return respond(request, reply, outcome, (result) =>
      publishResultSchema.parse({ ...result, correlationId: request.correlationId }),
    );
  });

  /* ── history ────────────────────────────────────────────────── CAP-014 ── */

  app.get(
    `${base}/periods/:periodId/history`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withPublication(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, periodId);
        if (period === undefined) return { kind: 'not-found' as const };

        const rows = (await (uow.query as Kysely<Database>)
          .selectFrom('schedule_versions')
          .select([...VERSION_COLUMNS])
          .where('period_id', '=', periodId)
          .orderBy('created_at', 'desc')
          .execute()) as unknown as VersionRow[];

        const names = await readDisplayNames(uow);
        const counts = await activeAssignmentCounts(uow, periodId);
        const canPublish = await holdsGrant(uow, request, PUBLISH_ACTION);

        return {
          kind: 'ok' as const,
          value: {
            period: periodView(period),
            versions: rows.map((row) => publishedVersionView(row, names, counts)),
            currentVersionId: rows.find((row) => row.is_current)?.id ?? null,
            canPublish,
            canRevert: canPublish && (await holdsGrant(uow, request, REVERT_ACTION)),
            timezone: await readTimezone(uow),
          },
        };
      });

      return respond(request, reply, outcome, (history) =>
        versionHistorySchema.parse({ ...history, correlationId: request.correlationId }),
      );
    },
  );

  /* ── the published schedule, read-only ──────────────────────── CAP-014 ── */

  app.get(
    `${base}/periods/:periodId/published`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withPublication(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, periodId);
        if (period === undefined) return { kind: 'not-found' as const };

        const current = await loadCurrentVersion(uow, periodId);
        const names = await readDisplayNames(uow);
        const counts = await activeAssignmentCounts(uow, periodId);
        const shiftTypes = await readShiftTypes(uow);

        const snapshots = current === undefined ? [] : await readSnapshots(uow, current.id);
        const assignments = snapshots
          .filter((row) => row.status === 'active')
          .map((row) => ({
            assignmentIdentityId: row.assignment_identity_id,
            membershipId: row.membership_id,
            displayName: names.get(row.membership_id) ?? null,
            date: calendarDate(row.date),
            shiftTypeId: row.shift_type_id,
            startsAt: row.starts_at.toISOString(),
            endsAt: row.ends_at.toISOString(),
            isPinned: row.is_pinned,
            // The reason TEXT never reaches the wire — only that one was given.
            overrideReasonGiven: row.override_reason !== null,
          }))
          // A total, tie-free order, so two reads of an immutable version are
          // byte-identical however the plan returned the rows.
          .sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              a.startsAt.localeCompare(b.startsAt) ||
              a.shiftTypeId.localeCompare(b.shiftTypeId) ||
              a.assignmentIdentityId.localeCompare(b.assignmentIdentityId),
          );

        return {
          kind: 'ok' as const,
          value: {
            period: periodView(period),
            version: current === undefined ? null : publishedVersionView(current, names, counts),
            assignments,
            shiftTypes,
            timezone: await readTimezone(uow),
          },
        };
      });

      return respond(request, reply, outcome, (published) =>
        publishedScheduleSchema.parse({ ...published, correlationId: request.correlationId }),
      );
    },
  );

  /* ── comparison and the affected-staff read ─────────────────── CAP-014 ── */

  app.get(
    `${base}/versions/:versionId/comparison`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const query = request.query as { againstVersionId?: string };

      const outcome = await withPublication(request, async (uow) => {
        const resolved = await resolveComparison(uow, versionId, query.againstVersionId);
        if (resolved.kind !== 'ok') return resolved;
        const { from, to } = resolved.value;

        const { wire } = await differenceBetween(uow, from?.id ?? null, to.id);
        const names = await readDisplayNames(uow);
        const counts = await activeAssignmentCounts(uow, to.period_id);
        const shiftTypes = await readShiftTypes(uow);

        return {
          kind: 'ok' as const,
          value: {
            fromVersion: from === undefined ? null : publishedVersionView(from, names, counts),
            toVersion: publishedVersionView(to, names, counts),
            difference: withShiftTypeCodes(wire, shiftTypes),
            shiftTypes,
            timezone: await readTimezone(uow),
          },
        };
      });

      return respond(request, reply, outcome, (comparison) =>
        versionComparisonSchema.parse({ ...comparison, correlationId: request.correlationId }),
      );
    },
  );

  app.get(
    `${base}/versions/:versionId/affected-staff`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { versionId } = request.params as { versionId?: string };
      const query = request.query as { againstVersionId?: string };

      const outcome = await withPublication(request, async (uow) => {
        const resolved = await resolveComparison(uow, versionId, query.againstVersionId);
        if (resolved.kind !== 'ok') return resolved;
        const { from, to } = resolved.value;

        const { core, wire } = await differenceBetween(uow, from?.id ?? null, to.id);
        return {
          kind: 'ok' as const,
          value: {
            fromVersionId: from?.id ?? null,
            toVersionId: to.id,
            affectedMembers: wire.affectedMembers,
            changeCount: core.changes.length,
          },
        };
      });

      return respond(request, reply, outcome, (affected) =>
        affectedStaffDiffSchema.parse({ ...affected, correlationId: request.correlationId }),
      );
    },
  );

  /* ── publication records (NOT the audit chain — see the contract) ─ CAP-014 ── */

  app.get(
    `${base}/periods/:periodId/publication-records`,
    { config: VERSION_READ_CONFIG },
    async (request, reply) => {
      const { periodId } = request.params as { periodId?: string };
      const outcome = await withPublication(request, async (uow) => {
        if (periodId === undefined || !isUuid(periodId)) return { kind: 'not-found' as const };
        const period = await loadPeriod(uow, periodId);
        if (period === undefined) return { kind: 'not-found' as const };

        /* Raw SQL, deliberately: `publication_records` is absent from the Kysely
         * schema so that no typed `updateTable('publication_records')` can exist
         * (schema.ts §"The publication spine"). Reading it back through the same
         * absence keeps that property — this query cannot be edited into a
         * write, because there is no typed handle to edit it into. */
        const rows = await sql<{
          id: string;
          version_id: string;
          outcome: string;
          created_at: Date;
          actor_membership_id: string | null;
          prerequisites_snapshot: {
            affectedCount?: number;
            priorCurrentVersionId?: string | null;
          } | null;
          version_number: number | null;
        }>`
          SELECT r.id, r.version_id, r.outcome, r.created_at, r.actor_membership_id,
                 r.prerequisites_snapshot, v.version_number
            FROM publication_records r
            JOIN schedule_versions v ON v.id = r.version_id
           WHERE r.period_id = ${periodId}
           ORDER BY r.created_at DESC, r.id DESC
        `.execute(uow.query as Kysely<Database>);

        const names = await readDisplayNames(uow);
        return {
          kind: 'ok' as const,
          value: rows.rows.map((row) => ({
            id: row.id,
            versionId: row.version_id,
            versionNumber: row.version_number,
            outcome: row.outcome as 'published',
            recordedAt: row.created_at.toISOString(),
            actorMembershipId: row.actor_membership_id,
            actorDisplayName:
              row.actor_membership_id === null
                ? null
                : (names.get(row.actor_membership_id) ?? null),
            affectedCount: row.prerequisites_snapshot?.affectedCount ?? null,
            priorCurrentVersionId: row.prerequisites_snapshot?.priorCurrentVersionId ?? null,
          })),
        };
      });

      return respond(request, reply, outcome, (records) =>
        publicationRecordListSchema.parse({
          periodId,
          records,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /* ── helpers that need `Uow` but not the app ────────────────────────────── */

  /** The idempotency record for this (period, key), read under the period lock. */
  async function recordedPublication(
    uow: Uow,
    periodId: string,
    idempotencyKey: string,
  ): Promise<{ version_id: string } | undefined> {
    const rows = await sql<{ version_id: string }>`
      SELECT version_id
        FROM publication_records
       WHERE period_id = ${periodId}
         AND publication_idempotency_key = ${idempotencyKey}
    `.execute(uow.query as Kysely<Database>);
    return rows.rows[0];
  }

  /**
   * Call the frozen service and shape its result for the wire.
   *
   * It deliberately catches NOTHING: the publication transaction writes
   * `state = 'publishing'` before it re-checks its prerequisites, so a failure
   * has to reach `withPublication`'s catch OUTSIDE the unit of work, where it
   * becomes a `ROLLBACK`. Catching here would commit a half-finished
   * publication. See `withPublication`'s docblock for the measurement.
   */
  async function publishThrough(
    run: () => Promise<{
      replay: boolean;
      versionId: string;
      versionNumber: number;
      priorCurrentVersionId: string | null;
      difference: VersionDifference;
    }>,
  ): Promise<
    Outcome<{
      replay: boolean;
      versionId: string;
      versionNumber: number;
      priorCurrentVersionId: string | null;
      affectedMembershipCount: number;
      changeCount: number;
    }>
  > {
    const result = await run();
    return {
      kind: 'ok',
      value: {
        replay: result.replay,
        versionId: result.versionId,
        versionNumber: result.versionNumber,
        priorCurrentVersionId: result.priorCurrentVersionId,
        affectedMembershipCount: result.difference.affectedMembershipIds.length,
        changeCount: result.difference.changes.length,
      },
    };
  }

  /** How many ACTIVE assignments each version of a period holds. Counting only. */
  async function activeAssignmentCounts(
    uow: Uow,
    periodId: string,
  ): Promise<ReadonlyMap<string, number>> {
    const rows = await sql<{ version_id: string; count: string }>`
      SELECT s.version_id, count(*)::text AS count
        FROM assignment_snapshots s
        JOIN schedule_versions v ON v.id = s.version_id
       WHERE v.period_id = ${periodId}
         AND s.status = 'active'
       GROUP BY s.version_id
    `.execute(uow.query as Kysely<Database>);
    return new Map(rows.rows.map((row) => [row.version_id, Number(row.count)]));
  }

  /**
   * Resolve the two sides of a comparison.
   *
   * With no `againstVersionId`, the default "from" is the version this one
   * SUPERSEDED — read from `version_supersessions`, which is the append-only
   * record of what actually happened, rather than from `cloned_from_version_id`,
   * which records where the content came from and is a different question. A
   * first publication has no predecessor and compares against nothing, which
   * correctly renders every assignment as added.
   */
  async function resolveComparison(
    uow: Uow,
    versionId: string | undefined,
    againstVersionId: string | undefined,
  ): Promise<Outcome<{ from: VersionRow | undefined; to: VersionRow }>> {
    if (versionId === undefined || !isUuid(versionId)) return { kind: 'not-found' };
    const to = await loadVersion(uow, versionId);
    if (to === undefined) return { kind: 'not-found' };

    if (againstVersionId !== undefined) {
      if (!isUuid(againstVersionId)) return { kind: 'not-found' };
      const from = await loadVersion(uow, againstVersionId);
      if (from === undefined || from.period_id !== to.period_id) return { kind: 'not-found' };
      return { kind: 'ok', value: { from, to } };
    }

    const superseded = await sql<{ superseded_version_id: string }>`
      SELECT superseded_version_id
        FROM version_supersessions
       WHERE superseding_version_id = ${versionId}
    `.execute(uow.query as Kysely<Database>);
    const predecessorId = superseded.rows[0]?.superseded_version_id;
    return {
      kind: 'ok',
      value: {
        from: predecessorId === undefined ? undefined : await loadVersion(uow, predecessorId),
        to,
      },
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Free functions
 * ──────────────────────────────────────────────────────────────────────────── */

function publishedVersionView(
  row: VersionRow,
  names: ReadonlyMap<string, string>,
  counts: ReadonlyMap<string, number>,
): PublishedVersionView {
  return {
    ...versionView(row),
    publishedAt: row.published_at?.toISOString() ?? null,
    publishedByMembershipId: row.published_by,
    publishedByDisplayName:
      row.published_by === null ? null : (names.get(row.published_by) ?? null),
    supersededAt: row.superseded_at?.toISOString() ?? null,
    supersededByVersionId: row.superseded_by_version_id,
    createdAt: row.created_at.toISOString(),
    isImmutable: isImmutableState(row.state),
    activeAssignmentCount: counts.get(row.id) ?? 0,
  } as PublishedVersionView;
}

/**
 * Enforce the confirmation friction, server-side.
 *
 * The tier is recomputed here from the SERVER's reading of the world, never from
 * anything the client sent, and the phrase is compared through the shared
 * `publicationPhraseMatches` so the client's enable/disable logic and this
 * refusal can never disagree about what counts as confirmed.
 *
 * A friction control that only lives in the browser is decoration: this
 * repository has twice shipped one (a decorative override reason in OPUS-M3-004,
 * a compare-and-set guarded on the wrong counter in OPUS-M3-007) and both were
 * found by asking what the server does when the client omits the field.
 *
 * Returns `null` when the confirmation is satisfied.
 */
function checkFriction(
  input: {
    readonly supersedesCurrentVersion: boolean;
    readonly affectedMembershipCount: number;
    readonly isRevert: boolean;
  },
  periodName: string,
  typed: string | undefined,
): { kind: 'invalid'; problems: readonly FieldProblem[] } | null {
  if (publicationFrictionTier(input) !== 'type-to-confirm') return null;

  const required = publicationConfirmationPhrase({ periodName, isRevert: input.isRevert });
  if (typed !== undefined && publicationPhraseMatches(typed, required)) return null;

  return {
    kind: 'invalid',
    problems: [
      {
        field: 'confirmationPhrase',
        message: `This publication changes a schedule people are already working to. Type “${required}” to confirm it.`.slice(
          0,
          MAX_PROBLEM_MESSAGE,
        ),
      },
    ],
  };
}

/**
 * The acting principal, as the frozen schedule service's actor.
 *
 * The evaluator needs the USER; RLS needs the membership, which travels on the
 * unit of work's context rather than here.
 */
function actorOf(request: FastifyRequest): { principalUserId: string } {
  const { context } = requireTenantContext(request);
  return { principalUserId: context.principalUserId };
}
