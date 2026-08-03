import {
  contextProbeResultSchema,
  jobEnqueueResultSchema,
  type ContextProbeResult,
  type JobEnqueueResult,
} from '@schedulepoint/contracts';
import {
  bindTarget,
  type Decision,
  type FrozenJobContext,
  type TenantContext,
} from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { recordAuditEvent } from '../../audit/recorder.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { CONTEXT_PROBE_TOUCH_JOB } from '../../jobs/handlers.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendContextFailure, sendForbidden, sendNotFound } from '../context/responses.js';
import {
  MEMBERSHIP_AGGREGATE,
  resolveMembershipCoordinates,
} from '../context/target-resolution.js';
import { type RouteConfigWithPolicy } from '../policy.js';

/**
 * The context-verification surfaces.
 *
 * ## What these routes are, and what they are not
 *
 * OPUS-M1-001's packet permits this task to "register routes with explicit
 * placeholder policies that **deny** everything except the context-verification
 * paths under test". These are those paths. They exist so SPEC-01 §7.1's table
 * can be executed **over HTTP** against the production middleware rather than
 * against a test double — a context path proven only in unit tests is a context
 * path whose middleware wiring is unproven.
 *
 * They are not product routes. Every one of them declares a `capability` policy
 * with a provisional allow-list; the SPEC-06 evaluator replaces that list
 * wholesale in OPUS-M1-002, and every layer it adds can only remove access.
 *
 * ## ONE unit of work per command (FAD-12)
 *
 * **The authorization re-evaluation and the mutation it authorizes share a single
 * transaction.** They must, and the reason is a race rather than a style
 * preference: with the role read in transaction A and the write in transaction B,
 * a revocation committed between them is authorized by a verdict that was already
 * stale when the write landed — and the write would look perfectly authorized in
 * the log. Inside one transaction the read takes its snapshot and the write
 * commits against it, so there is no window to lose.
 *
 * The middleware's §2.3 resolution stays in its own read-only transaction (it has
 * to: `app.membership_id` is derived *by* it and cannot be set before it runs).
 * The handler therefore re-reads the acting membership rather than trusting what
 * the middleware saw — which is also what I-19 demands, "against current state".
 *
 * Asserted by `apps/api/test/http/context-surface.test.ts`, describe block
 * "FAD-12 — authorization and mutation share one unit of work".
 *
 * ## The mutation
 *
 * The write is `memberships.last_active_at` for the **acting** membership. It is
 * a genuine tenant-table mutation under the declared context, it is self-scoped
 * (so it needs no ownership policy beyond "the acting membership"), and it
 * invents no table. T-01 proves the row that moves is the one in the *declared*
 * group; the ground-truth census proves no row moved anywhere else.
 *
 * ## Why there are two `touch` routes and a third that looks wrong
 *
 * | Route | Declared scope | Exercises |
 * |---|---|---|
 * | `POST /organizations/:o/groups/:g/context-probe/touch` | `group` | T-01, T-02, T-04, T-06 |
 * | `POST /organizations/:o/context-probe/touch` | `organization` | T-06b, T-06c |
 * | `POST /organizations/:o/context-probe/group-scoped-touch` | **`group`** | T-06d |
 *
 * The third declares group scope at a path that carries no group segment. That
 * is not a mistake — it is the case SPEC-01 §2.1 (V-06) makes normative: **"the
 * branch is selected by the route's declared scope, never by the presence or
 * absence of the field."** A route in that state must fail closed with a `404`
 * on every request, and shipping it proves that it does. It is deny-by-default
 * in every other respect too, so it grants nothing.
 */

const PROBE_CAPABILITY = 'CAP-003';

/**
 * The route declarations, now naming a SPEC-06 **action** rather than a list of
 * roles.
 *
 * OPUS-M1-001's `provisional.allowRoles` is gone. What decides these routes is
 * `packages/domain/src/authz`'s truth table, evaluated per request against
 * current state inside the same transaction as the write. `scheduler` and
 * `group_admin` still reach them and `member`, `viewer` and `telecom` still do
 * not — but now because `SYSTEM_ROLE_CAPABILITIES` says so and
 * `role_capabilities` holds the rows, not because a route listed two strings.
 *
 * Still exported, and since OPUS-M1-004 for a stronger reason:
 * `apps/api/test/jobs/job-context.test.ts` compares the job handler's
 * declaration against **this object**, not against a copy of its contents. The
 * two surfaces now run the same evaluator over the same action (FAD-13 item 1),
 * so there is one declaration to agree about rather than two lists to keep in
 * step.
 */
export const GROUP_SCOPED_CONFIG = {
  policy: { kind: 'capability', capability: PROBE_CAPABILITY },
  actionScope: 'group',
  action: {
    key: 'membership.touch_self',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

export const ORGANIZATION_SCOPED_CONFIG = {
  policy: { kind: 'capability', capability: PROBE_CAPABILITY },
  actionScope: 'organization',
  action: {
    key: 'organization.membership.touch_self',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * The target-binding route declares the SAME capability but **with** an object
 * policy, because SPEC-01 §2.3 step 6 only has a question to answer when the
 * action names an object.
 */
export const TARGET_BINDING_CONFIG = {
  policy: { kind: 'capability', capability: PROBE_CAPABILITY },
  actionScope: 'group',
  action: {
    key: 'membership.touch_self',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: true,
    /**
     * **The declaration now has consequences, and it did not before.**
     *
     * An independent review flipped `requiresObjectPolicy` to `false` and
     * nothing changed: the handler computed `authorizedInDeclaredTenant` and
     * discarded the decision, so L5.1 was inert on the only route that declared
     * it — the route every later feature will copy.
     *
     * `membership.touch_self` is self-scoped by its own name, so ownership is
     * the honest object policy for it: the actor may touch their OWN membership
     * and not somebody else's, unless they hold the administrative capability
     * that lifts it. That makes the declaration testable in both directions.
     */
    ownershipRequired: true,
    ownershipOverrideCapability: 'documents.manage',
  },
} as const satisfies RouteConfigWithPolicy;

/** The outcomes a probe transaction can reach without writing anything. */
type ProbeOutcome =
  | { readonly kind: 'ok'; readonly mutatedAt: Date }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'denied'; readonly decision: Decision };

interface TouchedRow {
  updated_at: Date;
}

/**
 * The shared mutation: re-authorize and touch the acting membership, in ONE
 * transaction, under the verified context.
 */
async function touchActingMembership(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | ContextProbeResult> {
  const { context, command, route } = requireTenantContext(request);

  const outcome = await request.server.tenancy.runtime.run(
    command,
    async (uow): Promise<ProbeOutcome> => {
      /* ── OPUS-M1-004: evaluate → deny → mutate → audit, in ONE unit of work ──
       *
       * FAD-12's ordering, composed from both parallel branches. The evaluation
       * comes FIRST so a denial writes nothing at all — not the mutation and not
       * an audit row claiming a mutation happened. The audit write comes LAST,
       * after the mutation it records, and inside the same transaction, so the
       * two commit or roll back together. */
      const { query } = uow;

      // SPEC-06's full truth table, evaluated against current state inside the
      // same transaction as the write below (I-19, FAD-12). Nothing is cached.
      const { decision } = await evaluateInTransaction(query, { request, context, route });
      if (!decision.allowed) return { kind: 'denied', decision };

      const now = new Date();
      const rows = (await query
        .updateTable('memberships')
        .set({ last_active_at: now, updated_at: now })
        .where('id', '=', context.membershipId)
        .returning('updated_at')
        .execute()) as unknown as TouchedRow[];

      const touched = rows[0];
      if (touched === undefined) return { kind: 'not-found' };

      // OPUS-M1-003 — the audit write joins THIS unit of work (FAD-12,
      // ADR-0019, non-bypass rule 6). One line, and it names nothing
      // tenant-shaped: the organization, group, actor and correlation id all
      // come from `uow.context`. See `apps/api/src/audit/recorder.ts`.
      await recordAuditEvent(uow, {
        eventName: 'membership.activity_touched',
        subjectType: 'membership',
        subjectId: context.membershipId,
      });

      return { kind: 'ok', mutatedAt: touched.updated_at };
    },
  );

  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);

  return probeResult(context, outcome.mutatedAt);
}

function probeResult(
  context: ReturnType<typeof requireTenantContext>['context'],
  mutatedAt: Date,
): ContextProbeResult {
  return contextProbeResultSchema.parse({
    organizationId: context.expectedOrganizationId,
    groupId: context.expectedGroupId,
    membershipId: context.membershipId,
    actionScope: context.actionScope,
    authorizationVersion: context.authorizationVersion,
    correlationId: context.correlationId,
    mutatedAt: mutatedAt.toISOString(),
  } satisfies ContextProbeResult);
}

export default function contextProbeRoutes(app: FastifyInstance): void {
  /* ── group-scoped mutation ─────────────────────────────────────── T-01, T-02, T-04, T-06 ── */
  app.post(
    '/organizations/:organizationId/groups/:groupId/context-probe/touch',
    { config: GROUP_SCOPED_CONFIG },
    touchActingMembership,
  );

  /* ── organization-scoped mutation ─────────────────────────────────────── T-06b, T-06c ── */
  app.post(
    '/organizations/:organizationId/context-probe/touch',
    { config: ORGANIZATION_SCOPED_CONFIG },
    touchActingMembership,
  );

  /* ── group-scoped route with no group segment ───────────────────────────────── T-06d ── */
  app.post(
    '/organizations/:organizationId/context-probe/group-scoped-touch',
    { config: GROUP_SCOPED_CONFIG },
    touchActingMembership,
  );

  /* ── target aggregate binding (§3, §2.3 step 6) ─────────────────────── T-05, T-05b ── */
  app.post(
    '/organizations/:organizationId/groups/:groupId/context-probe/targets/:targetMembershipId',
    { config: TARGET_BINDING_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const targetMembershipId = (request.params as { targetMembershipId?: string })
        .targetMembershipId;
      if (targetMembershipId === undefined) return sendNotFound(request, reply);

      /* ── ONE transaction: the in-scope target lookup, the capability verdict,
       *    and (when both succeed) the write. ─────────────────────────────────── */
      const decided = await request.server.tenancy.runtime.run(command, async ({ query }) => {
        const targetRows = (await query
          .selectFrom('memberships')
          .select(['organization_id', 'group_id'])
          .where('id', '=', targetMembershipId)
          .execute()) as unknown as { organization_id: string; group_id: string | null }[];

        const inScope = targetRows[0];

        /* ── the decision is EVALUATED WITH THE TARGET, and honoured ──────────
         *
         * When the target is visible in the declared scope, L5.1 has something
         * to run against and its verdict decides the request. The previous
         * version passed `target: null` and then threw the decision away, which
         * made the route's own `requiresObjectPolicy: true` declaration inert —
         * found by an independent review flipping it to `false` and observing no
         * change.
         *
         * `authorizedInDeclaredTenant` is still computed, and still WITHOUT the
         * object-policy layer: SPEC-01 §2.3 step 6 (V-07) needs exactly that to
         * choose between `409` and `404`, and it is why SPEC-06 places tenant
         * binding at L5.1 after L4 rather than before it. Both come from ONE
         * snapshot read. */
        const verdict = await evaluateInTransaction(query, {
          request,
          context,
          route,
          target:
            inScope === undefined
              ? null
              : {
                  organizationId: inScope.organization_id,
                  groupId: inScope.group_id,
                  type: MEMBERSHIP_AGGREGATE,
                  ownerMembershipId: targetMembershipId,
                  state: null,
                },
        });

        if (inScope === undefined) {
          return {
            authorized: verdict.authorizedInDeclaredTenant,
            decision: verdict.decision,
            inScope: null,
          } as const;
        }

        return {
          authorized: verdict.authorizedInDeclaredTenant,
          decision: verdict.decision,
          inScope: {
            organizationId: inScope.organization_id,
            groupId: inScope.group_id,
            aggregateType: MEMBERSHIP_AGGREGATE,
          },
        } as const;
      });

      if (decided.inScope !== null) {
        const binding = bindTarget(
          context,
          decided.inScope,
          MEMBERSHIP_AGGREGATE,
          decided.authorized,
        );
        if (!binding.ok) {
          return sendContextFailure(request, reply, binding.failure, {
            principalUserId: context.principalUserId,
            organizationId: context.expectedOrganizationId,
            groupId: context.expectedGroupId,
          });
        }
        if (!decided.authorized) {
          return sendForbidden(request, reply, `role does not hold ${route.action.key}`);
        }
        // L5.1 ran against a real target. Its verdict is the answer — including
        // the ownership rule, which is the half `bindTarget` cannot see.
        if (!decided.decision.allowed) {
          return respondToDenial(request, reply, decided.decision);
        }
        return probeResult(context, new Date());
      }

      /* The target is not visible in the declared scope.
       *
       * An UNAUTHORIZED actor stops here — same queries, same body, same status
       * as a request naming an id that does not exist anywhere (T-05b). No
       * cross-group read is issued on their behalf, which is what makes the two
       * indistinguishable in work as well as in output. */
      if (!decided.authorized) return sendNotFound(request, reply);

      /* An AUTHORIZED actor may learn that the id belongs to a sibling group of
       * their own organization — and only that (V-07). */
      const coordinates = await resolveMembershipCoordinates(
        request.server.tenancy.runtime,
        context,
        targetMembershipId,
      );
      const binding = bindTarget(context, coordinates, MEMBERSHIP_AGGREGATE, true);
      if (!binding.ok) {
        return sendContextFailure(request, reply, binding.failure, {
          principalUserId: context.principalUserId,
          organizationId: context.expectedOrganizationId,
          groupId: context.expectedGroupId,
        });
      }
      // Unreachable in practice: a target that binds must have been visible in
      // the declared scope. Returning 404 rather than proceeding keeps the
      // impossible case fail-closed instead of merely unhandled.
      return sendNotFound(request, reply);
    },
  );

  /* ── job enqueue with frozen context (§6) ────────────────────────── T-03 (job surface) ── */
  app.post(
    '/organizations/:organizationId/groups/:groupId/context-probe/enqueue',
    { config: GROUP_SCOPED_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);

      const decision = await request.server.tenancy.runtime.run(
        command,
        async ({ query }) => (await evaluateInTransaction(query, { request, context, route })).decision,
      );

      if (!decision.allowed) return respondToDenial(request, reply, decision);

      // SPEC-01 §6: the context is FROZEN into the payload at enqueue — the
      // tenant tuple, the acting membership, the correlation id, and the
      // authorization version observed now. The version is evidence of intent;
      // the worker re-evaluates from scratch (SPEC-06 §5).
      const frozen: FrozenJobContext = {
        actionScope: context.actionScope,
        expectedOrganizationId: context.expectedOrganizationId,
        expectedGroupId: context.expectedGroupId,
        membershipId: context.membershipId,
        // OPUS-M1-004: frozen so the worker can run the SPEC-06 evaluator
        // against the principal the job was authorized for, rather than against
        // whoever the membership row names at execution time.
        principalUserId: context.principalUserId,
        systemActor: false,
        correlationId: context.correlationId,
        authorizationVersionAtEnqueue: context.authorizationVersion,
      };

      const job = await request.server.jobQueue.enqueue(CONTEXT_PROBE_TOUCH_JOB, frozen, {});

      return jobEnqueueResultSchema.parse({
        jobId: job.id,
        kind: job.kind,
        frozen: {
          organizationId: frozen.expectedOrganizationId,
          groupId: frozen.expectedGroupId,
          membershipId: frozen.membershipId,
          actionScope: frozen.actionScope,
          authorizationVersionAtEnqueue: frozen.authorizationVersionAtEnqueue,
        },
        correlationId: context.correlationId,
      } satisfies JobEnqueueResult);
    },
  );
}

/** Kept for the type-level check that the command context is what the runner takes. */
export type ProbeCommandContext = TenantContext;
