import {
  contextProbeResultSchema,
  jobEnqueueResultSchema,
  type ContextProbeResult,
  type JobEnqueueResult,
} from '@schedulepoint/contracts';
import { bindTarget, type FrozenJobContext, type TenantContext } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../../db/schema.js';
import { CONTEXT_PROBE_TOUCH_JOB } from '../../jobs/handlers.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendContextFailure, sendForbidden, sendNotFound } from '../context/responses.js';
import {
  MEMBERSHIP_AGGREGATE,
  resolveMembershipCoordinates,
} from '../context/target-resolution.js';
import { provisionallyAuthorized, type RouteConfigWithPolicy } from '../policy.js';

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
 * Exported so the job handler's parity test can compare against **this object**
 * rather than against a copy of its contents. A test that restates the list is a
 * test that keeps passing after the two surfaces diverge (SPEC-06 §7).
 */
export const GROUP_SCOPED_CONFIG = {
  policy: { kind: 'capability', capability: PROBE_CAPABILITY },
  actionScope: 'group',
  provisional: {
    allowRoles: ['scheduler', 'group_admin'],
    rationale:
      'Provisional, pending the SPEC-06 evaluator (OPUS-M1-002). Two group roles only, so the ' +
      'harness has both an authorized actor (T-05) and an unauthorized one (T-05b) without a ' +
      'wildcard anywhere.',
  },
} as const satisfies RouteConfigWithPolicy;

export const ORGANIZATION_SCOPED_CONFIG = {
  policy: { kind: 'capability', capability: PROBE_CAPABILITY },
  actionScope: 'organization',
  provisional: {
    allowRoles: ['org_admin'],
    rationale:
      'Provisional. The organization role namespace is disjoint from the group one (SPEC-06 ' +
      'P-10), so listing `org_admin` here cannot grant anything at group scope.',
  },
} as const satisfies RouteConfigWithPolicy;

interface ActingMembershipRow {
  kind: 'organization' | 'group';
  group_role: string | null;
  organization_role: string | null;
}

/**
 * Reads the acting membership **inside the caller's transaction**.
 *
 * Never call this in a transaction other than the one that performs the write it
 * authorizes — that is the whole of FAD-12.
 */
async function readActingMembership(
  query: Kysely<Database>,
  membershipId: string,
): Promise<ActingMembershipRow | undefined> {
  const rows = (await query
    .selectFrom('memberships')
    .select(['kind', 'group_role', 'organization_role'])
    .where('id', '=', membershipId)
    .execute()) as unknown as ActingMembershipRow[];
  return rows[0];
}

function roleOf(membership: ActingMembershipRow): string | null {
  return membership.kind === 'group' ? membership.group_role : membership.organization_role;
}

/** The outcomes a probe transaction can reach without writing anything. */
type ProbeOutcome =
  | { readonly kind: 'ok'; readonly mutatedAt: Date }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' };

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
    async ({ query }): Promise<ProbeOutcome> => {
      const membership = await readActingMembership(query, context.membershipId);
      // The membership verified at step 2 is no longer visible. Fail closed.
      if (membership === undefined) return { kind: 'not-found' };

      // SPEC-06 L4.2's shape, evaluated against current state inside the same
      // transaction as the write below (I-19, FAD-12). Nothing is cached.
      if (!provisionallyAuthorized(route, { kind: membership.kind, role: roleOf(membership) })) {
        return { kind: 'forbidden' };
      }

      const now = new Date();
      const rows = (await query
        .updateTable('memberships')
        .set({ last_active_at: now, updated_at: now })
        .where('id', '=', context.membershipId)
        .returning('updated_at')
        .execute()) as unknown as TouchedRow[];

      const touched = rows[0];
      if (touched === undefined) return { kind: 'not-found' };
      return { kind: 'ok', mutatedAt: touched.updated_at };
    },
  );

  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'forbidden') {
    return sendForbidden(request, reply, `role does not hold ${route.policy.capability}`);
  }

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
    { config: GROUP_SCOPED_CONFIG },
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

        const acting = await readActingMembership(query, context.membershipId);
        // The capability verdict is computed WITHOUT the object-policy layer,
        // which is exactly SPEC-06's reason for placing tenant binding at L5.1
        // after L4 rather than before it.
        const authorized =
          acting !== undefined &&
          provisionallyAuthorized(route, { kind: acting.kind, role: roleOf(acting) });

        const inScope = targetRows[0];
        if (inScope === undefined) return { authorized, inScope: null } as const;

        return {
          authorized,
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
          return sendForbidden(request, reply, `role does not hold ${route.policy.capability}`);
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

      const authorized = await request.server.tenancy.runtime.run(command, async ({ query }) => {
        const acting = await readActingMembership(query, context.membershipId);
        if (acting === undefined) return null;
        return provisionallyAuthorized(route, { kind: acting.kind, role: roleOf(acting) });
      });

      if (authorized === null) return sendNotFound(request, reply);
      if (!authorized) {
        return sendForbidden(request, reply, `role does not hold ${route.policy.capability}`);
      }

      // SPEC-01 §6: the context is FROZEN into the payload at enqueue — the
      // tenant tuple, the acting membership, the correlation id, and the
      // authorization version observed now. The version is evidence of intent;
      // the worker re-evaluates from scratch (SPEC-06 §5).
      const frozen: FrozenJobContext = {
        actionScope: context.actionScope,
        expectedOrganizationId: context.expectedOrganizationId,
        expectedGroupId: context.expectedGroupId,
        membershipId: context.membershipId,
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
