import type { UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import type { JobHandler } from '../jobs/worker.js';

import { expireRequest, type ExpiredRequest } from './service.js';
import { requestStore } from './store.js';

/**
 * **The expiry sweeper** — SPEC-08 §3: *"Expiry is a job. A sweeper moves
 * undecided past-deadline requests to `expired`, audited, requester notified"*
 * (OPUS-M5-001, doc 42 §5c Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why expiry is a job and not a read-time computation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A request whose deadline has passed could in principle be *treated* as expired
 * wherever it is read, with no row ever changing. §3 chose a job instead, and
 * the choice is right for three reasons this implementation depends on:
 *
 *   1. **The requester is notified.** A status nobody wrote is a status nobody
 *      can be told about. A read-time computation would leave a person's request
 *      quietly dead with no message and nothing in their timeline.
 *   2. **It is audited.** The chain records what happened to the aggregate, and
 *      "this expired at this moment" is a fact about the aggregate. A derived
 *      status has no moment.
 *   3. **Every reader would need the rule.** A computed status is a rule
 *      re-implemented in every query that reads a request — the solver
 *      projection, the scheduler's queue, the member's list — and one of them
 *      would eventually get it wrong.
 *
 * ## The three legal source states, and nothing else (V-31, R-23)
 *
 * `claimExpirable` selects on `submitted`, `under_review`, `accepted_as_input`,
 * and `expireRequest` re-asks the domain matrix before writing. Both are the
 * enumeration, and neither is a wildcard — the superseded `* → expired` spelling
 * would have let this job expire a request a PUBLISHED version already honours,
 * which is the specific outcome R-23 tests for.
 *
 * ## Authorization: a real acting membership, re-evaluated at execution
 *
 * This is a `JobHandler`, so it goes through the same evaluator as every HTTP
 * route (SPEC-06 §7, FAD-13 item 1) and its authorization is **re-evaluated
 * against current state at execution time**, not against the decision frozen
 * when it was enqueued (I-19). The worker refuses a job whose frozen context
 * names no membership, so this never runs anonymously — which is why migration
 * 0023's SENSITIVE-PII narrowing needs no system arm and contains none.
 *
 * It declares `requests.administer`, because expiring somebody else's request is
 * an administrative act on SENSITIVE-PII data. The RLS policy names the same
 * key, so the grant is checked twice on independent paths: once by the evaluator
 * before the body runs, and once by the database on every row this touches.
 *
 * ## I-11 — a notification failure never rolls back a domain change
 *
 * Each expiry writes its status change, its audit row and its outbox row in ONE
 * transaction. Delivery happens afterwards, from a dispatcher that cannot reach
 * back into it. There is no path here in which a failed notification un-expires
 * a request.
 *
 * ## Bounded, and re-entrant
 *
 * One sweep claims at most `SWEEP_LIMIT` rows with `FOR UPDATE SKIP LOCKED`.
 * Two sweepers divide the work rather than colliding; neither waits on the
 * other. And the bound matters most in exactly the case it looks unnecessary: a
 * sweeper that tried to expire every overdue request accumulated during an
 * outage would hold locks proportional to the length of the outage, so the
 * longer the failure the more damage the recovery does. Leftovers are swept by
 * the next run.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** Rows claimed per sweep. See the header on why this is bounded. */
export const SWEEP_LIMIT = 200;

export const REQUEST_EXPIRY_SWEEP_JOB = 'requests.expiry-sweep';

export interface SweepResult {
  readonly claimed: number;
  readonly expired: readonly ExpiredRequest[];
  /**
   * Rows claimed that the domain matrix or the conditional update refused.
   *
   * Reported rather than swallowed. A non-zero count means the claim query and
   * §2's matrix disagree, or another writer moved the row between the claim and
   * the write — both are facts an operator should be able to see, and neither is
   * a reason to fail the sweep and leave the rest unswept.
   */
  readonly refused: number;
}

/**
 * Sweep one batch. Exported separately from the handler so a test can drive it
 * with an explicit `now` — a sweeper whose only entry point read the wall clock
 * would have no boundary cases that could be written down.
 */
export async function sweepExpiredRequests(uow: Uow, now: Date): Promise<SweepResult> {
  const claimed = await requestStore.claimExpirable(uow, now, SWEEP_LIMIT);

  const expired: ExpiredRequest[] = [];
  let refused = 0;

  for (const root of claimed) {
    const outcome = await expireRequest(uow, root, now);
    if (outcome.ok) expired.push(outcome.value);
    else refused += 1;
  }

  return { claimed: claimed.length, expired, refused };
}

export const requestExpirySweepHandler: JobHandler = {
  kind: REQUEST_EXPIRY_SWEEP_JOB,
  policy: {
    capability: 'CAP-021',
    actionScope: 'group',
    action: {
      key: 'requests.administer',
      moduleKey: 'requests_vacation',
      /* No object policy: the sweep has no single target. It acts on every row
       * the group's deadline has passed for, and L5.1's ownership question has
       * no answer for a set. The narrowing that makes this safe is the RLS
       * policy naming the same capability, evaluated per row. */
      requiresObjectPolicy: false,
    },
  },
  run: async (uow) => {
    await sweepExpiredRequests(uow, new Date());
  },
};
