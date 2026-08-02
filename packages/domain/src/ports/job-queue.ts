/**
 * SPEC-01 §6 — background job context binding.
 *
 * | Rule | Detail |
 * |---|---|
 * | **Enqueue** | Freezes `expected_organization_id`, `expected_group_id`, acting `membership_id` (or an explicit system-actor marker), `correlation_id`, and the `authorization_version` observed at enqueue |
 * | **Execution** | Opens a unit of work with that context and **re-evaluates authorization against current state** — not against the frozen decision |
 * | **Authorization now fails** | The job terminates in an explicit `cancelled_unauthorized` state, is audited, and notifies the requester |
 * | **No context** | The worker **refuses the job**. There is no default tenant |
 *
 * The durable queue itself lands in OPUS-M1-003 (outbox + graphile-worker). This
 * port and the in-memory adapter behind it exist now so that the **context
 * freezing and re-evaluation** half — which is SPEC-01's half, and which SPEC-01
 * §7.1 T-03 tests — is proven on the same context path as the HTTP surface
 * rather than retrofitted onto a queue later.
 */

import type { ActionScope } from '../context/request-context.js';

/**
 * The context frozen into the job payload at enqueue.
 *
 * Frozen, not referenced: the values are copied at enqueue so that a later
 * change to the requester's context cannot silently retarget the job. The
 * `authorizationVersion` is carried as **evidence of intent, never authority**
 * (SPEC-06 §5) — execution re-evaluates from scratch and the frozen version is
 * only used to notice that something changed.
 */
export interface FrozenJobContext {
  readonly actionScope: ActionScope;
  readonly expectedOrganizationId: string;
  readonly expectedGroupId: string | null;
  /** The requesting membership, or `null` for an explicit system actor. */
  readonly membershipId: string | null;
  /** `true` when this job has no human requester. Audited as a system action. */
  readonly systemActor: boolean;
  readonly correlationId: string;
  readonly authorizationVersionAtEnqueue: string;
}

export interface EnqueuedJob {
  readonly id: string;
  readonly kind: string;
  readonly context: FrozenJobContext;
  /**
   * Job arguments. Tenant identifiers and record ids only — **never a payload
   * body and never delivery material** (I-17, SPEC-07 §3).
   */
  readonly args: Readonly<Record<string, string>>;
  readonly enqueuedAt: string;
}

/**
 * A job's terminal state.
 *
 * `cancelled_unauthorized` is spelled out because SPEC-06 §5 requires it by
 * name: a job whose authorization no longer holds **does not silently succeed
 * and does not silently vanish**.
 */
export type JobOutcome =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled_unauthorized'; readonly reason: string }
  | { readonly status: 'refused_no_context'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface JobQueue {
  enqueue(
    kind: string,
    context: FrozenJobContext,
    args: Readonly<Record<string, string>>,
  ): Promise<EnqueuedJob>;
}
