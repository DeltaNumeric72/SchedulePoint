import pg from 'pg';

import { databaseName, superuserConfig } from './config.js';
import { ROLES, roleAttributes, type RoleSpec } from './roles.js';

/**
 * Cluster bootstrap — roles and the database itself.
 *
 * **This is not a migration, and it must not become one.** Roles are cluster
 * objects, and `app_migrator` deliberately holds neither `CREATEROLE` nor
 * `CREATEDB` nor superuser (SPEC-01 §4.4). A migration that could create the
 * roles would be a migration running as a role powerful enough to grant itself
 * `BYPASSRLS`, which defeats the entire role matrix. So role creation is a
 * separate, superuser-only step, run once per cluster, and the migration owns
 * only the GRANTS — which are schema objects and are the migrator's to give.
 *
 * `app_migrator` owns `schema public` outright and `PUBLIC` is revoked from both
 * the database and the schema, so a role that is not explicitly granted has no
 * access at all rather than the PostgreSQL default of "some".
 */

export interface BootstrapOptions {
  /** Passwords, by role name. Read from the environment by the caller. */
  readonly passwords: Readonly<Record<string, string>>;
  readonly database?: string;
  readonly log?: (message: string) => void;
}

/**
 * A PostgreSQL identifier, quoted.
 *
 * Role and database names here come only from `ROLES` and from configuration
 * this process already trusts, never from a request. Quoting is belt-and-braces
 * against a configuration value with an unexpected character, not a substitute
 * for that.
 */
function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`refusing to use ${JSON.stringify(value)} as a SQL identifier`);
  }
  return `"${value}"`;
}

/**
 * A password literal for `CREATE ROLE`.
 *
 * `CREATE ROLE ... PASSWORD` is a utility statement and cannot take a bind
 * parameter, so the value must be a literal. It is escaped by doubling single
 * quotes and rejected outright if it contains a NUL or a backslash — the two
 * characters that make quoting depend on `standard_conforming_strings`.
 */
function quotePassword(value: string): string {
  if (value.length === 0) throw new Error('refusing to create a role with an empty password');
  if (value.includes('\0') || value.includes('\\')) {
    throw new Error('role password must not contain a backslash or a NUL byte');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function passwordFor(spec: RoleSpec, passwords: Readonly<Record<string, string>>): string {
  const value = passwords[spec.name];
  if (value === undefined || value === '') {
    throw new Error(`no password supplied for role ${spec.name} (${spec.passwordEnv})`);
  }
  return value;
}

/** Reads every role password from the environment. Missing ones throw. */
export function rolePasswordsFromEnv(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const spec of ROLES) {
    const value = process.env[spec.passwordEnv];
    if (value === undefined || value === '') {
      throw new Error(`${spec.passwordEnv} is not set (role ${spec.name})`);
    }
    out[spec.name] = value;
  }
  return out;
}

/**
 * Creates the five roles and the database. Idempotent at the role level: an
 * existing role has its attributes and password re-applied rather than being
 * skipped, so a drifted attribute (someone granting `BYPASSRLS` by hand) is
 * corrected rather than tolerated.
 */
export async function bootstrapCluster(options: BootstrapOptions): Promise<void> {
  const database = options.database ?? databaseName();
  const log = options.log ?? ((): void => {});

  const admin = new pg.Client(superuserConfig('postgres'));
  await admin.connect();
  try {
    for (const spec of ROLES) {
      const attributes = roleAttributes(spec).join(' ');
      const password = quotePassword(passwordFor(spec, options.passwords));
      const name = quoteIdentifier(spec.name);

      const exists = await admin.query<{ n: number }>(
        'select count(*)::int as n from pg_roles where rolname = $1',
        [spec.name],
      );
      if ((exists.rows[0]?.n ?? 0) > 0) {
        await admin.query(`ALTER ROLE ${name} ${attributes} PASSWORD ${password}`);
        log(`role ${spec.name}: attributes re-applied (${attributes})`);
      } else {
        await admin.query(`CREATE ROLE ${name} ${attributes} PASSWORD ${password}`);
        log(`role ${spec.name}: created (${attributes})`);
      }
    }

    const dbExists = await admin.query<{ n: number }>(
      'select count(*)::int as n from pg_database where datname = $1',
      [database],
    );
    if ((dbExists.rows[0]?.n ?? 0) === 0) {
      await admin.query(
        `CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier('app_migrator')}`,
      );
      log(`database ${database}: created, owned by app_migrator`);
    }

    // REVOKE ALL then GRANT CONNECT — so no role is left holding **TEMP**.
    // That is load-bearing beyond tidiness: `app_bump_membership_set_version` is
    // SECURITY DEFINER, and a role with TEMP could create a temporary table
    // named `users` to shadow the real one inside it. The function pins
    // `search_path = public, pg_temp` so the decoy loses anyway; this revoke is
    // the outer half of the same defence. Asserted by A-05b.
    await admin.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${ROLES.map((r) =>
        quoteIdentifier(r.name),
      ).join(', ')}`,
    );
  } finally {
    await admin.end();
  }

  const inDatabase = new pg.Client(superuserConfig(database));
  await inDatabase.connect();
  try {
    // SPEC-01 §4.4 "Owns schema: yes" for app_migrator, and only for it.
    await inDatabase.query(`ALTER SCHEMA public OWNER TO ${quoteIdentifier('app_migrator')}`);
    await inDatabase.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    log('schema public: owned by app_migrator, PUBLIC revoked');
  } finally {
    await inDatabase.end();
  }
}
