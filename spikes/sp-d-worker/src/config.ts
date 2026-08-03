import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(SPIKE_ROOT, '.pgdata');

export const PG_PORT = Number(process.env.SPIKE_PG_PORT ?? 55433);
export const PG_HOST = '127.0.0.1';
export const DATABASE = 'schedulepoint_spike_d';

/**
 * Synthetic local-only credentials (SPIKE ONLY).
 *
 * Same posture as SP-A: there is no container here (FAD-7); the cluster is a
 * user-space PostgreSQL listening on 127.0.0.1 with a data directory inside this
 * spike that is .gitignored and destroyed between runs. These strings are not
 * secrets, are not reused anywhere, and must never be copied into any non-spike
 * code.
 */
export const SUPERUSER = {
  user: 'postgres',
  password: process.env.SPIKE_PG_SUPERUSER_PASSWORD ?? 'spike-local-superuser',
} as const;

export type RoleName = 'app_migrator' | 'app_runtime' | 'app_worker';

export interface RoleSpec {
  readonly name: RoleName;
  readonly password: string;
  readonly purpose: string;
}

/**
 * Three of SPEC-01 §4.4's five roles — the three the queue question touches.
 *
 * `app_readonly_support` and `app_breakglass` are out of scope here: this spike
 * asks whether graphile-worker's enqueue is transactional and its lease durable,
 * not whether the role matrix holds (SP-A proved that, and OPUS-M1-001 ships it).
 */
export const ROLES: readonly RoleSpec[] = [
  {
    name: 'app_migrator',
    password: 'spike-local-migrator',
    purpose: 'Owns the schema, including the graphile_worker schema.',
  },
  {
    name: 'app_runtime',
    password: 'spike-local-runtime',
    purpose: 'Web/API processes. ENQUEUES jobs inside the domain transaction.',
  },
  {
    name: 'app_worker',
    password: 'spike-local-worker',
    purpose: 'Background processes. CONSUMES jobs.',
  },
] as const;

export function roleSpec(name: RoleName): RoleSpec {
  const found = ROLES.find((r) => r.name === name);
  if (!found) throw new Error(`unknown role ${name}`);
  return found;
}

export function connectionConfig(role: RoleName, database = DATABASE) {
  const spec = roleSpec(role);
  return {
    host: PG_HOST,
    port: PG_PORT,
    database,
    user: spec.name,
    password: spec.password,
  };
}

export function connectionString(role: RoleName, database = DATABASE): string {
  const spec = roleSpec(role);
  return `postgres://${spec.name}:${spec.password}@${PG_HOST}:${String(PG_PORT)}/${database}`;
}

export function superuserConfig(database = DATABASE) {
  return {
    host: PG_HOST,
    port: PG_PORT,
    database,
    user: SUPERUSER.user,
    password: SUPERUSER.password,
  };
}

/** The schema graphile-worker installs itself into. */
export const WORKER_SCHEMA = 'graphile_worker';
