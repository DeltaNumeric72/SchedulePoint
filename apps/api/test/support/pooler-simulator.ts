import type pg from 'pg';

/**
 * A statement-level pooler, simulated **at the driver boundary**.
 *
 * ## Why this lives here and not in the wrapper
 *
 * The SP-A spike simulated the prohibited pooling mode with a `poolerMode`
 * branch *inside* `withUnitOfWork`, and its own report disclosed that as a
 * weakness in the evidence — "a mock inside the unit under test is a real (if
 * accepted) weakness" (SPIKE-REPORT §8.2). This harness removes it: the
 * production `PgUnitOfWorkRunner` contains no branch that exists for a test, and
 * the fault is injected by wrapping the `pg.Pool` handed to it — which is
 * exactly where a real pooler sits, between the driver and the server.
 *
 * The runner cannot tell the difference, which is the point: T-14 and T-14b now
 * prove that the *shipped* code detects the fault, not that a test-only branch
 * of it does.
 *
 * ## What the simulation is, and is not
 *
 * Two faults, both strictly *more* detectable than the worst real case:
 *
 *  - `drops-all-set-config` — every `set_config` is swallowed, as if routed to a
 *    backend the rest of the transaction never sees;
 *  - `drops-group-id` — only `app.group_id` is swallowed. The partial case, and
 *    the one that matters: a read-back that checked `app.organization_id` alone
 *    would pass this and then run fail-OPEN across every group in the right
 *    organization (T-14b).
 *
 * A **real** statement-level pooler routes every statement independently,
 * including the read-back itself, so it could route `set_config` and the
 * read-back together and the actual query elsewhere. No simulation catches that;
 * only the startup assertion in `src/db/pooler-assertion.ts` does. This is a
 * detector test, and the report says so (SPIKE-REPORT §5).
 */

export type SimulatedPoolerFault = 'drops-all-set-config' | 'drops-group-id';

const SET_CONFIG = /set_config\s*\(/i;

/**
 * Which `set_config` call this statement is, judged from its bind parameters
 * rather than from the SQL text — the wrapper parameterises the setting name, so
 * the text is identical for all four.
 */
function settingNameOf(params: unknown): string | undefined {
  if (!Array.isArray(params)) return undefined;
  const first = params[0];
  return typeof first === 'string' ? first : undefined;
}

/**
 * Wraps a pool so that `set_config` statements are silently discarded.
 *
 * The statement is replaced with a harmless `select 1` rather than skipped, so
 * the driver's request/response accounting stays consistent and the transaction
 * proceeds exactly as it would if the setting had been applied on a backend this
 * one cannot see.
 */
export function withSimulatedPoolerFault(pool: pg.Pool, fault: SimulatedPoolerFault): pg.Pool {
  const realConnect = pool.connect.bind(pool);

  const patchedConnect = async (): Promise<pg.PoolClient> => {
    const client = await realConnect();
    const realQuery = client.query.bind(client) as (text: unknown, params?: unknown) => unknown;

    (client as unknown as { query: unknown }).query = (text: unknown, params?: unknown) => {
      const sqlText =
        typeof text === 'string' ? text : String((text as { text?: string }).text ?? '');
      const bound =
        params ?? (typeof text === 'object' && text !== null
          ? (text as { values?: unknown }).values
          : undefined);

      if (SET_CONFIG.test(sqlText)) {
        const setting = settingNameOf(bound);
        const drop =
          fault === 'drops-all-set-config' ||
          (fault === 'drops-group-id' && setting === 'app.group_id');
        if (drop) {
          return realQuery('select 1 as discarded_by_simulated_pooler');
        }
      }
      return realQuery(text, params);
    };

    return client;
  };

  (pool as unknown as { connect: unknown }).connect = patchedConnect;
  return pool;
}
