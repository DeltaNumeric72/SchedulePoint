import {
  auditEventListSchema,
  auditEventQuerySchema,
  validationProblemBodySchema,
  type AuditEventQuery,
  type AuditEventView,
} from '@schedulepoint/contracts';
import type { Decision, FieldProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { readAuditEvents } from '../../audit/reader.js';
import type { Database } from '../../db/schema.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The audit READ surface (OPUS-M3-008; the gap FAD-26 recorded).
 *
 * ## One route, one question
 *
 * `GET …/groups/:groupId/audit-events` answers "what happened, in this group,
 * that I am allowed to see?" — optionally narrowed to one subject. It does not
 * verify the chain, does not export it, and writes nothing: `apps/api/src/audit/
 * reader.ts` contains no statement that is not a `SELECT`, so non-bypass rule 6
 * is preserved by construction rather than by review.
 *
 * ## Why the key is grant-only and new
 *
 * `audit.read` is declared in `packages/domain/src/authz/catalogue.ts` with the
 * full reasoning. In short: `audit.export` is organization-scoped and is the
 * whole log, so gating a group-scoped subject read on it would mean granting the
 * entire organization's audit log to display one version's history — the shape
 * of over-grant the holiday-calendar split exists to undo. No role holds it, so
 * a scheduler sees the denial state until somebody grants it, which is honest.
 *
 * ## Denial and not-found are the same reply
 *
 * The standing rule (T-05b, P-3): a caller without the key gets the fixed 403/404
 * envelope with no reason, and a subject in another group produces the same
 * `404` an absent subject does — RLS makes the rows invisible rather than the
 * route making a decision about them.
 *
 * ## The query is parsed AFTER the verdict
 *
 * SBX-001's disclosure finding. Parsing first would let an unauthorized caller
 * distinguish "this route exists and dislikes your parameter" from "there is no
 * such route" by sending `?limit=nonsense`.
 */

/**
 * `audit.read`, CAP-014.
 *
 * CAP-014 rather than a new CAP-###: the baseline is the 58 capabilities of
 * report 19 and this adds none. The publication/version traceability row is what
 * this surface serves — the audit trail OF a schedule publication — and the
 * ACTION key is the unit L4 evaluates.
 */
export const AUDIT_READ_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-014' },
  actionScope: 'group',
  action: {
    key: 'audit.read',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

type Uow = Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0];

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] };

const MAX_PROBLEM_MESSAGE = 300;

function parseQuery(query: unknown): Outcome<AuditEventQuery> {
  const parsed = auditEventQuerySchema.safeParse(query);
  if (parsed.success) return { kind: 'ok', value: parsed.data };
  const problems: FieldProblem[] = parsed.error.issues.map((issue) => ({
    field: issue.path.join('.') || 'query',
    message:
      issue.message.length > MAX_PROBLEM_MESSAGE
        ? `${issue.message.slice(0, MAX_PROBLEM_MESSAGE - 1)}…`
        : issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0 ? problems : [{ field: 'query', message: 'The query is not valid.' }],
  };
}

/**
 * Display names for the memberships this context can see.
 *
 * Read here rather than imported from the publication route: a cross-route
 * import for four lines of SQL would couple two surfaces whose only shared fact
 * is that people have names. RLS scopes it; there is no id list to leak through.
 */
async function readDisplayNames(uow: Uow): Promise<ReadonlyMap<string, string>> {
  const rows = (await (uow.query as Kysely<Database>)
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['m.id as id', 'u.display_name as display_name'])
    .execute()) as unknown as { id: string; display_name: string }[];
  return new Map(rows.map((row) => [row.id, row.display_name]));
}

export default function auditRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/audit-events';

  app.get(base, { config: AUDIT_READ_CONFIG }, async (request, reply) => {
    const { context, command, route } = requireTenantContext(request);

    const outcome = await request.server.tenancy.runtime.run(
      command,
      async (uow): Promise<Outcome<{ events: readonly AuditEventView[]; truncated: boolean }>> => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied', decision };

        const parsed = parseQuery(request.query);
        if (parsed.kind !== 'ok') return parsed;

        const names = await readDisplayNames(uow);
        const result = await readAuditEvents(uow, parsed.value, names);
        return { kind: 'ok', value: result };
      },
    );

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

    return auditEventListSchema.parse({
      events: outcome.value.events,
      truncated: outcome.value.truncated,
      sequenceIsOrganizationWide: true,
      correlationId: request.correlationId,
    });
  });
}
