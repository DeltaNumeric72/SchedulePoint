import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { roleSpec, type RoleName } from './roles.js';

/**
 * Database connection configuration.
 *
 * One rule governs this file: **there is no default credential.** A missing
 * password throws at the point of use rather than falling back to a well-known
 * string, because a fallback credential is indistinguishable from a working
 * configuration until the day it is the production one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `apps/api/migrations` — plain SQL, run only by `app_migrator`. */
export const MIGRATIONS_DIR = resolve(HERE, '../../migrations');

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function requiredEnv(name: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(
      `${name} is not set. Every database role's credential comes from the environment; ` +
        'there is deliberately no default.',
    );
  }
  return value;
}

export interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

export function databaseHost(): string {
  return env('SP_PG_HOST') ?? '127.0.0.1';
}

export function databasePort(): number {
  return Number.parseInt(env('SP_PG_PORT') ?? '5432', 10);
}

export function databaseName(): string {
  return env('SP_PG_DATABASE') ?? 'schedulepoint';
}

export function connectionConfig(role: RoleName, database = databaseName()): ConnectionConfig {
  const spec = roleSpec(role);
  return {
    host: databaseHost(),
    port: databasePort(),
    database,
    user: spec.name,
    password: requiredEnv(spec.passwordEnv),
  };
}

/**
 * Superuser configuration, used **only** for cluster bootstrap (role and
 * database creation, which are cluster objects `app_migrator` deliberately
 * cannot create) and, in the harness, for out-of-band ground-truth reads.
 *
 * No request path may use it. There is no code in `src/http` that imports this.
 */
export function superuserConfig(database = databaseName()): ConnectionConfig {
  return {
    host: databaseHost(),
    port: databasePort(),
    database,
    user: env('SP_PG_SUPERUSER') ?? 'postgres',
    password: requiredEnv('SP_PG_SUPERUSER_PASSWORD'),
  };
}

/** Where a migration file lives, given its filename. */
export function migrationPath(fileName: string): string {
  return join(MIGRATIONS_DIR, fileName);
}
