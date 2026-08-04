import type { ActionInput, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { evaluateAction } from '../authz/authorize-request.js';
import type { Database } from '../db/schema.js';
import { ScheduleDeniedError } from './errors.js';

/**
 * The schedule module's authorization gate.
 *
 * ## One evaluator, every path (SPEC-06 §7)
 *
 * This packet ships no HTTP surface — the scheduler-facing routes are
 * OPUS-M3-004/005/006 — so the gate is called by the SERVICE rather than by a
 * route handler. It is nevertheless the same `evaluateAction`, the same loader
 * and the same fifteen-row truth table the routes use: the evaluator is
 * integrated here, never reimplemented and never modified.
 *
 * ## Freshness is a property of WHERE this runs (I-19)
 *
 * `evaluateAction` takes the unit of work's `Kysely` handle, so the
 * authorization snapshot, the mutation and the audit row are one transaction
 * (FAD-12), and the verdict is against current state. A grant revoked while a
 * publication is in flight is therefore seen by the publication: the gate runs
 * inside the transaction that publishes, not before it.
 *
 * ## Publish is a distinct capability from edit
 *
 * `schedule.version.edit` is role-implied for a scheduler; `schedule.publish`
 * and `schedule.revert` are grant-only (doc 08 §4). Authoring a draft and making
 * it the authoritative, staff-visible schedule are different powers.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** The acting principal. The evaluator needs the user; RLS needs the membership. */
export interface ScheduleActor {
  readonly principalUserId: string;
}

/**
 * The four action keys this module evaluates.
 *
 * `requiresObjectPolicy: false` on every one: L5.1's object policy is for
 * self-scoped actions (own request, own profile), and none of these is
 * self-scoped — a scheduler acts on the group's schedule, not on their own row.
 * Ownership is deliberately absent for the same reason.
 */
export const SCHEDULE_ACTIONS = {
  /** Create and maintain periods and their period-scoped requirements. */
  periodAdminister: {
    key: 'schedule.period.administer',
    moduleKey: 'core_scheduling',
    scope: 'group',
    requiresObjectPolicy: false,
  },
  /** Author a DRAFT version: create, clone, assign, override, pin, credit, transition. */
  versionEdit: {
    key: 'schedule.version.edit',
    moduleKey: 'core_scheduling',
    scope: 'group',
    requiresObjectPolicy: false,
  },
  /** Publish a version. Grant-only. */
  publish: {
    key: 'schedule.publish',
    moduleKey: 'core_scheduling',
    scope: 'group',
    requiresObjectPolicy: false,
  },
  /** Revert by publishing forward. Grant-only, and distinct from `publish`. */
  revert: {
    key: 'schedule.revert',
    moduleKey: 'core_scheduling',
    scope: 'group',
    requiresObjectPolicy: false,
  },
} as const satisfies Record<string, ActionInput>;

export type ScheduleActionName = keyof typeof SCHEDULE_ACTIONS;

/**
 * Evaluate, and throw on a denial — the "evaluate → deny" half of FAD-12's
 * ordering. Callers do the "→ mutate → audit" half in the same unit of work.
 *
 * The `Decision` travels on the error rather than being flattened to a boolean,
 * so a future route maps it through `respondToDenial` and discloses only the
 * disclosure class (P-5/P-6). The explanation never reaches a caller.
 */
export async function requireScheduleCapability(
  uow: Uow,
  actor: ScheduleActor,
  action: ScheduleActionName,
  now?: Date,
): Promise<void> {
  const membershipId = uow.context.membershipId;
  if (membershipId === null) {
    // The evaluator's context requires an acting membership (SPEC-01 §2.3 step
    // 2). Every action here is a human scheduling act; there is no system-actor
    // branch, and defaulting one in would be an unauthenticated write path.
    throw new Error(
      'SCHEDULE_REQUIRES_ACTING_MEMBERSHIP: a schedule action was reached with a system-actor ' +
        'context',
    );
  }

  const { decision } = await evaluateAction(uow.query, {
    context: {
      principalUserId: actor.principalUserId,
      expectedOrganizationId: uow.context.organizationId,
      expectedGroupId: uow.context.groupId,
      membershipId,
    },
    action: SCHEDULE_ACTIONS[action],
    ...(now === undefined ? {} : { now }),
  });
  if (!decision.allowed) throw new ScheduleDeniedError(decision);
}
