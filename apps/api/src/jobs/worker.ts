import {
  membershipIsActive,
  type EnqueuedJob,
  type JobOutcome,
  type MembershipSnapshot,
  type TenantContext,
} from '@schedulepoint/domain';

import { actionInputOf, evaluateAction } from '../authz/authorize-request.js';
import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import type { PgUnitOfWork } from '../db/unit-of-work.js';
import type { DeclaredAction } from '../http/policy.js';

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
 *
 * ## OPUS-M1-004: the SPEC-06 evaluator, on this surface too (FAD-13 item 1)
 *
 * Until this task the worker authorized on OPUS-M1-001's **role allow-list**,
 * because `apps/api/src/jobs/**` was OPUS-M1-003's parallel file scope while
 * OPUS-M1-002 was replacing that mechanism on the HTTP surface. The consequence
 * was not cosmetic: a role allow-list cannot see entitlements, module
 * availability or capability grants, so **SPEC-06 A-07 — "capability revoked
 * after enqueue, before execution" — was only covered in the role dimension.**
 * An organization whose module had been revoked mid-flight still had its queued
 * jobs run.
 *
 * The gate below is now `evaluateAction` — the same loader and the same truth
 * table the HTTP surface runs, in the same transaction as the mutation and its
 * audit row (FAD-12). `provisionallyAuthorized` is deleted; there is no second
 * authorization path left on any surface (SPEC-06 §7).
 *
 * What did **not** change: the re-evaluation still happens at execution against
 * current state, and the two terminal states keep their names and their
 * meanings — `refused_no_context` when the frozen context cannot be used at all,
 * `cancelled_unauthorized` when it can and the answer is no.
 */

/**
 * What a job handler requires, in the evaluator's own vocabulary.
 *
 * `capability` is the `CAP-###` baseline id and is **traceability**, not
 * evaluation input, exactly as it is on a route. What the evaluator reads is
 * `action.key`, and it reads it through the same `actionInputOf` the HTTP
 * surface uses.
 */
export interface JobAuthorizationPolicy extends DeclaredAction {
  /** `CAP-###` from the capability baseline. */
  readonly capability: string;
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

/**
 * An instant as an ISO string, or `null` when the value is not a usable date.
 *
 * **S-21, the third copy of this guard and the last one that was missing.**
 * `timestamptz` accepts `infinity`, node-postgres returns it as the JavaScript
 * **number** `Infinity` rather than a `Date`, and `Infinity.toISOString` does not
 * exist — so a single stored infinite bound on a membership crashed the worker
 * with a `TypeError` at the snapshot build, turning a job that should have been
 * cancelled into an unhandled failure.
 *
 * `apps/api/src/http/context/snapshot.ts` and
 * `apps/api/src/authz/load-policy-input.ts` both fixed this shape in
 * OPUS-M1-002; this one was left because `jobs/**` was another task's scope.
 * `0002_authorization.sql` now forbids infinite bounds at the CHECK level, which
 * makes it unreachable for **new** writes — the guard survives for rows written
 * before that constraint existed, and because "this membership is not usable" is
 * a better answer than a crash to a question that has one.
 *
 * The sentinel parses to `NaN`, `membershipIsActive` returns false, and the job
 * terminates `cancelled_unauthorized` — an explicit terminal state, which is what
 * SPEC-06 §5 requires and what a `TypeError` is not.
 */
const UNPARSABLE_INSTANT = 'unparsable-instant';

function instantOf(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
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
  if (frozen.systemActor) {
    // A system actor has "its own narrow capability set, audited as a system
    // action" (SPEC-06 §5). That capability set still does not exist — SPEC-06's
    // catalogue has no system-actor role and the evaluator has no slot for one —
    // so the only honest behaviour is to refuse rather than to invent an
    // unbounded actor. Recorded in EV-M1-INTEGRATION §5.
    return refuse('system-actor jobs have no capability set defined');
  }
  const membershipId = frozen.membershipId;
  const principalUserId = frozen.principalUserId;

  if (membershipId === null) {
    return refuse('the frozen context names neither a membership nor a system actor');
  }
  if (principalUserId === null) {
    // The evaluator's L3 cross-checks the acting membership against the
    // principal it was frozen for. A frozen context with no principal cannot be
    // evaluated, and evaluating it "without that check" would be a second,
    // weaker evaluator — which is the thing this task exists to remove.
    return refuse('the frozen context names no principal for its membership');
  }

  const context: TenantContext = {
    organizationId: frozen.expectedOrganizationId,
    groupId: frozen.expectedGroupId,
    membershipId,
    correlationId: frozen.correlationId,
  };

  return worker.run(context, async (uow) => {
    /* ── re-evaluate against CURRENT state, not the frozen decision ──────────
     *
     * The read is under RLS with the frozen tenant tuple in force, so a
     * membership that has been moved, ended, or belonged to another tenant all
     * along simply is not visible — and invisible is the same answer as revoked.
     *
     * The membership row is read FIRST because the handler needs the snapshot,
     * and `membershipIsActive` is the job surface's stand-in for SPEC-01 §2.3
     * step 2: the HTTP surface has middleware that resolves and validates the
     * acting membership before authorization runs, and the worker has no
     * middleware, so it does that half itself. It is a **narrowing** pre-check
     * over the same facts the evaluator re-reads, not a second verdict: the
     * authorization answer comes from `evaluateAction` and from nothing else. */
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
      .where('id', '=', membershipId)
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
      // S-21: guarded. See `instantOf` above.
      validFrom: instantOf(row.valid_from) ?? UNPARSABLE_INSTANT,
      validTo: row.valid_to === null ? null : (instantOf(row.valid_to) ?? UNPARSABLE_INSTANT),
    };

    if (!membershipIsActive(membership, new Date().toISOString())) {
      return cancel(`the acting membership is ${membership.status} or outside its validity window`);
    }

    /* ── SPEC-06's full truth table, on this surface too (FAD-13 item 1) ──────
     *
     * The same `loadPolicyInput` and the same `authorize` the HTTP surface runs,
     * against the same transaction's snapshot as the mutation below. The worker
     * therefore now sees L0 organization/group status, L1 entitlements and their
     * dependency closure, L2 group module availability, L3 the membership, L4
     * role capabilities AND capability grants, and L5/L6 — every dimension the
     * role allow-list could not see. */
    const { decision } = await evaluateAction(uow.query, {
      context: {
        principalUserId,
        expectedOrganizationId: frozen.expectedOrganizationId,
        expectedGroupId: frozen.expectedGroupId,
        membershipId,
      },
      action: actionInputOf(handler.policy),
    });

    if (!decision.allowed) {
      // The REASON code, never the explanation. A job outcome is read by
      // operators and stored; `Deny.explanation` is log-only on every surface
      // (`respondToDenial` does the same on HTTP).
      return cancel(
        `authorization no longer holds for ${handler.policy.action.key}: ${decision.reason} at ${decision.step}`,
      );
    }

    await handler.run(uow, job, membership);
    return { status: 'completed' } satisfies JobOutcome;
  });
}
