import { rm } from 'node:fs/promises';

import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

import { DATABASE, DATA_DIR, PG_PORT, ROLES, SUPERUSER, superuserConfig } from './config.ts';

/**
 * FAD-7 environment substitution — identical posture to SP-A.
 *
 * No Docker, no Homebrew, no sudo on this machine, so the cluster is a REAL
 * PostgreSQL 17.10 server started user-space from the `embedded-postgres`
 * package's platform binaries. Everything this spike measures — advisory-free
 * row locking, `for update skip locked`, transaction visibility, generated
 * columns, `LISTEN`/`NOTIFY` — is server-side, so it is the same executable a
 * container would run.
 *
 * The one substitution that matters for THIS spike is on the client side, not
 * the server: the worker is a real separate OS process and the kill is a real
 * `SIGKILL`, which is exactly what the crash-recovery question needs.
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
      onLog: quiet ? () => {} : (m) => { console.log(`[pg] ${m}`); },
      onError: quiet ? () => {} : (m) => { console.error(`[pg] ${String(m)}`); },
      // Several worker processes, each with its own pool, plus the harness's
      // observation clients. NOTE: do not raise log_min_messages —
      // embedded-postgres detects readiness by matching the readiness line.
      postgresFlags: ['-c', 'max_connections=100'],
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
   * Cluster-level bootstrap a migration cannot perform: roles are cluster
   * objects and `app_migrator` deliberately holds neither CREATEROLE nor
   * CREATEDB nor superuser (SPEC-01 §4.4).
   */
  async bootstrapRolesAndDatabase(): Promise<void> {
    const admin = new pg.Client({ ...superuserConfig('postgres') });
    await admin.connect();
    try {
      for (const role of ROLES) {
        await admin.query(
          `CREATE ROLE ${role.name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ` +
            `NOINHERIT NOBYPASSRLS PASSWORD '${role.password}'`,
        );
      }
      await admin.query(`CREATE DATABASE ${DATABASE} OWNER app_migrator`);
      await admin.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
      await admin.query(
        `GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLES.map((r) => r.name).join(', ')}`,
      );
    } finally {
      await admin.end();
    }

    const inDb = new pg.Client({ ...superuserConfig(DATABASE) });
    await inDb.connect();
    try {
      await inDb.query('ALTER SCHEMA public OWNER TO app_migrator');
      await inDb.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    } finally {
      await inDb.end();
    }
  }

  /**
   * Superuser client, used ONLY for out-of-band observation and fault injection.
   * Never used to satisfy an assertion about application behaviour.
   */
  adminClient(): pg.Client {
    return new pg.Client({ ...superuserConfig(DATABASE) });
  }
}
