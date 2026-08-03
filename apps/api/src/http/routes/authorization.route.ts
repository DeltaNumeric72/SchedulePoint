import { randomUUID } from 'node:crypto';

import {
  conflictBodySchema,
  createMembershipRequestSchema,
  createMembershipResultSchema,
  setEntitlementStateRequestSchema,
  setEntitlementStateResultSchema,
  writeGrantRequestSchema,
  writeGrantResultSchema,
  type ConflictBody,
  type CreateMembershipResult,
  type SetEntitlementStateResult,
  type WriteGrantResult,
} from '@schedulepoint/contracts';
import {
  capabilityDefinition,
  type AuditEventName,
  type Decision,
} from '@schedulepoint/domain';
import type { FastifyInstance } from 'fastify';

import { recordAuditEvent } from '../../audit/recorder.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { PG_ERRORS, isPostgresError } from '../../db/pg-errors.js';
import { publishOutboxEvent } from '../../outbox/publisher.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendContextMalformed, sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The SPEC-06 §1.1 organization-administration surfaces.
 *
 * ## Why these three routes exist
 *
 * They are not padding. Each one is the production path for a control that
 * `docs/evidence/EV-M1-TENANCY/INDEX.md` §5.2 recorded as open, and without a
 * real route the control would be proven only against a hand-built transaction:
 *
 * | Route | Closes |
 * |---|---|
 * | `POST …/memberships` | **residual 1** (cross-organization user attach, including the irreversible foreign-user counter bump) and **residual 2** (the 23503 existence oracle) |
 * | `POST …/memberships/:id/grants` | **residual 4** (self role escalation) and SPEC-06 **A-12** (the exclusion constraint) |
 * | `PATCH …/entitlements/:moduleKey` | CAP-057, and SPEC-06 **A-05** / **A-09** — revocation mid-session, re-enable with data intact |
 *
 * ## The shape every one of them has
 *
 * ```
 * runtime.run(command, async (uow) => {
 *     const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
 *     if (!decision.allowed) return denied(decision);   // nothing written
 *     … the mutation …
 *     await recordAuditEvent(uow, { eventName, subjectType, subjectId });
 * })
 * ```
 *
 * **One unit of work.** The re-evaluation, the mutation it authorizes and the
 * audit row share a transaction (FAD-12), the verdict is against current state
 * (I-19), and a denial returns before any statement that writes — so a refused
 * request leaves neither a change nor an audit row claiming one.
 *
 * ## The audit rows, wired at OPUS-M1-004
 *
 * When these routes shipped there was no `audit_events` table: OPUS-M1-003 was
 * building it in a parallel worktree, and non-bypass rule 6 forbids writing an
 * audit row outside the chain. The routes were therefore *shaped* for emission —
 * stable event names, one unit-of-work boundary each — and emitted nothing.
 * FAD-13 item 2 issued the integration; the three calls below are it, and they
 * are the documented one-liner with nothing tenant-shaped passed.
 *
 * The entitlement change also publishes an **outbox** event. The other two do
 * not, and the reason is written at that call site rather than left as an
 * asymmetry a reader has to guess at.
 */

/**
 * The event name each mutation is audited under.
 *
 * Exported and asserted (`apps/api/test/authz/http-authorization.test.ts`) so the
 * names are a contract rather than three strings in three handlers that quietly
 * diverge — and, since OPUS-M1-004, so that the contract is checked against
 * `AUDIT_EVENT_NAMES` in the domain rather than only against itself.
 */
export const AUDIT_EVENTS = {
  membershipCreated: 'authorization.membership.created',
  capabilityGrantWritten: 'authorization.capability_grant.written',
  entitlementStateChanged: 'authorization.entitlement.state_changed',
} as const satisfies Record<string, AuditEventName>;

export const CREATE_MEMBERSHIP_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-006' },
  actionScope: 'organization',
  action: {
    key: 'organization.membership.administer',
    moduleKey: 'organization_administration',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

export const WRITE_GRANT_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-006' },
  actionScope: 'organization',
  action: {
    key: 'organization.role.administer',
    moduleKey: 'organization_administration',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

export const SET_ENTITLEMENT_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-057' },
  actionScope: 'organization',
  action: {
    key: 'organization.entitlement.administer',
    moduleKey: 'entitlements',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  /** A conflict the caller may know about, because they passed L4 in their own tenant. */
  | { readonly kind: 'conflict' };

export default function authorizationRoutes(app: FastifyInstance): void {
  /* ── create a membership ──────────────────────────── residuals 1 and 2 ── */
  app.post(
    '/organizations/:organizationId/memberships',
    { config: CREATE_MEMBERSHIP_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);

      const parsed = createMembershipRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendContextMalformed(request, reply, 'MEMBERSHIP_BODY_MALFORMED');
      const body = parsed.data;

      const outcome = await request.server.tenancy.runtime.run(
        command,
        async (uow): Promise<Outcome<CreateMembershipResult>> => {
          const { query } = uow;
          /* ── authorize FIRST, before any statement that could reach the FK ──
           *
           * This ordering is residual 2's fix at the application layer, and it is
           * the half that does not depend on trigger-versus-constraint ordering:
           * an unauthorized actor's request never issues the INSERT at all, so
           * there is no 23503 to distinguish from a 42501. The database trigger
           * `memberships_guard_administration_on_insert` is the other half, for
           * every path that is not this route. */
          const { decision } = await evaluateInTransaction(query, { request, context, route });
          if (!decision.allowed) return { kind: 'denied', decision };

          const kind = body.groupId === null ? ('organization' as const) : ('group' as const);
          // SERVER-GENERATED. See the contract's docblock: a caller-chosen
          // primary key is an X-11 existence oracle, because PK checks bypass
          // RLS and `id` cannot be tenant-qualified.
          const membershipId = randomUUID();
          try {
            await query
              .insertInto('memberships')
              .values({
                id: membershipId,
                organization_id: context.expectedOrganizationId,
                group_id: body.groupId,
                user_id: body.userId,
                kind,
                organization_role: kind === 'organization' ? body.role : null,
                group_role: kind === 'group' ? body.role : null,
              })
              .execute();
          } catch (error) {
            // 23505 (a membership that already exists) is a conflict the caller
            // is entitled to know about — they hold the administration
            // capability in this organization, so nothing is disclosed. Every
            // OTHER database error, 23503 included, becomes a plain `404`: a
            // foreign key that fires on `user_id` would otherwise be exactly the
            // existence oracle residual 2 is about.
            if (isUniqueViolation(error)) return { kind: 'conflict' };
            request.log.warn(
              { correlationId: request.correlationId },
              'membership creation refused by the database',
            );
            return { kind: 'not-found' };
          }

          // FAD-12, ADR-0019, non-bypass rule 6: the audit row joins THIS
          // transaction, after the change it records. Nothing tenant-shaped is
          // passed — organization, group, actor and correlation id all come
          // from `uow.context` (`apps/api/src/audit/recorder.ts`).
          //
          // No outbox event. The membership's downstream consequence is the
          // `membership_set_version` counter, which 0001's trigger bumps inside
          // this same transaction, so the next request from that principal is
          // already forced through §2.3's staleness check. Publishing an
          // invitation would be inventing a delivery this milestone does not
          // have (SPEC-07 / TDG-06).
          await recordAuditEvent(uow, {
            eventName: AUDIT_EVENTS.membershipCreated,
            subjectType: 'membership',
            subjectId: membershipId,
          });

          return {
            kind: 'ok',
            value: createMembershipResultSchema.parse({
              membershipId,
              organizationId: context.expectedOrganizationId,
              groupId: body.groupId,
              kind,
              correlationId: context.correlationId,
            } satisfies CreateMembershipResult),
          };
        },
      );

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
      return outcome.value;
    },
  );

  /* ── write a capability grant ──────────────────── residual 4, and A-12 ── */
  app.post(
    '/organizations/:organizationId/memberships/:membershipId/grants',
    { config: WRITE_GRANT_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);

      const parsed = writeGrantRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendContextMalformed(request, reply, 'GRANT_BODY_MALFORMED');
      const body = parsed.data;

      // The catalogue check is here as well as at build time: a grant naming a
      // key the evaluator will never read is a row that looks like authority and
      // is not, and the quietest possible failure.
      if (capabilityDefinition(body.capabilityKey) === undefined) {
        return sendContextMalformed(request, reply, 'GRANT_CAPABILITY_UNKNOWN');
      }

      const outcome = await request.server.tenancy.runtime.run(
        command,
        async (uow): Promise<Outcome<WriteGrantResult>> => {
          const { query } = uow;
          const { decision } = await evaluateInTransaction(query, { request, context, route });
          if (!decision.allowed) return { kind: 'denied', decision };

          // The grant's group_id must match the target membership's, and the
          // target must be visible in this context. Reading it here rather than
          // trusting the body is what stops a grant being written against a
          // membership the caller cannot see.
          const targetRows = (await query
            .selectFrom('memberships')
            .select(['id', 'group_id', 'user_id'])
            .where('id', '=', body.membershipId)
            .execute()) as unknown as {
            id: string;
            group_id: string | null;
            user_id: string;
          }[];
          const target = targetRows[0];
          if (target === undefined) return { kind: 'not-found' };

          /* Residual 4, at the application layer — keyed on the PRINCIPAL.
           *
           * **This compared membership ids until an independent review broke it
           * in two requests.** A user holds many memberships (0001's partial
           * unique indexes permit an organization membership and a group
           * membership at once), so an `org_admin` could create a group
           * membership for their own user with
           * `organization.membership.administer` and then grant that membership
           * any grant-only capability — `schedule.publish`, `vacation.commit`,
           * `picklist.administer`, `identity.impersonate`, `audit.export`. The
           * membership ids differed, so the old check waved it through.
           *
           * The database refuses the same thing unconditionally
           * (`app_guard_capability_grant_administration`); this half produces a
           * clean response instead of a 42501, and is the half a reader of the
           * route can see. */
          if (target.user_id === context.principalUserId) {
            request.log.warn(
              { correlationId: request.correlationId, securityEvent: true },
              'a principal attempted to write a capability grant for one of their own memberships',
            );
            return { kind: 'not-found' };
          }

          const grantId = randomUUID();
          try {
            await query
              .insertInto('capability_grants')
              .values({
                id: grantId,
                organization_id: context.expectedOrganizationId,
                group_id: target.group_id,
                membership_id: body.membershipId,
                capability_key: body.capabilityKey,
                granted: body.granted,
                granted_by_membership_id: context.membershipId,
                ...(body.validFrom === undefined ? {} : { valid_from: new Date(body.validFrom) }),
                ...(body.validTo === undefined || body.validTo === null
                  ? {}
                  : { valid_to: new Date(body.validTo) }),
              })
              .execute();
          } catch (error) {
            // 23P01 is the exclusion constraint: an overlapping window for the
            // same (membership, capability). SPEC-06 A-12's outcome, surfaced as
            // a conflict rather than a 500 — the caller holds the administration
            // capability, so telling them their windows overlap discloses
            // nothing they did not already supply.
            if (isExclusionViolation(error) || isUniqueViolation(error)) {
              return { kind: 'conflict' };
            }
            request.log.warn(
              { correlationId: request.correlationId },
              'capability grant refused by the database',
            );
            return { kind: 'not-found' };
          }

          // The subject is the GRANT, not the membership it names. A grant is
          // its own aggregate with its own lifecycle, and filing it under the
          // membership would make "everything that happened to this grant"
          // unanswerable — which is the question an authorization incident asks.
          //
          // No outbox event, same reason as the membership above: the grant's
          // downstream consequence is 0002's `membership_set_version` bump, and
          // it happens in this transaction.
          await recordAuditEvent(uow, {
            eventName: AUDIT_EVENTS.capabilityGrantWritten,
            subjectType: 'capability_grant',
            subjectId: grantId,
          });

          return {
            kind: 'ok',
            value: writeGrantResultSchema.parse({
              grantId,
              membershipId: body.membershipId,
              capabilityKey: body.capabilityKey,
              granted: body.granted,
              correlationId: context.correlationId,
            } satisfies WriteGrantResult),
          };
        },
      );

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
      return outcome.value;
    },
  );

  /* ── change an entitlement's state ───────────────── CAP-057, A-05, A-09 ── */
  app.patch(
    '/organizations/:organizationId/entitlements/:moduleKey',
    { config: SET_ENTITLEMENT_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const moduleKey = (request.params as { moduleKey?: string }).moduleKey;
      if (moduleKey === undefined) return sendNotFound(request, reply);

      const parsed = setEntitlementStateRequestSchema.safeParse(request.body);
      if (!parsed.success) return sendContextMalformed(request, reply, 'ENTITLEMENT_BODY_MALFORMED');

      const outcome = await request.server.tenancy.runtime.run(
        command,
        async (uow): Promise<Outcome<SetEntitlementStateResult>> => {
          const { query } = uow;
          const { decision } = await evaluateInTransaction(query, { request, context, route });
          if (!decision.allowed) return { kind: 'denied', decision };

          /* ── the IN-FORCE row, not every row for the module ────────────────
           *
           * `entitlements` is effective-dated with a `[)` EXCLUDE constraint, so
           * more than one row per (organization, module) is the **designed**
           * steady state: re-windowing leaves a closed historical row beside the
           * live one. Without a window predicate this UPDATE rewrote history —
           * it changed the state of windows that ended months ago, alongside the
           * one the administrator meant.
           *
           * The write-side twin of the read-side defect in
           * `load-policy-input.ts`; an independent review found both. The
           * predicate is the same one `pickEntitlementInForce` applies, and the
           * EXCLUDE constraint guarantees it matches at most one row. */
          const now = new Date();
          const updated = (await query
            .updateTable('entitlements')
            .set({ state: parsed.data.state, updated_at: now })
            .where('organization_id', '=', context.expectedOrganizationId)
            .where('module_key', '=', moduleKey)
            .where('effective_from', '<=', now)
            .where((eb) =>
              eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]),
            )
            // `id` is returned for one reason: the audit row's subject is the
            // entitlement ROW, and a subject id read back from the write is the
            // only one guaranteed to name the row that actually moved.
            .returning(['id', 'module_key', 'state'])
            .execute()) as unknown as { id: string; module_key: string; state: string }[];

          // Belt and braces on the constraint: if it were ever dropped, a
          // multi-row update here would be a silent history rewrite again.
          //
          // **THROW, do not return.** `return` unwinds normally and the unit of
          // work COMMITS — so the guard made a history rewrite noisy while its
          // comment claimed it prevented one. Throwing rolls the transaction
          // back, which is the behaviour the comment always described. A second
          // reviewer caught the gap between the two.
          if (updated.length > 1) {
            request.log.error(
              { correlationId: request.correlationId, matched: updated.length },
              'more than one entitlement row was in force for a module — the exclusion constraint is missing',
            );
            throw new Error(
              'more than one entitlement row was in force for a module; the transaction is rolled back',
            );
          }

          // PO-DEC-04: "disabling never deletes data". This route only ever
          // moves `state` — there is no DELETE anywhere in it, and the runtime
          // role holds no DELETE grant on `entitlements` to reach one with.
          //
          // No row IN FORCE is a 404 even when historical rows exist: there is
          // nothing current to change, and saying "it exists but not now" would
          // disclose the module's history to a caller P-3 says must not learn
          // the module's shape from an error.
          const changed = updated[0];
          if (changed === undefined) return { kind: 'not-found' };

          const recorded = await recordAuditEvent(uow, {
            eventName: AUDIT_EVENTS.entitlementStateChanged,
            subjectType: 'entitlement',
            subjectId: changed.id,
          });

          /* ── the one mutation here that warrants asynchronous follow-up ─────
           *
           * The other two mutations announce nothing, because their whole
           * downstream consequence — the `membership_set_version` bump — lands
           * in this same transaction and forces the affected principal's next
           * request through SPEC-01 §2.3's staleness check.
           *
           * An entitlement change is different in kind. It moves what an ENTIRE
           * ORGANIZATION may do, and the counter only reaches a principal who
           * makes another request: it does not reach a live server-authoritative
           * session (PO-DEC-18), a queued job for the withdrawn module, or an
           * administrator who should be told the module was suspended. That work
           * is by definition outside this transaction, and I-11 says a
           * notification failure must never roll back a domain change — which is
           * the transactional outbox's entire reason for existing (SPEC-11 §3.3).
           *
           * The publication is linked to the audit row it belongs to, so the
           * reconciler can join the three sequences. The consumer today is
           * `DatabaseOutboxSink` — the effect is a row, nothing leaves the
           * machine, and no real notification exists until SPEC-07's milestone.
           * That limit is recorded in EV-M1-INTEGRATION §5 rather than implied
           * away here.
           *
           * The idempotency key is the AUDIT SEQUENCE, which is gapless per
           * organization and assigned by the chain trigger: at-least-once
           * delivery re-runs the job, and a key derived from the state or the
           * module would collide across two legitimate changes to the same
           * module while failing to dedupe a genuine retry. */
          await publishOutboxEvent(uow, recorded, {
            kind: AUDIT_EVENTS.entitlementStateChanged,
            idempotencyKey: `entitlement-state:${recorded.sequence}`,
          });

          return {
            kind: 'ok',
            value: setEntitlementStateResultSchema.parse({
              organizationId: context.expectedOrganizationId,
              moduleKey,
              state: parsed.data.state,
              correlationId: context.correlationId,
            } satisfies SetEntitlementStateResult),
          };
        },
      );

      if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
      if (outcome.kind === 'not-found' || outcome.kind === 'conflict') {
        return sendNotFound(request, reply);
      }
      return outcome.value;
    },
  );
}

/** SQLSTATE 23505 — a row with this tenant-qualified key already exists. */
function isUniqueViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.uniqueViolation;
}

/** SQLSTATE 23P01 — `exclusion_violation`. SPEC-06 P-7's constraint, firing (A-12). */
function isExclusionViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.exclusionViolation;
}
