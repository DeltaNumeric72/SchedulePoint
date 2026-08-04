import {
  conflictBodySchema,
  createGroupHolidayRequestSchema,
  createShiftGroupRequestSchema,
  createShiftTypeRequestSchema,
  createStaffGroupRequestSchema,
  createValidGroupRequestSchema,
  groupHolidayListSchema,
  groupHolidayResultSchema,
  isUuid,
  membershipEligibilitySchema,
  pickPositionCountSchema,
  setPickPositionCountRequestSchema,
  setShiftTypeQualificationsRequestSchema,
  setWeekdayDemandRequestSchema,
  shiftGroupListSchema,
  shiftGroupResultSchema,
  shiftTypeListSchema,
  shiftTypeQualificationListSchema,
  shiftTypeResultSchema,
  staffGroupListSchema,
  staffGroupResultSchema,
  updateShiftGroupRequestSchema,
  updateShiftTypeRequestSchema,
  validGroupListSchema,
  validGroupResultSchema,
  validationProblemBodySchema,
  weekdayDemandSchema,
  type ConflictBody,
} from '@schedulepoint/contracts';
import type { AuditEventName, AuditPayload, Decision, FieldProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAuditEvent } from '../../audit/recorder.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import {
  CATALOGUE_AUDIT_EVENTS,
  ELIGIBILITY_READ_CONFIG,
  HOLIDAY_CONFIG,
  HOLIDAY_READ_CONFIG,
  PICK_POSITION_CONFIG,
  SHIFT_GROUP_CONFIG,
  SHIFT_TYPE_CONFIG,
  SHIFT_TYPE_QUALIFICATION_CONFIG,
  STAFF_GROUP_CONFIG,
  VALID_GROUP_CONFIG,
} from '../../catalogue/policies.js';
import * as catalogue from '../../catalogue/service.js';
import type { CatalogueOutcome } from '../../catalogue/service.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
import { transactionNow } from '../../profiles/work-profiles.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';

/**
 * The scheduling-structure catalogue's HTTP surface (OPUS-M2-002; CAP-011,
 * CAP-012, and the CAR-011 holiday slice).
 *
 * ## The shape every mutating route has, and why it never varies
 *
 * ```
 * runtime.run(command, async (uow) => {
 *   const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *   if (!decision.allowed) return denied(decision);   // nothing written
 *   … the mutation …
 *   await recordAuditEvent(uow, { eventName, subjectType, subjectId });
 * })
 * ```
 *
 * FAD-12's ordering — **evaluate → deny → mutate → audit, in ONE unit of work**.
 * The evaluation is first so a denial writes neither the change nor an audit row
 * claiming one; the audit write is last and inside the same transaction, so the
 * two commit or roll back together; and the verdict is against current state
 * inside the transaction that writes (I-19).
 *
 * `withCatalogueCommand` below is that shape, once, as a function. Ten handlers
 * repeating it by hand would be ten chances to get the order wrong, and the
 * wrong order is invisible in review — it looks like the right one.
 *
 * ## Why this file is thin
 *
 * Route auto-discovery requires `*.route.ts` to live in this directory; the slice
 * itself lives under `apps/api/src/catalogue/`. Everything here is transport:
 * parse, delegate, choose a status code.
 *
 * ## Four failure shapes, and the difference between them matters
 *
 * | Shape | Status | Reached when |
 * |---|---|---|
 * | denial | 403 / 404, chosen by `denialDisclosure` alone | the evaluator said no. **No reason on the wire** (P-3) |
 * | not found | 404, byte-identical to every other tenant 404 | RLS made the row invisible, or it does not exist. The two are the same answer (T-05b) |
 * | validation | **422 with field-addressed problems** | the caller holds the capability in this group and typed something wrong |
 * | conflict | 409, one fixed code | a tenant-qualified unique key or an exclusion constraint fired |
 *
 * The 422 is the only one that carries detail, and it is the only one where
 * detail discloses nothing: reaching it requires having passed the evaluator in
 * the declared group, so everything it names is something the caller just sent.
 */

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] };

/**
 * Parses a request body into the catalogue outcome shape.
 *
 * **Called INSIDE the unit of work, after the authorization decision** — and
 * that ordering is a disclosure control rather than a style choice. Parsing
 * first meant an actor who holds nothing in this group could send `{}` and
 * receive a `400` describing the body the route expects, while a genuinely
 * absent route answers `404`. The two must be indistinguishable to that actor
 * (SPEC-01 §2.4, SPEC-06 P-3).
 *
 * Found by SBX-001's role × route matrix, which sends `{}` to every registered
 * route as every principal and classifies the answer. It reported a `400` that
 * was neither an allow, a clean deny, nor a context refusal — which is exactly
 * what that scenario exists to notice.
 *
 * A schema failure is a **422**, not a 400: the body was well-formed JSON and
 * specific fields were wrong, which is a different fact from "this request was
 * not intelligible", and it is the fact an authoring form can act on.
 */
function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): CatalogueOutcome<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    field: String(issue.path[0] ?? 'body'),
    message: issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0 ? problems : [{ field: 'body', message: 'The request body is not valid.' }],
  };
}

/**
 * Validates a uuid path parameter — **inside the unit of work, after the
 * authorization decision**, for exactly the reason `parseBody` is called there.
 *
 * ## Why validation and not a catch
 *
 * `GET …/shift-types/:shiftTypeId/qualifications` used to hand the raw segment
 * to the database, so a non-uuid raised `22P02` inside the read. The first fix
 * caught every database error and answered `404` — the right answer reached the
 * wrong way, because it also swallowed faults that had nothing to do with the
 * identifier while logging a cause it had never checked. A malformed identifier
 * is a SHAPE problem, decidable before any statement runs; deciding it here
 * means the `22P02` class never reaches the database, which is what lets the
 * error handling below be narrow enough to be honest (review finding V-02).
 *
 * ## Why AFTER the verdict
 *
 * An unauthorized caller must not be able to tell "that is not a uuid" from
 * "you may not do this". Validating before the evaluator would answer `404` for
 * a malformed id and `403` for a well-formed one, which hands an actor who
 * holds nothing here the parameter's shape — the same disclosure SBX-001 found
 * in the body parsing and the same fix (SPEC-01 §2.4, SPEC-06 P-3).
 */
function requireUuid(value: string | undefined): CatalogueOutcome<never> | null {
  return value !== undefined && isUuid(value) ? null : { kind: 'not-found' };
}

/** SQLSTATE 23505 — a row with this tenant-qualified key already exists. */
function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.uniqueViolation;
}

/**
 * Runs one catalogue command under FAD-12's ordering.
 *
 * `audit` is called only when the command reports `ok`, and it is called INSIDE
 * the same unit of work — so there is no path on which a mutation commits
 * without its audit row, and none on which an audit row survives a rolled-back
 * mutation.
 */
async function withCatalogueCommand<T>(
  request: FastifyRequest,
  run: (uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0]) => Promise<CatalogueOutcome<T>>,
  audit: (
    value: T,
  ) => {
    eventName: AuditEventName;
    subjectType: string;
    subjectId: string;
    /** Identifiers, tokens and counts only. Never free text (I-07). */
    payload?: AuditPayload;
  } | null,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };

    let outcome: CatalogueOutcome<T>;
    try {
      outcome = await run(uow);
    } catch (error) {
      // A NON-database fault is re-thrown, and that is the correction rather
      // than a refinement: catching everything turned a bug in this process —
      // a TypeError, a contract parse failure, an exhausted pool — into a 404
      // carrying a log line that asserted "refused by the database" about a
      // cause it had never checked. Rethrowing sends it to `setErrorHandler`,
      // which logs the real error with its stack and answers 500 with the fixed
      // message (review finding V-02).
      if (!isPostgresError(error)) throw error;
      if (isUniqueViolation(error)) return { kind: 'conflict' };
      // Every other DATABASE error becomes a plain 404. A SQLSTATE on the wire
      // describes the schema, and a constraint name describes it precisely.
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'catalogue statement refused by the database',
      );
      return { kind: 'not-found' };
    }

    if (outcome.kind !== 'ok') return outcome;

    const entry = audit(outcome.value);
    if (entry !== null) {
      await recordAuditEvent(uow, {
        eventName: entry.eventName,
        subjectType: entry.subjectType as never,
        subjectId: entry.subjectId,
        // Optional, and only ever a closed payload: `assertClosedAuditPayload`
        // and the `app_audit_payload_is_closed` CHECK both refuse anything else
        // (I-07). Added by OPUS-M2-004 so the requirement-set write can record
        // its before/after summary; every existing caller omits it and lands the
        // same `{}` it landed before.
        ...(entry.payload === undefined ? {} : { payload: entry.payload }),
      });
    }
    return { kind: 'ok', value: outcome.value };
  });
}

/**
 * A read: authorize inside the unit of work, then read. No audit row for a read.
 *
 * ## Two layers, and what each one is for
 *
 * OPUS-M2-004's own SBX-001 run found this route answering **500** to a request
 * whose unsubstituted path parameter arrived as the literal text
 * `:shiftTypeId`: a `22P02` invalid-uuid-syntax error propagating out of an
 * uncaught read. A 500 there is a disclosure as well as a defect — it tells an
 * unauthorized caller the id was the problem, and so that the parameter is a
 * uuid, while a genuinely absent route answers 404.
 *
 *  1. **`requireUuid`**, after the verdict, decides the SHAPE. The `22P02`
 *     class therefore never reaches the database.
 *  2. **This catch**, narrowed to errors carrying a SQLSTATE, turns a database
 *     refusal into a 404. A non-database fault is re-thrown to
 *     `setErrorHandler`, which logs it in full and answers 500 with the fixed
 *     message — because a bug in this process is not a missing row, and a log
 *     line asserting "refused by the database" about an unexamined cause is
 *     worse than no log line (review finding V-02).
 *
 * ## The byte-identity claim, stated exactly
 *
 * **Absent, RLS-hidden and cross-tenant are one answer** — that is the identity
 * that matters, because those three are the states an actor probes to learn
 * whether a row exists in a tenant they cannot see (T-05b, SPEC-06 P-3). It
 * holds, and `shift-type-qualifications.test.ts` compares the bodies.
 *
 * A **malformed** id is not part of that identity and does not need to be: it is
 * refused by layer 1 before any lookup, so it discloses nothing about any row.
 * It happens to produce the same 404 envelope, which is a consequence of
 * `sendNotFound` being the one not-found responder rather than a claim being
 * made here (review finding V-03).
 *
 * The authorization decision is evaluated FIRST in both layers, so neither can
 * be reached by a caller who was not allowed to make the request.
 */
async function withCatalogueQuery<T>(
  request: FastifyRequest,
  run: (uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0]) => Promise<T>,
  /**
   * Checked after the verdict and before `run` — the read's equivalent of the
   * commands calling `requireUuid` at the top of their callback. A slot rather
   * than a check inside `run` so the ordering is a property of this function,
   * which is the whole reason the FAD-12 shape lives here at all.
   */
  precondition?: () => CatalogueOutcome<never> | null,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);
  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };
    const failed = precondition?.();
    if (failed != null) return failed;
    try {
      return { kind: 'ok', value: await run(uow) };
    } catch (error) {
      if (!isPostgresError(error)) throw error;
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'catalogue read refused by the database',
      );
      return { kind: 'not-found' };
    }
  });
}

/**
 * Turns an outcome into a response. One place, so the four shapes cannot drift.
 *
 * `body` is expected to PARSE its result through the relevant contract schema —
 * the same discipline `responses.ts` states for the 409 path: "it makes a field
 * added here without being added to the schema a test failure rather than an
 * undocumented wire change." The parsing happens at the call site rather than
 * here because `apps/api` does not depend on zod (the layering rule: contracts
 * imports zod; api imports contracts), so this function cannot name a schema
 * type at all.
 */
function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
  body: (value: T) => unknown,
): FastifyReply | unknown {
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'conflict') {
    return reply.code(409).send(
      conflictBodySchema.parse({
        error: {
          code: 'CONFLICT',
          message: 'The request could not be completed.',
          correlationId: request.correlationId,
        },
      } satisfies ConflictBody),
    );
  }
  if (outcome.kind === 'invalid') {
    return reply.code(422).send(
      validationProblemBodySchema.parse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: request.correlationId,
          problems: outcome.problems.map((problem) => ({
            field: problem.field,
            message: problem.message,
          })),
        },
      }),
    );
  }
  return body(outcome.value);
}

export default function catalogueRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/catalogue';

  /* ── shift types ────────────────────────────────────────────── CAP-011 ── */

  app.get(`${base}/shift-types`, { config: SHIFT_TYPE_CONFIG }, async (request, reply) => {
    const outcome = await withCatalogueQuery(request, (uow) => catalogue.listShiftTypes(uow));
    return respond(request, reply, outcome, (shiftTypes) => shiftTypeListSchema.parse({
      shiftTypes,
      correlationId: request.correlationId,
    }));
  });

  app.post(`${base}/shift-types`, { config: SHIFT_TYPE_CONFIG }, async (request, reply) => {

    const outcome = await withCatalogueCommand(
      request,
      async (uow) => {
        const parsed = parseBody(createShiftTypeRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.createShiftType(uow, parsed.value);
      },
      (shiftType) => ({
        eventName: CATALOGUE_AUDIT_EVENTS.shiftTypeCreated,
        subjectType: 'shift_type',
        subjectId: shiftType.shiftTypeId,
      }),
    );
    return respond(request, reply, outcome, (shiftType) => shiftTypeResultSchema.parse({
      shiftType,
      correlationId: request.correlationId,
    }));
  });

  app.patch(
    `${base}/shift-types/:shiftTypeId`,
    { config: SHIFT_TYPE_CONFIG },
    async (request, reply) => {
      const shiftTypeId = (request.params as { shiftTypeId?: string }).shiftTypeId;
      if (shiftTypeId === undefined) return sendNotFound(request, reply);


      const outcome = await withCatalogueCommand(
        request,
        async (uow) => {
        const malformed = requireUuid(shiftTypeId);
        if (malformed !== null) return malformed;
        const parsed = parseBody(updateShiftTypeRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.updateShiftType(uow, shiftTypeId, parsed.value);
      },
        // Retirement gets its OWN event name. "This type was retired" is the
        // question a scheduling incident asks, and answering it by scanning
        // every `updated` row for a status change makes retirement invisible in
        // a filtered audit query — which is the query that matters.
        (result) => ({
          eventName: result.archived
            ? CATALOGUE_AUDIT_EVENTS.shiftTypeArchived
            : CATALOGUE_AUDIT_EVENTS.shiftTypeUpdated,
          subjectType: 'shift_type',
          subjectId: result.shiftType.shiftTypeId,
        }),
      );
      return respond(request, reply, outcome, (result) => shiftTypeResultSchema.parse({
        shiftType: result.shiftType,
        correlationId: request.correlationId,
      }));
    },
  );

  app.put(
    `${base}/shift-types/:shiftTypeId/weekday-demand`,
    { config: SHIFT_TYPE_CONFIG },
    async (request, reply) => {
      const shiftTypeId = (request.params as { shiftTypeId?: string }).shiftTypeId;
      if (shiftTypeId === undefined) return sendNotFound(request, reply);


      const outcome = await withCatalogueCommand(
        request,
        async (uow) => {
        const malformed = requireUuid(shiftTypeId);
        if (malformed !== null) return malformed;
        const parsed = parseBody(setWeekdayDemandRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.setWeekdayDemand(uow, shiftTypeId, parsed.value);
      },
        // Filed under the shift type, not under a subject type of its own:
        // demand has no life apart from the type it belongs to, and "everything
        // that happened to this shift type" must return its demand changes.
        () => ({
          eventName: CATALOGUE_AUDIT_EVENTS.shiftTypeDemandSet,
          subjectType: 'shift_type',
          subjectId: shiftTypeId,
        }),
      );
      return respond(request, reply, outcome, (demand) => weekdayDemandSchema.parse({
        shiftTypeId,
        demand,
        correlationId: request.correlationId,
      }));
    },
  );

  /* ── shift groups ───────────────────────────────────────────── CAP-012 ── */

  app.get(`${base}/shift-groups`, { config: SHIFT_GROUP_CONFIG }, async (request, reply) => {
    const outcome = await withCatalogueQuery(request, (uow) => catalogue.listShiftGroups(uow));
    return respond(request, reply, outcome, (shiftGroups) => shiftGroupListSchema.parse({
      shiftGroups,
      correlationId: request.correlationId,
    }));
  });

  app.post(`${base}/shift-groups`, { config: SHIFT_GROUP_CONFIG }, async (request, reply) => {

    const outcome = await withCatalogueCommand(
      request,
      async (uow) => {
        const parsed = parseBody(createShiftGroupRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.createShiftGroup(uow, parsed.value);
      },
      (shiftGroup) => ({
        eventName: CATALOGUE_AUDIT_EVENTS.shiftGroupCreated,
        subjectType: 'shift_group',
        subjectId: shiftGroup.shiftGroupId,
      }),
    );
    return respond(request, reply, outcome, (shiftGroup) => shiftGroupResultSchema.parse({
      shiftGroup,
      correlationId: request.correlationId,
    }));
  });

  app.patch(
    `${base}/shift-groups/:shiftGroupId`,
    { config: SHIFT_GROUP_CONFIG },
    async (request, reply) => {
      const shiftGroupId = (request.params as { shiftGroupId?: string }).shiftGroupId;
      if (shiftGroupId === undefined) return sendNotFound(request, reply);


      const outcome = await withCatalogueCommand(
        request,
        async (uow) => {
        const malformed = requireUuid(shiftGroupId);
        if (malformed !== null) return malformed;
        const parsed = parseBody(updateShiftGroupRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.updateShiftGroup(uow, shiftGroupId, parsed.value);
      },
        (shiftGroup) => ({
          eventName: CATALOGUE_AUDIT_EVENTS.shiftGroupUpdated,
          subjectType: 'shift_group',
          subjectId: shiftGroup.shiftGroupId,
        }),
      );
      return respond(request, reply, outcome, (shiftGroup) => shiftGroupResultSchema.parse({
        shiftGroup,
        correlationId: request.correlationId,
      }));
    },
  );

  /* ── staff groups ───────────────────────────────────────────── CAP-012 ── */

  app.get(`${base}/staff-groups`, { config: STAFF_GROUP_CONFIG }, async (request, reply) => {
    const outcome = await withCatalogueQuery(request, (uow) => catalogue.listStaffGroups(uow));
    return respond(request, reply, outcome, (staffGroups) => staffGroupListSchema.parse({
      staffGroups,
      correlationId: request.correlationId,
    }));
  });

  app.post(`${base}/staff-groups`, { config: STAFF_GROUP_CONFIG }, async (request, reply) => {

    const outcome = await withCatalogueCommand(
      request,
      async (uow) => {
        const parsed = parseBody(createStaffGroupRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.createStaffGroup(uow, parsed.value);
      },
      (staffGroup) => ({
        eventName: CATALOGUE_AUDIT_EVENTS.staffGroupCreated,
        subjectType: 'staff_group',
        subjectId: staffGroup.staffGroupId,
      }),
    );
    return respond(request, reply, outcome, (staffGroup) => staffGroupResultSchema.parse({
      staffGroup,
      correlationId: request.correlationId,
    }));
  });

  /* ── valid combinations and pick positions ──────────────────── CAP-011 ── */

  app.get(`${base}/valid-groups`, { config: VALID_GROUP_CONFIG }, async (request, reply) => {
    const outcome = await withCatalogueQuery(request, (uow) => catalogue.listValidGroups(uow));
    return respond(request, reply, outcome, (result) => validGroupListSchema.parse({
      validGroups: result.validGroups,
      pickPositionCount: result.pickPositionCount,
      correlationId: request.correlationId,
    }));
  });

  app.post(`${base}/valid-groups`, { config: VALID_GROUP_CONFIG }, async (request, reply) => {

    const outcome = await withCatalogueCommand(
      request,
      async (uow) => {
        const parsed = parseBody(createValidGroupRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.createValidGroup(uow, parsed.value);
      },
      (validGroup) => ({
        eventName: CATALOGUE_AUDIT_EVENTS.validGroupCreated,
        subjectType: 'valid_group',
        subjectId: validGroup.validGroupId,
      }),
    );
    return respond(request, reply, outcome, (validGroup) => validGroupResultSchema.parse({
      validGroup,
      correlationId: request.correlationId,
    }));
  });

  app.get(`${base}/pick-positions`, { config: PICK_POSITION_CONFIG }, async (request, reply) => {
    const outcome = await withCatalogueQuery(request, (uow) =>
      catalogue.readPickPositionCount(uow),
    );
    return respond(request, reply, outcome, (pickPositionCount) => pickPositionCountSchema.parse({
      pickPositionCount,
      correlationId: request.correlationId,
    }));
  });

  app.put(`${base}/pick-positions`, { config: PICK_POSITION_CONFIG }, async (request, reply) => {

    const { context } = requireTenantContext(request);
    const groupId = context.expectedGroupId;

    const outcome = await withCatalogueCommand(
      request,
      async (uow) => {
        const parsed = parseBody(setPickPositionCountRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.setPickPositionCount(uow, parsed.value.pickPositionCount);
      },
      // The subject is the GROUP: the count is a property of the group, and
      // filing it under a catalogue aggregate would make "what changed about
      // this group?" unanswerable.
      () =>
        groupId === null
          ? null
          : {
              eventName: CATALOGUE_AUDIT_EVENTS.pickPositionsIncreased,
              subjectType: 'group',
              subjectId: groupId,
            },
    );
    return respond(request, reply, outcome, (pickPositionCount) => pickPositionCountSchema.parse({
      pickPositionCount,
      correlationId: request.correlationId,
    }));
  });

  /* ── group holidays ─────────────────────────── CAP-004 slice (CAR-011) ── */

  /* READ is gated by the CATALOGUE key, WRITE by the calendar key — the S-10 /
   * D-10 ruling, recorded in `catalogue/policies.ts`. A scheduler authoring
   * per-shift-type `holiday` demand has to be able to see which dates that
   * demand applies to. */
  app.get(`${base}/holidays`, { config: HOLIDAY_READ_CONFIG }, async (request, reply) => {
    const outcome = await withCatalogueQuery(request, (uow) => catalogue.listGroupHolidays(uow));
    return respond(request, reply, outcome, (holidays) => groupHolidayListSchema.parse({
      holidays,
      correlationId: request.correlationId,
    }));
  });

  app.post(`${base}/holidays`, { config: HOLIDAY_CONFIG }, async (request, reply) => {

    const outcome = await withCatalogueCommand(
      request,
      async (uow) => {
        const parsed = parseBody(createGroupHolidayRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;
        return catalogue.createGroupHoliday(uow, parsed.value);
      },
      (holiday) => ({
        eventName: CATALOGUE_AUDIT_EVENTS.groupHolidayCreated,
        subjectType: 'group_holiday',
        subjectId: holiday.groupHolidayId,
      }),
    );
    return respond(request, reply, outcome, (holiday) => groupHolidayResultSchema.parse({
      holiday,
      correlationId: request.correlationId,
    }));
  });

  /* ── qualification requirements, and eligibility ─── CAP-011 x CAP-058 ──── */

  app.get(
    `${base}/shift-types/:shiftTypeId/qualifications`,
    { config: SHIFT_TYPE_QUALIFICATION_CONFIG },
    async (request, reply) => {
      const shiftTypeId = (request.params as { shiftTypeId?: string }).shiftTypeId;
      if (shiftTypeId === undefined) return sendNotFound(request, reply);

      const outcome = await withCatalogueQuery(
        request,
        (uow) => catalogue.listShiftTypeQualifications(uow, shiftTypeId as string),
        () => requireUuid(shiftTypeId),
      );
      return respond(request, reply, outcome, (requirements) =>
        shiftTypeQualificationListSchema.parse({
          shiftTypeId,
          requirements,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /**
   * The whole requirement set, replaced in one request.
   *
   * A PUT of the set rather than per-row POST/DELETE: I-10 (one author action,
   * one request) and archive-not-delete (the removal decision stays on the
   * server, where the retention rule lives — the database refuses a DELETE
   * outright, for the table owner as well as the runtime roles).
   */
  app.put(
    `${base}/shift-types/:shiftTypeId/qualifications`,
    { config: SHIFT_TYPE_QUALIFICATION_CONFIG },
    async (request, reply) => {
      const shiftTypeId = (request.params as { shiftTypeId?: string }).shiftTypeId;
      if (shiftTypeId === undefined) return sendNotFound(request, reply);

      const outcome = await withCatalogueCommand(
        request,
        async (uow) => {
          const malformed = requireUuid(shiftTypeId);
          if (malformed !== null) return malformed;
          const parsed = parseBody(setShiftTypeQualificationsRequestSchema, request.body);
          if (parsed.kind !== 'ok') return parsed;
          return catalogue.setShiftTypeQualifications(uow, shiftTypeId, parsed.value);
        },
        // Filed under the SHIFT TYPE, not under a subject type of its own: a
        // requirement has no life apart from the shift type it constrains, and
        // "everything that happened to this shift type" must return its
        // requirement changes.
        (result) => ({
          eventName: CATALOGUE_AUDIT_EVENTS.shiftTypeQualificationsSet,
          subjectType: 'shift_type',
          subjectId: shiftTypeId,
          payload: {
            mechanism: 'set',
            beforeActiveCount: result.beforeActiveCount,
            afterActiveCount: result.requirements.filter((r) => r.active).length,
            addedCount: result.addedCount,
            reactivatedCount: result.reactivatedCount,
            archivedCount: result.archivedCount,
          },
        }),
      );
      return respond(request, reply, outcome, (result) =>
        shiftTypeQualificationListSchema.parse({
          shiftTypeId,
          requirements: result.requirements,
          correlationId: request.correlationId,
        }),
      );
    },
  );

  /**
   * Which shift types a membership is qualified for.
   *
   * Gated by `staffing.qualification_holding.read` (CAP-058), not by the
   * catalogue key: the answer names shift types, but its sensitive input is
   * `qualification_holdings`, which is `SENSITIVE-PII`. What comes back is then
   * decided by the RLS SELECT policies rather than by this handler — your own
   * holdings always, another membership's only with `…read_any`. A caller
   * without `read_any` asking about a colleague sees every requirement as
   * missing, which is the same answer they would get for a colleague who holds
   * no credentials (P-3).
   *
   * **The response is a report, not an authorization verdict.** Enforcement of
   * credential requirements belongs to the M4 engine, computing with its own
   * credential; nothing here is a decision anything may act on.
   */
  app.get(
    `${base}/memberships/:membershipId/eligible-shift-types`,
    { config: ELIGIBILITY_READ_CONFIG },
    async (request, reply) => {
      const membershipId = (request.params as { membershipId?: string }).membershipId;
      if (membershipId === undefined) return sendNotFound(request, reply);

      const outcome = await withCatalogueQuery(
        request,
        async (uow) => {
          // The transaction's own clock, once, for every row — never `now()` read
          // per statement. Expiry makes eligibility time-dependent, and two rows
          // evaluated against two clock readings inside one transaction is the
          // class the in-force loader exists to prevent.
          const at = await transactionNow(uow.query);
          return {
            at,
            shiftTypes: await catalogue.listMembershipEligibility(
              uow,
              membershipId as string,
              at,
            ),
          };
        },
        () => requireUuid(membershipId),
      );

      return respond(request, reply, outcome, (result) =>
        membershipEligibilitySchema.parse({
          membershipId,
          at: result.at.toISOString(),
          shiftTypes: result.shiftTypes,
          correlationId: request.correlationId,
        }),
      );
    },
  );
}
