import {
  authorWorkProfileRequestSchema,
  authorWorkProfileResultSchema,
  changeHoldingStatusRequestSchema,
  changeHoldingStatusResultSchema,
  conflictBodySchema,
  createQualificationRequestSchema,
  createQualificationResultSchema,
  grantHoldingRequestSchema,
  grantHoldingResultSchema,
  instantSchema,
  membershipHoldingsResultSchema,
  setQualificationStatusRequestSchema,
  workProfileHistoryResultSchema,
  workProfileInForceResultSchema,
  type ConflictBody,
  type Holding,
  type WorkProfile,
} from '@schedulepoint/contracts';
import { AmbiguousInForceError, isEligibleAt, type Decision } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
import { buildEnvelope } from '../errors.js';
import {
  loadHoldings,
  loadWeekdayTargets,
  loadWorkProfiles,
  workProfileInForce,
  type HoldingRow,
  type WeekdayTargetRow,
  type WorkProfileRow,
} from '../../profiles/in-force-loader.js';
import {
  changeHoldingStatus,
  createQualification,
  grantHolding,
  setQualificationStatus,
} from '../../profiles/qualifications.js';
import {
  RetroactiveEffectiveFromError,
  authorWorkProfile,
  transactionNow,
} from '../../profiles/work-profiles.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendContextMalformed, sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The staffing-parameter surfaces — CAP-013 (work profiles, FTE targets, maximum
 * assignments) and CAP-058 (qualifications, credentials, expiry).
 *
 * **API-first: this packet ships no UI.** OPUS-M2-002 builds the shared form and
 * list foundation for the whole milestone in a parallel worktree; profile screens
 * follow once it exists. That is a recorded sequencing decision, not a dropped
 * capability — CAP-013 and CAP-058 are both `REQUIRED FOR PRODUCTION` and both
 * move on the parity matrix with this change.
 *
 * ## Every handler has the same shape, and it is FAD-12's
 *
 * ```
 * runtime.run(command, async (uow) => {
 *     const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *     if (!decision.allowed) return denied(decision);   // nothing written
 *     … the mutation, through a service in src/profiles/ …
 *     … which records its own audit event in THIS transaction …
 * })
 * ```
 *
 * One unit of work: the verdict is against current state (I-19), the mutation and
 * its audit row share the transaction, and a denial returns before any statement
 * that writes — so a refused request leaves neither a change nor an audit row
 * claiming one.
 *
 * ## Reads take a transaction too, and that is not overhead
 *
 * A read of an effective-dated table has to answer "at which instant?", and the
 * honest default is the database's own `now()` rather than the process clock or
 * the client's. Taking the transaction gets the authorization verdict, the
 * instant and the rows from one snapshot. It is also the only way any statement
 * may touch a tenant table at all (I-15).
 *
 * ## Failure translation
 *
 * `translatePgError` already maps the three SQLSTATEs this surface produces, and
 * they are produced by design rather than by accident:
 *
 * | SQLSTATE | Raised by | Answer |
 * |---|---|---|
 * | `23P01` | the profile EXCLUDE constraint — overlapping windows | `409` |
 * | `23001` | `app_guard_work_profile_history`, the holding transition table | `422` |
 * | `42501` | `app_require_capability` in a guard trigger, or an RLS `WITH CHECK` | `404` |
 *
 * The `409` and `422` bodies name no constraint and no column: a caller who
 * supplied the overlapping window learns that it overlaps, and learns nothing
 * about the schema (X-11).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Route declarations
 *
 * `policy.capability` is the BASELINE id (`CAP-###`) and is traceability;
 * `action.key` is what the SPEC-06 evaluator reads. Several actions belong to one
 * baseline capability, which is why both fields exist.
 * ──────────────────────────────────────────────────────────────────────────── */

export const AUTHOR_WORK_PROFILE_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-013' },
  actionScope: 'group',
  action: {
    key: 'staffing.work_profile.administer',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

export const READ_WORK_PROFILE_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-013' },
  actionScope: 'group',
  action: {
    key: 'staffing.work_profile.read',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

export const ADMINISTER_QUALIFICATION_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-058' },
  actionScope: 'group',
  action: {
    key: 'staffing.qualification.administer',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

export const ADMINISTER_HOLDING_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-058' },
  actionScope: 'group',
  action: {
    key: 'staffing.qualification_holding.administer',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * The read surface declares `…holding.read`, **not** `…holding.read_any`.
 *
 * If it declared `read_any`, a member could not read their own credentials at
 * all, and the SENSITIVE-PII narrowing would live in the choice of URL rather
 * than in the data. Declaring the weaker key admits the caller to the route and
 * lets the RLS SELECT policies decide what comes back: your own always, someone
 * else's only with `read_any`. A caller without `read_any` asking about a
 * colleague gets an empty list — the same answer they would get for a colleague
 * with no credentials, which is the P-3 requirement.
 */
export const READ_HOLDINGS_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-058' },
  actionScope: 'group',
  action: {
    key: 'staffing.qualification_holding.read',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/* ────────────────────────────────────────────────────────────────────────────
 * Shared helpers
 * ──────────────────────────────────────────────────────────────────────────── */

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unprocessable' }
  /** The body did not parse. Reached ONLY after the caller was authorized. */
  | { readonly kind: 'malformed'; readonly problem: string };

/** SQLSTATE 23P01 — the EXCLUDE constraint firing: the windows overlap. */
function isExclusionViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.exclusionViolation;
}

/** SQLSTATE 23001 — a guard trigger refusing a history rewrite or an illegal transition. */
function isRestrictViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.restrictViolation;
}

function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.uniqueViolation;
}

/**
 * Turns a database refusal into an outcome, or rethrows.
 *
 * Rethrowing is the important half: an unrecognised error must become a 500 with
 * a fixed body, never a 404 that reads like "no such thing". The three
 * recognised states are all ones the caller caused with data they supplied.
 */
function classify(error: unknown, request: FastifyRequest): Outcome<never> {
  if (isExclusionViolation(error) || isUniqueViolation(error)) return { kind: 'conflict' };
  if (isRestrictViolation(error)) return { kind: 'unprocessable' };
  if (isPostgresError(error) && error.code === PG_ERRORS.insufficientPrivilege) {
    return { kind: 'not-found' };
  }
  /* T-01: authoring history is refused by the SERVICE, and the surface has to say
   * so with the same status a guard trigger's refusal gets.
   *
   * **This mapping was missing.** The service threw correctly and `classify` fell
   * through to `throw error`, so the refusal reached the client as a 500 — an
   * internal error for a request the caller simply may not make. The service-level
   * test passed throughout, because it asserted the throw rather than the status,
   * which is exactly the gap between "the rule exists" and "the rule is the answer
   * the caller gets". 422, like every other refusal on this surface. */
  if (error instanceof RetroactiveEffectiveFromError) {
    return { kind: 'unprocessable' };
  }
  if (error instanceof AmbiguousInForceError) {
    // The EXCLUDE constraint has been dropped or bypassed. The transaction is
    // already rolling back; this is logged as a security-relevant event because
    // it means a database invariant this surface depends on is gone.
    request.log.error(
      { correlationId: request.correlationId, securityEvent: true },
      'two work-profile rows were in force at once — the non-overlap constraint is missing',
    );
    throw error;
  }
  throw error;
}

function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
): FastifyReply | T {
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
  if (outcome.kind === 'malformed') return sendContextMalformed(request, reply, outcome.problem);
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
  if (outcome.kind === 'unprocessable') {
    /* 422, and the body names no constraint.
     *
     * This is what a guard trigger's refusal looks like from outside: an attempt
     * to rewrite a closed profile window, or an illegal credential transition. The
     * caller supplied the request that was refused, so telling them it was refused
     * discloses nothing — telling them WHICH constraint fired would describe the
     * schema, which is the disclosure `pg-errors.ts` exists to prevent. */
    return reply
      .code(422)
      .send(buildEnvelope('UNPROCESSABLE', 'The request was rejected.', request.correlationId));
  }
  return outcome.value;
}

function toWireProfile(
  profile: WorkProfileRow,
  targets: readonly WeekdayTargetRow[],
): WorkProfile {
  return {
    id: profile.id,
    membershipId: profile.membershipId,
    effectiveFrom: profile.effectiveFrom,
    effectiveTo: profile.effectiveTo,
    workPercentage: profile.workPercentage,
    maxAssignmentsPerWeek: profile.maxAssignmentsPerWeek,
    maxAssignmentsPerPeriod: profile.maxAssignmentsPerPeriod,
    maxConsecutiveDays: profile.maxConsecutiveDays,
    weekdayTargets: targets
      .filter((target) => target.workProfileId === profile.id)
      .map((target) => ({
        day: target.day,
        fteFraction: target.fteFraction,
        maxAssignments: target.maxAssignments,
      })),
  };
}

function toWireHolding(holding: HoldingRow): Holding {
  return {
    id: holding.id,
    membershipId: holding.membershipId,
    qualificationId: holding.qualificationId,
    validFrom: holding.effectiveFrom,
    validUntil: holding.effectiveTo,
    evidenceRef: holding.evidenceRef,
    status: holding.status,
  };
}

/** `?at=<iso>`, or `null` when absent. `undefined` marks a value that is present and unusable. */
function requestedInstant(request: FastifyRequest): Date | null | undefined {
  const raw = (request.query as { at?: unknown }).at;
  if (raw === undefined) return null;
  const parsed = instantSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return new Date(parsed.data);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────────────────── */

export default function profileRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId';

  /* ── author a work profile (create, future-date, supersede) ── CAP-013 ── */
  app.post(`${base}/work-profiles`, { config: AUTHOR_WORK_PROFILE_CONFIG }, async (request, reply) => {
    const { context, command, route } = requireTenantContext(request);

    const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
      /* ── AUTHORIZE FIRST, THEN PARSE. The order is the point ────────────────
       *
       * Every handler here evaluates the capability before it looks at the body.
       * The reverse order — which is what this file shipped with, and what the
       * SBX-001 role matrix found by probing every route as every principal with
       * an empty body — answers `400 …_BODY_MALFORMED` to a caller who holds
       * nothing. That is a disclosure: an unauthorized principal learns the route
       * exists, that it takes a body, and by iterating, what shape the body has.
       *
       * Authorizing first makes the answer to an unauthorized caller identical
       * whatever they send. A `400` is reachable only by someone who was allowed
       * to make the request in the first place, which is the only caller entitled
       * to be told their request was malformed. */
      const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
      if (!decision.allowed) return { kind: 'denied', decision } as const;

      const parsed = authorWorkProfileRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return { kind: 'malformed', problem: 'WORK_PROFILE_BODY_MALFORMED' } as const;
      }
      const body = parsed.data;

      try {
        const authored = await authorWorkProfile(uow, {
          membershipId: body.membershipId,
          effectiveFrom: body.effectiveFrom,
          workPercentage: body.workPercentage,
          maxAssignmentsPerWeek: body.maxAssignmentsPerWeek,
          maxAssignmentsPerPeriod: body.maxAssignmentsPerPeriod,
          maxConsecutiveDays: body.maxConsecutiveDays,
          weekdayTargets: body.weekdayTargets,
        });
        return {
          kind: 'ok',
          value: authorWorkProfileResultSchema.parse({
            profile: toWireProfile(authored.profile, authored.weekdayTargets),
            supersededProfileId: authored.supersededProfileId,
            correlationId: context.correlationId,
          }),
        } as const;
      } catch (error) {
        return classify(error, request);
      }
    });

    return respond(request, reply, outcome);
  });

  /* ── the profile IN FORCE at an instant ─────────────────────── CAP-013 ── */
  app.get(
    `${base}/memberships/:membershipId/work-profile`,
    { config: READ_WORK_PROFILE_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const membershipId = (request.params as { membershipId?: string }).membershipId;
      if (membershipId === undefined) return sendNotFound(request, reply);

      const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision } as const;

        // Parsed after the verdict, for the same reason the bodies are: a `400`
        // that only an authorized caller can reach discloses nothing.
        const at = requestedInstant(request);
        if (at === undefined) {
          return { kind: 'malformed', problem: 'AT_INSTANT_MALFORMED' } as const;
        }

        const instant = at ?? (await transactionNow(uow.query));
        try {
          const selection = await workProfileInForce(uow.query, {
            organizationId: context.expectedOrganizationId,
            membershipId,
            at: instant,
          });

          /* ── the reason is reported BY NAME, and this is the S-01 lesson ────
           *
           * "There is no profile", "the first one has not started yet", "the last
           * one has ended" and "there is a gap between two of them" are four
           * different facts with four different fixes. An API that answers `null`
           * to all four makes an effective-dating defect invisible from the
           * outside — which is exactly how an arbitrary-row read survived a whole
           * milestone before an independent reviewer reproduced it. */
          const profile =
            selection.kind === 'in-force'
              ? toWireProfile(
                  selection.row,
                  await loadWeekdayTargets(uow.query, {
                    organizationId: context.expectedOrganizationId,
                    workProfileIds: [selection.row.id],
                  }),
                )
              : null;

          return {
            kind: 'ok',
            value: workProfileInForceResultSchema.parse({
              membershipId,
              at: instant.toISOString(),
              profile,
              reason: selection.kind === 'none' ? selection.reason : null,
              correlationId: context.correlationId,
            }),
          } as const;
        } catch (error) {
          return classify(error, request);
        }
      });

      return respond(request, reply, outcome);
    },
  );

  /* ── the full history, oldest first ─────────────────────────── CAP-013 ── */
  app.get(
    `${base}/memberships/:membershipId/work-profiles`,
    { config: READ_WORK_PROFILE_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const membershipId = (request.params as { membershipId?: string }).membershipId;
      if (membershipId === undefined) return sendNotFound(request, reply);

      const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision } as const;

        const rows = await loadWorkProfiles(uow.query, {
          organizationId: context.expectedOrganizationId,
          membershipId,
        });
        const targets = await loadWeekdayTargets(uow.query, {
          organizationId: context.expectedOrganizationId,
          workProfileIds: rows.map((row) => row.id),
        });

        return {
          kind: 'ok',
          value: workProfileHistoryResultSchema.parse({
            membershipId,
            // EVERY row, closed ones included. History that a reader cannot see
            // is history nobody can audit.
            profiles: rows.map((row) => toWireProfile(row, targets)),
            correlationId: context.correlationId,
          }),
        } as const;
      });

      return respond(request, reply, outcome);
    },
  );

  /* ── the qualification vocabulary ───────────────────────────── CAP-058 ── */
  app.post(`${base}/qualifications`, { config: ADMINISTER_QUALIFICATION_CONFIG }, async (request, reply) => {
    const { context, command, route } = requireTenantContext(request);

    const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
      const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
      if (!decision.allowed) return { kind: 'denied', decision } as const;

      const parsed = createQualificationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return { kind: 'malformed', problem: 'QUALIFICATION_BODY_MALFORMED' } as const;
      }
      const body = parsed.data;

      try {
        const qualification = await createQualification(uow, {
          key: body.key,
          name: body.name,
          requiresExpiry: body.requiresExpiry,
          issuingBody: body.issuingBody,
        });
        return {
          kind: 'ok',
          value: createQualificationResultSchema.parse({
            qualification,
            correlationId: context.correlationId,
          }),
        } as const;
      } catch (error) {
        return classify(error, request);
      }
    });

    return respond(request, reply, outcome);
  });

  /* ── retire or reinstate. NEVER a delete ────────────────────── CAP-058 ── */
  app.patch(
    `${base}/qualifications/:qualificationId`,
    { config: ADMINISTER_QUALIFICATION_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const qualificationId = (request.params as { qualificationId?: string }).qualificationId;
      if (qualificationId === undefined) return sendNotFound(request, reply);

      const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision } as const;

        const parsed = setQualificationStatusRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return { kind: 'malformed', problem: 'QUALIFICATION_BODY_MALFORMED' } as const;
        }

        try {
          const qualification = await setQualificationStatus(uow, {
            qualificationId,
            status: parsed.data.status,
          });
          if (qualification === null) return { kind: 'not-found' } as const;
          return {
            kind: 'ok',
            value: createQualificationResultSchema.parse({
              qualification,
              correlationId: context.correlationId,
            }),
          } as const;
        } catch (error) {
          return classify(error, request);
        }
      });

      return respond(request, reply, outcome);
    },
  );

  /* ── issue a credential ─────────────────── CAP-058, PO-DEC-12 default ── */
  app.post(
    `${base}/qualification-holdings`,
    { config: ADMINISTER_HOLDING_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);

      const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision } as const;

        const parsed = grantHoldingRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return { kind: 'malformed', problem: 'HOLDING_BODY_MALFORMED' } as const;
        }
        const body = parsed.data;

        try {
          const holding = await grantHolding(uow, {
            membershipId: body.membershipId,
            qualificationId: body.qualificationId,
            validFrom: body.validFrom,
            validUntil: body.validUntil,
            evidenceRef: body.evidenceRef,
            status: body.status,
          });
          return {
            kind: 'ok',
            value: grantHoldingResultSchema.parse({
              holding: toWireHolding(holding),
              correlationId: context.correlationId,
            }),
          } as const;
        } catch (error) {
          return classify(error, request);
        }
      });

      return respond(request, reply, outcome);
    },
  );

  /* ── revoke, or move through the expiry states ──────────────── CAP-058 ── */
  app.patch(
    `${base}/qualification-holdings/:holdingId`,
    { config: ADMINISTER_HOLDING_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const holdingId = (request.params as { holdingId?: string }).holdingId;
      if (holdingId === undefined) return sendNotFound(request, reply);

      const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision } as const;

        const parsed = changeHoldingStatusRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return { kind: 'malformed', problem: 'HOLDING_BODY_MALFORMED' } as const;
        }

        try {
          const holding = await changeHoldingStatus(uow, {
            holdingId,
            status: parsed.data.status,
          });
          if (holding === null) return { kind: 'not-found' } as const;
          return {
            kind: 'ok',
            value: changeHoldingStatusResultSchema.parse({
              holding: toWireHolding(holding),
              correlationId: context.correlationId,
            }),
          } as const;
        } catch (error) {
          return classify(error, request);
        }
      });

      return respond(request, reply, outcome);
    },
  );

  /* ── read a membership's credentials ─── CAP-058, the SENSITIVE-PII path ── */
  app.get(
    `${base}/memberships/:membershipId/qualification-holdings`,
    { config: READ_HOLDINGS_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const membershipId = (request.params as { membershipId?: string }).membershipId;
      if (membershipId === undefined) return sendNotFound(request, reply);

      const outcome = await request.server.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision } as const;

        // Parsed after the verdict, for the same reason the bodies are: a `400`
        // that only an authorized caller can reach discloses nothing.
        const at = requestedInstant(request);
        if (at === undefined) {
          return { kind: 'malformed', problem: 'AT_INSTANT_MALFORMED' } as const;
        }

        const instant = at ?? (await transactionNow(uow.query));
        /* What comes back is decided by the RLS SELECT policies, not by this
         * handler: your own holdings always, another membership's only with
         * `staffing.qualification_holding.read_any`. An unauthorized caller gets
         * an EMPTY LIST rather than an error — indistinguishable from a colleague
         * who holds no credentials, which is what P-3 requires and what an
         * application-layer 403 would have destroyed. */
        const holdings = await loadHoldings(uow.query, {
          organizationId: context.expectedOrganizationId,
          membershipId,
        });

        return {
          kind: 'ok',
          value: membershipHoldingsResultSchema.parse({
            membershipId,
            at: instant.toISOString(),
            holdings: holdings.map(toWireHolding),
            // CAP-058's open question, honoured rather than resolved: eligibility
            // is evaluated at the instant asked about, never at "request time".
            eligible: isEligibleAt([...holdings], instant),
            correlationId: context.correlationId,
          }),
        } as const;
      });

      return respond(request, reply, outcome);
    },
  );
}
