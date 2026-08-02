import { randomUUID } from 'node:crypto';

import type pg from 'pg';

/**
 * SPEC-01 §4 amendment (c) — the pooler-mode startup assertion.
 *
 * > the per-transaction read-back is a **detector, not a proof**, against
 * > statement-level routing; each process asserts transaction affinity at
 * > startup (two-statement probe equivalent to X-02) and **refuses traffic on
 * > failure**.
 *
 * The read-back inside every unit of work is a point-in-time check, and a real
 * statement-level pooler routes *every* statement independently — including the
 * read-back statement itself. It is therefore possible for such a pooler to send
 * `set_config` and the read-back to the same backend (read-back passes) and then
 * send the actual query elsewhere. **The load-bearing control for TDG-03 is
 * configuration, not detection** (SPIKE-REPORT §5). This is that control.
 *
 * The probe asserts three things, in one transaction plus one checkout:
 *
 *  1. **Affinity** — two statements in one transaction reach the same backend.
 *  2. **Survival** — a `set_config(..., true)` written by statement one is
 *     visible to statement two. Under statement-level pooling it is not.
 *  3. **Expiry** — after the transaction ends, the value is gone. If it survived,
 *     the setting was not transaction-local and CAR-002 is live.
 *
 * A failure is fatal by design. A process that cannot prove transaction affinity
 * must not serve traffic: every tenant guarantee in the system is downstream of
 * it.
 */

/** A GUC used only by this probe. It is never read by any RLS policy. */
const PROBE_SETTING = 'app.pooler_probe';

export class PoolerModeAssertionError extends Error {
  readonly code = 'POOLER_MODE_UNSUPPORTED';

  constructor(
    reason: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(
      `POOLER_MODE_UNSUPPORTED: ${reason}. Statement-level pooling is prohibited ` +
        '(SPEC-01 §4.2, SPEC-15 TDG-03); the pooler must run in session or ' +
        'transaction mode with transaction affinity. This process will not serve traffic.',
    );
    this.name = 'PoolerModeAssertionError';
  }
}

export interface PoolerProbeResult {
  readonly firstBackendPid: number;
  readonly secondBackendPid: number;
  readonly settingSurvivedWithinTransaction: boolean;
  readonly settingExpiredAfterTransaction: boolean;
}

/**
 * Runs the probe. Returns the observations; **throws** if any of the three
 * properties does not hold.
 */
export async function assertTransactionAffinity(pool: pg.Pool): Promise<PoolerProbeResult> {
  const nonce = randomUUID();
  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;

    // Statement one: write the transaction-local value and record the backend.
    const first = await client.query<{ pid: number }>(
      'select set_config($1, $2, true), pg_backend_pid() as pid',
      [PROBE_SETTING, nonce],
    );

    // Statement two: a SEPARATE round trip. A statement-level pooler routes it
    // to a different backend, which sees neither the value nor the transaction.
    const second = await client.query<{ pid: number; observed: string | null }>(
      'select pg_backend_pid() as pid, current_setting($1, true) as observed',
      [PROBE_SETTING],
    );

    await client.query('COMMIT');
    inTransaction = false;

    const firstBackendPid = first.rows[0]?.pid ?? -1;
    const secondBackendPid = second.rows[0]?.pid ?? -2;
    const settingSurvivedWithinTransaction = second.rows[0]?.observed === nonce;

    // After the transaction the value must be gone. `SET LOCAL` reverts the
    // VALUE without undefining the GUC, so the post-transaction reading is `''`
    // on this connection, not NULL — which is exactly why every RLS predicate is
    // spelled `nullif(current_setting(...), '')` (SPIKE-REPORT §6.1 / X-09).
    const after = await client.query<{ observed: string | null }>(
      'select current_setting($1, true) as observed',
      [PROBE_SETTING],
    );
    const observedAfter = after.rows[0]?.observed ?? null;
    const settingExpiredAfterTransaction = observedAfter === null || observedAfter === '';

    const result: PoolerProbeResult = {
      firstBackendPid,
      secondBackendPid,
      settingSurvivedWithinTransaction,
      settingExpiredAfterTransaction,
    };

    if (firstBackendPid !== secondBackendPid) {
      throw new PoolerModeAssertionError(
        'two statements in one transaction reached different backends',
        { ...result },
      );
    }
    if (!settingSurvivedWithinTransaction) {
      throw new PoolerModeAssertionError(
        'a transaction-local setting written by the first statement was not visible to the second',
        { ...result },
      );
    }
    if (!settingExpiredAfterTransaction) {
      throw new PoolerModeAssertionError(
        'a transaction-local setting survived the transaction — the setting is not transaction-local',
        { ...result, observedAfter },
      );
    }

    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the connection is being released either way */
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
