import pg from 'pg';

import { WORKER_SCHEMA, connectionConfig } from './config.ts';

/**
 * The three tables this spike observes.
 *
 * `spike_domain_writes` is the **domain change**. The whole TDG-04 question is
 * whether an enqueue can be made atomic with a row in this table.
 *
 * `spike_effects` is the **externally visible effect** a job produces, keyed by
 * an idempotency key. Retries are expected; duplicate effects are the thing that
 * must not happen, and a primary key is the cheapest honest proof.
 *
 * `spike_runs` is the **observation log**: one row per task invocation, written
 * by the task before it does anything else, so the harness can see an attempt
 * that was killed before it could report anything.
 *
 * None of them is tenant-scoped and none carries RLS. That is deliberate and it
 * is a limit of this spike, recorded in SPIKE-REPORT §7: tenant isolation is
 * SP-A's and OPUS-M1-001's question, already answered, and mixing it in here
 * would make a queue failure and an isolation failure hard to tell apart.
 */
const DOMAIN_DDL = `
CREATE TABLE spike_domain_writes (
    id          uuid PRIMARY KEY,
    label       text NOT NULL CHECK (length(btrim(label)) > 0),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spike_effects (
    idempotency_key  text PRIMARY KEY,
    job_id           bigint NOT NULL,
    attempt          integer NOT NULL,
    applied_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE spike_pools (
    pool_id      text PRIMARY KEY,
    label        text NOT NULL,
    worker_pid   integer NOT NULL,
    started_at   timestamptz NOT NULL DEFAULT now(),
    released_at  timestamptz
);

CREATE TABLE spike_runs (
    id          bigserial PRIMARY KEY,
    task        text NOT NULL,
    job_id      bigint NOT NULL,
    attempt     integer NOT NULL,
    worker_pid  integer NOT NULL,
    phase       text NOT NULL,
    at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;

const DOMAIN_GRANTS = `
GRANT USAGE ON SCHEMA public TO app_runtime, app_worker;
GRANT SELECT, INSERT ON spike_domain_writes TO app_runtime, app_worker;
GRANT SELECT, INSERT ON spike_effects       TO app_runtime, app_worker;
GRANT SELECT, INSERT ON spike_runs          TO app_runtime, app_worker;
GRANT SELECT, INSERT, UPDATE ON spike_pools TO app_worker;
GRANT USAGE, SELECT ON SEQUENCE spike_runs_id_seq TO app_runtime, app_worker;
`;

/**
 * Table-level GRANTs on graphile-worker's own schema — **necessary and, as E-0
 * measures, NOT sufficient.**
 *
 * `graphile_worker.add_job` is `SECURITY INVOKER`, graphile-worker's migrations
 * contain no `GRANT` at all, and — the part nobody expects — every one of its
 * tables is created with `ENABLE ROW LEVEL SECURITY` **and no policy**. RLS is
 * not FORCEd, so the schema owner bypasses it and every other role is refused
 * outright regardless of how generous the grants are. E-0 measures both halves.
 */
const WORKER_SCHEMA_GRANTS = `
GRANT USAGE ON SCHEMA ${WORKER_SCHEMA} TO app_runtime, app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA ${WORKER_SCHEMA} TO app_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${WORKER_SCHEMA} TO app_worker;
`;

/**
 * The remediation E-0 proves is required, in the two shapes production would
 * actually use.
 *
 * **(a) The consuming role gets explicit policies.** Not `DISABLE ROW LEVEL
 * SECURITY` — non-bypass rule 3 — and not `BYPASSRLS` on `app_worker`, which
 * would hand it a bypass over every *tenant* table too. A named permissive
 * policy `TO app_worker` on each of graphile-worker's own infrastructure tables
 * is the narrowest thing that works, and it is written by a loop over the tables
 * that actually have RLS enabled so a graphile-worker upgrade adding a table
 * cannot silently leave a hole.
 *
 * **(b) The enqueuing role gets a `SECURITY DEFINER` wrapper and nothing else.**
 * `app_runtime` receives no grant and no policy on the queue tables at all; it
 * can only enqueue through this function, which runs as the schema owner. The
 * property E-1 must then prove is that `SECURITY DEFINER` does **not** open a
 * new transaction — if it did, the outbox property would be lost and TDG-04
 * would fail on its one hard requirement.
 *
 * `SET search_path = ${WORKER_SCHEMA}, public, pg_temp` — **`pg_temp` LAST**, for
 * the reason migration 0001 spells out: PostgreSQL searches `pg_temp` first when
 * it is not named, so a caller holding TEMP could shadow a table the definer
 * function touches.
 */
const WORKER_SCHEMA_REMEDIATION = `
DO $remediate$
DECLARE t record;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = '${WORKER_SCHEMA}'
           AND c.relkind = 'r'
           AND c.relrowsecurity
    LOOP
        EXECUTE format(
            'CREATE POLICY sp_worker_all ON ${WORKER_SCHEMA}.%I '
            'FOR ALL TO app_worker USING (true) WITH CHECK (true)', t.relname);
    END LOOP;
END
$remediate$;

CREATE FUNCTION spike_enqueue(identifier text, payload json)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ${WORKER_SCHEMA}, public, pg_temp
AS $enqueue$
DECLARE
    v_id bigint;
BEGIN
    SELECT id INTO v_id FROM ${WORKER_SCHEMA}.add_job(identifier, payload);
    RETURN v_id;
END
$enqueue$;

REVOKE ALL ON FUNCTION spike_enqueue(text, json) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spike_enqueue(text, json) TO app_runtime, app_worker;

CREATE FUNCTION spike_enqueue_capped(identifier text, payload json, cap integer)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ${WORKER_SCHEMA}, public, pg_temp
AS $enqueue$
DECLARE
    v_id bigint;
BEGIN
    SELECT id INTO v_id
      FROM ${WORKER_SCHEMA}.add_job(identifier, payload, max_attempts => cap);
    RETURN v_id;
END
$enqueue$;

REVOKE ALL ON FUNCTION spike_enqueue_capped(text, json, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spike_enqueue_capped(text, json, integer) TO app_runtime, app_worker;
`;

export async function createDomainSchema(): Promise<void> {
  const client = new pg.Client({ ...connectionConfig('app_migrator') });
  await client.connect();
  try {
    await client.query(DOMAIN_DDL);
    await client.query(DOMAIN_GRANTS);
  } finally {
    await client.end();
  }
}

/** Run AFTER graphile-worker's own migrations have created its schema. */
export async function grantWorkerSchema(): Promise<void> {
  const client = new pg.Client({ ...connectionConfig('app_migrator') });
  await client.connect();
  try {
    await client.query(WORKER_SCHEMA_GRANTS);
  } finally {
    await client.end();
  }
}

/** Applied by E-0 once the lock-out has been measured, not before. */
export async function remediateWorkerSchema(): Promise<number> {
  const client = new pg.Client({ ...connectionConfig('app_migrator') });
  await client.connect();
  try {
    await client.query(WORKER_SCHEMA_REMEDIATION);
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_policies
        WHERE schemaname = '${WORKER_SCHEMA}' AND policyname = 'sp_worker_all'`,
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

/** Tables graphile-worker created with RLS enabled but no policy of its own. */
export async function rlsEnabledWorkerTables(): Promise<
  { table: string; policies: number }[]
> {
  const client = new pg.Client({ ...connectionConfig('app_migrator') });
  await client.connect();
  try {
    const { rows } = await client.query<{ table: string; policies: string }>(
      `SELECT c.relname AS table,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${WORKER_SCHEMA}' AND c.relkind = 'r' AND c.relrowsecurity
        ORDER BY c.relname`,
    );
    return rows.map((r) => ({ table: r.table, policies: Number(r.policies) }));
  } finally {
    await client.end();
  }
}

export async function truncateObservations(): Promise<void> {
  const client = new pg.Client({ ...connectionConfig('app_migrator') });
  await client.connect();
  try {
    await client.query('TRUNCATE spike_domain_writes, spike_effects, spike_runs, spike_pools');
    await client.query(`DELETE FROM ${WORKER_SCHEMA}._private_jobs`);
    await client.query(`UPDATE ${WORKER_SCHEMA}._private_job_queues
                           SET locked_at = null, locked_by = null`);
  } finally {
    await client.end();
  }
}
