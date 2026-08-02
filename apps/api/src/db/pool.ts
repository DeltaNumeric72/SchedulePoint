import pg from 'pg';

import { connectionConfig } from './config.js';
import type { RoleName } from './roles.js';

/**
 * The connection pool.
 *
 * **In-process `pg.Pool`, with transaction affinity.** TDG-03 confirmed this
 * shape and re-confirmed that statement-level pooling is prohibited: a pooler
 * that routes each statement independently breaks transaction-local tenant
 * context, and the failure is fail-closed but total (SPIKE-REPORT §5, X-02).
 *
 * If an external pooler is ever put in front of PostgreSQL it must run in
 * session or transaction mode with transaction affinity, and TDG-03 needs a
 * follow-up spike against that specific product — the executed spike exercised
 * only the in-process pool and says so (SPIKE-REPORT §8.1). Whatever is in
 * front, `assertTransactionAffinity` runs at startup and refuses traffic if the
 * property does not hold.
 */
export interface PoolOptions {
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
  /** node-postgres client-side deadline. Distinct from the server's `statement_timeout`. */
  readonly queryTimeoutMillis?: number;
  readonly allowExitOnIdle?: boolean;
  readonly database?: string;
}

export function createPool(role: RoleName, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    ...connectionConfig(role, options.database),
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    ...(options.queryTimeoutMillis === undefined
      ? {}
      : { query_timeout: options.queryTimeoutMillis }),
    allowExitOnIdle: options.allowExitOnIdle ?? false,
  });
}
