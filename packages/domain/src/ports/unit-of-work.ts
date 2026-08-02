/**
 * The unit-of-work port — **interface only**.
 *
 * The *interface* lives in `packages/domain`; the *implementation* lives in
 * `apps/api/src/db/unit-of-work.ts`, and the dependency-cruiser boundary rule
 * makes it impossible for that direction to reverse.
 *
 * ## The conditions this interface carries
 *
 * `spikes/sp-a-isolation/SPIKE-REPORT.md` §7 attaches three conditions to its
 * CONFIRM verdicts. None of them is visible from a type signature, so they are
 * recorded here and asserted by `apps/api/test/tenancy/`:
 *
 *  1. **Predicate spelling is normative.** RLS predicates read
 *     `nullif(current_setting('app.<x>', true), '')::uuid` — the setting is
 *     `NULL` *or* `''`. `SET LOCAL` reverts a GUC's value; it does not undefine
 *     the GUC, so `''` is the production steady state (§6.1 / X-09).
 *  2. **`set_config(name, value, true)` is the only permitted spelling.** Every
 *     `SET` / `SET SESSION` / `SET LOCAL` form of a tenant setting is banned by
 *     lint, because the only way to write them is to interpolate the tenant id
 *     into SQL — an injection surface at the most security-critical statement in
 *     the system (§7.2 / X-10).
 *  3. **The pooler's mode is asserted at process start**, not only per
 *     transaction; the read-back is a detector, not a proof (§5, §7.3).
 *
 * And the one the executed spike promoted from "recommended" to normative in
 * SPEC-01 §4.2: **read back all four settings, not one** (§6.4 / T-14b). A
 * single-setting read-back passes when only `app.group_id` is lost, which
 * reproduces the CAR-001 defect class below the application layer.
 */

/**
 * The four transaction-local settings a unit of work establishes.
 *
 * This is the tenant tuple the *database* sees. It is deliberately narrower than
 * the SPEC-01 §2.1 request-context tuple: RLS needs the tenant and the actor,
 * not the freshness counters.
 */
export interface TenantContext {
  readonly organizationId: string;
  /**
   * `null` for an organization-scoped unit of work (SPEC-01 §2.1, V-06).
   *
   * `set_config` coerces `null` to the empty string, and the RLS predicates use
   * `nullif(..., '')`, so a null group is fail-closed on every group-scoped
   * table rather than matching everything.
   */
  readonly groupId: string | null;
  /**
   * The acting membership, or `null` for a system actor — context resolution
   * before the membership is known, and the background-job system-actor marker
   * of SPEC-01 §6. A null membership matches no `owner_membership_id`, so
   * ownership object policies are fail-closed against it.
   */
  readonly membershipId: string | null;
  readonly correlationId: string;
}

/** The four setting names, in the order the wrapper establishes them. */
export const TENANT_SETTING_NAMES = [
  'app.organization_id',
  'app.group_id',
  'app.membership_id',
  'app.correlation_id',
] as const;

export type TenantSettingName = (typeof TENANT_SETTING_NAMES)[number];

/**
 * The exact values expected in the read-back, for a given context.
 *
 * Pure, and exported, because the read-back comparison is the single detector
 * for the TDG-02/TDG-03 failure mode and must be testable without a database.
 */
export function tenantSettingValues(
  context: TenantContext,
): Readonly<Record<TenantSettingName, string>> {
  return {
    'app.organization_id': context.organizationId,
    'app.group_id': context.groupId ?? '',
    'app.membership_id': context.membershipId ?? '',
    'app.correlation_id': context.correlationId,
  };
}

export interface SettingMismatch {
  readonly setting: TenantSettingName;
  readonly expected: string;
  readonly actual: string | null;
}

/**
 * Compares a read-back against the expectation, for **all four** settings.
 *
 * @returns every setting whose observed value differs. Empty means the context
 *          is established and the unit of work may proceed.
 */
export function readBackMismatches(
  context: TenantContext,
  observed: Readonly<Partial<Record<TenantSettingName, string | null>>>,
): readonly SettingMismatch[] {
  const expected = tenantSettingValues(context);
  const mismatches: SettingMismatch[] = [];
  for (const setting of TENANT_SETTING_NAMES) {
    const actual = observed[setting] ?? null;
    if (actual !== expected[setting]) {
      mismatches.push({ setting, expected: expected[setting], actual });
    }
  }
  return mismatches;
}

/**
 * Raised when the transaction-local settings do not read back.
 *
 * SPEC-01 §4.2 (V-10) requires **all three** consequences and forbids logging
 * and continuing: the transaction aborts, the connection is discarded from the
 * pool rather than returned to it, and an operational alert is raised at page
 * severity.
 */
export class ContextReadbackMismatchError extends Error {
  readonly code = 'CONTEXT_READBACK_MISMATCH';

  constructor(readonly mismatches: readonly SettingMismatch[]) {
    super(
      `CONTEXT_READBACK_MISMATCH: ${mismatches
        .map(
          (m) =>
            `${m.setting} expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}`,
        )
        .join('; ')}`,
    );
    this.name = 'ContextReadbackMismatchError';
  }
}

/**
 * Raised when a nested unit of work declares a different tenant.
 *
 * SPEC-01 §4.2: "No nested transaction may change tenant. Savepoints are
 * permitted; re-tenanting is not." Thrown **before any statement is issued**, so
 * the outer transaction is untouched and the caller may recover.
 */
export class NestedTenantChangeError extends Error {
  readonly code = 'NESTED_TENANT_CHANGE';

  constructor(
    readonly outer: TenantContext,
    readonly inner: TenantContext,
  ) {
    super(
      'NESTED_TENANT_CHANGE: a nested unit of work may not re-tenant. ' +
        `outer=(${outer.organizationId}, ${String(outer.groupId)}) ` +
        `inner=(${inner.organizationId}, ${String(inner.groupId)})`,
    );
    this.name = 'NestedTenantChangeError';
  }
}

/**
 * True when `inner` may not run as a savepoint inside `outer`.
 *
 * Two things count as a change, and the second is about attribution rather than
 * isolation:
 *
 *  - **A different tenant.** Re-tenanting inside a transaction is the CAR-001
 *    defect class and SPEC-01 §4.2 forbids it outright.
 *
 *  - **A different acting membership.** `app.membership_id` is established once
 *    per transaction and is what the audit chain will attribute every row in it
 *    to (ADR-0019, landing in OPUS-M1-003). A nested call declaring a *different*
 *    membership would run its statements under the OUTER membership's setting
 *    while the caller believed it had switched actors — the audit row would then
 *    name the wrong person, and it would name them convincingly. Refusing is the
 *    only honest option, because a savepoint cannot carry its own setting.
 *
 * A `null` inner membership is **not** a change: it means "no acting membership
 * of my own", which is how the system-actor and context-resolution paths declare
 * themselves, and inheriting the outer attribution is correct for them.
 */
export function isTenantChange(outer: TenantContext, inner: TenantContext): boolean {
  if (outer.organizationId !== inner.organizationId) return true;
  if ((outer.groupId ?? null) !== (inner.groupId ?? null)) return true;
  if (inner.membershipId !== null && inner.membershipId !== outer.membershipId) return true;
  return false;
}

/**
 * The handle a domain operation receives *inside* an open unit of work.
 *
 * There is no `commit()` and no `rollback()` on purpose: the runner owns the
 * transaction boundary, so no caller can end a transaction early or keep a
 * connection past the callback (I-15).
 *
 * `Q` is the query-builder type. The domain never names it — the parameter
 * exists so `apps/api` can bind its own without the domain importing a driver.
 */
export interface UnitOfWork<Q = unknown> {
  readonly context: TenantContext;
  /**
   * Queries execute only through this handle. The implementation guarantees
   * every statement runs on the one client pinned to this transaction, after
   * transaction-local tenant context has been established and read back.
   */
  readonly query: Q;
  /** 0 for the outermost unit of work; >0 inside a savepoint. */
  readonly depth: number;
}

/**
 * The only way to touch a tenant table (I-15).
 *
 * @remarks
 * Implementations must: open a transaction, establish transaction-local tenant
 * context with `set_config(name, value, true)`, read **all four** settings back
 * and abort-discard-alert on any mismatch, run `fn`, then commit or roll back.
 * The context ends with the transaction. Re-tenanting a nested call throws.
 */
export interface UnitOfWorkRunner<Q = unknown> {
  run<T>(context: TenantContext, fn: (uow: UnitOfWork<Q>) => Promise<T>): Promise<T>;
}
