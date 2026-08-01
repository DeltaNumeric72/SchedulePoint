import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SPIKE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = join(SPIKE_ROOT, 'migrations');
export const DATA_DIR = join(SPIKE_ROOT, '.pgdata');

export const PG_PORT = Number(process.env.SPIKE_PG_PORT ?? 55432);
export const PG_HOST = '127.0.0.1';
export const DATABASE = 'schedulepoint_spike';

/**
 * Synthetic local-only credentials (SPIKE ONLY).
 *
 * The packet's security constraint is "secrets via env for local containers
 * only". There is no container here (FAD-7); the cluster is a user-space
 * PostgreSQL listening on 127.0.0.1 with a data directory inside this spike
 * that is .gitignored and destroyed between runs. These strings are not
 * secrets, are not reused anywhere, and must never be copied into any
 * non-spike code.
 */
export const SUPERUSER = {
  user: 'postgres',
  password: process.env.SPIKE_PG_SUPERUSER_PASSWORD ?? 'spike-local-superuser',
} as const;

export type RoleName =
  | 'app_migrator'
  | 'app_runtime'
  | 'app_worker'
  | 'app_readonly_support'
  | 'app_breakglass';

export interface RoleSpec {
  readonly name: RoleName;
  readonly password: string;
  /** SPEC-01 §4.4 expectations, asserted by the harness. */
  readonly expect: {
    readonly ownsSchema: boolean;
    readonly bypassRls: boolean;
    readonly superuser: boolean;
  };
  readonly purpose: string;
}

export const ROLES: readonly RoleSpec[] = [
  {
    name: 'app_migrator',
    password: 'spike-local-migrator',
    expect: { ownsSchema: true, bypassRls: false, superuser: false },
    purpose: 'Owns the schema. Migrations only, never application traffic.',
  },
  {
    name: 'app_runtime',
    password: 'spike-local-runtime',
    expect: { ownsSchema: false, bypassRls: false, superuser: false },
    purpose: 'Web/API processes. DML only under RLS.',
  },
  {
    name: 'app_worker',
    password: 'spike-local-worker',
    expect: { ownsSchema: false, bypassRls: false, superuser: false },
    purpose: 'Background/scheduling/real-time processes. DML only under RLS.',
  },
  {
    name: 'app_readonly_support',
    password: 'spike-local-support',
    expect: { ownsSchema: false, bypassRls: false, superuser: false },
    purpose: 'Support tooling. SELECT only, under RLS, every read audited.',
  },
  {
    name: 'app_breakglass',
    password: 'spike-local-breakglass',
    expect: { ownsSchema: false, bypassRls: true, superuser: false },
    purpose: 'Two-person emergency only. Every session audited and alerted.',
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

export function superuserConfig(database = DATABASE) {
  return {
    host: PG_HOST,
    port: PG_PORT,
    database,
    user: SUPERUSER.user,
    password: SUPERUSER.password,
  };
}

/** Fixed synthetic tenant fixture: two organizations, two groups each. */
export const FIXTURE = {
  orgA: {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Org A (synthetic)',
    groupA1: '1a1a1a1a-1111-4111-8111-a1a1a1a1a1a1',
    groupA2: '1b1b1b1b-1111-4111-8111-b1b1b1b1b1b1',
    membership: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  },
  orgB: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Org B (synthetic)',
    groupB1: '2a2a2a2a-2222-4222-8222-a2a2a2a2a2a2',
    groupB2: '2b2b2b2b-2222-4222-8222-b2b2b2b2b2b2',
    membership: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  },
} as const;
