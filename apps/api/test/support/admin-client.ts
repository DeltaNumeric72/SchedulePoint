import pg from 'pg';

import { HARNESS_ENV } from './env.js';

/**
 * A superuser client, used **only** for out-of-band harness observation and
 * fault injection: `pg_cancel_backend`, `pg_terminate_backend`, `pg_policies`,
 * `pg_stat_activity`, and the ground-truth census.
 *
 * It is never used to satisfy an assertion about application behaviour. Reading
 * the fixture with a superuser and then claiming the application could see it
 * would be evidence of nothing.
 *
 * ## Why this is not in `cluster.ts`
 *
 * `cluster.ts` imports `embedded-postgres`, and **importing that package changes
 * the exit code of whatever process imports it** — see the docblock there. Test
 * files need an admin client; they must not, even transitively, import the
 * cluster module. Keeping the two apart is what makes that a structural fact
 * rather than a convention, and
 * `test/architecture/embedded-postgres-isolation.test.ts` asserts it.
 */
export function adminClient(database = HARNESS_ENV['SP_PG_DATABASE']): pg.Client {
  return new pg.Client({
    host: HARNESS_ENV['SP_PG_HOST'],
    port: Number(HARNESS_ENV['SP_PG_PORT']),
    database,
    user: HARNESS_ENV['SP_PG_SUPERUSER'],
    password: HARNESS_ENV['SP_PG_SUPERUSER_PASSWORD'],
  });
}
