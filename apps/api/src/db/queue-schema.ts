import { runMigrations } from 'graphile-worker';
import pg from 'pg';

import { connectionConfig } from './config.js';

/**
 * Installing graphile-worker's schema, and the two things SP-D proved it needs.
 *
 * ## Why it lives in `src/db/`
 *
 * Because it owns a connection. `apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts`
 * requires every connection-owning module to sit in the `db/` layer, and the
 * right response to an architecture rule is to satisfy it rather than to add an
 * exemption — non-bypass rule 10 is about not subtracting tests, and widening an
 * allow-list is the quiet form of subtracting one.
 *
 * ## Why this is not a migration
 *
 * graphile-worker owns its own schema and its own migration history
 * (`graphile_worker.migrations`). Reproducing its DDL in `apps/api/migrations`
 * would fork it at the first upgrade, and calling its migrator *from* a
 * migration would nest two migration runners in one transaction. So this is a
 * bootstrap step, alongside `bootstrapCluster` — cluster and queue
 * infrastructure the domain migrations sit on top of, run as `app_migrator`.
 *
 * ## The two remediations, measured in SP-D E-0
 *
 * **graphile-worker creates all four of its tables with `ENABLE ROW LEVEL
 * SECURITY` and defines no policy at all, and its migrations contain no
 * `GRANT`.** RLS is not `FORCE`d there, so its owner bypasses it and every other
 * role is refused — regardless of grants. Measured:
 *
 * | Role | With full table grants |
 * |---|---|
 * | `app_worker` | reads **zero rows, silently**; graphile-worker logs "No tasks found" and idles forever |
 * | `app_runtime` | `add_job` → **`42501`** |
 *
 * The silent half is the dangerous one: a worker with grants but no policy
 * starts, reports healthy, and processes nothing.
 *
 * So:
 *
 * 1. **The consumer gets named policies**, one per RLS-enabled table, generated
 *    by a loop over `pg_class.relrowsecurity` rather than a hard-coded list — a
 *    graphile-worker upgrade that adds a table must not silently leave a hole.
 *    **Not** `DISABLE ROW LEVEL SECURITY` (non-bypass rule 3) and **not**
 *    `BYPASSRLS` on `app_worker`, which would hand it a bypass over every
 *    *tenant* table as well.
 * 2. **The producer gets a `SECURITY DEFINER` wrapper and nothing else.**
 *    `app_runtime` holds no grant and no policy on the queue tables; it can only
 *    enqueue through `app_enqueue_job`, which runs as the schema owner. SP-D
 *    E-1.1 measured the property that makes this safe: `SECURITY DEFINER` does
 *    **not** open a transaction of its own, so a rolled-back domain transaction
 *    still enqueues nothing.
 *
 * ## What is NOT tenant-scoped here, said plainly
 *
 * graphile-worker's tables carry no tenant column and are not under our RLS.
 * They hold a task name, a small payload of identifiers, and scheduling state.
 * **The tenant boundary for a job is enforced where SPEC-01 §6 puts it** — the
 * frozen context in the payload, re-verified when the worker opens its unit of
 * work — not in the queue table. A job payload therefore carries identifiers
 * only, never a payload body and never delivery material (I-17, rule 9).
 */

const WORKER_SCHEMA = 'graphile_worker';

const CONSUMER_POLICIES = `
DO $sp_queue_policies$
DECLARE t record;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = '${WORKER_SCHEMA}'
           AND c.relkind = 'r'
           AND c.relrowsecurity
           AND NOT EXISTS (
                 SELECT 1 FROM pg_policy p
                  WHERE p.polrelid = c.oid AND p.polname = 'sp_worker_all')
    LOOP
        EXECUTE format(
            'CREATE POLICY sp_worker_all ON ${WORKER_SCHEMA}.%I '
            'FOR ALL TO app_worker USING (true) WITH CHECK (true)', t.relname);
    END LOOP;
END
$sp_queue_policies$;
`;

const CONSUMER_GRANTS = `
GRANT USAGE ON SCHEMA ${WORKER_SCHEMA} TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${WORKER_SCHEMA} TO app_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${WORKER_SCHEMA} TO app_worker;
`;

/**
 * The producer's only route to the queue.
 *
 * `SET search_path = graphile_worker, public, pg_temp` — **`pg_temp` LAST**, for
 * the reason migration 0001 spells out: PostgreSQL searches `pg_temp` first when
 * it is not named, so a caller holding TEMP could shadow a table this definer
 * function touches. No runtime role holds TEMP either (the bootstrap revokes it).
 *
 * The signature is deliberately narrow — a task name and a JSON payload. No
 * queue name, no priority, no `job_key`, no `max_attempts`: each of those is a
 * behaviour the outbox would then have to reason about, and none of them has a
 * caller yet. Widening it later is a migration; narrowing it is a breaking
 * change to something already in use.
 */
const ENQUEUE_WRAPPER = `
CREATE OR REPLACE FUNCTION app_enqueue_job(p_task text, p_payload json)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ${WORKER_SCHEMA}, public, pg_temp
AS $sp_enqueue$
DECLARE
    v_id bigint;
BEGIN
    IF p_task !~ '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9_]*){1,3}$' OR length(p_task) > 64 THEN
        RAISE EXCEPTION 'refusing to enqueue task name %', p_task
            USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT id INTO v_id FROM ${WORKER_SCHEMA}.add_job(p_task, p_payload);
    RETURN v_id;
END
$sp_enqueue$;

REVOKE ALL ON FUNCTION app_enqueue_job(text, json) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_enqueue_job(text, json) TO app_runtime, app_worker;
`;

export interface QueueSchemaReport {
  readonly workerMigrations: number;
  readonly policiesCreated: number;
  readonly rlsTables: readonly string[];
}

/**
 * Runs graphile-worker's migrations and applies both remediations. Idempotent.
 */
export async function installQueueSchema(
  log: (message: string) => void = (): void => {},
): Promise<QueueSchemaReport> {
  const config = connectionConfig('app_migrator');
  await runMigrations({
    connectionString: `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(
      config.password,
    )}@${config.host}:${String(config.port)}/${encodeURIComponent(config.database)}`,
  });
  log('graphile-worker: schema migrated');

  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query(CONSUMER_GRANTS);
    await client.query(CONSUMER_POLICIES);
    await client.query(ENQUEUE_WRAPPER);

    const applied = await client.query<{ n: string }>(
      `select count(*)::text as n from ${WORKER_SCHEMA}.migrations`,
    );
    const tables = await client.query<{ relname: string; policies: string }>(
      `select c.relname,
              (select count(*)::text from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind = 'r' and c.relrowsecurity
        order by c.relname`,
      [WORKER_SCHEMA],
    );

    // A table with RLS enabled and still no policy is the silent-idle failure
    // mode. Loud here rather than mysterious in production.
    const unpoliced = tables.rows.filter((r) => Number(r.policies) === 0).map((r) => r.relname);
    if (unpoliced.length > 0) {
      throw new Error(
        `graphile-worker tables have RLS enabled and no policy after remediation: ${unpoliced.join(', ')}. ` +
          'app_worker would read zero rows and process nothing, silently (SP-D E-0.2).',
      );
    }

    log(
      `graphile-worker: ${String(tables.rows.length)} RLS table(s) policed for app_worker; ` +
        'app_enqueue_job installed (app_runtime holds no direct grant)',
    );

    return {
      workerMigrations: Number(applied.rows[0]?.n ?? '0'),
      policiesCreated: tables.rows.length,
      rlsTables: tables.rows.map((r) => r.relname),
    };
  } finally {
    await client.end();
  }
}
