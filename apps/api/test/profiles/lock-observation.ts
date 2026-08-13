import type pg from 'pg';

/**
 * Observing, from outside, that one backend is blocked on a lock **another named
 * backend holds** (OPUS-M4-001S; review finding R-3).
 *
 * ## Why this is a module rather than a copy in each file
 *
 * Two proofs in this directory build a deterministic interleaving by starting one
 * transaction, holding it open, and starting a second that must block —
 * `granted-while-retiring-inertness.test.ts` (FAD-28(2)/FAD-35, the audit
 * advisory lock) and `requires-expiry-flip-serialization.test.ts` (FAD-36(2), the
 * qualification row lock). Both stand or fall on the same observation, so both
 * make it the same way. It is not collected by Vitest — the project's `include`
 * takes only files ending `.test.ts` — and it contains no assertions of its own:
 * it observes, and the caller asserts.
 *
 * ## What R-3 tightened, and why the weaker form was not enough
 *
 * The first version waited for `wait_event_type = 'Lock'` and returned. That is
 * satisfied by ANY lock wait — a lock on another table, a wait caused by an
 * unrelated fixture, a queue behind a third backend. A proof whose ordering
 * premise is "something, somewhere, blocked" is a proof of nothing in
 * particular. So a caller now names what it expects:
 *
 *   * `waitEvent`   — WHICH lock (`advisory` for the 0003 per-organization audit
 *                     lock; `transactionid`/`tuple` for a row lock), and
 *   * `blockedBy`   — WHICH backend holds it, checked against
 *                     `pg_blocking_pids()` rather than inferred from timing.
 *
 * Both are matched before the wait returns; neither is optional when the caller
 * passes it. A timeout reports the LAST observation, so "it blocked on the wrong
 * thing" and "it never blocked" are distinguishable in the failure text rather
 * than in a rerun.
 *
 * Polled with the superuser client, which is harness OBSERVATION only — see
 * `../support/admin-client.ts`. No assertion about application behaviour is
 * satisfied by a superuser read.
 */

export interface LockObservation {
  readonly pid: number;
  readonly waitEventType: string;
  readonly waitEvent: string | null;
  /** `pg_blocking_pids()` — the backends whose locks this one is waiting for. */
  readonly blockedBy: readonly number[];
  readonly state: string | null;
}

export interface LockExpectation {
  /** The `pg_stat_activity.wait_event` the caller expects, or a set of accepted ones. */
  readonly waitEvent?: string | readonly string[];
  /** The backend the caller expects to be holding the lock. */
  readonly blockedBy?: number;
  /** How long to wait for the expectation to be met. */
  readonly budgetMs?: number;
}

function describe(row: LockObservation | undefined): string {
  if (row === undefined) return 'no such backend';
  return (
    `state=${String(row.state)} wait=${row.waitEventType}/${String(row.waitEvent)} ` +
    `blocked_by=[${row.blockedBy.join(',')}]`
  );
}

function matches(row: LockObservation, expectation: LockExpectation): boolean {
  if (row.waitEventType !== 'Lock') return false;
  const { waitEvent, blockedBy } = expectation;
  if (waitEvent !== undefined) {
    const accepted = typeof waitEvent === 'string' ? [waitEvent] : waitEvent;
    if (row.waitEvent === null || !accepted.includes(row.waitEvent)) return false;
  }
  if (blockedBy !== undefined && !row.blockedBy.includes(blockedBy)) return false;
  return true;
}

/** One reading of a backend's wait state, or `undefined` if it is gone. */
export async function observeBackend(
  admin: pg.Client,
  pid: number,
): Promise<LockObservation | undefined> {
  const seen = await admin.query<{
    wait_event_type: string | null;
    wait_event: string | null;
    state: string | null;
    blocked_by: number[] | null;
  }>(
    `select wait_event_type, wait_event, state, pg_blocking_pids(pid) as blocked_by
       from pg_stat_activity where pid = $1`,
    [pid],
  );
  const row = seen.rows[0];
  if (row === undefined) return undefined;
  return {
    pid,
    waitEventType: String(row.wait_event_type),
    waitEvent: row.wait_event,
    blockedBy: row.blocked_by ?? [],
    state: row.state,
  };
}

/**
 * Waits until `pid` is blocked on a lock matching `expectation`, and returns the
 * observation that matched.
 *
 * Throws — naming the last thing it saw — rather than returning a weaker
 * observation. "The transaction never blocked" is a finding about the mechanism
 * the caller's proof depends on, not a flake to retry.
 */
export async function waitUntilBlockedOnLock(
  admin: pg.Client,
  pid: number,
  expectation: LockExpectation = {},
): Promise<LockObservation> {
  const budgetMs = expectation.budgetMs ?? 20_000;
  const deadline = Date.now() + budgetMs;
  let last: LockObservation | undefined;
  while (Date.now() < deadline) {
    last = await observeBackend(admin, pid);
    if (last !== undefined && matches(last, expectation)) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  const acceptedEvents =
    expectation.waitEvent === undefined
      ? 'any Lock'
      : `Lock/${(typeof expectation.waitEvent === 'string' ? [expectation.waitEvent] : expectation.waitEvent).join('|')}`;
  const wanted =
    acceptedEvents +
    (expectation.blockedBy === undefined
      ? ''
      : ` held by backend ${String(expectation.blockedBy)}`);
  throw new Error(
    `backend ${String(pid)} was not blocked on ${wanted} within ${String(budgetMs)}ms ` +
      `(last seen: ${describe(last)}). The interleaving this proof depends on could not be ` +
      'established — investigate the serialisation mechanism before treating this as a transient.',
  );
}
