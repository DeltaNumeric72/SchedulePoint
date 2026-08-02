/**
 * SPEC-01 §4.4 — the role matrix.
 *
 * | Role | Owns schema | `BYPASSRLS` | Superuser | Used by |
 * |---|:--:|:--:|:--:|---|
 * | `app_migrator`            | **yes** | no  | no | Migrations only, in CI/CD. **No application traffic** |
 * | `app_runtime`             | no      | no  | no | Web/API processes. DML **only under RLS** |
 * | `app_worker`              | no      | no  | no | Background, scheduling, real-time processes |
 * | `app_readonly_support`    | no      | no  | no | Support tooling. `SELECT` only, **every read audited** |
 * | `app_breakglass`          | no      | yes | no | **Two-person emergency only.** Every session audited and alerted |
 *
 * The five are genuinely distinct and the harness probes each of them: A-02
 * asserts the attributes, A-04 that FORCE RLS binds the owner, A-05 that no
 * runtime role holds `TRUNCATE` or `REFERENCES` (neither is subject to RLS, so
 * withholding the grant is the only control), A-07 that support is read-only,
 * A-08 that break-glass genuinely differs.
 *
 * **No password appears in this file or anywhere in the repository.** Each role's
 * credential is read from the environment, and a missing one is a startup
 * failure rather than a silent fallback — a default password is how a
 * development credential reaches production.
 */

export const ROLE_NAMES = [
  'app_migrator',
  'app_runtime',
  'app_worker',
  'app_readonly_support',
  'app_breakglass',
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

export interface RoleExpectation {
  readonly ownsSchema: boolean;
  readonly bypassRls: boolean;
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDb: boolean;
}

export interface RoleSpec {
  readonly name: RoleName;
  readonly expect: RoleExpectation;
  readonly purpose: string;
  /** Environment variable carrying this role's password. */
  readonly passwordEnv: string;
}

const base: Omit<RoleExpectation, 'ownsSchema' | 'bypassRls'> = {
  superuser: false,
  createRole: false,
  createDb: false,
};

export const ROLES: readonly RoleSpec[] = [
  {
    name: 'app_migrator',
    expect: { ...base, ownsSchema: true, bypassRls: false },
    purpose: 'Owns the schema. Migrations only, never application traffic.',
    passwordEnv: 'SP_PG_PASSWORD_APP_MIGRATOR',
  },
  {
    name: 'app_runtime',
    expect: { ...base, ownsSchema: false, bypassRls: false },
    purpose: 'Web/API processes. DML only under RLS.',
    passwordEnv: 'SP_PG_PASSWORD_APP_RUNTIME',
  },
  {
    name: 'app_worker',
    expect: { ...base, ownsSchema: false, bypassRls: false },
    purpose: 'Background, scheduling and real-time processes. DML only under RLS.',
    passwordEnv: 'SP_PG_PASSWORD_APP_WORKER',
  },
  {
    name: 'app_readonly_support',
    expect: { ...base, ownsSchema: false, bypassRls: false },
    purpose: 'Support tooling. SELECT only, under RLS, every read audited.',
    passwordEnv: 'SP_PG_PASSWORD_APP_READONLY_SUPPORT',
  },
  {
    name: 'app_breakglass',
    expect: { ...base, ownsSchema: false, bypassRls: true },
    purpose: 'Two-person emergency only. Every session audited and alerted.',
    passwordEnv: 'SP_PG_PASSWORD_APP_BREAKGLASS',
  },
] as const;

export function roleSpec(name: RoleName): RoleSpec {
  const found = ROLES.find((role) => role.name === name);
  if (found === undefined) throw new Error(`unknown role: ${name}`);
  return found;
}

/**
 * The `CREATE ROLE` attribute list for a role.
 *
 * Exported as data rather than as SQL so that the bootstrap can build the
 * statement and a test can assert the attributes without parsing SQL. Every
 * attribute is stated explicitly, including the negatives: relying on a server
 * default for `NOBYPASSRLS` means a server with a different default silently
 * grants it.
 */
export function roleAttributes(spec: RoleSpec): readonly string[] {
  return [
    'LOGIN',
    spec.expect.superuser ? 'SUPERUSER' : 'NOSUPERUSER',
    spec.expect.createDb ? 'CREATEDB' : 'NOCREATEDB',
    spec.expect.createRole ? 'CREATEROLE' : 'NOCREATEROLE',
    'NOINHERIT',
    spec.expect.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS',
  ];
}
