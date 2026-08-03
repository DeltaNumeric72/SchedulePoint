import pg from 'pg';

import { WORKER_SCHEMA, connectionConfig } from './config.ts';

export interface JobRow {
  id: string;
  task_identifier: string;
  attempts: number;
  max_attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
  run_at: Date;
  last_error: string | null;
}

export interface RunRow {
  id: string;
  task: string;
  job_id: string;
  attempt: number;
  worker_pid: number;
  phase: string;
  at: Date;
}

/**
 * Out-of-band observation, as `app_migrator`.
 *
 * Deliberately a SEPARATE connection from anything the workers use, and
 * deliberately never used to make something happen that the system under test
 * should have made happen itself. The two exceptions are labelled where they
 * occur: ageing `locked_at` (simulating the passage of lease time) and
 * `TRUNCATE` between experiments.
 */
export class Observer {
  readonly #client: pg.Client;

  constructor() {
    this.#client = new pg.Client({ ...connectionConfig('app_migrator') });
  }

  async connect(): Promise<void> {
    await this.#client.connect();
  }

  async end(): Promise<void> {
    await this.#client.end();
  }

  async jobs(): Promise<JobRow[]> {
    const { rows } = await this.#client.query<JobRow>(
      `SELECT id::text, task_identifier, attempts, max_attempts,
              locked_at, locked_by, run_at, last_error
         FROM ${WORKER_SCHEMA}.jobs
        ORDER BY id`,
    );
    return rows;
  }

  async runs(): Promise<RunRow[]> {
    const { rows } = await this.#client.query<RunRow>(
      'SELECT id::text, task, job_id::text, attempt, worker_pid, phase, at FROM spike_runs ORDER BY id',
    );
    return rows;
  }

  async effects(): Promise<{ idempotency_key: string; job_id: string; attempt: number }[]> {
    const { rows } = await this.#client.query<{
      idempotency_key: string;
      job_id: string;
      attempt: number;
    }>(
      'SELECT idempotency_key, job_id::text, attempt FROM spike_effects ORDER BY idempotency_key',
    );
    return rows;
  }

  async domainWrites(): Promise<{ id: string; label: string }[]> {
    const { rows } = await this.#client.query<{ id: string; label: string }>(
      'SELECT id::text, label FROM spike_domain_writes ORDER BY label',
    );
    return rows;
  }

  /** Job-queue locks. E-3's "no orphaned state" assertion reads this. */
  async lockedQueues(): Promise<{ queue_name: string; locked_by: string | null }[]> {
    const { rows } = await this.#client.query<{ queue_name: string; locked_by: string | null }>(
      `SELECT queue_name, locked_by
         FROM ${WORKER_SCHEMA}._private_job_queues
        WHERE locked_at IS NOT NULL
        ORDER BY queue_name`,
    );
    return rows;
  }

  /**
   * FAULT INJECTION, and the only place time is manipulated.
   *
   * graphile-worker's lease is a comparison against `locked_at`, so moving
   * `locked_at` backwards is exactly equivalent to letting the clock move
   * forwards — and it is the only way to measure a four-hour lease inside a
   * test suite. Every assertion that depends on it says so at the call site.
   */
  async ageLocks(interval: string): Promise<number> {
    const { rowCount } = await this.#client.query(
      `UPDATE ${WORKER_SCHEMA}._private_jobs
          SET locked_at = now() - $1::interval
        WHERE locked_at IS NOT NULL`,
      [interval],
    );
    return rowCount ?? 0;
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const { rows } = await this.#client.query<T>(text, values);
    return rows;
  }
}
