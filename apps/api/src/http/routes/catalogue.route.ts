import {
  conflictBodySchema,
  createGroupHolidayRequestSchema,
  createShiftGroupRequestSchema,
  createShiftTypeRequestSchema,
  createStaffGroupRequestSchema,
  createValidGroupRequestSchema,
  groupHolidayListSchema,
  groupHolidayResultSchema,
  pickPositionCountSchema,
  setPickPositionCountRequestSchema,
  setWeekdayDemandRequestSchema,
  shiftGroupListSchema,
  shiftGroupResultSchema,
  shiftTypeListSchema,
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
import type { AuditEventName, Decision, FieldProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAuditEvent } from '../../audit/recorder.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import {
  CATALOGUE_AUDIT_EVENTS,
  HOLIDAY_CONFIG,
  PICK_POSITION_CONFIG,
  SHIFT_GROUP_CONFIG,
  SHIFT_TYPE_CONFIG,
  STAFF_GROUP_CONFIG,
  VALID_GROUP_CONFIG,
} from '../../catalogue/policies.js';
import * as catalogue from '../../catalogue/service.js';
import type { CatalogueOutcome } from '../../catalogue/service.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
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
  audit: (value: T) => { eventName: AuditEventName; subjectType: string; subjectId: string } | null,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };

    let outcome: CatalogueOutcome<T>;
    try {
      outcome = await run(uow);
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'conflict' };
      // Every other database error becomes a plain 404. A SQLSTATE on the wire
      // describes the schema, and a constraint name describes it precisely.
      request.log.warn(
        { correlationId: request.correlationId },
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
      });
    }
    return { kind: 'ok', value: outcome.value };
  });
}

/** A read: authorize inside the unit of work, then read. No audit row for a read. */
async function withCatalogueQuery<T>(
  request: FastifyRequest,
  run: (uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0]) => Promise<T>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);
  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };
    return { kind: 'ok', value: await run(uow) };
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

  app.get(`${base}/holidays`, { config: HOLIDAY_CONFIG }, async (request, reply) => {
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
}
