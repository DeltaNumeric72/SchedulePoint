import { rm } from 'node:fs/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {
  DATABASE,
  DATA_DIR,
  PG_PORT,
  ROLES,
  SUPERUSER,
  superuserConfig,
} from './config.ts';

/**
 * FAD-7 environment substitution.
 *
 * The packet specifies a docker-composed PostgreSQL. This machine has no
 * Docker, no Homebrew and no sudo, so the cluster is a REAL PostgreSQL 17.10
 * server started user-space from the `embedded-postgres` npm package's
 * platform binaries. Nothing about RLS, `SET LOCAL`, role attributes or
 * pooling semantics differs from a containerised server: it is the same
 * `postgres` executable. See docker-compose.yml for the CI-facing equivalent.
 */
export class SpikeCluster {
  #pg: EmbeddedPostgres | undefined;
  #started = false;

  async start(options: { fresh?: boolean; quiet?: boolean } = {}): Promise<void> {
    const { fresh = true, quiet = true } = options;

    if (fresh) {
      await rm(DATA_DIR, { recursive: true, force: true });
    }

    this.#pg = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: PG_PORT,
      user: SUPERUSER.user,
      password: SUPERUSER.password,
      authMethod: 'scram-sha-256',
      persistent: false,
      onLog: quiet ? () => {} : (m) => console.log(`[pg] ${m}`),
      onError: quiet ? () => {} : (m) => console.error(`[pg] ${String(m)}`),
      // Small but non-trivial connection budget: the harness deliberately runs
      // a tiny pool against it and must not be masked by an enormous ceiling.
      //
      // NOTE: do NOT raise log_min_messages here. embedded-postgres detects
      // readiness by matching the "database system is ready to accept
      // connections" line on stdout; suppressing it makes start() hang forever.
      postgresFlags: ['-c', 'max_connections=60'],
    });

    await this.#pg.initialise();
    await this.#pg.start();
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (this.#pg && this.#started) {
      await this.#pg.stop();
      this.#started = false;
    }
  }

  /**
   * Cluster-level bootstrap that a migration cannot perform, because roles are
   * cluster objects and the migration role is deliberately not a superuser and
   * holds neither CREATEROLE nor CREATEDB.
   */
  async bootstrapRolesAndDatabase(): Promise<void> {
    const admin = new pg.Client({ ...superuserConfig('postgres') });
    await admin.connect();
    try {
      for (const role of ROLES) {
        const attrs = [
          'LOGIN',
          'NOSUPERUSER',
          'NOCREATEDB',
          'NOCREATEROLE',
          'NOINHERIT',
          role.expect.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS',
        ].join(' ');
        await admin.query(
          `CREATE ROLE ${role.name} ${attrs} PASSWORD '${role.password}'`,
        );
      }

      await admin.query(`CREATE DATABASE ${DATABASE} OWNER app_migrator`);
      await admin.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${DATABASE} TO ` +
          ROLES.map((r) => r.name).join(', '),
      );
    } finally {
      await admin.end();
    }

    const inDb = new pg.Client({ ...superuserConfig(DATABASE) });
    await inDb.connect();
    try {
      // app_migrator owns the schema outright (SPEC-01 §4.4 "Owns schema: yes").
      await inDb.query('ALTER SCHEMA public OWNER TO app_migrator');
      await inDb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    } finally {
      await inDb.end();
    }
  }

  /** Superuser client, used ONLY for out-of-band harness observation and fault
   * injection (pg_cancel_backend / pg_terminate_backend / ground-truth reads).
   * Never used to satisfy an assertion about application behaviour. */
  adminClient(): pg.Client {
    return new pg.Client({ ...superuserConfig(DATABASE) });
  }
}
