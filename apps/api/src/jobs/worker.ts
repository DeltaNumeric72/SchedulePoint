import {
  membershipIsActive,
  type EnqueuedJob,
  type JobOutcome,
  type MembershipSnapshot,
  type TenantContext,
} from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import type { PgUnitOfWork } from '../db/unit-of-work.js';
import { provisionallyAuthorized } from '../http/policy.js';

/**
 * SPEC-01 §6 and SPEC-06 §5 — executing a job under a frozen context.
 *
 * | Rule | Detail |
 * |---|---|
 * | **Execution** | Opens a unit of work with the frozen context and **re-evaluates authorization against current state** — not against the frozen decision |
 * | **Authorization now fails** | Terminal state `cancelled_unauthorized`, audited, requester notified. **Not silently dropped, not silently completed** |
 * | **No context** | The worker **refuses the job**. There is no default tenant |
 *
 * > The enqueue-time decision is **evidence of intent, never authority.**
 *
 * This closes the scenario CAR-008 named: a queued export that runs after the
 * user's access is removed and writes a downloadable artifact. Here it
 * terminates as `cancelled_unauthorized` and produces nothing.
 *
 * The worker runs under **`app_worker`** — a separate credential from
 * `app_runtime`, with its own grants, and no `BYPASSRLS` (SPEC-01 §4.4). It is
 * subject to exactly the same policies, which is why the §7.2 battery probes it
 * as well as the runtime role.
 */

/** Roles permitted to run a job of a given kind, pending SPEC-06's evaluator. */
export interface JobAuthorizationPolicy {
  readonly capability: string;
  readonly actionScope: 'group' | 'organization';
  readonly allowRoles: readonly string[];
  readonly rationale: string;
}

export type JobBody = (
  uow: PgUnitOfWork,
  job: EnqueuedJob,
  membership: MembershipSnapshot,
) => Promise<void>;

export interface JobHandler {
  readonly kind: string;
  readonly policy: JobAuthorizationPolicy;
  readonly run: JobBody;
}

interface MembershipRow {
  id: string;
  kind: string;
  organization_id: string;
  group_id: string | null;
  user_id: string;
  status: string;
  organization_role: string | null;
  group_role: string | null;
  valid_from: Date;
  valid_to: Date | null;
}

function refuse(reason: string): JobOutcome {
  return { status: 'refused_no_context', reason };
}

function cancel(reason: string): JobOutcome {
  return { status: 'cancelled_unauthorized', reason };
}

/**
 * Executes one job.
 *
 * Every outcome is explicit. There is no path that returns without a
 * `JobOutcome`, and no path that swallows a denial — SPEC-06 §5's whole point is
 * that a job whose authorization lapsed neither succeeds nor vanishes.
 */
export async function executeJob(
  worker: PgUnitOfWorkRunner,
  job: EnqueuedJob,
  handlers: ReadonlyMap<string, JobHandler>,
): Promise<JobOutcome> {
  const handler = handlers.get(job.kind);
  if (handler === undefined) {
    return { status: 'failed', reason: `no handler registered for job kind ${job.kind}` };
  }

  const frozen = job.context;

  /* ── "No context: the worker refuses the job. There is no default tenant." ── */
  if (frozen.expectedOrganizationId === '') {
    return refuse('the frozen context names no organization');
  }
  if (frozen.actionScope !== handler.policy.actionScope) {
    return refuse(
      `the frozen context declares ${frozen.actionScope} scope but the handler is ${handler.policy.actionScope}-scoped`,
    );
  }
  if (frozen.actionScope === 'group' && frozen.expectedGroupId === null) {
    return refuse('a group-scoped job froze no group');
  }
  if (frozen.actionScope === 'organization' && frozen.expectedGroupId !== null) {
    return refuse('an organization-scoped job froze a group');
  }
  if (!frozen.systemActor && frozen.membershipId === null) {
    return refuse('the frozen context names neither a membership nor a system actor');
  }
  if (frozen.systemActor) {
    // A system actor has "its own narrow capability set, audited as a system
    // action" (SPEC-06 §5). That capability set does not exist yet, so the only
    // honest behaviour is to refuse rather than to invent an unbounded actor.
    return refuse('system-actor jobs have no capability set until OPUS-M1-002 defines one');
  }

  const context: TenantContext = {
    organizationId: frozen.expectedOrganizationId,
    groupId: frozen.expectedGroupId,
    membershipId: frozen.membershipId,
    correlationId: frozen.correlationId,
  };

  return worker.run(context, async (uow) => {
    /* ── re-evaluate against CURRENT state, not the frozen decision ────────── */
    //
    // The read is under RLS with the frozen tenant tuple in force, so a
    // membership that has been moved, ended, or belonged to another tenant all
    // along simply is not visible — and invisible is the same answer as revoked.
    const rows = (await uow.query
      .selectFrom('memberships')
      .select([
        'id',
        'kind',
        'organization_id',
        'group_id',
        'user_id',
        'status',
        'organization_role',
        'group_role',
        'valid_from',
        'valid_to',
      ])
      .where('id', '=', frozen.membershipId)
      .execute()) as unknown as MembershipRow[];

    const row = rows[0];
    if (row === undefined) {
      return cancel('the acting membership is no longer visible in the frozen tenant');
    }

    const membership: MembershipSnapshot = {
      id: row.id,
      kind: row.kind === 'organization' ? 'organization' : 'group',
      organizationId: row.organization_id,
      groupId: row.group_id,
      userId: row.user_id,
      status: row.status as MembershipSnapshot['status'],
      organizationRole: row.organization_role,
      groupRole: row.group_role,
      validFrom: row.valid_from.toISOString(),
      validTo: row.valid_to?.toISOString() ?? null,
    };

    if (!membershipIsActive(membership, new Date().toISOString())) {
      return cancel(`the acting membership is ${membership.status} or outside its validity window`);
    }

    const authorized = provisionallyAuthorized(
      {
        policy: { kind: 'capability', capability: handler.policy.capability },
        actionScope: handler.policy.actionScope,
        provisional: {
          allowRoles: handler.policy.allowRoles,
          rationale: handler.policy.rationale,
        },
      },
      {
        kind: membership.kind,
        role: membership.kind === 'group' ? membership.groupRole : membership.organizationRole,
      },
    );

    if (!authorized) {
      return cancel(
        `the acting membership's role no longer satisfies ${handler.policy.capability}`,
      );
    }

    await handler.run(uow, job, membership);
    return { status: 'completed' } satisfies JobOutcome;
  });
}
